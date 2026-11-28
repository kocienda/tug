/**
 * `enhance-arc-statement` — the frame a `tugarcs` fence wears.
 *
 * A `tugarcs` fence states a run of arcs: tugcast queues them on their cycle
 * when the answer ends, and the card draws the fence as that run, one row per
 * arc — its label, its brief, where it stands, and the command that opens it
 * while it still waits to be opened. JSON is not what the reader came for, so
 * a fence that parses never shows it.
 *
 * The fence stays a `<pre><code class="language-tugarcs">` in the DOM, hidden
 * inside the frame. That is what lets every reader of a fence go on reading
 * this one: the selection serializer and Find find its text where they always
 * do, and a copy writes the spec, not the rows.
 *
 * The brief is an inline `<code>`, so the annotation pass rules it as the file
 * atom a backticked path in prose becomes: the annotator descends into every
 * `<code>` that is not a fence's.
 *
 * Built by {@link enhanceFencedCode} on every pass over a block, so the frame
 * holds no state: a row's state is empty and its command hidden until a
 * surface that can read the cycle syncs it with {@link syncArcStatementFrame}.
 * A spec that does not parse — a fence still streaming, or a mistake — builds
 * nothing, and the fence falls through to the ordinary code chrome.
 *
 * Laws: [L06] appearance via DOM and CSS, not React state.
 *
 * @module lib/markdown/enhance-arc-statement
 */

import "./enhance-arc-statement.css";

import { buildCopyButton } from "./enhance-block-chrome";
import { arcCommandText, parseArcStatement, type ArcRowReading } from "@/lib/arc-statement";

/** The fence language that states a run of arcs. */
export const ARC_STATEMENT_LANG = "tugarcs";

/** The language a statement is written out under in Markdown. */
export const ARC_STATEMENT_JSON_LANG = "json";

/** Whether a fence's language states a run of arcs. */
export function isArcStatementLang(lang: string | null): boolean {
  return lang !== null && lang.toLowerCase() === ARC_STATEMENT_LANG;
}

/** The class of a statement's frame; an enhanced statement's `<pre>` sits inside one. */
export const ARC_STATEMENT_CLASS = "tugx-md-arcs";

/** The class of one arc's row. */
export const ARC_STATEMENT_ROW_CLASS = "tugx-md-arcs-row";

/** The class of the rows' container, whose text is the frame's and never the fence's. */
export const ARC_STATEMENT_ROWS_CLASS = "tugx-md-arcs-rows";

const STATE_CLASS = "tugx-md-arcs-state";
const COMMAND_CLASS = "tugx-md-arcs-command";

/**
 * Wrap a statement's `<pre>` in its frame. Returns false, touching nothing,
 * when the fence's text is not a spec that can be drawn.
 */
export function buildArcStatementFrame(pre: HTMLElement, codeEl: HTMLElement): boolean {
  const parsed = parseArcStatement(codeEl.textContent ?? "");
  if ("error" in parsed) return false;

  const frame = document.createElement("div");
  frame.className = ARC_STATEMENT_CLASS;

  const rows = document.createElement("div");
  rows.className = ARC_STATEMENT_ROWS_CLASS;
  for (const arc of parsed.arcs) {
    const row = document.createElement("div");
    row.className = ARC_STATEMENT_ROW_CLASS;
    row.dataset.arc = arc.name;

    const label = document.createElement("span");
    label.className = "tugx-md-arcs-label";
    label.textContent = arc.label ?? arc.name;

    const brief = document.createElement("span");
    brief.className = "tugx-md-arcs-brief";
    const briefCode = document.createElement("code");
    briefCode.textContent = arc.brief;
    brief.appendChild(briefCode);

    const state = document.createElement("span");
    state.className = STATE_CLASS;

    const command = document.createElement("span");
    command.className = COMMAND_CLASS;
    command.hidden = true;
    const commandCode = document.createElement("code");
    const text = arcCommandText(arc);
    commandCode.textContent = text;
    command.appendChild(commandCode);
    command.appendChild(buildCopyButton(() => text, "Copy command"));

    row.append(label, brief, state, command);
    rows.appendChild(row);
  }

  pre.hidden = true;
  // The frame takes the `<pre>`'s slot first, then the `<pre>` moves into
  // it, so the document never briefly loses the block.
  pre.replaceWith(frame);
  frame.appendChild(pre);
  frame.appendChild(rows);
  return true;
}

/** Every statement frame in a container, in document order. */
export function arcStatementFrames(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`.${ARC_STATEMENT_CLASS}`));
}

/**
 * Write each row of `frame` from `read`: its `data-state`, its word, and
 * whether its command shows. A value already written is not written again.
 */
export function syncArcStatementFrame(frame: HTMLElement, read: (name: string) => ArcRowReading): void {
  for (const row of frame.querySelectorAll<HTMLElement>(`.${ARC_STATEMENT_ROW_CLASS}`)) {
    const name = row.dataset.arc;
    if (name === undefined) continue;
    const reading = read(name);
    if (row.dataset.state !== reading.state) row.dataset.state = reading.state;
    const state = row.querySelector<HTMLElement>(`.${STATE_CLASS}`);
    if (state !== null && state.textContent !== reading.word) state.textContent = reading.word;
    const command = row.querySelector<HTMLElement>(`.${COMMAND_CLASS}`);
    if (command !== null && command.hidden === reading.command) command.hidden = !reading.command;
  }
}
