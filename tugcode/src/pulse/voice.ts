/**
 * voice — the PULSE strip as the machine thinking out loud.
 *
 * The strip shows the worker's running monologue, verbatim from the
 * wire: `assistant_text` frames carry the interstitial narration the
 * assistant writes between tool calls ("Now checking how the reducer
 * handles task transitions…", "That didn't work — re-reading the
 * file."). The voice mirror surfaces the latest settled thought while
 * the turn works, says `done` when the turn completes (`stopped` when
 * cancelled), and goes quiet when the user submits (the deck clears
 * the strip per scope).
 *
 * In the machine's own words — so there is nothing to fabricate, no
 * second model, no phrasing layer. Earlier architectures (a model
 * commentator, a status mirror, a notability latch) and why they
 * failed live in the spike README.
 *
 * Mechanics: text accumulates per `(msg_id, block_index)` under the
 * deck reducer's rule (partial appends, complete replaces); only the
 * NEWEST block speaks (the latest thought). Display extraction takes
 * the last complete sentence — or the in-progress tail once it is
 * long enough to read — RAW (the deck renders the markdown; the
 * daemon never rewrites the machine's words) and clipped to the
 * strip's single-line budget. Emission is change-driven and
 * throttled (~1s) by the flush loop so streaming deltas don't strobe
 * the strip. Every method takes explicit wall-clock ms.
 *
 * @module pulse/voice
 */

import type {
  AssistantText,
  CompactBoundary,
  OutboundMessage,
  ToolInputProgress,
  ToolUse,
  TurnCancelled,
  TurnComplete,
} from "../types";

/** Minimum spacing between monologue updates per scope. */
export const VOICE_THROTTLE_MS = 1_000;
/** An in-progress thought this long may show before any sentence
 *  settles (marked with a streaming ellipsis). */
const PARTIAL_MIN_CHARS = 40;
/**
 * Minimum substance for a RETAINED intent — the high-level "this is
 * what I'm trying to do" line that rides along with a low-level tool
 * beat. A thought must read as a real clause to be worth pinning over
 * a whole tool chain; an interstitial beat ("Now the tests.") fails
 * both gates and the previous substantive intent survives instead.
 * Math is always substantial (an equation is a whole thought).
 */
export const INTENT_MIN_CHARS = 24;
export const INTENT_MIN_WORDS = 4;
/** Intent budget — tighter than {@link LINE_CLIP}: the intent shares
 *  the strip's single line with the action beat. */
const INTENT_CLIP = 160;
/** Raw-markdown budget per line. Generous: LaTeX source is several
 *  times wider than its rendered form, and the strip's CSS ellipsis
 *  owns VISUAL overflow — this cap only bounds wire/ledger rows. */
const LINE_CLIP = 300;
/** A math-only segment borrows a label this short from the segment
 *  before it ("**2. Gauss's Law** $$…$$"). */
const LABEL_MAX_CHARS = 80;
/** Scopes silent this long are swept. */
export const SCOPE_IDLE_SWEEP_MS = 30 * 60 * 1000;

/** One emitted voice line, scoped to its session. */
export interface VoiceLine {
  scope: string;
  text: string;
  /**
   * The retained high-level thought behind a low-level beat: the last
   * substantive monologue line, carried while a tool chain runs so the
   * strip can show "intent • action" instead of the action alone.
   * Absent when the text IS the monologue (it is its own intent) and
   * on turn-boundary markers.
   */
  intent?: string;
}

/** Token counts at strip scale: thousands above 1k, exact below. */
function formatTokens(tokens: number): string {
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : `${tokens}`;
}

/** Collapse whitespace to one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * `$…$` / `$$…$$` spans, conservatively matched (mirrors the deck's
 * inline-math walker grammar): `$$` pairs may span anything; single
 * `$` must hug its content (no space after the opener or before the
 * closer, no digit after the closer). Math is ATOMIC for extraction —
 * no sentence boundary and no clip point ever lands inside a span.
 */
export function findMathSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "$" || text[i - 1] === "\\") {
      i++;
      continue;
    }
    if (text[i + 1] === "$") {
      const close = text.indexOf("$$", i + 2);
      if (close === -1) break; // unclosed display math: no partial match
      spans.push({ start: i, end: close + 2 });
      i = close + 2;
      continue;
    }
    // Inline `$`: not followed by whitespace; closer not preceded by
    // whitespace, not followed by a digit.
    if (text[i + 1] === undefined || /\s/.test(text[i + 1])) {
      i++;
      continue;
    }
    let j = i + 1;
    let close = -1;
    while (j < text.length) {
      if (text[j] === "$" && text[j - 1] !== "\\" && !/\s/.test(text[j - 1]) && !/[0-9]/.test(text[j + 1] ?? "")) {
        close = j;
        break;
      }
      j++;
    }
    if (close === -1) {
      i++;
      continue;
    }
    spans.push({ start: i, end: close + 1 });
    i = close + 1;
  }
  return spans;
}

function insideSpan(index: number, spans: Array<{ start: number; end: number }>): boolean {
  return spans.some((s) => index >= s.start && index < s.end);
}

/** Does the text carry any math span? */
function hasMath(text: string): boolean {
  return findMathSpans(text).length > 0;
}

/**
 * Sentence boundaries OUTSIDE math spans, tolerating a closing
 * `)`/`"`, and skipping list enumerators ("2.") — an enumerator's dot
 * introduces an item; it never ends a thought.
 */
function sentenceEnds(text: string): number[] {
  const spans = findMathSpans(text);
  const ends: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    if (insideSpan(i, spans)) continue;
    // Enumerator: the token before the dot is digits only.
    let t = i - 1;
    while (t >= 0 && /[0-9]/.test(text[t])) t--;
    if (t < i - 1 && (t < 0 || text[t] === " " || text[t] === "*")) continue;
    let j = i + 1;
    if (text[j] === ")" || text[j] === '"' || text[j] === "\u201d") j++;
    // A bold/italic span may close right after the terminator
    // ("…the same thing.**") — the markers belong to the sentence.
    while (text[j] === "*") j++;
    if (j >= text.length || text[j] === " ") ends.push(j - 1);
  }
  return ends;
}

/** Drop one stray `**` when a slice ends up with an odd count — a
 *  literal double-asterisk is worse than losing one bold span. */
function balanceEmphasis(text: string): string {
  const count = (text.match(/\*\*/g) ?? []).length;
  if (count % 2 === 0) return text;
  const last = text.lastIndexOf("**");
  return oneLine(text.slice(0, last) + text.slice(last + 2));
}

/** A prose chunk worth pinning: a real clause, or any math at all. */
function isShowable(chunk: string): boolean {
  if (hasMath(chunk)) return true;
  return chunk.length >= 12 && chunk.includes(" ");
}

/**
 * A heading-style label that only introduces what follows — e.g. "Verified
 * behavior:" or "**What's next:**" — never a thought on its own. Trailing
 * emphasis markers and whitespace are stripped before the colon test.
 */
function isDanglingLabel(chunk: string): boolean {
  return /:\s*[*_\s]*$/.test(chunk);
}

/** A segment counts as settled when it ends like a finished thought. */
function endsSettled(segment: string): boolean {
  const t = segment.trimEnd();
  if (t.endsWith("$$")) return true;
  const last = t[t.length - 1];
  const beforeQuote = t[t.length - 2];
  if (last === "." || last === "!" || last === "?") return true;
  if ((last === ")" || last === '"') && (beforeQuote === "." || beforeQuote === "!" || beforeQuote === "?")) {
    return true;
  }
  return false;
}

/** Clip to `n`, cutting at a space and never inside a math span. */
export function clipOutsideMath(text: string, n: number): string {
  if (text.length <= n) return text;
  const spans = findMathSpans(text);
  let cut = n - 1;
  while (cut > 0 && (text[cut] !== " " || insideSpan(cut, spans))) cut--;
  if (cut <= 0) return `${text.slice(0, n - 1)}…`;
  return `${text.slice(0, cut).trimEnd()}…`;
}

/**
 * The display chunk of an accumulating thought, sliced along the
 * document's own structure so markup never tears:
 *
 *  - segments are blank-line paragraphs; the newest SETTLED segment
 *    speaks (every segment but the last is settled; the last counts
 *    once it ends like a finished thought);
 *  - a math-only segment borrows its short label segment ("**2.
 *    Gauss's Law** $$…$$") so equations keep their names;
 *  - a long prose segment narrows to its last showable sentence
 *    (math-atomic, enumerator-aware boundaries);
 *  - before anything settles, a long clean tail shows with a
 *    streaming ellipsis;
 *  - the byte clip never cuts inside a math span — rendered math is
 *    far narrower than its source, and the strip's CSS owns visual
 *    overflow.
 *
 * Returns RAW MARKDOWN — the deck renders it with full transcript
 * parity; the daemon never rewrites the machine's words.
 */
export function extractDisplay(raw: string): string | null {
  const segments = raw
    .split(/\n[ \t]*\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  for (let i = segments.length - 1; i >= 0; i--) {
    const settled = i < segments.length - 1 || endsSettled(segments[i]);
    if (!settled) continue;
    let display = oneLine(segments[i]);
    if (!isShowable(display)) continue;
    // Skip a bare heading label ("Verified behavior:") — it introduces the
    // next segment but says nothing itself; fall through to an older thought.
    if (!hasMath(display) && isDanglingLabel(display)) continue;
    const spans = findMathSpans(display);
    const mathOnly =
      spans.length > 0 &&
      oneLine(
        spans.reduce((acc, s) => acc.slice(0, s.start) + " ".repeat(s.end - s.start) + acc.slice(s.end), display),
      ).length < 4;
    if (mathOnly && i > 0) {
      const label = oneLine(segments[i - 1]);
      if (label.length <= LABEL_MAX_CHARS) display = `${label} ${display}`;
    }
    if (!hasMath(display)) {
      // Long prose narrows to its freshest showable sentence.
      const ends = sentenceEnds(display);
      for (let s = ends.length - 1; s >= 0; s--) {
        const start = s === 0 ? 0 : ends[s - 1] + 1;
        const sentence = display.slice(start, ends[s] + 1).trim();
        if (isShowable(sentence)) {
          display = sentence;
          break;
        }
      }
    }
    return clipOutsideMath(balanceEmphasis(display), LINE_CLIP);
  }

  // Nothing settled yet: show the streaming tail once it reads as a
  // thought — cut before any unclosed math rather than inside it.
  let tail = oneLine(segments[segments.length - 1]);
  const lastOpen = tail.lastIndexOf("$$");
  if (lastOpen !== -1 && !insideSpan(lastOpen, findMathSpans(tail))) {
    tail = tail.slice(0, lastOpen).trimEnd();
  }
  const ends = sentenceEnds(tail);
  if (ends.length > 0) {
    // The tail segment itself contains finished sentences (it just
    // hasn't closed its paragraph) — show the freshest one.
    for (let s = ends.length - 1; s >= 0; s--) {
      const start = s === 0 ? 0 : ends[s - 1] + 1;
      const sentence = tail.slice(start, ends[s] + 1).trim();
      if (isShowable(sentence)) {
        return clipOutsideMath(balanceEmphasis(sentence), LINE_CLIP);
      }
    }
  }
  if (tail.length >= PARTIAL_MIN_CHARS && isShowable(tail)) {
    return `${clipOutsideMath(balanceEmphasis(tail), LINE_CLIP - 1)}…`;
  }
  return null;
}

/**
 * Substance gate for a retained intent: a clause of at least
 * {@link INTENT_MIN_CHARS} chars AND {@link INTENT_MIN_WORDS} words, or
 * any math. Below the gate a thought is an interstitial beat, not an
 * intent worth pinning over a tool chain.
 */
export function isSubstantialIntent(display: string): boolean {
  if (hasMath(display)) return true;
  if (display.length < INTENT_MIN_CHARS) return false;
  const words = display.split(" ").filter((w) => w.length > 0);
  return words.length >= INTENT_MIN_WORDS;
}

/**
 * The intent line of an accumulating monologue: its display extraction
 * ({@link extractDisplay}), admitted only past the substance gate and
 * clipped to the tighter {@link INTENT_CLIP} budget. Null when nothing
 * substantive has been said — callers keep the previous intent.
 */
export function extractIntent(raw: string): string | null {
  const display = extractDisplay(raw);
  if (display === null) return null;
  if (!isSubstantialIntent(display)) return null;
  return clipOutsideMath(display, INTENT_CLIP);
}

/**
 * Parse one stdin line into a spliced frame. Returns null (no throw)
 * for malformed JSON, missing `type`, or missing the spliced
 * `tug_session_id` — the bridge only forwards spliced relay lines.
 */
export function parseWireLine(
  line: string,
): { scope: string; frame: OutboundMessage } | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.type !== "string") return null;
  if (typeof v.tug_session_id !== "string" || v.tug_session_id.length === 0) {
    return null;
  }
  return { scope: v.tug_session_id, frame: value as OutboundMessage };
}

/** Present-progressive verb for a tool, else the tool name itself. */
function toolVerb(toolName: string): string {
  switch (toolName) {
    case "Write":
      return "Writing";
    case "Edit":
      return "Editing";
    case "NotebookEdit":
      return "Editing";
    default:
      return toolName;
  }
}

/**
 * Render a task-list `tool_use` (TaskCreate / TaskUpdate) into a one-line
 * lifecycle beat, else null for any other tool. Reads the assembled tool
 * input (the empty-input content_block_start frame yields null and is
 * skipped; the filled continuation frame carries subject / status).
 */
function taskBeat(frame: ToolUse): string | null {
  const input = (frame.input ?? {}) as Record<string, unknown>;
  if (frame.tool_name === "TaskCreate") {
    return typeof input.subject === "string" && input.subject.length > 0
      ? `Created: ${input.subject}`
      : null;
  }
  if (frame.tool_name === "TaskUpdate") {
    const status = typeof input.status === "string" ? input.status : null;
    const id = input.taskId != null ? String(input.taskId) : null;
    if (status === null || id === null) return null;
    if (status === "in_progress") return `Started task ${id}`;
    if (status === "completed") return `Completed task ${id}`;
    if (status === "deleted") return `Dropped task ${id}`;
    return null;
  }
  return null;
}

/**
 * A tool's file target as the beat should carry it: relative to the session's
 * own root when it is under it, and otherwise exactly as it arrived.
 *
 * The same doctrine as {@link PHRASE_GUARD}, applied to a path. Reducing this
 * to a bare file name is a display budget guessed at the producer — it throws
 * the tail away at one width for every surface at once, and it throws away the
 * part `TugPulse` is built to keep: the deck truncates an activity in the
 * MIDDLE precisely so a path keeps its verb at the head and its file at the
 * tail, which it can only do given the whole string.
 *
 * The root comes off the scope's `system_metadata` (see `ScopeVoiceState`),
 * which lands at spawn, before the first turn. Absent it — a scope whose
 * metadata has not arrived — the path is passed through whole: an absolute
 * path is long, but it is the truth, and the deck can still cut it.
 */
function displayPath(path: string, root: string | null): string {
  if (root === null || root.length === 0) return path;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Display names for the agent-type slugs that don't read as a clean
 *  word on their own. */
const AGENT_LABEL_OVERRIDES: Record<string, string> = {
  "general-purpose": "General",
  "statusline-setup": "Statusline",
  "output-style-setup": "Output style",
};

/**
 * A subagent-type slug as a display label: a known override, else the
 * slug with separators turned to spaces and the first letter
 * capitalized ("code-reviewer" → "Code reviewer"). Keeps a raw slug
 * ("general-purpose", which clips to "general-p…" on the strip) from
 * ever reaching the pulse.
 */
export function agentDisplayLabel(slug: string): string {
  const override = AGENT_LABEL_OVERRIDES[slug];
  if (override !== undefined) return override;
  const spaced = slug.replace(/[-_]+/g, " ").trim();
  if (spaced.length === 0) return slug;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * A beat for an `AskUserQuestion` tool call — the turn is pausing for the
 * user. Borrows the first question's short `header` when present ("Asking:
 * Auth method"), else a bare "Asking a question". Without this the strip
 * would freeze on the assistant's last pre-question thought.
 */
function askQuestionBeat(frame: ToolUse): string {
  return questionBeat(frame.input ?? {}, "Asking");
}

/**
 * `<verb>: <first question's header>`, or `<verb> a question` when the call
 * carries none.
 *
 * Shared by the `AskUserQuestion` tool beat and the permission wait's own
 * question branch ([P09].1): a question forwarded for an answer and a question
 * announced as a tool call are the same call read at two moments, so they read
 * the header the same way rather than each parsing the input for itself.
 */
function questionBeat(rawInput: unknown, verb: "Asking" | "Waiting on"): string {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const first = questions[0] as Record<string, unknown> | undefined;
  const header =
    first && typeof first.header === "string" && first.header.length > 0
      ? first.header
      : null;
  return header !== null
    ? `${verb}: ${narratedPhrase(header)}`
    : `${verb} a question`;
}

/**
 * The skill name for a skill invocation, or null when the call is not a
 * skill. Two wire shapes: a `<plugin>:<skill>` tool name surfaced directly
 * (e.g. `tugplug:vet`), or the generic `Skill` tool carrying the id in its
 * input. A skill drives its own turn with little interstitial narration, so
 * naming it keeps the strip off "None".
 */
function skillLabel(frame: ToolUse): string | null {
  const name = frame.tool_name;
  if (/^[\w.-]+:[\w.-]+$/.test(name)) {
    return name.split(":").pop() ?? name;
  }
  if (name === "Skill") {
    const input = (frame.input ?? {}) as Record<string, unknown>;
    for (const key of ["command", "name", "skill"]) {
      const v = input[key];
      if (typeof v === "string" && v.length > 0) {
        return v.includes(":") ? (v.split(":").pop() ?? v) : v;
      }
    }
    return "a skill";
  }
  return null;
}

/** A tool with no file target — narrated generically as a fallback so the
 *  strip moves; a file tool (with `file_path`) defers to the monologue /
 *  `tool_input_progress` line instead. */
function isGenericNonFileTool(frame: ToolUse): boolean {
  const input = (frame.input ?? {}) as Record<string, unknown>;
  return typeof input.file_path !== "string";
}

/**
 * The transport guard on a phrase quoted into a beat — a command, a search
 * pattern, a question's header.
 *
 * Deliberately far above any display width, because it is NOT a display
 * budget. How much of a phrase fits is the DECK's to decide, at the width the
 * surface actually has: the Z2 strip and a Cards session row are different
 * widths, both move with the window, and `TugPulse` truncates an activity in
 * the MIDDLE — which it can only do given the whole string, since a command
 * identifies itself at the head and names what it acts on at the tail. A
 * budget guessed here throws that tail away before the deck ever sees it, and
 * throws it away at one width for every surface at once.
 *
 * What the guard is for is a pathological input riding the feed: a heredoc, a
 * minified blob, a pasted file. An ordinary command never reaches it.
 */
const PHRASE_GUARD = 400;

/** One line, whole — see {@link PHRASE_GUARD} for the one case it is not. */
function narratedPhrase(text: string): string {
  const t = oneLine(text);
  return t.length <= PHRASE_GUARD ? t : `${t.slice(0, PHRASE_GUARD - 1)}…`;
}

/**
 * Narrate a generic tool call ("Reading foo.ts", "Running make test") for the
 * strip — used for SUBAGENT tool calls, which are the only activity a subagent
 * streams to the parent (no text/thinking deltas cross over).
 */
function narrateTool(
  toolName: string,
  input: object,
  root: string | null,
): string {
  const inp = input as Record<string, unknown>;
  const path =
    typeof inp.file_path === "string" ? displayPath(inp.file_path, root) : null;
  switch (toolName) {
    case "Read":
      return path ? `Reading ${path}` : "Reading";
    case "Write":
      return path ? `Writing ${path}` : "Writing";
    case "Edit":
    case "NotebookEdit":
      return path ? `Editing ${path}` : "Editing";
    case "Bash":
      return typeof inp.command === "string"
        ? `Running ${narratedPhrase(inp.command)}`
        : "Running a command";
    case "Grep":
      return typeof inp.pattern === "string"
        ? `Searching ${narratedPhrase(inp.pattern)}`
        : "Searching";
    case "Glob":
      return typeof inp.pattern === "string"
        ? `Finding ${narratedPhrase(inp.pattern)}`
        : "Finding files";
    default:
      return toolName;
  }
}

/**
 * Render a `tool_input_progress` frame into a one-line strip update, e.g.
 * "Writing voice.ts — 37 lines". Falls back to the bare file name (or verb)
 * before any content has streamed.
 */
function synthesizeToolLine(
  frame: ToolInputProgress,
  root: string | null,
): string {
  const verb = toolVerb(frame.tool_name);
  const target =
    frame.file_path !== null ? displayPath(frame.file_path, root) : null;
  if (target !== null && frame.content_lines > 0) {
    const noun = frame.content_lines === 1 ? "line" : "lines";
    return `${verb} ${target} — ${frame.content_lines} ${noun}`;
  }
  if (target !== null) return `${verb} ${target}…`;
  return `${verb}…`;
}

class ScopeVoiceState {
  /** The newest text block — the latest thought is the only speaker. */
  blockKey: string | null = null;
  blockText = "";
  /**
   * A tool-progress line ("Writing foo.ts — 37 lines") synthesized from
   * `tool_input_progress`. While set it takes precedence over the monologue,
   * so the strip stays live during a long Write instead of freezing on the
   * assistant's last pre-tool thought. Cleared when the assistant speaks
   * again (monologue resumes) or the turn ends.
   */
  directLine: string | null = null;
  /**
   * The line a permission wait superseded, held so the wait can end by
   * putting it back ([P09].1). There is no other prior-line memory here:
   * `directLine` is overwritten, never stacked, so a wait that simply cleared
   * it would leave the strip on the wait's own text after the answer landed.
   *
   * `null` means no wait is in flight, which is also what ends one — the two
   * fields below are written and cleared together.
   */
  preWaitLine: string | null = null;
  /**
   * The `tool_use_id` the in-flight permission forward named, or `null` when
   * it named none — which is the QUESTION case, where the frame's
   * `tool_use_id` is optional and absent. The wait ends on the `tool_result`
   * carrying this id, and on any `tool_result` when it is null.
   */
  waitingToolUseId: string | null = null;
  /**
   * The retained high-level thought — the last monologue line that
   * passed {@link isSubstantialIntent}. Rides along with `directLine`
   * emits so the strip shows what the tool chain is FOR. Survives a
   * trivially-short new thought (the gate keeps the previous intent);
   * cleared at turn boundaries.
   */
  lastIntent: string | null = null;
  /**
   * Launched-agent labels: `Agent`/`Task` tool_use_id → a short label
   * (subagent type or description). A subagent's own tool calls arrive with
   * `parent_tool_use_id` set to its launching call, so this lets the strip
   * prefix them ("Explore · Reading foo.ts").
   */
  agentLabels = new Map<string, string>();
  /**
   * The session's own working directory, off its `system_metadata` — what a
   * tool's file path is shown RELATIVE TO (see {@link displayPath}).
   *
   * Session-scoped, not turn-scoped, so `resetTurn` leaves it: a session does
   * not change directory between turns, and re-learning it every turn would
   * spend the first tool beat of each turn on an absolute path. It arrives on
   * the spawn-time `cwd`-only frame, before any turn has run.
   */
  root: string | null = null;
  /** The line currently on the strip (dedupe for change-driven emits). */
  shownText: string | null = null;
  lastEmitAt = Number.NEGATIVE_INFINITY;
  lastActivityAt = 0;

  resetTurn(): void {
    this.blockKey = null;
    this.blockText = "";
    this.directLine = null;
    this.lastIntent = null;
    this.preWaitLine = null;
    this.waitingToolUseId = null;
    this.agentLabels.clear();
    this.shownText = null;
  }
}

export class PulseVoice {
  private readonly scopes = new Map<string, ScopeVoiceState>();

  private scopeState(scope: string, atMs: number): ScopeVoiceState {
    let state = this.scopes.get(scope);
    if (state === undefined) {
      state = new ScopeVoiceState();
      this.scopes.set(scope, state);
    }
    state.lastActivityAt = atMs;
    return state;
  }

  /**
   * Ingest one frame. Turn boundaries speak immediately; text only
   * accumulates — the {@link flush} loop emits monologue updates.
   */
  onFrame(scope: string, frame: OutboundMessage, atMs: number): VoiceLine | null {
    const state = this.scopeState(scope, atMs);
    switch (frame.type) {
      case "assistant_text":
        this.onAssistantText(state, frame);
        return null;
      // Not a beat — the frame the scope learns its root from, so every tool
      // line after it can name a file the way the user does. Silent: the
      // metadata says nothing about what the session is DOING.
      case "system_metadata":
        if (frame.cwd.length > 0) state.root = frame.cwd;
        return null;
      case "tool_input_progress":
        state.directLine = synthesizeToolLine(frame, state.root);
        return null;
      // ── The narrated wait ([P09].1) ────────────────────────────────────
      // A permission request went out to the user. The strip's whole job for
      // the next stretch is to say so: a watched card sitting on the tool
      // call that opened the request tells the reader nothing about why it
      // stopped, and this is the most common state a watched card is in.
      case "control_request_forward": {
        // A second forward while one is already in flight keeps the FIRST
        // wait's superseded line: the second's `directLine` is the first
        // wait's own text, and putting that back at the end would leave the
        // strip narrating a wait that is over.
        if (state.waitingToolUseId === null && state.preWaitLine === null) {
          state.preWaitLine = state.directLine;
        }
        state.waitingToolUseId =
          typeof frame.tool_use_id === "string" && frame.tool_use_id.length > 0
            ? frame.tool_use_id
            : null;
        state.directLine = frame.is_question
          ? questionBeat(frame.input, "Waiting on")
          : `Waiting for permission: ${narrateTool(
              frame.tool_name,
              frame.input ?? {},
              state.root,
            )}`;
        return null;
      }
      // The request was withdrawn — one of the two ways a wait ends.
      case "control_request_cancel":
        this.endWait(state);
        return null;
      // …and the other, the one that covers an ALLOW. Nothing outbound
      // announces the user's decision — `tool_approval` is inbound-only and
      // the voice runs in its own daemon, so the wire is all it can see — but
      // an approved call runs and reports, and a denied one reports the
      // denial. `tool_result` is the one frame that arrives either way.
      //
      // Correlated by `tool_use_id`, so a result for some OTHER call in
      // flight does not end this wait. A forward that named none is the
      // question case, where any result is the answer.
      case "tool_result":
        if (
          state.waitingToolUseId === null ||
          state.waitingToolUseId === frame.tool_use_id
        ) {
          this.endWait(state);
        }
        return null;
      case "tool_use": {
        const parentId = (frame as unknown as Record<string, unknown>)
          .parent_tool_use_id;
        if (typeof parentId === "string" && parentId.length > 0) {
          // A SUBAGENT's tool call — the only activity a subagent streams to
          // the parent. Narrate it (prefixed with the agent's label) so the
          // strip isn't frozen while an agent works in the background.
          if (Object.keys(frame.input ?? {}).length > 0) {
            const label = state.agentLabels.get(parentId) ?? "Agent";
            state.directLine = `${label} · ${narrateTool(frame.tool_name, frame.input, state.root)}`;
          }
          return null;
        }
        // A launched agent: remember its label so its tool calls can be
        // prefixed, and announce the launch.
        if (frame.tool_name === "Agent" || frame.tool_name === "Task") {
          const input = frame.input as Record<string, unknown>;
          const label =
            (typeof input.subagent_type === "string" && input.subagent_type.length > 0
              ? agentDisplayLabel(input.subagent_type)
              : null) ??
            (typeof input.description === "string" && input.description.length > 0
              ? input.description
              : null);
          if (label !== null) {
            state.agentLabels.set(frame.tool_use_id, label);
            state.directLine = `Launching ${label}…`;
          }
          return null;
        }
        // Task-list lifecycle is a materially interesting beat the prose
        // monologue glosses over — surface it directly. taskBeat owns these
        // tools; an empty-input frame (the content_block_start) is
        // intentionally silent, so never fall through to a generic label.
        if (frame.tool_name === "TaskCreate" || frame.tool_name === "TaskUpdate") {
          const beat = taskBeat(frame);
          if (beat !== null) state.directLine = beat;
          return null;
        }
        // AskUserQuestion — the turn is pausing for the user.
        if (frame.tool_name === "AskUserQuestion") {
          state.directLine = askQuestionBeat(frame);
          return null;
        }
        // A skill invocation (`<plugin>:<skill>` / the `Skill` tool) — a
        // distinct, always-shown beat: a skill drives its own turn with
        // little narration, so without this the strip sits on "None".
        const skill = skillLabel(frame);
        if (skill !== null) {
          state.directLine = `Running ${skill}`;
          return null;
        }
        // Generic non-file tool FALLBACK — only when the assistant has NOT
        // narrated (no monologue to own the strip). This keeps a tool-only
        // stretch (a lone search, a plugin tool with no prose) off "None",
        // while a foreground Bash/Grep DURING narration stays quiet (the
        // monologue keeps the strip). A file tool defers to the monologue /
        // tool_input_progress line regardless.
        if (state.blockText.length === 0 && isGenericNonFileTool(frame)) {
          state.directLine = narrateTool(
            frame.tool_name,
            frame.input ?? {},
            state.root,
          );
        }
        return null;
      }
      case "turn_complete":
        return this.onTurnEnd(state, scope, atMs, "Done", frame);
      case "turn_cancelled":
        return this.onTurnEnd(state, scope, atMs, "Stopped", frame);
      // A compaction landed — on a manual `/compact` (the whole turn) or
      // mid-turn at capacity. It emits IMMEDIATELY rather than through the
      // flush loop: on a manual `/compact` the boundary is followed within
      // a frame or two by `turn_complete`, which resets the scope, so a
      // throttled beat would be swallowed and the run would read as if it
      // had never happened.
      case "compact_boundary":
        return this.onCompactBoundary(state, scope, atMs, frame);
      // --- Beats the prose monologue never covers, surfaced directly ---
      // A backgrounded job reached a terminal state. (The launch + a
      // subagent's own tool calls are already narrated via the tool_use
      // path; this is the completion beat, which isn't.)
      case "task_updated": {
        const verb =
          frame.status === "completed"
            ? "finished"
            : frame.status === "failed"
              ? "failed"
              : "stopped";
        state.directLine = `Background job ${verb}`;
        return null;
      }
      // Woke from idle to service a deferred/background completion.
      case "wake_started":
        state.directLine = "Resumed";
        return null;
      // A transient stall the user should read as recovery, not a hang.
      case "api_retry":
        state.directLine =
          frame.attempt > 0
            ? `Retrying (attempt ${frame.attempt})…`
            : "Retrying…";
        return null;
      // The model declined and the SDK fell back to another model.
      case "model_refusal_fallback":
        state.directLine =
          frame.fallback_model.length > 0
            ? `Switched to ${frame.fallback_model}`
            : "Switched to a fallback model";
        return null;
      // The turn hit the output ceiling.
      case "output_truncated":
        state.directLine = "Response truncated";
        return null;
      // A backgrounded agent made progress. Its own tool calls do NOT
      // stream to the parent (unlike a foreground subagent), so this
      // per-step frame — carrying the agent's most recent tool — is the
      // ONLY thing keeping the strip alive while it works. Without it the
      // pulse freezes on "Done" the instant the launch turn ends.
      case "task_progress": {
        const label =
          state.agentLabels.get(frame.tool_use_id) ??
          (typeof frame.subagent_type === "string" && frame.subagent_type.length > 0
            ? agentDisplayLabel(frame.subagent_type)
            : "Agent");
        state.directLine =
          typeof frame.last_tool_name === "string" && frame.last_tool_name
            ? `${label} · ${frame.last_tool_name}`
            : `${label} working…`;
        return null;
      }
      default:
        return null;
    }
  }

  /**
   * Change-driven, throttled monologue updates. Call on a ~0.5–1s
   * cadence; emits at most one line per scope per call.
   */
  flush(atMs: number): VoiceLine[] {
    const lines: VoiceLine[] = [];
    for (const [scope, state] of this.scopes) {
      if (atMs - state.lastEmitAt < VOICE_THROTTLE_MS) continue;
      // A live tool-progress line outranks the monologue: during a long
      // Write there is no assistant_text to settle, so the directLine is
      // the only thing keeping the strip alive. The monologue it
      // superseded rides along as `intent` — the strip shows what the
      // tool chain is FOR, not just the beat.
      if (state.directLine !== null) {
        if (state.directLine === state.shownText) continue;
        if (state.blockText.length > 0) {
          const intent = extractIntent(state.blockText);
          if (intent !== null) state.lastIntent = intent;
        }
        state.shownText = state.directLine;
        state.lastEmitAt = atMs;
        lines.push({
          scope,
          text: state.directLine,
          ...(state.lastIntent !== null ? { intent: state.lastIntent } : {}),
        });
        continue;
      }
      if (state.blockText.length === 0) continue;
      const display = extractDisplay(state.blockText);
      if (display === null || display === state.shownText) continue;
      state.shownText = display;
      state.lastEmitAt = atMs;
      lines.push({ scope, text: display });
    }
    return lines;
  }

  /** Drop scopes idle past {@link SCOPE_IDLE_SWEEP_MS}. */
  sweepInactive(atMs: number): string[] {
    const swept: string[] = [];
    for (const [scope, state] of this.scopes) {
      if (atMs - state.lastActivityAt >= SCOPE_IDLE_SWEEP_MS) {
        this.scopes.delete(scope);
        swept.push(scope);
      }
    }
    return swept;
  }

  // -------------------------------------------------------------------------

  private onAssistantText(state: ScopeVoiceState, frame: AssistantText): void {
    if (typeof frame.text !== "string") return;
    // The assistant is narrating again — the monologue supersedes any
    // lingering tool-progress line.
    state.directLine = null;
    const key = `${frame.msg_id}:${frame.block_index}`;
    if (state.blockKey !== key) {
      // A new block starts a new thought; the old one is history.
      state.blockKey = key;
      state.blockText = frame.is_partial ? frame.text : frame.text;
      return;
    }
    // The deck reducer's rule: partial appends, complete replaces.
    state.blockText = frame.is_partial ? state.blockText + frame.text : frame.text;
  }

  /**
   * The compaction beat. Everything the scope was carrying — the
   * in-progress thought, its retained intent, any tool line — describes
   * the context that was just summarized away, so the scope starts clean
   * from here.
   */
  private onCompactBoundary(
    state: ScopeVoiceState,
    scope: string,
    atMs: number,
    frame: CompactBoundary,
  ): VoiceLine {
    const verb =
      frame.trigger === "auto" ? "Auto-compacted context" : "Compacted context";
    const pre =
      typeof frame.pre_tokens === "number" && frame.pre_tokens > 0
        ? ` (was ${formatTokens(frame.pre_tokens)})`
        : "";
    state.blockKey = null;
    state.blockText = "";
    state.directLine = null;
    state.lastIntent = null;
    const text = `${verb}${pre}`;
    state.lastEmitAt = atMs;
    state.shownText = text;
    return { scope, text };
  }

  /**
   * End the wait in flight, if there is one: the superseded line goes back on
   * the strip and the two wait fields clear together ([P09].1).
   *
   * A no-op when nothing is waiting, which is the ordinary case for every
   * `tool_result` in a turn nobody was asked to approve.
   */
  private endWait(state: ScopeVoiceState): void {
    if (state.waitingToolUseId === null && state.preWaitLine === null) return;
    state.directLine = state.preWaitLine;
    state.preWaitLine = null;
    state.waitingToolUseId = null;
  }

  private onTurnEnd(
    state: ScopeVoiceState,
    scope: string,
    atMs: number,
    marker: "Done" | "Stopped",
    frame: TurnComplete | TurnCancelled,
  ): VoiceLine {
    void frame;
    // Captured BEFORE the reset clears it. What the turn was FOR is the one
    // fact a resting card can still say something with ([P09].2), and until
    // now it was dropped on the floor at exactly the moment it became the
    // only thing left. It rides both markers; the deck decides that only
    // `Done` reads as finished.
    const intent = state.lastIntent;
    state.resetTurn();
    state.lastEmitAt = atMs;
    state.shownText = marker;
    return { scope, text: marker, ...(intent !== null ? { intent } : {}) };
  }
}
