import { useLayoutEffect, useRef, useState } from 'react';

/**
 * A pane's letter (A, B, C …) in its toolbar, optically centred on the same point as the icons
 * beside it. Centring the text box does not do that: where a capital sits in its line box depends on
 * the font's ascent / descent, which differ between the fonts the UI may end up with (the letter was
 * a pixel high on one system and half a pixel low on another). So the glyph's own ink is measured
 * (canvas `measureText`, same computed font) and drawn as SVG text with its ink centred at 12.5px —
 * where the 14px icons in their 26px buttons have theirs (strokes 1..12 of 16, offset 6).
 */
const BOX = 26;
const INK_CENTRE = 12.5;
let canvas: HTMLCanvasElement | null = null;

export function PaneLetter({ letter, focused, title }: { letter: string; focused: boolean; title: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState({ x: BOX / 2, y: 17 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let live = true;
    const place = () => {
      if (!live) return;
      const style = getComputedStyle(element);
      canvas ??= document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) return;
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const ink = context.measureText(letter);
      // Ink spans [x - left, x + right] and [y - ascent, y + descent] around the text's origin.
      const x = INK_CENTRE - (ink.actualBoundingBoxRight - ink.actualBoundingBoxLeft) / 2;
      const y = INK_CENTRE + (ink.actualBoundingBoxAscent - ink.actualBoundingBoxDescent) / 2;
      setAt(current => (current.x === x && current.y === y ? current : { x, y }));
    };
    place();
    // The UI font may still be loading on the first render.
    void document.fonts?.ready.then(place);
    return () => {
      live = false;
    };
  }, [letter, focused]);
  return (
    <span ref={ref} className="tmux-letter" title={title} role="img" aria-label={title}>
      <svg width={BOX} height={BOX} viewBox={`0 0 ${BOX} ${BOX}`} aria-hidden="true">
        <text x={at.x} y={at.y} fill="currentColor">
          {letter}
        </text>
      </svg>
    </span>
  );
}
