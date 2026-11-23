/**
 * Enter / leave animations for every popup, in one place: dropdown and context menus, the menu bar's
 * menus, the menu search, tooltips, dialogs (with their backdrop) and the Filer's transfer notices.
 *
 * Components just mount and unmount their popup as before. A MutationObserver sees each popup element
 * arrive and plays its enter animation (Web Animations, so React re-rendering the element's classes
 * cannot cut it short). When React removes a popup, the same element is put straight back where it
 * was — before the next frame, so nothing flickers — marked `inert` / `aria-hidden` / `is-leaving`,
 * plays its leave animation and is then removed for good. React no longer knows the element, so it is
 * never touched again; it cannot be focused or clicked while it fades.
 *
 * A popup replaced by another of the same kind in the same update (moving along the menu bar,
 * between submenus, from one tooltip to the next) is a switch, not a close: neither animates.
 * `prefers-reduced-motion: reduce` turns all of it off.
 */
type Motion = { enter: Keyframe[]; leave: Keyframe[]; enterMs: number; leaveMs: number; easing?: string };

const fade = (dy: number, scale = 1): Motion => ({
  enter: [
    { opacity: 0, transform: `translateY(${dy}px)${scale !== 1 ? ` scale(${scale})` : ''}` },
    { opacity: 1, transform: 'none' },
  ],
  leave: [
    { opacity: 1, transform: 'none' },
    { opacity: 0, transform: `translateY(${dy / 2}px)${scale !== 1 ? ` scale(${scale})` : ''}` },
  ],
  enterMs: 110,
  leaveMs: 90,
});

/** Popup kinds, first match wins. `kind` groups popups that replace each other (a switch). */
const KINDS: { selector: string; kind: string; motion: (element: HTMLElement) => Motion }[] = [
  { selector: '.menu-bar-menu', kind: 'menu-bar', motion: () => fade(-3) },
  { selector: '.ui-select-menu', kind: 'menu', motion: element => fade(element.classList.contains('opens-up') ? 3 : -3) },
  { selector: '.command-palette', kind: 'palette', motion: () => fade(-6) },
  {
    selector: '.ui-tip',
    kind: 'tip',
    motion: element => ({ ...fade(element.dataset.placement === 'above' ? 2 : -2), enterMs: 90, leaveMs: 70 }),
  },
  {
    selector: '.modal-backdrop',
    kind: 'dialog',
    motion: () => ({ enter: [{ opacity: 0 }, { opacity: 1 }], leave: [{ opacity: 1 }, { opacity: 0 }], enterMs: 140, leaveMs: 110 }),
  },
  { selector: '.filer-transfer', kind: 'notice', motion: () => ({ ...fade(4), enterMs: 140, leaveMs: 160 }) },
];
const SELECTOR = KINDS.map(entry => entry.selector).join(',');
/** The dialog box inside a backdrop moves a little as the backdrop fades. */
const DIALOG_BOX = fade(8, 0.985);

const kindOf = (element: Element) => KINDS.find(entry => element.matches(entry.selector));

const motionQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
/** Cheap first check on class names: terminals (gutter rows, decorations) add and remove many nodes. */
const MAYBE = /menu|palette|ui-tip|backdrop|filer-transfer/;
const candidate = (node: Node): node is HTMLElement =>
  node instanceof HTMLElement && MAYBE.test(node.className) && !node.classList.contains('is-leaving') && node.matches(SELECTOR);

const settled = (element: HTMLElement) => element.dispatchEvent(new Event('animationend', { bubbles: true }));

function enter(element: HTMLElement) {
  const entry = kindOf(element);
  if (!entry) return;
  const motion = entry.motion(element);
  const animation = element.animate(motion.enter, { duration: motion.enterMs, easing: 'ease-out' });
  // Web Animations fire no animationend; layers that re-measure after animations (custom scrollbars) wait for it.
  animation.finished.then(
    () => settled(element),
    () => undefined,
  );
  if (entry.kind === 'dialog') {
    const box = element.firstElementChild as HTMLElement | null;
    box?.animate(DIALOG_BOX.enter, { duration: motion.enterMs, easing: 'ease-out' });
  }
}

function leave(element: HTMLElement, parent: Node, before: Node | null) {
  const entry = kindOf(element);
  if (!entry || !parent.isConnected) return;
  const motion = entry.motion(element);
  element.classList.add('is-leaving');
  element.setAttribute('aria-hidden', 'true');
  element.inert = true;
  element.removeAttribute('id');
  element.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
  parent.insertBefore(element, before && before.parentNode === parent ? before : null);
  const animation = element.animate(motion.leave, { duration: motion.leaveMs, easing: 'ease-in', fill: 'forwards' });
  if (entry.kind === 'dialog') {
    const box = element.firstElementChild as HTMLElement | null;
    box?.animate(DIALOG_BOX.leave, { duration: motion.leaveMs, easing: 'ease-in', fill: 'forwards' });
  }
  settled(element);
  const done = () => element.remove();
  animation.finished.then(done, done);
}

export function installPopupMotion(root: Node = document.body): () => void {
  const observer = new MutationObserver(records => {
    if (motionQuery?.matches) return;
    const added: HTMLElement[] = [];
    const removed: { element: HTMLElement; parent: Node; before: Node | null }[] = [];
    for (const record of records) {
      for (const node of record.addedNodes) if (candidate(node)) added.push(node);
      for (const node of record.removedNodes)
        if (candidate(node) && !node.isConnected) removed.push({ element: node, parent: record.target, before: record.nextSibling });
    }
    if (!added.length && !removed.length) return;
    const arriving = new Set(added.map(element => kindOf(element)?.kind));
    const leaving = new Set(removed.map(item => kindOf(item.element)?.kind));
    // Switches: a popup of the same kind both left and arrived in this update.
    for (const element of added) if (!leaving.has(kindOf(element)?.kind)) enter(element);
    for (const item of removed) if (!arriving.has(kindOf(item.element)?.kind)) leave(item.element, item.parent, item.before);
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
