/**
 * Clicking the title of a field (the text of a `<label>` around an input, a drop-down, a font box …)
 * does not focus / open the field: only a click on the field itself does. The browser's default
 * would move the focus to the label's control (and click a drop-down's trigger button, opening it).
 *
 * Check boxes and radio buttons keep the usual behaviour: clicking their text toggles them (their
 * text is part of the control, not a title above it).
 *
 * One capture-phase `click` listener on the document (`main.tsx`): when the click lands inside a
 * `<label>` but outside its control and outside any other interactive element, its default action
 * (the label activation) is cancelled. Other handlers still get the click.
 */
const INTERACTIVE =
  'input, textarea, select, button, a[href], [contenteditable=""], [contenteditable="true"], [role="button"], [role="combobox"], [role="listbox"], [role="option"], [role="tree"], [role="treeitem"], [role="menu"], [role="menuitem"], [tabindex]:not([tabindex="-1"])';

export function installLabelClicks() {
  document.addEventListener(
    'click',
    event => {
      const target = event.target instanceof Element ? event.target : null;
      const label = target?.closest('label');
      if (!target || !label) return;
      if (target.closest(INTERACTIVE)) return;
      const control = label.control;
      if (control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')) return;
      event.preventDefault();
    },
    true,
  );
}
