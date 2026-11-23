import type { KeyboardEvent, MouseEvent } from 'react';

/** Dialog keydown handler: Esc closes the dialog, unless it only closes an open dropdown inside it. */
export const escapeCloses = (onClose: () => void) => (event: KeyboardEvent) => {
  if (event.key === 'Escape' && !(event.target as Element).closest('.ui-select.is-open')) {
    event.preventDefault();
    event.stopPropagation();
    onClose();
  }
};

/**
 * Backdrop mousedown: clicking the dimmed area around a dialog does not close it (only the close
 * button, Cancel / OK or Esc do), and the field that has the keyboard focus keeps it.
 */
export const backdropMouseDown = (event: MouseEvent) => {
  if (event.target === event.currentTarget) event.preventDefault();
};
