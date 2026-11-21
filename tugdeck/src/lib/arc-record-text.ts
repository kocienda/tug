/**
 * arc-record-text.ts — an arc's idea or sketch record, read into the blocks
 * a panel draws.
 *
 * A record is plain text in one of two shapes: sentences, or a sentence and
 * a short list under it. A line that opens with `- ` or `* ` is a list item,
 * and a run of them is one list; any other run of lines is a paragraph, its
 * lines joined by a space. Blank lines part the blocks. Nothing else is
 * read: a record carries no emphasis, no code and no headings. Pure: no IO
 * and no DOM.
 *
 * @module lib/arc-record-text
 */

/** One block of a record: sentences, or a list of short items. */
export type ArcRecordBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] };

const ITEM = /^\s*[-*]\s+(.*)$/;

/** The blocks of a record's text, in the order written. */
export function parseArcRecord(text: string): ArcRecordBlock[] {
  const blocks: ArcRecordBlock[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    if (items.length > 0) blocks.push({ kind: "list", items });
    paragraph = [];
    items = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    const item = ITEM.exec(line);
    if (item !== null) {
      // A list under a paragraph ends the paragraph.
      if (paragraph.length > 0) flush();
      if (item[1].trim() !== "") items.push(item[1].trim());
      continue;
    }
    if (items.length > 0) {
      // A line under an item that is not an item continues it.
      items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`;
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
