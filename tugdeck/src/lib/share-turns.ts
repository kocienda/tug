/**
 * share-turns.ts — the pure core of sharing turns from a Session card.
 *
 * The user marks turns, and an output is made from exactly those: a
 * Markdown document, or a rendering through the card's own transcript cells.
 * Everything here is a data transform with no store, no DOM and no React:
 *
 *  - the **selection edits** — a click toggles a turn, a shift-click extends
 *    from the anchor across the selectable turns in transcript order;
 *  - the **slice** — the selected turns, deep-copied, with thinking removed
 *    and tool calls kept or dropped by the tool mode;
 *  - the **strings walk** — every string an output will show, collected for
 *    the one scrub request and put back from its answer;
 *  - the **header** — title, project name, dates, and the turn numbers the
 *    turns have in the card;
 *  - the **signature** that gates Copy, Save… and Share… on a preview of
 *    exactly what would leave;
 *  - the **Markdown**, which `/export` writes through too, and the decoder
 *    for the document the render page receives.
 *
 * A turn is the unit: nothing selects part of one. Every turn is selectable,
 * whoever it is from — the user, Claude, the wheel, or an ink turn (`shell`,
 * `refs`), the record of something the user ran. An ink turn's command and
 * output ride the scrub like any other text, the Markdown writes it as a
 * fenced block, and the render page draws it through the card's own cell.
 *
 * @module lib/share-turns
 */

import type {
  CodeSessionSnapshot,
  Message,
  ToolUseMessage,
  TurnEntry,
} from "@/lib/code-session-store/types";
import { isInkOrigin } from "@/lib/code-session-store/types";
import type { SessionIdentity } from "@/lib/session-identity";
import { sessionDisplayTitle } from "@/lib/session-identity";
import { stripAnsi } from "@/lib/ansi/strip-ansi";
import { composeShellShareText } from "@/lib/shell-share";
import { turnNumberAt } from "@/lib/session-transcript-data-source";
import { turnEntryToMarkdown } from "@/lib/turn-entry-markdown";
import type { ToolCallMode } from "@/lib/turn-entry-markdown";

export { toolCallSummaryLine } from "@/lib/turn-entry-markdown";

/** How a share writes tool calls; `summaries` is the default. */
export type ShareToolMode = ToolCallMode;

/** The three outputs a share makes. */
export type ShareFormat = "markdown" | "pdf" | "png";

const TOOL_MODES: ReadonlySet<string> = new Set(["summaries", "full", "none"]);

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** The marked turns, by `turnKey`, and the anchor a shift-click extends from. */
export interface ShareSelection {
  selected: ReadonlySet<string>;
  anchor: string | null;
}

/** The selectable turns' keys — every committed turn's — in transcript order. */
export function selectableTurnKeys(transcript: ReadonlyArray<TurnEntry>): string[] {
  return transcript.map((turn) => turn.turnKey);
}

/** Toggle `key`'s mark, and make it the anchor. */
export function toggleTurn(state: ShareSelection, key: string): ShareSelection {
  const selected = new Set(state.selected);
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  return { selected, anchor: key };
}

/**
 * Select every key between the anchor and `key`, inclusive, in `order` (the
 * selectable turn keys in transcript order), adding to what is already
 * selected. The anchor does not move, so a second shift-click re-extends from
 * the same place. With no anchor — or one no longer in `order` — the click is
 * a toggle, which sets the anchor.
 */
export function extendTo(
  state: ShareSelection,
  key: string,
  order: ReadonlyArray<string>,
): ShareSelection {
  const from = state.anchor === null ? -1 : order.indexOf(state.anchor);
  const to = order.indexOf(key);
  if (from === -1 || to === -1) return toggleTurn(state, key);
  const selected = new Set(state.selected);
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  for (let i = lo; i <= hi; i += 1) selected.add(order[i]);
  return { selected, anchor: state.anchor };
}

// ---------------------------------------------------------------------------
// The slice
// ---------------------------------------------------------------------------

/**
 * The selected turns in transcript order — whatever order the set was built
 * in — deep-copied so the live transcript is never touched, with every
 * `assistant_thinking` message removed, and under `none` every `tool_use`
 * message removed. `summaries` and `full` keep the tool calls: the render
 * page shows them collapsed or open ({@link shareExpansionOverrides}), and
 * the Markdown writes them as lines or sections. An ink turn's one message
 * is kept whole.
 */
export function buildShareSlice(
  transcript: ReadonlyArray<TurnEntry>,
  selected: ReadonlySet<string>,
  toolMode: ShareToolMode,
): TurnEntry[] {
  const slice: TurnEntry[] = [];
  for (const turn of transcript) {
    if (!selected.has(turn.turnKey)) continue;
    const copy = structuredClone(turn) as TurnEntry;
    const messages = copy.messages.filter(
      (m) =>
        m.kind !== "assistant_thinking" && !(toolMode === "none" && m.kind === "tool_use"),
    );
    slice.push({ ...copy, messages });
  }
  return slice;
}

/**
 * The tool blocks' collapsed state on the render page, by `toolUseId`, in the
 * shape a `ToolBlockExpansionState` restores: `true` (collapsed, header only)
 * for every top-level call under `summaries`, `false` (open) under `full`, and
 * nothing under `none`, whose slice holds no calls. A subagent's child calls
 * draw inside their parent's block and take no override.
 */
export function shareExpansionOverrides(
  turns: ReadonlyArray<TurnEntry>,
  toolMode: ShareToolMode,
): Record<string, boolean> {
  const overrides: Record<string, boolean> = {};
  if (toolMode === "none") return overrides;
  for (const turn of turns) {
    for (const m of turn.messages) {
      if (m.kind === "tool_use" && m.parentToolUseId === undefined) {
        overrides[m.toolUseId] = toolMode === "summaries";
      }
    }
  }
  return overrides;
}

// ---------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------

/** The facts that open every share output ([B10]). */
export interface ShareHeader {
  title: string;
  /** The project's leaf name, never its path. */
  project: string;
  /** One local date, or `first – last`. */
  dates: string;
  /** The selected turns' numbers, as ranges: `#3–5, #9`. */
  turns: string;
}

/** `[3, 4, 5, 9]` → `#3–5, #9`; sorted and de-duplicated first. */
export function compressTurnNumbers(numbers: ReadonlyArray<number>): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const runs: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    runs.push(i === j ? `#${sorted[i]}` : `#${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return runs.join(", ");
}

/** A wall-clock ms as a local `YYYY-MM-DD`. */
function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The header for the selected turns of `transcript`: the session's display
 * title and project leaf from `identity`, the local date of the first selected
 * turn's end (or `first – last` when the last differs), and the selected
 * conversation turns' numbers as the card shows them ({@link turnNumberAt}
 * over `snapshot`), compressed to ranges. An ink turn is dated but not
 * numbered there: its `#s`/`#r` address is its own sequence, not a turn's.
 */
export function shareHeader(input: {
  identity: SessionIdentity;
  transcript: ReadonlyArray<TurnEntry>;
  selected: ReadonlySet<string>;
  snapshot: CodeSessionSnapshot;
}): ShareHeader {
  const { identity, transcript, selected, snapshot } = input;
  const numbers: number[] = [];
  const ends: number[] = [];
  transcript.forEach((turn, index) => {
    if (!selected.has(turn.turnKey)) return;
    if (!isInkOrigin(turn.origin)) numbers.push(turnNumberAt(snapshot, index));
    ends.push(turn.endedAt);
  });
  let dates = "";
  if (ends.length > 0) {
    const first = localDate(ends[0]);
    const last = localDate(ends[ends.length - 1]);
    dates = first === last ? first : `${first} – ${last}`;
  }
  return {
    title: sessionDisplayTitle(identity),
    project: identity.project,
    dates,
    turns: compressTurnNumbers(numbers),
  };
}

// ---------------------------------------------------------------------------
// The strings walk
// ---------------------------------------------------------------------------

/** `value` with every string inside it, at any depth, passed through `f`. */
function mapStrings(value: unknown, f: (s: string) => string): unknown {
  if (typeof value === "string") return f(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, f));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = mapStrings(item, f);
    return out;
  }
  return value;
}

/**
 * One message with every string an output shows passed through `f`, in a
 * fixed order: a user message's text and its attachments' labels, values
 * and session references; prose and note text; a tool call's input, result
 * and structured result, recursively. Identity strings — keys, kinds, ids —
 * are left alone.
 */
function mapMessageStrings(m: Message, f: (s: string) => string): Message {
  switch (m.kind) {
    case "user_message":
      return {
        ...m,
        text: f(m.text),
        attachments: m.attachments.map((atom) => ({
          ...atom,
          label: f(atom.label),
          value: f(atom.value),
          ...(atom.session !== undefined
            ? { session: mapStrings(atom.session, f) as typeof atom.session }
            : {}),
        })),
      };
    case "assistant_text":
    case "assistant_thinking":
      return { ...m, text: f(m.text) };
    case "system_note":
      // A boundary draws its facts, not its text: a relocation's two
      // directories, a stage's document, a replay's paths and worktree. They
      // reach the rendered page as written, so they ride the walk too.
      return {
        ...m,
        text: f(m.text),
        ...(m.relocation !== undefined
          ? { relocation: mapStrings(m.relocation, f) as typeof m.relocation }
          : {}),
        ...(m.stageFacts !== undefined
          ? { stageFacts: mapStrings(m.stageFacts, f) as typeof m.stageFacts }
          : {}),
        ...(m.noticeFacts !== undefined
          ? { noticeFacts: mapStrings(m.noticeFacts, f) as typeof m.noticeFacts }
          : {}),
        ...(m.command !== undefined ? { command: f(m.command) } : {}),
      };
    case "tool_use":
      return {
        ...m,
        input: mapStrings(m.input, f),
        result: mapStrings(m.result, f),
        structuredResult: mapStrings(m.structuredResult, f),
      } as ToolUseMessage;
    case "shell_exchange":
      // What the row shows: the command, its output and the directory it ran
      // in, before and after.
      return {
        ...m,
        command: f(m.command),
        output: f(m.output),
        cwd: f(m.cwd),
        ...(m.cwdAfter !== null ? { cwdAfter: f(m.cwdAfter) } : {}),
      };
    case "refs_result":
      // The command, the root every path is relative to, each ref's path and
      // matched-line windows, and any notice.
      return {
        ...m,
        command: f(m.command),
        root: f(m.root),
        refs: mapStrings(m.refs, f) as typeof m.refs,
        ...(m.notice !== null ? { notice: f(m.notice) } : {}),
      };
    default:
      return m;
  }
}

/** The one walk both halves of the round trip ride, so their order agrees. */
function walkShare(
  slice: ReadonlyArray<TurnEntry>,
  header: ShareHeader | null,
  f: (s: string) => string,
): { slice: TurnEntry[]; header: ShareHeader | null } {
  const nextHeader = header === null ? null : { ...header, title: f(header.title) };
  const nextSlice = slice.map((turn) => ({
    ...turn,
    messages: turn.messages.map((m) => mapMessageStrings(m, f)),
  }));
  return { slice: nextSlice, header: nextHeader };
}

/** Every string the outputs will show, in walk order: the header's title first. */
export function collectShareStrings(
  slice: ReadonlyArray<TurnEntry>,
  header: ShareHeader | null,
): string[] {
  const texts: string[] = [];
  walkShare(slice, header, (s) => {
    texts.push(s);
    return s;
  });
  return texts;
}

/**
 * `slice` and `header` with their strings replaced, in walk order, by
 * `texts` — the scrub answer to {@link collectShareStrings}. Returns `null`
 * when `texts` is not exactly as long as the walk, so a short answer can
 * never leave a string unscrubbed.
 */
export function applyShareStrings(
  slice: ReadonlyArray<TurnEntry>,
  header: ShareHeader | null,
  texts: ReadonlyArray<string>,
): { slice: TurnEntry[]; header: ShareHeader | null } | null {
  if (texts.length !== collectShareStrings(slice, header).length) return null;
  let i = 0;
  return walkShare(slice, header, () => texts[i++]);
}

// ---------------------------------------------------------------------------
// The signature
// ---------------------------------------------------------------------------

/**
 * What a preview was of: the selected turn keys (sorted, so the order a set
 * was built in does not matter), the tool mode and the format. Copy, Save…
 * and Share… are open exactly when the last preview's signature equals the
 * current one.
 */
export function shareSignature(state: {
  selected: ReadonlySet<string>;
  toolMode: ShareToolMode;
  format: ShareFormat;
}): string {
  return JSON.stringify([[...state.selected].sort(), state.toolMode, state.format]);
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** The first `user_message` text in a turn, or `null` if it opens otherwise. */
function turnPrompt(turn: TurnEntry): string | null {
  for (const m of turn.messages) {
    if (m.kind === "user_message") return m.text;
  }
  return null;
}

/** The header's facts line: `<project> · <dates> · turns <turns>`, empties left out. */
function factsLine(header: ShareHeader): string {
  const parts: string[] = [];
  if (header.project.length > 0) parts.push(header.project);
  if (header.dates.length > 0) parts.push(header.dates);
  if (header.turns.length > 0) parts.push(`turns ${header.turns}`);
  return parts.join(" · ");
}

/**
 * `turns` as one Markdown document: each turn's prompt under `## You` and
 * the assistant's tool calls and prose under `## Claude`, a side with nothing
 * leaving its heading out, tool calls written by `toolMode`.
 *
 * With `header: null` the document opens `# Session transcript` — the
 * `/export` archive, whose bytes this must keep. With a header it opens
 * `# <title>` and one line of facts, a wheel's prompt is headed `## Wheel`,
 * and an ink turn is written too, as the fenced block its row shows: a shell
 * exchange under `## Shell`, ANSI stripped and nothing capped, and a refs run
 * under `## Refs`.
 */
export function shareDocumentMarkdown(input: {
  turns: ReadonlyArray<TurnEntry>;
  toolMode: ShareToolMode;
  header: ShareHeader | null;
}): string {
  const { turns, toolMode, header } = input;
  const sections: string[] = [];
  if (header === null) {
    sections.push("# Session transcript");
  } else {
    sections.push(`# ${header.title}`);
    const facts = factsLine(header);
    if (facts.length > 0) sections.push(facts);
  }
  for (const turn of turns) {
    if (header !== null && isInkOrigin(turn.origin)) {
      const ink = inkTurnMarkdown(turn);
      if (ink !== null) sections.push(ink);
      continue;
    }
    const prompt = turnPrompt(turn);
    if (prompt !== null && prompt.trim().length > 0) {
      const speaker = header !== null && turn.origin === "wheel" ? "Wheel" : "You";
      sections.push(`## ${speaker}\n\n${prompt.trim()}`);
    }
    const assistant = turnEntryToMarkdown(turn, { toolMode });
    if (assistant.length > 0) {
      sections.push(`## Claude\n\n${assistant}`);
    }
  }
  return `${sections.join("\n\n")}\n`;
}

/** A fence longer than any backtick run in `body`, around it. */
function fenced(body: string): string {
  const longestRun = body.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${body}\n${fence}`;
}

/**
 * An ink turn's section: a shell exchange as `$ command`, its whole output
 * and its exit, the text Add to Context composes uncapped; a refs run as its
 * command and one line per ref. `null` for a turn whose message is neither.
 */
function inkTurnMarkdown(turn: TurnEntry): string | null {
  const m = turn.messages[0];
  if (m?.kind === "shell_exchange") {
    const text = composeShellShareText({ ...m, output: stripAnsi(m.output) }, Number.POSITIVE_INFINITY);
    return `## Shell\n\n${text.trimEnd()}`;
  }
  if (m?.kind === "refs_result") {
    const lines = [m.command];
    for (const ref of m.refs) {
      const at = ref.line === null ? ref.path : `${ref.path}:${ref.line}`;
      const preview = ref.preview?.segments.map((s) => s.text).join("…").trim() ?? "";
      lines.push(preview === "" ? at : `${at}: ${preview}`);
    }
    if (m.notice !== null && m.notice !== "") lines.push(m.notice);
    return `## Refs\n\n${fenced(lines.join("\n"))}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The render document
// ---------------------------------------------------------------------------

/** The width, in CSS pixels, a share renders at. */
export const SHARE_RENDER_WIDTH = 720;

/** What the render page receives: everything it draws, and nothing else. */
export interface ShareRenderDocument {
  version: 1;
  /** The theme the requesting page was showing. */
  theme: string;
  width: typeof SHARE_RENDER_WIDTH;
  header: ShareHeader;
  toolMode: ShareToolMode;
  modelName: string | null;
  /** The scrubbed slice. */
  turns: TurnEntry[];
  /** Each turn's number in the card, parallel to `turns`. */
  turnNumbers: number[];
}

/**
 * The number each slice turn wears in the card, parallel to `slice`: for a
 * conversation turn, the number {@link turnNumberAt} gives its place in
 * `transcript` over `snapshot`, so a pick of #3 and #9 renders as #3 and #9;
 * for an ink turn, its place in its own `#s` or `#r` sequence — the count of
 * its origin's turns up to it, as the card's row layout counts them. A slice
 * turn the transcript does not hold (never, for a slice built from it) reads
 * `0`.
 */
export function shareTurnNumbers(
  slice: ReadonlyArray<TurnEntry>,
  transcript: ReadonlyArray<TurnEntry>,
  snapshot: CodeSessionSnapshot,
): number[] {
  const indexByKey = new Map<string, number>();
  const inkOrdinalByKey = new Map<string, number>();
  let shell = 0;
  let refs = 0;
  transcript.forEach((turn, index) => {
    indexByKey.set(turn.turnKey, index);
    if (turn.origin === "shell") inkOrdinalByKey.set(turn.turnKey, (shell += 1));
    else if (turn.origin === "refs") inkOrdinalByKey.set(turn.turnKey, (refs += 1));
  });
  return slice.map((turn) => {
    const ink = inkOrdinalByKey.get(turn.turnKey);
    if (ink !== undefined) return ink;
    const index = indexByKey.get(turn.turnKey);
    return index === undefined ? 0 : turnNumberAt(snapshot, index);
  });
}

/** The render document for a (scrubbed) slice and its header. */
export function buildShareRenderDocument(input: {
  theme: string;
  header: ShareHeader;
  toolMode: ShareToolMode;
  modelName: string | null;
  slice: TurnEntry[];
  turnNumbers: number[];
}): ShareRenderDocument {
  return {
    version: 1,
    theme: input.theme,
    width: SHARE_RENDER_WIDTH,
    header: input.header,
    toolMode: input.toolMode,
    modelName: input.modelName,
    turns: input.slice,
    turnNumbers: input.turnNumbers,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Decode a render document from its JSON. A wrong version or any shape
 * mismatch is `null`: the page then posts nothing, and the host's deadline
 * answers the render as failed.
 */
export function decodeShareRenderDocument(json: string): ShareRenderDocument | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.version !== 1) return null;
  if (typeof value.theme !== "string") return null;
  if (value.width !== SHARE_RENDER_WIDTH) return null;
  const header = value.header;
  if (
    !isRecord(header) ||
    typeof header.title !== "string" ||
    typeof header.project !== "string" ||
    typeof header.dates !== "string" ||
    typeof header.turns !== "string"
  ) {
    return null;
  }
  if (typeof value.toolMode !== "string" || !TOOL_MODES.has(value.toolMode)) return null;
  if (value.modelName !== null && typeof value.modelName !== "string") return null;
  if (!Array.isArray(value.turns) || !Array.isArray(value.turnNumbers)) return null;
  if (value.turns.length !== value.turnNumbers.length) return null;
  for (const turn of value.turns) {
    if (
      !isRecord(turn) ||
      typeof turn.turnKey !== "string" ||
      typeof turn.origin !== "string" ||
      !Array.isArray(turn.messages)
    ) {
      return null;
    }
  }
  if (!value.turnNumbers.every((n) => typeof n === "number" && Number.isInteger(n))) return null;
  return value as unknown as ShareRenderDocument;
}
