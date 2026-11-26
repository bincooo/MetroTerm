import type { IBuffer, IBufferCell } from '@xterm/xterm';

/**
 * Logical lines of an xterm buffer: a line the shell printed can take several rows when it is
 * longer than the terminal is wide (soft wrap, `isWrapped` on the continuation rows). Shared by the
 * gutter, the same-text marks, find and the right-click menu.
 */

/** First buffer row of the logical line that contains `row`. */
export const lineStart = (buffer: IBuffer, row: number) => {
  let start = row;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  return start;
};

/** Number of rows of the logical line starting at `start`. */
export const lineRows = (buffer: IBuffer, start: number) => {
  let rows = 1;
  while (start + rows < buffer.length && buffer.getLine(start + rows)?.isWrapped) rows++;
  return rows;
};

/** Plain text of the logical line starting at `start` (trailing blanks of each row dropped, as xterm copies it). */
export const lineText = (buffer: IBuffer, start: number) => {
  let text = buffer.getLine(start)?.translateToString(true) ?? '';
  for (let row = start + 1; row < buffer.length && buffer.getLine(row)?.isWrapped; row++)
    text += buffer.getLine(row)?.translateToString(true) ?? '';
  return text;
};

/** A logical line with the cell of every UTF-16 unit of its text (row, column, cell width). */
type CellLine = { text: string; rows: number[]; cols: number[]; widths: number[]; end: number };

let cell: IBufferCell | undefined;

/**
 * Text of the logical line starting at `start`, mapped back to cells: wide characters (CJK) take two
 * cells — the second has width 0 and is skipped — so string offsets and columns differ. Trailing
 * blanks of the last row are not text; a wrapped row keeps them (they are content). `end` = the row
 * after the line.
 */
export function cellLine(buffer: IBuffer, start: number): CellLine {
  let text = '';
  const rows: number[] = [];
  const cols: number[] = [];
  const widths: number[] = [];
  let row = start;
  do {
    const line = buffer.getLine(row);
    if (!line) break;
    let rowText = '';
    let lastContent = 0;
    const rowCols: number[] = [];
    const rowWidths: number[] = [];
    for (let x = 0; x < line.length; x++) {
      cell = line.getCell(x, cell);
      if (!cell) break;
      const width = cell.getWidth();
      if (width === 0) continue;
      const chars = cell.getChars();
      const unit = chars || ' ';
      for (let k = 0; k < unit.length; k++) {
        rowCols.push(x);
        rowWidths.push(width);
      }
      rowText += unit;
      if (chars) lastContent = rowText.length;
    }
    const keep = buffer.getLine(row + 1)?.isWrapped ? rowText.length : lastContent;
    text += rowText.slice(0, keep);
    for (let i = 0; i < keep; i++) {
      rows.push(row);
      cols.push(rowCols[i]);
      widths.push(rowWidths[i]);
    }
    row++;
  } while (row < buffer.length && buffer.getLine(row)?.isWrapped);
  return { text, rows, cols, widths, end: row };
}

/** Cells covered by text[at, at + length): one segment per row. */
export function cellSegments(line: CellLine, at: number, length: number) {
  const segments: { row: number; x: number; width: number }[] = [];
  for (let i = at; i < at + length; i++) {
    const last = segments[segments.length - 1];
    if (last && last.row === line.rows[i]) last.width = line.cols[i] + line.widths[i] - last.x;
    else segments.push({ row: line.rows[i], x: line.cols[i], width: line.widths[i] });
  }
  return segments;
}
