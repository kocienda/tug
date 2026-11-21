/**
 * `applyCarriageReturns` — read a carriage return as a redraw of its line.
 *
 * A command's output arrives as the bytes it wrote, so a progress line a
 * script redraws with `\r` is one long line holding every value it ever
 * showed. A terminal shows only the last of them. This does the same: on
 * each line, what follows the last carriage return replaces what came
 * before it.
 *
 * Two shapes keep their text. A line that ends in `\r` (`\r\n` line endings,
 * or a redraw whose next value has not been written yet) keeps the value
 * before it, so a line never blanks between two redraws. And a redraw
 * replaces the whole line, whatever the lengths of the two values: columns
 * are not counted, because the line may carry colour escapes that take no
 * column.
 *
 * Pure, and applied wherever output is shown or shared, so the running
 * block, the settled block, Find and a result added to context all read the
 * same text.
 *
 * @module lib/ansi/carriage-return
 */

/** Resolve each line of `text` to what a terminal would be showing on it. */
export function applyCarriageReturns(text: string): string {
  if (text.indexOf("\r") === -1) return text;
  return text
    .split("\n")
    .map((line) => {
      if (line.indexOf("\r") === -1) return line;
      const drawn = line.split("\r");
      for (let i = drawn.length - 1; i >= 0; i--) {
        if (drawn[i] !== "") return drawn[i];
      }
      return "";
    })
    .join("\n");
}
