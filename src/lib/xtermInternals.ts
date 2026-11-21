import type { Terminal } from '@xterm/xterm';

/**
 * Typed access to the xterm 5.5 internals MetroTerm relies on (render dimensions, the DOM renderer,
 * the decoration service, the viewport). They are private API: every accessor returns `undefined`
 * instead of throwing when a field is missing, so a future xterm only loses the dependent feature.
 */

/** Cell size as xterm lays the rows out: CSS px (may be fractional) and device px. */
export type RenderDimensions = {
  css: { cell: { width: number; height: number } };
  device: { cell: { width: number; height: number } };
};

type XtermCore = {
  _renderService?: { dimensions?: RenderDimensions; _renderer?: { value?: unknown } };
  _decorationService?: unknown;
  viewport?: { scrollBarWidth?: number };
};

const core = (terminal: Terminal) => (terminal as unknown as { _core?: XtermCore })._core;

export const renderDimensions = (terminal: Terminal) => core(terminal)?._renderService?.dimensions;

/** The active renderer (MetroTerm always uses xterm's DOM renderer); `T` describes the fields used. */
export const activeRenderer = <T>(terminal: Terminal) => core(terminal)?._renderService?._renderer?.value as T | undefined;

export const decorationService = <T>(terminal: Terminal) => core(terminal)?._decorationService as T | undefined;

export const xtermViewport = (terminal: Terminal) => core(terminal)?.viewport;
