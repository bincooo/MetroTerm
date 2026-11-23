/**
 * WebGL contexts for the terminals' renderers (one per terminal).
 *
 * Browsers keep only so many live WebGL contexts (Chromium and WebKit: 16) and drop the oldest when
 * a new one is created. With many panes and tabs that turned into a loop: a dropped renderer was
 * restarted, which dropped another one, and so on (most of the CPU spent creating contexts), and
 * every hidden terminal held a context and its glyph atlas in GPU memory.
 *
 * So the terminals share a budget of MAX_CONTEXTS:
 * - a terminal gets a context when it is shown and gives it back when it has been hidden a while
 *   (TerminalView), or right away when a shown terminal needs one and the budget is spent;
 * - with every context in use by terminals on screen, a further one waits with xterm's DOM renderer
 *   and gets WebGL as soon as a context is given back;
 * - a released renderer's context is lost explicitly (WEBGL_lose_context): otherwise it stays alive
 *   until garbage collection and still counts against the browser's limit.
 */

/** Below the browsers' 16, leaving room for other WebGL users. */
const MAX_CONTEXTS = 12;

export type WebglSlot = {
  /** On screen now (hidden tabs / windows / panes have no size). */
  visible: () => boolean;
  /** Give the context back (dispose the renderer); must call `releaseWebgl(slot)`. */
  release: () => void;
  /** A context is free again: try to start the renderer. */
  retry: () => void;
  /** When it was last on screen (the longest hidden one is released first). */
  lastShown: number;
};

const live = new Set<WebglSlot>();
const waiting = new Set<WebglSlot>();

/** May this terminal create a WebGL renderer now? false = wait (it is retried when one is free). */
export function acquireWebgl(slot: WebglSlot): boolean {
  if (live.has(slot)) return true;
  if (live.size >= MAX_CONTEXTS) {
    const hidden = [...live].filter(item => !item.visible()).sort((a, b) => a.lastShown - b.lastShown)[0];
    hidden?.release();
  }
  if (live.size >= MAX_CONTEXTS) {
    waiting.add(slot);
    return false;
  }
  waiting.delete(slot);
  live.add(slot);
  return true;
}

/** The renderer is gone (released, lost, failed or the terminal closed). */
export function releaseWebgl(slot: WebglSlot) {
  waiting.delete(slot);
  if (!live.delete(slot)) return;
  // Next one on screen that waits — after the current call stack (the caller may be taking the slot).
  queueMicrotask(() => {
    const next = [...waiting].find(item => item.visible());
    if (next && live.size < MAX_CONTEXTS) {
      waiting.delete(next);
      next.retry();
    }
  });
}

/**
 * Lose the WebGL contexts of a disposed renderer's canvases now (xterm's dispose only removes
 * them from the page). `getContext` returns the canvas's existing context; 2D canvases give null.
 */
export function loseContexts(canvases: HTMLCanvasElement[]) {
  for (const canvas of canvases) {
    try {
      const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
      if (gl && !gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* not a WebGL canvas */
    }
  }
}
