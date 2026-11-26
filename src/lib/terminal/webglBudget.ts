/**
 * WebGL contexts for the terminal renderers. Browsers keep ~16 live contexts and drop the oldest when
 * a new one is created; with many terminals that became a restart loop. So terminals share MAX_CONTEXTS:
 * a context is taken when shown and given back after being hidden a while (or at once when a shown
 * terminal needs one); a terminal left without one uses the DOM renderer until one is free. Released
 * contexts are lost explicitly (WEBGL_lose_context), else they count until garbage collection.
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
