/**
 * transcript-search-index — the query-independent store→text index behind the
 * Session card's Find route.
 *
 * The transcript is a virtualized list: almost every row is unmounted at any
 * moment (`OVERSCAN_COUNT = 3`), so a whole-transcript match count cannot come
 * from the DOM. This module projects **every** data-source row to an ordered
 * list of **search segments**, keyed to the row's flat index, so
 * `transcript-search.searchSegments` can count and order matches over the
 * entire transcript regardless of what is mounted. Painting (a separate
 * concern) then resolves DOM Ranges only for the handful of mounted rows.
 *
 * **Units mirror the DOM's `data-tugx-findable` containers.** Each projected
 * part corresponds 1:1, in DOM order, with one marked container in the row's
 * rendered cell (`transcript-find-highlighter.ts` walks exactly those). A
 * query is searched per unit on BOTH sides, so a match can never span two
 * containers — and the k-th index match in a row is the k-th DOM match, which
 * is the invariant navigation relies on. Adding a searchable kind is a
 * two-sided checklist: mark the container, project the same text here in the
 * same order, and extend the fidelity fixture.
 *
 * **Fidelity via the shared parse cache.** Markdown-rendered kinds (assistant
 * text, thinking, user bodies, scheduled wake notes) are reduced to rendered
 * text by reading through `ensureParsed` — for streamed kinds with the same
 * scope (`codeSessionStore.streamingDocument`) and identity
 * (`turn.${turnKey}.message.${messageKey}.text`) the renderer uses, so the
 * index free-rides on warm parses; for static kinds (user bodies, notes) the
 * cache entry is index-owned (first build parses, repeat builds hit). The
 * block HTML is reduced to text with a scratch DOM element (entities
 * decoded), which is why the fidelity check is an app-test, not a pure unit
 * test.
 *
 * The index does **not** depend on the query — only the transcript snapshot
 * and expansion state. Callers rebuild it on those changes and re-run the
 * search over the result on query/options changes.
 *
 * Scope: `user` bodies, `assistant_text`, `assistant_thinking`, rendered
 * `system_note`s (compact divider label, scheduled wake chip). A
 * `system_note` with `source: "other"` has no renderer, so it projects
 * nothing — the index never counts invisible text. Every top-level tool
 * call contributes its HEADER (`toolHeaderParts` — the name and the target)
 * in both collapse states, because the header is on screen in both; a
 * collapsed block's BODY is unmounted by `BlockChrome` and projects
 * nothing. Shell exchanges follow the same split: the header command
 * always, the output only while expanded. Embedded-editor content joins as
 * `editor` segments.
 *
 * **Only what is on screen is counted.** A collapsed thinking block keeps
 * its prose MOUNTED but clipped, so the rule cannot be "is it in the DOM?"
 * — it projects its one-line preview while collapsed and its full prose
 * while expanded, and the DOM marks whichever of the two is hidden with
 * `data-tugx-find-hidden` so the painter skips it. Find never reports a
 * match the reader cannot see.
 *
 * @module lib/transcript-search-index
 */

import { ensureParsed } from "@/lib/markdown/parse-cache";
import { findInlineMathRanges } from "@/lib/markdown/block-transformers/inline-math-walker";
import { stripAnsi } from "@/lib/ansi/strip-ansi";
import type { RowSegment } from "@/lib/transcript-search";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-img";
import { RETAINED_LINE_CAP } from "@/components/tugways/body-kinds/terminal-block";
import { parseGitCommit } from "@/components/tugways/body-kinds/commit-block";
import { refsFindablePaths } from "@/components/tugways/cards/refs-result-view";
import {
  extractTextOutput,
  renderedToolBlock,
} from "@/components/tugways/cards/session-assistant-renderer-dispatch";
import { toolHeaderParts } from "@/components/tugways/cards/blocks/tool-header-projection";
import {
  computePreview,
  thinkingCollapseKey,
  THINKING_LABEL,
} from "@/components/tugways/chrome/session-thinking-block";
import {
  BashToolBlock,
  composeTerminalData,
  narrowStructured as narrowBashStructured,
  tryParseBashDiff,
} from "@/components/tugways/cards/blocks/bash-tool-block";
import {
  DefaultToolBlock,
  pickOutputBody,
} from "@/components/tugways/cards/blocks/default-tool-block";
import { ReadToolBlock } from "@/components/tugways/cards/blocks/read-tool-block";
import { collapseDefaultForMessage } from "@/components/tugways/cards/blocks/tool-collapse-defaults";
import { resolveCommandBlockSearchParts } from "@/components/tugways/cards/session-command-block-registry";
import {
  STAGE_BOUNDARY_EVENT,
  stageBoundaryParts,
} from "@/lib/code-session-store/stages";
import type { ToolBlockExpansionState } from "@/components/tugways/blocks/expansion-state";
import type { ToolUseMessage } from "@/lib/code-session-store/types";
import type { PropertyStore } from "@/components/tugways/property-store";
import type {
  SessionRowDescriptor,
  SessionTranscriptDataSource,
} from "@/lib/session-transcript-data-source";

/** A row's message slice, from a committed turn or the in-flight turn. */
type RowMessages = NonNullable<SessionRowDescriptor["turn"]>["messages"];

// Reused scratch element for HTML→text reduction (entities decoded, tags
// dropped). Created lazily so importing this module never touches the DOM —
// the DOM-free row kinds (compact notes, unrendered notes) never reach it, so
// a pure unit test over those rows stays DOM-free.
let htmlScratch: HTMLDivElement | null = null;

/**
 * Strip unfenced `$…$` / `$$…$$` math, using the SAME detector
 * (`findInlineMathRanges`) the render pipeline uses to promote those spans into
 * `.tugx-katex`. pulldown-cmark leaves `$$…$$` as literal text in `block.html`
 * (it isn't a fenced block), so `.tugx-katex` removal alone misses it and the
 * LaTeX source (e.g. `\varepsilon`, which contains "are") leaks into the index.
 * The painter skips the rendered `.tugx-katex` in the DOM, so stripping here
 * keeps index ↔ DOM aligned.
 */
function stripInlineMath(text: string): string {
  const ranges = findInlineMathRanges(text);
  if (ranges.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const range of ranges) {
    out += text.slice(cursor, range.start);
    cursor = range.end;
  }
  out += text.slice(cursor);
  return out;
}

function htmlToText(html: string): string {
  if (typeof document === "undefined") return html;
  if (htmlScratch === null) htmlScratch = document.createElement("div");
  htmlScratch.innerHTML = html;
  // Drop FENCED math: the parse-time `.tugx-katex` placeholder carries the
  // LaTeX source as text (e.g. `\varepsilon_0`). The painter skips the rendered
  // `.tugx-katex` in the DOM, so excluding it here keeps them aligned.
  for (const el of htmlScratch.querySelectorAll(".tugx-katex")) el.remove();
  // Drop UNFENCED `$…$` / `$$…$$` math, which cmark leaves as literal text.
  return stripInlineMath(htmlScratch.textContent ?? "");
}

/**
 * Reduce markdown source to its rendered text via the shared parse cache.
 * Atom placeholders (`U+FFFC`) are removed from the result: the rendered DOM
 * replaces each with a chip host whose SVG label the painter excludes
 * (`.tug-atom-chip-host`), so the aligned projection is "no text there".
 */
function markdownToText(
  streamingStore: PropertyStore,
  identity: string,
  text: string,
): string {
  if (text === "") return "";
  const blocks = ensureParsed(streamingStore, identity, text);
  return blocks
    .map((b) => htmlToText(b.html))
    .join("\n")
    .split(TUG_ATOM_CHAR)
    .join("");
}

/**
 * Strip the `>` Code route prefix from a user body the way the user row's
 * renderer does (`stripUserBodyPrefix` in `session-card-transcript.tsx`) — the
 * projection must match the DISPLAYED text, not the wire text.
 */
function stripUserBodyPrefix(text: string): string {
  if (text.startsWith("> ")) return text.slice(2);
  if (text.startsWith(">")) return text.slice(1);
  return text;
}

/** Terminal output as the DOM renders it: stdout lines, then stderr lines
 *  (`renderTerminal`'s stream order), ANSI-stripped, capped at the
 *  retention limit so the count never exceeds what unfolding can reveal. */
function terminalText(stdout: string, stderr: string): string {
  const lines: string[] = [];
  if (stdout !== "") lines.push(...stripAnsi(stdout).split("\n"));
  if (stderr !== "") lines.push(...stripAnsi(stderr).split("\n"));
  return lines.slice(0, RETAINED_LINE_CAP).join("\n");
}

/**
 * Search segments of one EXPANDED tool call's BODY, mirroring what its
 * wrapper marks `data-tugx-findable` below the header (plus `editor`
 * segments for embedded editors). The header is projected separately by
 * `toolHeaderParts` and is not gated on expansion.
 *
 *  - **Bash** (`BashToolBlock`): the terminal body's stdout-then-stderr
 *    text. The wrapper's smart-pick routing is mirrored via the SAME
 *    exported helpers it uses: a streaming call has no body and a
 *    diff-routed body renders `DiffBlock`, which is out of scope.
 *  - **Default-routed tools** (`DefaultToolBlock`): the markdown text
 *    result (`pickOutputBody`'s `markdown` branch) on a `done` call. The
 *    JSON input tree is fold-dependent and stays unsearchable.
 *  - **Read** (`ReadToolBlock`): the file content as an `editor` segment.
 *  - Everything else (bespoke wrappers, hidden tools) contributes nothing.
 */
function toolUseSegments(
  message: ToolUseMessage,
  toolUseId: string,
  streamingStore: PropertyStore,
): RowSegment[] {
  // The factory the transcript will actually mount — drift routes a
  // registered wrapper to `DefaultToolBlock`, so asking the registry by
  // name alone would project a body the DOM never renders.
  const factory = renderedToolBlock(message);
  if (factory === ReadToolBlock) {
    // The Read body is an embedded CodeMirror editor over
    // `structured_result.file.content` — the SAME bytes `composeFileData`
    // feeds `FileBlock`. CM6 virtualizes its DOM, so this is an `editor`
    // segment: counted here, painted/navigated by the editor's own search.
    const structured = message.structuredResult as
      | { file?: { content?: unknown } }
      | null;
    const content =
      structured !== null &&
      typeof structured === "object" &&
      structured.file !== undefined &&
      typeof structured.file.content === "string"
        ? structured.file.content
        : undefined;
    if (content === undefined || content === "") return [];
    return [{ kind: "editor", key: toolUseId, text: content }];
  }
  if (factory === BashToolBlock) {
    const input = message.input as Record<string, unknown> | null;
    const command =
      input !== null && typeof input === "object" && typeof input.command === "string"
        ? input.command
        : undefined;
    const structured = narrowBashStructured(message.structuredResult);
    const textOutput = extractTextOutput(message.result);
    const isError = message.status === "error";
    const terminal = composeTerminalData(structured, textOutput, isError);
    // Commit receipt: the body is `CommitBlock`, which is unmarked.
    if (
      message.status === "done" &&
      command !== undefined &&
      /\bgit\b[\s\S]*\bcommit\b/.test(command) &&
      parseGitCommit(command, terminal.stdout ?? "") !== null
    ) {
      return [];
    }
    // Streaming has no body; a diff-routed body renders `DiffBlock`
    // (unmarked). Otherwise the body is the marked terminal — keyed so
    // navigation can open its internal fold.
    if (
      message.status !== "pending" &&
      tryParseBashDiff(terminal.stdout) === null
    ) {
      const text = terminalText(terminal.stdout ?? "", terminal.stderr ?? "");
      if (text !== "") return [{ kind: "dom", text, key: toolUseId }];
    }
    return [];
  }
  if (factory === DefaultToolBlock && message.status === "done") {
    const output = pickOutputBody(
      message.structuredResult,
      extractTextOutput(message.result),
    );
    if (output.kind === "markdown" && output.text !== "") {
      const identity = `tool.${toolUseId}.result`;
      const projected = markdownToText(streamingStore, identity, output.text);
      return projected === "" ? [] : [{ kind: "dom", text: projected }];
    }
  }
  return [];
}

/**
 * Search segments contributed by one message, in the same order the renderer
 * mounts that message's marked containers (searchable kinds only).
 */
function messageSegments(
  message: RowMessages[number],
  turnKey: string,
  streamingStore: PropertyStore,
  expansion: ToolBlockExpansionState,
): RowSegment[] {
  switch (message.kind) {
    case "user_message":
      // Rendered by the user row, not the assistant body — projected there.
      return [];
    case "assistant_text": {
      // Renders through `TugMarkdownBlock` subscribed to the SAME streaming
      // path the reducer writes, so this identity hits the renderer-warmed
      // parse cache. Read the live store value first — the in-flight text
      // can be ahead of the committed Message.
      const path = `turn.${turnKey}.message.${message.messageKey}.text`;
      const live = streamingStore.get(path);
      const text = typeof live === "string" ? live : message.text;
      const projected = markdownToText(streamingStore, path, text);
      return projected === "" ? [] : [{ kind: "dom", text: projected }];
    }
    case "assistant_thinking": {
      // `SessionThinkingBlock` — the note variant. Its label is always on
      // screen; its prose is not. Unlike a tool block the collapsed body
      // stays MOUNTED (a height animation needs it) but clipped, so the
      // fold decides WHICH text is visible rather than whether any is: the
      // one-line preview while collapsed, the full prose while expanded.
      // The DOM marks the other one `data-tugx-find-hidden`, so this
      // projection and the painter agree.
      const path = `turn.${turnKey}.message.${message.messageKey}.text`;
      const live = streamingStore.get(path);
      const text = typeof live === "string" ? live : message.text;
      // An empty thinking block is `display: none` — no chrome, no label.
      if (text === "") return [];
      const segments: RowSegment[] = [{ kind: "dom", text: THINKING_LABEL }];
      // The transcript always mounts thinking in streaming mode (it threads
      // the streaming store for both live and replayed rows), so the
      // default is expanded — the same value the component resolves with.
      const collapsed = expansion.resolve(thinkingCollapseKey(path), false);
      const visible = collapsed
        ? computePreview(text)
        : markdownToText(streamingStore, path, text);
      if (visible !== "") segments.push({ kind: "dom", text: visible });
      return segments;
    }
    case "system_note": {
      if (message.source === "compact") {
        // `SessionCompactionEntry` splits the note on " · ": the label is the
        // boundary's (marked) event span, the token count rides the trailing
        // result summary, which is not searchable. The recap body is unmarked,
        // so it projects nothing in either collapse state.
        const [label] = message.text.split(" · ");
        return label === undefined || label === ""
          ? []
          : [{ kind: "dom", text: label }];
      }
      if (message.source === "scheduled" || message.source === "notice") {
        // The wake-trigger chip and the tug-notice row both render through
        // `TugMarkdownBlock` in static mode; the cache identity here is
        // index-owned (the static renderer parses via `renderIncremental`,
        // not the cache).
        const identity = `turn.${turnKey}.message.${message.messageKey}.note`;
        const projected = markdownToText(streamingStore, identity, message.text);
        return projected === "" ? [] : [{ kind: "dom", text: projected }];
      }
      if (message.source === "arc") {
        // The arc quiet line renders its sentence verbatim in a marked
        // span — no markdown pass, so the projection is the text itself.
        return message.text === "" ? [] : [{ kind: "dom", text: message.text }];
      }
      if (message.source === "stage") {
        // The stage boundary's event is a marked container, so it projects —
        // one unit, one part. Its detail (the document) and its model badge
        // are not marked and so are not searchable, which is why neither
        // appears here. The event is composed from the note's own facts by
        // the same function the renderer calls, so the two readings cannot
        // drift; a note that arrived without facts reads the bare floor.
        return [
          {
            kind: "dom",
            text:
              message.stageFacts === undefined
                ? STAGE_BOUNDARY_EVENT
                : stageBoundaryParts(message.stageFacts).event,
          },
        ];
      }
      // `source: "other"` has no marked container — invisible or unmarked
      // text is not searchable.
      return [];
    }
    case "tool_use": {
      // Subagent children render inside their parent Agent block (out of
      // scope). A top-level call's HEADER is on screen in both collapse
      // states — it is the whole block when collapsed — so it projects
      // unconditionally; only the body, which `BlockChrome` unmounts while
      // collapsed, is expansion-gated.
      if (message.parentToolUseId !== undefined) return [];
      const segments: RowSegment[] = domSegments(toolHeaderParts(message));
      const collapsed = expansion.resolve(
        message.toolUseId,
        collapseDefaultForMessage(message),
      );
      if (collapsed) return segments;
      segments.push(
        ...toolUseSegments(message, message.toolUseId, streamingStore),
      );
      return segments;
    }
    default:
      // shell_exchange never appears in an assistant slice.
      return [];
  }
}

/** Project a user body (markdown-rendered, prefix-stripped, chips removed). */
function userBodyParts(
  text: string,
  turnKey: string,
  messageKey: string,
  streamingStore: PropertyStore,
): string[] {
  const displayed = stripUserBodyPrefix(text);
  if (displayed === "") return [];
  // Index-owned cache identity — the user body renders via
  // `TugAtomMarkdownBody` → `TugMarkdownBlock` static mode, which does not
  // populate the shared cache.
  const identity = `turn.${turnKey}.message.${messageKey}.userbody`;
  const projected = markdownToText(streamingStore, identity, displayed);
  return projected === "" ? [] : [projected];
}

/**
 * Project one shell exchange as its two search units — the header command,
 * then the ANSI-stripped output capped at `RETAINED_LINE_CAP` lines (the
 * DOM's `TerminalBlock` retains at most that many, so the projection never
 * counts text no amount of unfolding can reveal). The command rides the
 * header and stays on screen when the exchange is collapsed, so it projects
 * either way; only the output — unmounted with the body — is gated. Shell
 * rows default expanded.
 *
 * A row a BESPOKE command block claims (a `/commit` or `/arc-join` receipt)
 * renders none of that: it parses the output and shows its own arrangement
 * of it. Those rows project what their registration declares — the same text
 * their renderer marks findable — because projecting the raw output would
 * count matches no painter could ever reach.
 */
function shellSegments(
  descriptor: SessionRowDescriptor,
  expansion: ToolBlockExpansionState,
): RowSegment[] {
  const message = descriptor.turn?.messages[0];
  if (message === undefined || message.kind !== "shell_exchange") return [];
  // A bespoke block may fold part of what it parsed (the join boundary folds
  // its whole receipt), so it is handed the row's fold state and projects only
  // what is mounted. The default is `true` where the generic block's is
  // `false`, because the two disagree about what an untouched row shows: a
  // shell exchange defaults expanded, and a boundary defaults folded. Same
  // key, different default, so the two resolves cannot be shared.
  const claimed = resolveCommandBlockSearchParts(
    message,
    expansion.resolve(message.exchangeId, true),
  );
  if (claimed !== null) return domSegments(claimed);
  const segments: RowSegment[] = [];
  if (message.command !== "") {
    segments.push({ kind: "dom", text: message.command });
  }
  if (expansion.resolve(message.exchangeId, false)) return segments;
  if (message.output !== "") {
    const visible = stripAnsi(message.output)
      .split("\n")
      .slice(0, RETAINED_LINE_CAP)
      .join("\n");
    if (visible !== "") {
      // Keyed: the terminal's internal fold can hide the tail of this unit;
      // navigation unfolds it through the card's FindTargetRegistry.
      segments.push({ kind: "dom", text: visible, key: message.exchangeId });
    }
  }
  return segments;
}

/**
 * Project one refs run as its search units ([P03]): the command that ran it,
 * then — while the block is expanded — the file path of each row the block
 * renders. Both sides are marked `data-tugx-findable`: the command rides the
 * block header, the paths are the body kinds' own path elements, opted in by
 * the refs block's `findable`.
 *
 * The command projects in both collapse states because it rides the header
 * and stays on screen; the paths are unmounted with the body, so they are
 * gated exactly as a shell exchange's output is. Refs rows default expanded.
 *
 * Matched LINES are deliberately not projected. Which match rows exist
 * depends on `SearchResultBlock`'s per-file collapse set — React state this
 * index cannot observe — so projecting them would desync the count from the
 * paint the first time a user folds a file.
 */
function refsSegments(
  descriptor: SessionRowDescriptor,
  expansion: ToolBlockExpansionState,
): RowSegment[] {
  const message = descriptor.turn?.messages[0];
  if (message === undefined || message.kind !== "refs_result") return [];
  const segments: RowSegment[] = [];
  if (message.command !== "") {
    segments.push({ kind: "dom", text: message.command });
  }
  if (expansion.resolve(message.runId, false)) return segments;
  for (const path of refsFindablePaths(message)) {
    segments.push({ kind: "dom", text: path });
  }
  return segments;
}

/** Wrap plain-text parts as `dom` segments. */
function domSegments(parts: string[]): RowSegment[] {
  return parts.map((text) => ({ kind: "dom" as const, text }));
}

/** Ordered search segments of one transcript row. */
function rowSegments(
  descriptor: SessionRowDescriptor,
  streamingStore: PropertyStore,
  expansion: ToolBlockExpansionState,
): RowSegment[] {
  if (descriptor.kind === "ghost") return [];
  if (descriptor.kind === "shell") {
    return shellSegments(descriptor, expansion);
  }
  if (descriptor.kind === "refs") {
    return refsSegments(descriptor, expansion);
  }
  if (descriptor.kind === "user") {
    const message = descriptor.userMessage;
    if (message === undefined) return [];
    return domSegments(
      userBodyParts(
        message.text,
        descriptor.turnKey,
        message.messageKey,
        streamingStore,
      ),
    );
  }
  const messages: RowMessages | undefined =
    descriptor.turn?.messages ?? descriptor.activeTurn?.messages;
  if (
    messages === undefined ||
    descriptor.messageStart === undefined ||
    descriptor.messageEnd === undefined
  ) {
    return [];
  }
  const segments: RowSegment[] = [];
  for (let j = descriptor.messageStart; j < descriptor.messageEnd; j++) {
    const message = messages[j];
    if (message !== undefined) {
      segments.push(
        ...messageSegments(message, descriptor.turnKey, streamingStore, expansion),
      );
    }
  }
  return segments;
}

/**
 * Build the whole-transcript row→segments index: `result[i]` is the ordered
 * list of search segments of data-source row `i` (empty for non-searchable
 * rows). The array length equals `dataSource.numberOfItems()`, so a match's
 * `row` is a valid `scrollToIndex` target.
 */
export function buildTranscriptSearchSegments(
  dataSource: SessionTranscriptDataSource,
  streamingStore: PropertyStore,
  expansion: ToolBlockExpansionState,
): RowSegment[][] {
  const n = dataSource.numberOfItems();
  const rows: RowSegment[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    rows[i] = rowSegments(dataSource.rowAt(i), streamingStore, expansion);
  }
  return rows;
}
