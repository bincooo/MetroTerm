import type { KeyboardEvent } from 'react';

/** Dialog keydown handler: Esc closes the dialog, unless it only closes an open dropdown inside it. */
export const escapeCloses = (onClose: () => void) => (event: KeyboardEvent) => {
  if (event.key === 'Escape' && !(event.target as Element).closest('.ui-select.is-open')) {
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }
};
