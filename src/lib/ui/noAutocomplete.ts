/**
 * No browser input history anywhere in the app: every <input>, <textarea> and <form> gets
 * autocomplete="off" (Chrome / WebKit otherwise offer earlier entries in a dropdown under
 * host names, paths, filters …). New fields are covered as React renders them.
 * Password prompts included, so the browser offers to save nothing.
 */
const FIELDS = 'input, textarea, form';
/** Areas re-rendered on every frame while a terminal scrolls or prints; they never add fields. */
const RENDER_AREAS = '.xterm-screen, .terminal-gutter, .sb-layer';

function disable(element: Element) {
  if (element.getAttribute('autocomplete') !== 'off') element.setAttribute('autocomplete', 'off');
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (!element.hasAttribute('autocorrect')) element.setAttribute('autocorrect', 'off');
    if (!element.hasAttribute('autocapitalize')) element.setAttribute('autocapitalize', 'off');
  }
}

export function disableAutocomplete(root: ParentNode = document) {
  root.querySelectorAll(FIELDS).forEach(disable);
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        disable(mutation.target as Element);
        continue;
      }
      if ((mutation.target as Element).closest?.(RENDER_AREAS)) continue;
      mutation.addedNodes.forEach(node => {
        if (!(node instanceof Element)) return;
        if (node.matches(FIELDS)) disable(node);
        node.querySelectorAll(FIELDS).forEach(disable);
      });
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['autocomplete'] });
  return () => observer.disconnect();
}
