/**
 * Keyboard inside an open dialog (any `.modal-backdrop`, and the lock screen):
 * - Tab / Shift+Tab do nothing: the focus stays where it is (it neither moves through the dialog nor leaves it for
 *   the app behind it). Fields are chosen with the mouse; the footer buttons with ← / →.
 * - ← / → move the focus between the footer buttons (`.dialog-actions`), wrapping around. They act only while a
 *   footer button (or the dialog itself, nothing inside it) has the focus, so text fields keep their arrow keys.
 *   Ctrl / Shift may still be held: a dialog opened by a shortcut (Ctrl+Shift+W → Close tab) answers the arrows
 *   pressed before those keys are released.
 * - Enter on a focused footer button clicks it, Ctrl / Shift held or not (the browser's own Enter activation
 *   only works without them). Other buttons keep their own Enter (a Select opens its list).
 * One capture listener on the window for every dialog, so no dialog has to wire it up.
 */
const CONTAINER = '.modal-backdrop:not(.is-leaving), .lock-screen:not(.is-leaving)';

/** The dialog on top: the last open one in document order (a dialog opened from a dialog comes after it). */
const topDialog = (): HTMLElement | null => {
  const all = document.querySelectorAll<HTMLElement>(CONTAINER);
  for (let index = all.length - 1; index >= 0; index--) if (!all[index].closest('[inert]')) return all[index];
  return null;
};

const visible = (element: HTMLElement) =>
  element.getClientRects().length > 0 && !element.closest('[hidden], [inert]') && getComputedStyle(element).visibility !== 'hidden';

const footerButtons = (group: Element) =>
  [...group.querySelectorAll<HTMLButtonElement>('button')].filter(button => !button.disabled && button.tabIndex >= 0 && visible(button));

const onKeyDown = (event: KeyboardEvent) => {
  if (event.defaultPrevented || event.isComposing) return;
  const tab = event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey;
  const arrow = (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.altKey && !event.metaKey;
  const enter = event.key === 'Enter' && !event.altKey && !event.metaKey && !event.repeat;
  if (!tab && !arrow && !enter) return;
  const container = topDialog();
  if (!container) return;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // Keyboard Shortcuts…: the field that is recording a key gets every key, Tab included.
  if (active?.closest('.key-capture.is-recording')) return;
  const inside = Boolean(active && container.contains(active));

  if (tab) {
    event.preventDefault();
    return;
  }
  if (enter) {
    const button = inside && active instanceof HTMLButtonElement && !active.disabled && active.closest('.dialog-actions') ? active : null;
    if (!button) return;
    event.preventDefault(); // no second click from the browser, no form submit by Enter
    button.click();
    return;
  }

  // ← / →: from a footer button to its neighbour; from the dialog itself (nothing inside focused) into the footer.
  const group = inside ? active?.closest('.dialog-actions') : null;
  const onButton = Boolean(group && active instanceof HTMLButtonElement);
  const onDialog = !inside || active === container || Boolean(active?.matches('[role="dialog"]'));
  if (!onButton && !onDialog) return;
  const actions = onButton ? group : [...container.querySelectorAll<HTMLElement>('.dialog-actions')].filter(visible).pop();
  if (!actions) return;
  const buttons = footerButtons(actions);
  if (!buttons.length) return;
  event.preventDefault();
  const step = event.key === 'ArrowRight' ? 1 : -1;
  const index = onButton ? buttons.indexOf(active as HTMLButtonElement) : -1;
  const next = index === -1 ? (step > 0 ? 0 : buttons.length - 1) : (index + step + buttons.length) % buttons.length;
  buttons[next].focus();
};

export function installDialogKeys() {
  window.addEventListener('keydown', onKeyDown, true);
}
