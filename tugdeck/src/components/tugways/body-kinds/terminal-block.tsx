/**
 * `TerminalBlock` — Layer-1 body kind for ANSI-aware terminal output.
 *
 * Renders structured terminal data (stdout / stderr / optional
 * footer fields) inline in the transcript. Used by Layer-2 wrappers
 * (`BashToolBlock` in [#step-6]) and reachable directly from the
 * gallery and from `RenderInput`-routed body kinds whose data shape
 * is "two text streams + post-mortem badges."
 *
 * Two-mode contract (mirrors the [Spec S02] body-kind shape):
 *
 *   1. **Static** — `<TerminalBlock data={…} />`. Renders once on
 *      mount, then ignores subsequent prop changes (mount-once
 *      contract). Consumers that need to swap content remount via a
 *      fresh React key.
 *
 *   2. **Streaming** — `<TerminalBlock streamingStore={…}
 *      streamingPath="…" />`. Subscribes to a `PropertyStore` path
 *      whose value is a `TerminalData` object; re-parses + redraws
 *      on each emission, coalesced by `requestAnimationFrame`.
 *      Implements the [Spec S05] streaming binding directly (G1
 *      sync read on mount, observe for updates, write the DOM
 *      imperatively).
 *
 * Composition:
 *
 *  - Header (React-rendered `.tugx-term-header`): an optional label
 *    slot at left (`headerLabel` prop — typically the command for
 *    Bash tool standalone use), a flex spacer, and a `Copy`
 *    `<TugIconButton>` at right. The header is `position: sticky` so
 *    it stays visible while the user scrolls deep into the body. The
 *    Copy overlay (`.tugx-term-copy` absolute div) it replaced was
 *    retired: it sat on top of the scrollbar gutter for any output
 *    tall enough to trigger scrolling.
 *  - Body (imperatively rendered into `.tugx-term-content`): the
 *    truncation banner, the line container, and the post-mortem
 *    footer. Lines render flat in document flow — the transcript is
 *    the one scroll surface; a terminal block never scrolls inside
 *    itself vertically. Long output is bounded by the collapse fold
 *    (folded to a preview by default) and the retention cap, not by a
 *    self-scrolling viewport.
 *
 * Embedded mode portals the Copy `<TugIconButton>` into the host
 * `BlockChrome`'s actions slot (via `ChromeActionsTargetContext`)
 * so the affordance surfaces in the chrome header rather than as a
 * separate strip. The body kind's own `.tugx-term-header` is
 * suppressed when embedded (the chrome owns identity).
 *
 * Render strategy:
 *
 *   - **Flat, always.** Every retained line is in the DOM, in
 *     document flow — no inner scroll container. A tool block
 *     expands/collapses in full; it does not scroll inside itself.
 *     The collapse fold caps the *default* height (folded to a
 *     `collapseThreshold`-line preview for long output); expanding
 *     reveals the whole thing and grows the transcript, which is the
 *     one and only scroll surface.
 *   - **Retention cap** at `RETAINED_LINE_CAP` (10k per [Q04]):
 *     when the parsed-line count exceeds the cap, the earliest
 *     lines are dropped and a "… N earlier lines truncated"
 *     indicator is prepended. The audit's max observed Bash output
 *     was 706 lines, so the cap is a defense against pathological
 *     streams (`watch`, log tails) — the ceiling on how many lines a
 *     full expand ever mounts.
 *
 * Laws:
 *  - [L03] `useLayoutEffect` for the mount-render and the streaming
 *    subscription so DOM is in place before paint.
 *  - [L06] appearance changes go through CSS / DOM. The line/footer
 *    body is written imperatively into `.tugx-term-content`. The Copy
 *    button's `aria-label` and `onClick` are React props, but the
 *    "I just wrote text to the clipboard" feedback is a DOM class
 *    swap on the button ref so the imperative render path doesn't
 *    have to roundtrip through React state.
 *  - [L19] file pair (`.tsx` + `.css`), exported props interface,
 *    `data-slot="terminal-body"` on the root.
 *  - [L20] component-token sovereignty — owns the `--tugx-term-*`
 *    slot family ([Table T07]). The retired Copy overlay's
 *    `--tugx-term-copy-*` slots were dropped with it.
 *  - [L22] streaming binding observes the `PropertyStore` directly
 *    and rebuilds the DOM imperatively; React state holds only
 *    container refs.
 *
 * Decisions:
 *  - [D06] ANSI parsing stays in JS (`ansi_up`); see
 *    `lib/ansi/ansi-to-html.ts`.
 *  - [Q04] retained-line cap is 10k — defense against pathological
 *    streams; not configurable in v1.
 *
 * @module components/tugways/body-kinds/terminal-block
 */

import "./terminal-block.css";

import React from "react";
import { createPortal } from "react-dom";

import type { PropertyStore } from "@/components/tugways/property-store";
import { useChromeActionsTarget } from "@/components/tugways/blocks/block-chrome";
import { useOptionalResponder } from "@/components/tugways/use-responder";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import { type TugAction } from "@/components/tugways/action-vocabulary";
import type { ActionHandler } from "@/components/tugways/responder-chain";
import { ansiToHtml } from "@/lib/ansi/ansi-to-html";
import {
  BlockActionsCluster,
  BlockCopyButton,
  BlockFoldCue,
  useBlockFoldState,
} from "./affordances";
import { useFindTargetRegistration } from "@/components/tugways/blocks/find-target-registry";
import {
  ToolBlockCollapseContext,
  ToolUseIdContext,
} from "@/components/tugways/blocks/collapse-context";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Structured terminal data — the body's render input.
 *
 * `stdout` / `stderr` are the two text streams. `exitCode`,
 * `durationMs`, and `interrupted` populate the footer when set;
 * they're optional because they only land at completion (the live
 * stream has neither yet).
 */
export interface TerminalData {
  stdout: string;
  stderr: string;
  exitCode?: number;
  durationMs?: number;
  interrupted?: boolean;
}

export interface TerminalBlockProps {
  /**
   * Static terminal data. Rendered once at mount; subsequent prop
   * changes are ignored (mount-once contract). Mutually exclusive
   * with `streamingStore` — if both are supplied, streaming mode
   * takes precedence.
   */
  data?: TerminalData;

  /**
   * `PropertyStore` for streaming mode. The path's value is read as
   * a `TerminalData` object on mount and on every emission.
   */
  streamingStore?: PropertyStore;

  /**
   * `PropertyStore` path key for the streaming `TerminalData`.
   * Default `"terminal"`. Only consulted in streaming mode.
   *
   * @default "terminal"
   */
  streamingPath?: string;

  /**
   * Forwarded class name. Cascade-scoped customization happens here —
   * consumers tune `--tugx-term-*` tokens via a wrapping selector
   * per [L20].
   */
  className?: string;

  /**
   * "Embedded" mode — composed inside a host that already paints a
   * container and a header (e.g. `BlockChrome` in
   * `BashToolBlock`). When `true`:
   *
   *   - The standalone frame (background / border / radius / outer
   *     margin) is dropped so the lines integrate flush with the host.
   *   - The terminal's own `.tugx-term-header` is suppressed — the
   *     wrapper owns identity.
   *   - The Copy `<TugIconButton>` portals into the host's chrome
   *     actions slot via `ChromeActionsTargetContext`. This is the
   *     load-bearing contract: `embedded={true}` MUST be used under
   *     a `BlockChrome` so Copy has somewhere to surface.
   *
   * @default false
   */
  embedded?: boolean;

  /**
   * Optional label rendered at the left of the standalone header. The
   * Bash tool block (`BashToolBlock`) passes the command here for
   * standalone gallery use; embedded callers don't need to set this
   * — the chrome owns identity in that mode. Strings are wrapped in
   * a `<span>` so the consumer doesn't have to pre-wrap; arbitrary
   * `ReactNode` is also accepted for caller-controlled markup (e.g.
   * a `<code>` element preserving the literal command).
   */
  headerLabel?: React.ReactNode;

  /**
   * Initial collapse state. When undefined, the component picks the
   * default from `collapseThreshold`: collapsed if the line count
   * exceeds the threshold, expanded otherwise. Mirrors FileBlock's
   * `collapsed` prop semantics.
   *
   * Streaming-mode TerminalBlocks (`streamingStore` set) compute the
   * threshold check against `0` at mount because the imperative
   * renderer owns the line growth — no fold cue surfaces in that
   * mode until a follow-up wires a streaming line-count subscription.
   * Static-mode TerminalBlocks (`data` set) compute against the
   * static line count and fold by default for long output.
   */
  collapsed?: boolean;

  /**
   * Notification callback fired when the user toggles the collapsed
   * state via the fold cue. Same controlled/uncontrolled semantics as
   * FileBlock: when `collapsed` is provided, the parent owns the
   * value and this callback is the change notification; when
   * `collapsed` is undefined, the body kind owns its own state and
   * this callback is purely informational.
   */
  onToggleCollapsed?: (next: boolean) => void;

  /**
   * Line cap for the expand / collapse axis. Output longer than this
   * many lines folds by default and the collapsed preview shows the
   * first `collapseThreshold` lines; output at or below it renders
   * expanded with no fold cue. Defaults to
   * {@link DEFAULT_COLLAPSE_THRESHOLD}.
   *
   * @default DEFAULT_COLLAPSE_THRESHOLD
   */
  collapseThreshold?: number;

  /**
   * Opt the terminal's OUTPUT LINES into transcript Find: stamps
   * `data-tugx-findable` on `.tugx-term-content` so the find painter walks
   * it. Set ONLY by transcript hosts whose output the search index projects
   * (the shell exchange row; the Bash tool block once indexed) — marking
   * without a matching projection breaks count↔paint alignment. The footer,
   * fold cue, and truncation banner stay unmarked chrome. A folded terminal
   * shows the FIRST `collapseThreshold` lines, so mounted hits are a prefix
   * of the projected hits — ordinal alignment holds. Default `false`.
   */
  findable?: boolean;

  /**
   * Opt-in key for the [A9] Component State Preservation Protocol.
   * When set, TerminalBlock persists its uncontrolled `collapsed`
   * flag into `bag.components` so a Maker > Reload restores the
   * fold. Undefined opts out (gallery, standalone).
   */
  componentStatePreservationKey?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default line cap for the expand / collapse axis — the one tunable
 * number behind the fold. Terminal output longer than this many lines
 * folds by default; the collapsed preview then shows exactly this many
 * lines and the fold cue carries a "N more lines" count for the
 * remainder. Output at or below the cap renders expanded with no fold
 * cue (there is nothing to collapse).
 *
 * 25 is the tuning point between two failure modes. Too low and the
 * reader expands constantly just to see ordinary command output. Too
 * high and a single `find` / `git log` / build run dominates the whole
 * transcript — the symptom this cap exists to fix: a 300-line
 * directory listing that rendered as 300 unbroken lines. 25 lines is
 * about a screenful of context: enough to recognize what a command
 * produced and decide whether to expand, while keeping any one result
 * modest next to the conversation around it.
 *
 * This is the consumer-overridable default for the `collapseThreshold`
 * prop. A wrapper that wants a different cap passes its own; tune the
 * value here to move the default for every terminal-rendered result
 * (Bash output, RenderInput-routed terminals) at once.
 */
export const DEFAULT_COLLAPSE_THRESHOLD = 25;

/**
 * Maximum retained-line count before the earliest lines are dropped
 * and replaced with a "… N earlier lines truncated" indicator
 * ([Q04]).
 */
export const RETAINED_LINE_CAP = 10_000;

const DEFAULT_STREAMING_PATH = "terminal";

const DATA_SLOT_ROOT = "terminal-body";
const DATA_SLOT_HEADER = "terminal-header";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Whether `data` carries any visible content (excluding footer-only). */
function hasContent(data: TerminalData | undefined): boolean {
  if (data === undefined) return false;
  return (data.stdout?.length ?? 0) > 0 || (data.stderr?.length ?? 0) > 0;
}

/**
 * Count visible lines in a `TerminalData` without parsing ANSI. Used
 * by the fold cue's threshold check — `parseTerminalLines` runs
 * `ansiToHtml` per line which is wasted work just to get a count.
 * Mirrors `parseTerminalLines`'s trailing-newline rule so the count
 * agrees with what the renderer eventually produces.
 */
export function quickLineCount(data: TerminalData | undefined): number {
  if (data === undefined) return 0;
  let total = 0;
  if (data.stdout.length > 0) {
    const parts = data.stdout.split("\n");
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    total += parts.length;
  }
  if (data.stderr.length > 0) {
    const parts = data.stderr.split("\n");
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    total += parts.length;
  }
  return total;
}

/**
 * Coerce an unknown PropertyStore value into a `TerminalData` shape
 * with safe defaults. Anything off-shape becomes the empty terminal.
 */
function coerceTerminalData(value: unknown): TerminalData {
  if (value === null || value === undefined || typeof value !== "object") {
    return { stdout: "", stderr: "" };
  }
  const v = value as Record<string, unknown>;
  return {
    stdout: typeof v.stdout === "string" ? v.stdout : "",
    stderr: typeof v.stderr === "string" ? v.stderr : "",
    exitCode: typeof v.exitCode === "number" ? v.exitCode : undefined,
    durationMs: typeof v.durationMs === "number" ? v.durationMs : undefined,
    interrupted: typeof v.interrupted === "boolean" ? v.interrupted : undefined,
  };
}

/** One parsed terminal line — sanitized HTML + the source stream. */
interface ParsedLine {
  html: string;
  source: "stdout" | "stderr";
}

/**
 * Split each stream by newline, run each line through `ansiToHtml`,
 * and tag with its source so the renderer can class it. Trailing
 * empty line from a `\n`-terminated stream is dropped — terminals
 * normally don't paint that blank.
 */
export function parseTerminalLines(data: TerminalData): ParsedLine[] {
  const lines: ParsedLine[] = [];
  if (data.stdout.length > 0) {
    const parts = data.stdout.split("\n");
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    for (const part of parts) {
      lines.push({ html: ansiToHtml(part), source: "stdout" });
    }
  }
  if (data.stderr.length > 0) {
    const parts = data.stderr.split("\n");
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    for (const part of parts) {
      lines.push({ html: ansiToHtml(part), source: "stderr" });
    }
  }
  return lines;
}

/**
 * Format milliseconds as a compact human duration (e.g. "428 ms",
 * "1.2 s", "5m 03s"). Picks the largest unit whose value is ≥ 1.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

// ---------------------------------------------------------------------------
// Imperative DOM rendering
// ---------------------------------------------------------------------------

/** Build a single line element. */
function buildLineElement(line: ParsedLine): HTMLElement {
  const el = document.createElement("div");
  el.className = `tugx-term-line tugx-term-line--${line.source}`;
  el.innerHTML = line.html;
  // Render an empty line as a single &nbsp;-equivalent box so it
  // takes up a line height and doesn't collapse — terminals show
  // blank lines as actual blank rows.
  if (line.html === "") el.innerHTML = "&nbsp;";
  return el;
}

/** Build the truncation banner shown above the scroll body. */
function buildTruncationIndicator(droppedCount: number): HTMLElement {
  const el = document.createElement("div");
  el.className = "tugx-term-truncation";
  el.dataset.slot = "terminal-truncation";
  el.textContent = `… ${droppedCount.toLocaleString()} earlier line${
    droppedCount === 1 ? "" : "s"
  } truncated`;
  return el;
}

/** Build the footer (exit code badge + duration + interrupted). */
function buildFooter(data: TerminalData): HTMLElement | null {
  const hasFooter =
    data.exitCode !== undefined ||
    data.durationMs !== undefined ||
    data.interrupted === true;
  if (!hasFooter) return null;

  const footer = document.createElement("div");
  footer.className = "tugx-term-footer";
  footer.dataset.slot = "terminal-footer";

  if (data.exitCode !== undefined) {
    const exit = document.createElement("span");
    const isZero = data.exitCode === 0;
    exit.className = `tugx-term-exit tugx-term-exit--${isZero ? "zero" : "nonzero"}`;
    exit.dataset.slot = "terminal-exit";
    exit.textContent = `exit ${data.exitCode}`;
    footer.appendChild(exit);
  }

  if (data.interrupted === true) {
    const intr = document.createElement("span");
    intr.className = "tugx-term-interrupted";
    intr.dataset.slot = "terminal-interrupted";
    intr.textContent = "interrupted";
    footer.appendChild(intr);
  }

  if (data.durationMs !== undefined) {
    const dur = document.createElement("span");
    dur.className = "tugx-term-duration";
    dur.dataset.slot = "terminal-duration";
    dur.textContent = formatDuration(data.durationMs);
    footer.appendChild(dur);
  }

  return footer;
}

/**
 * Append the line body — every line in document flow. The transcript
 * (the host) owns vertical scroll; the block never scrolls vertically
 * inside itself. Long lines scroll horizontally within the `<pre>`
 * (un-wrappable columnar output), via the CSS `overflow-x: auto`.
 */
function appendLineBody(container: HTMLElement, lines: ParsedLine[]): void {
  const pre = document.createElement("pre");
  pre.className = "tugx-term-pre";
  pre.dataset.slot = "terminal-pre";
  for (const line of lines) {
    pre.appendChild(buildLineElement(line));
  }
  container.appendChild(pre);
  // Stamp whether this run actually overflows, and switch the pre to
  // `overflow-x: scroll` when it does (see `[data-hscroll]` in the CSS pair).
  // `overflow-x: auto` alone is not enough here: the engine decides whether to
  // give an `auto` box a scrollbar during the layout that first sizes it, and
  // these lines are appended imperatively into a `contain: layout style`
  // transcript entry — content the engine has already sized. The clipped run
  // paints with no scrollbar until something else forces the entry to lay out
  // again (resizing the card, which is exactly when it appeared).
  //
  // The `scrollWidth` read below is a deliberate synchronous layout flush: it
  // is the measurement AND the invalidation, so the decision is made from the
  // real geometry in the same turn the lines land, not one frame later. rAF is
  // not an option — a background window never runs one.
  pre.dataset.hscroll = pre.scrollWidth > pre.clientWidth ? "true" : "false";
}

/**
 * Top-level imperative render. Rebuilds `body` from scratch each
 * call and stamps `data-empty` on the `outer` root. The header is
 * NOT touched here — React owns the header markup (label + Copy
 * `<TugIconButton>`); this function rebuilds only what lives below
 * the header (truncation banner, line container, post-mortem footer).
 * Every line renders in document flow — no inner scroller; the
 * transcript owns vertical scroll.
 *
 * **Collapsed preview path.** When `collapsed` is true, the renderer
 * renders just the first `previewLineCap` lines — the same lines the
 * user would see at the top of the expanded output. Truncation banner
 * is suppressed (the fold cue carries the "more exists below" signal).
 * Footer is suppressed (post-mortem badges sit at the END of the
 * output; revealing them during a TOP-of-file preview would mislead
 * the reader into thinking the command had completed within the
 * preview). Expanding the block restores the full render (truncation
 * banner, all lines, footer) on the next call.
 */
function renderTerminal(
  outer: HTMLElement,
  body: HTMLElement,
  data: TerminalData,
  collapsed: boolean = false,
  previewLineCap: number = DEFAULT_COLLAPSE_THRESHOLD,
): void {
  body.replaceChildren();
  // Empty terminal: render the footer if any post-mortem fields are
  // set, but leave the body empty. (A bash command that emitted no
  // output but exited with code 0 is meaningful — exit-code 0 badge
  // tells the user it succeeded.)
  const empty = !hasContent(data);
  outer.dataset.empty = empty ? "true" : "false";

  let lines: ParsedLine[] = [];
  let truncated = 0;
  if (!empty) {
    const allLines = parseTerminalLines(data);
    if (allLines.length > RETAINED_LINE_CAP) {
      truncated = allLines.length - RETAINED_LINE_CAP;
      lines = allLines.slice(-RETAINED_LINE_CAP);
    } else {
      lines = allLines;
    }
  }

  // Collapsed preview path — slice to the first `previewLineCap`
  // lines, skip the truncation banner + footer. The fold cue (in the
  // React-owned header) and the CSS mask-image fade together signal
  // "more below; click to expand."
  if (collapsed && lines.length > 0) {
    appendLineBody(body, lines.slice(0, previewLineCap));
    return;
  }

  if (truncated > 0) {
    body.appendChild(buildTruncationIndicator(truncated));
  }

  if (lines.length > 0) {
    appendLineBody(body, lines);
  }

  const footer = buildFooter(data);
  if (footer !== null) body.appendChild(footer);
}

/**
 * Compose the clipboard text. Prefer stdout, then stderr — neither
 * is annotated with a header because the typical use case is "give
 * me the command's output as I'd see it in a terminal."
 */
function composeCopyText(data: TerminalData): string {
  const parts: string[] = [];
  if (data.stdout.length > 0) parts.push(data.stdout);
  if (data.stderr.length > 0) parts.push(data.stderr);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------

const EMPTY_TERMINAL: TerminalData = { stdout: "", stderr: "" };

/** A responder that exists for identity alone handles nothing. Hoisted so
 *  the registration is not a fresh object on every render. */
const EMPTY_ACTIONS: Partial<Record<TugAction, ActionHandler>> = {};

export const TerminalBlock: React.FC<TerminalBlockProps> = ({
  data,
  streamingStore,
  streamingPath = DEFAULT_STREAMING_PATH,
  className,
  embedded = false,
  findable = false,
  headerLabel,
  collapsed: collapsedProp,
  onToggleCollapsed,
  collapseThreshold = DEFAULT_COLLAPSE_THRESHOLD,
  componentStatePreservationKey,
}) => {
  // Outer card — React owns the markup (header + body container);
  // imperative `renderTerminal` writes lines/footer into `bodyRef`.
  const outerRef = React.useRef<HTMLDivElement | null>(null);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  // Latest data for the Copy callback to read. Updated inside both
  // effects so streaming sees the freshest stdout/stderr without
  // forcing a React re-render of the shell.
  const latestDataRef = React.useRef<TerminalData>(EMPTY_TERMINAL);

  // The data prop captured at FIRST mount. Static mode renders this
  // value once and never again, even across collapse-driven
  // re-renders. Without this ref the collapse-aware re-render would
  // pick up subsequent prop changes — that's a contract violation of
  // the mount-once shape and would also force re-parses the
  // streaming path is supposed to own.
  const initialDataRef = React.useRef<TerminalData | undefined>(data);

  // ---- Fold state ([L06] data, not appearance: it controls *what*
  //                  is rendered, not *how* a rendered element
  //                  looks) ---------------------------------------------
  //
  // `overThreshold` is derived from the static line count (cheap
  // `quickLineCount`, no ANSI parse) and seeds the uncontrolled fold
  // default — long output folds, short output does not. Streaming
  // mode (`streamingStore` set) reads `lineCount` as 0 because the
  // imperative renderer owns the growing line pool, not React state;
  // the fold cue therefore stays hidden in streaming mode until a
  // follow-up wires a streaming line-count subscription.
  //
  // `useBlockFoldState` owns the rest — controlled / uncontrolled
  // resolution, mount-in-saved-state, and [A9] capture — shared with
  // the other fold-bearing body kinds.
  const lineCount = React.useMemo(
    () => quickLineCount(initialDataRef.current),
    [],
  );
  const overThreshold = lineCount > collapseThreshold;

  const { collapsed, setCollapsed } = useBlockFoldState({
    collapsed: collapsedProp,
    defaultCollapsed: overThreshold,
    onToggleCollapsed,
    componentStatePreservationKey,
  });

  // Find-target registration ([L03]): a folded terminal renders only its
  // first-lines preview, so a counted match can sit beyond the fold;
  // navigation resolves this target to open the fold on demand. No-op
  // outside a transcript host.
  const findCollapseHandle = React.useContext(ToolBlockCollapseContext);
  const findContextToolUseId = React.useContext(ToolUseIdContext);
  useFindTargetRegistration(
    findCollapseHandle?.toolUseId ?? findContextToolUseId,
    { unfold: () => setCollapsed(false) },
  );

  // Chrome actions target — non-null when this TerminalBlock is
  // composed inside a `BlockChrome` that has rendered its actions
  // slot. The Copy `<TugIconButton>` portals into the chrome header
  // rather than hosting it in a separate body-kind strip. Standalone
  // composition keeps the header strip and renders Copy at its
  // trailing edge.
  const chromeActionsTarget = useChromeActionsTarget();

  // Dev-mode misconfiguration check — `embedded={true}` requires a
  // parent `BlockChrome` so Copy has a portal target. The
  // setTimeout defers past the chrome's first-render
  // ref-callback → state-update → re-render cycle so the warn
  // doesn't fire spuriously when the chrome IS present. See
  // `file-block.tsx`'s version for the full rationale.
  React.useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (!embedded) return;
    if (chromeActionsTarget !== null) return;
    const handle = window.setTimeout(() => {
      console.warn(
        "TerminalBlock: `embedded={true}` requires a parent `BlockChrome`. " +
          "Without one, the body kind's identity header is suppressed AND its " +
          "Copy button has nowhere to portal — the user loses access to it " +
          "silently. Either compose under a chrome or set `embedded={false}`.",
      );
    }, 0);
    return () => {
      window.clearTimeout(handle);
    };
  }, [embedded, chromeActionsTarget]);

  // Standalone always renders an identity header — even without a
  // `headerLabel`, the header strip hosts Copy at the trailing edge.
  // Embedded mode suppresses the header — the chrome owns identity
  // and Copy portals into the chrome's actions slot instead.
  const showHeader = !embedded;

  // Static mode — re-runs whenever `collapsed` flips, so the imperative
  // body switches between the full render and the preview render
  // without a React re-mount. `data` is read from `initialDataRef`
  // (captured once at first mount) so the mount-once contract for the
  // `data` prop is preserved: subsequent `data` prop changes are
  // ignored even during a collapse-triggered re-render. Streaming
  // mode owns the body render through the effect below.
  React.useLayoutEffect(() => {
    if (streamingStore !== undefined) return;
    const outer = outerRef.current;
    const body = bodyRef.current;
    if (outer === null || body === null) return;
    const d = initialDataRef.current ?? EMPTY_TERMINAL;
    latestDataRef.current = d;
    renderTerminal(outer, body, d, collapsed, collapseThreshold);
  }, [collapsed, collapseThreshold, streamingStore]);

  // Streaming mode — Spec S05 binding. Reads sync on mount,
  // subscribes for updates, rAF-coalesces.
  //
  // `collapsed` is read through a latest-ref ([L07]) inside `rerender`
  // so a fold-toggle in streaming mode flips the preview without
  // re-subscribing to the store. Default for streaming today is
  // `collapsed = false` (the threshold check sees `lineCount = 0`
  // because quickLineCount runs against the static-data prop); the
  // ref is in place so a future phase that hooks a streaming line
  // count into local state can flip the preview cleanly.
  const collapsedStreamingRef = React.useRef(collapsed);
  React.useLayoutEffect(() => {
    collapsedStreamingRef.current = collapsed;
  }, [collapsed]);

  React.useLayoutEffect(() => {
    if (streamingStore === undefined) return;
    const outer = outerRef.current;
    const body = bodyRef.current;
    if (outer === null || body === null) return;
    const store = streamingStore;

    function rerender(): void {
      const outerEl = outerRef.current;
      const bodyEl = bodyRef.current;
      if (outerEl === null || bodyEl === null) return;
      const next = coerceTerminalData(store.get(streamingPath));
      latestDataRef.current = next;
      renderTerminal(
        outerEl,
        bodyEl,
        next,
        collapsedStreamingRef.current,
        collapseThreshold,
      );
    }

    rerender();

    let pendingRaf: number | null = null;
    const unsubscribe = store.observe(streamingPath, () => {
      if (pendingRaf !== null) return;
      pendingRaf = requestAnimationFrame(() => {
        pendingRaf = null;
        rerender();
      });
    });

    return () => {
      if (pendingRaf !== null) {
        cancelAnimationFrame(pendingRaf);
        pendingRaf = null;
      }
      unsubscribe();
    };
  }, [streamingStore, streamingPath, collapseThreshold]);

  // Streaming-mode re-render on collapse toggle. The store-subscription
  // effect above is the source of truth for streaming output, but a
  // bare collapse toggle doesn't fire the store callback — we have to
  // re-render explicitly. This effect runs ONLY when both `collapsed`
  // changes AND `streamingStore` is set; the static-mode effect above
  // owns the non-streaming case. Skips the first run because the
  // store-subscription effect's `rerender()` already covered it.
  const streamingCollapsedRenderedOnceRef = React.useRef(false);
  React.useLayoutEffect(() => {
    if (streamingStore === undefined) return;
    if (!streamingCollapsedRenderedOnceRef.current) {
      streamingCollapsedRenderedOnceRef.current = true;
      return;
    }
    const outer = outerRef.current;
    const body = bodyRef.current;
    if (outer === null || body === null) return;
    const next = coerceTerminalData(streamingStore.get(streamingPath));
    latestDataRef.current = next;
    renderTerminal(outer, body, next, collapsed, collapseThreshold);
  }, [collapsed, collapseThreshold, streamingStore, streamingPath]);

  // `getText` closure for the `BlockCopyButton` affordance —
  // reads the latest streamed-or-static data at click time. The
  // affordance owns the confirmation flash + timer cleanup +
  // clipboard call; this function is the only block-specific bit.
  const getCopyText = React.useCallback(
    () => composeCopyText(latestDataRef.current),
    [],
  );

  // ---- Responder identity ----------------------------------------------
  //
  // TerminalBlock owns the `text` data the `COPY` action operates on,
  // so it registers as a responder for `COPY`: a stable `useId`, a
  // `Partial<Record<TugAction, ActionHandler>>` registered via
  // `useOptionalResponder`, a `ResponderScope` wrapping the root.
  // Cmd-C while the block is first-responder runs the silent COPY
  // path; the confirmation flash is a click-affordance concern that
  // lives inside `BlockCopyButton`.
  const terminalBlockResponderId = React.useId();

  // Chain manager — promotes TerminalBlock to first-responder after a
  // focus-refusing affordance click (the fold cue / Copy carry
  // `data-tug-focus="refuse"`, so the chain provider's pointerdown
  // listener skips chain promotion on their clicks). Same pattern as
  // FileBlock; null outside a `ResponderChainProvider` (gallery /
  // unit tests).
  const chainManager = useResponderChain();

  // ---- Responder registration ([L11]) ---------------------------------
  //
  // The node exists for IDENTITY — collapsing the block makes it first
  // responder — and handles nothing. It used to register `COPY`, on the
  // belief that ⌘C over the block would copy the output. It never could:
  // ⌘C is Edit ▸ Copy's key equivalent, performed by AppKit as
  // `NSText.copy(_:)` against the document selection, and the chord
  // pipeline bails on natively-routed commands before the chain. So
  // the handler never ran, and the only thing the claim achieved was to
  // terminate the Edit-menu validation walk and report Copy as available
  // over a block that would not answer it. Copying the output is the
  // `BlockCopyButton` above, which works and says so.
  const terminalBlockResponder = useOptionalResponder({
    id: terminalBlockResponderId,
    actions: EMPTY_ACTIONS,
  });

  // ---- Position-stable click infrastructure ---------------------------
  //
  // Position-stable click is now encapsulated inside the affordance
  // components (BlockCopyButton, BlockFoldCue) — each calls
  // `useOuterScrollport` + `usePositionStableClick` internally. The
  // scrollport-level tail spacer combo (wired by session-card-transcript)
  // still applies: the spacer raises `maxScrollTop` so a collapse
  // doesn't hit a hard clamp, and the position-stable hook inside
  // `BlockFoldCue` writes the exact `scrollTop` that holds the
  // cluster under the user's cursor across the height change.

  // Fold-cue toggle callback. The `BlockFoldCue` affordance has
  // already released the host scroller's follow-bottom lock and
  // routed the call through the position-stable wrapper. This
  // callback adds the one block-specific concern `useBlockFoldState`
  // can't own — promoting TerminalBlock to first-responder so a
  // Cmd-C right after the click reaches its COPY handler — then
  // delegates the state mutation + host notification to `setCollapsed`.
  const handleFoldToggle = React.useCallback((next: boolean) => {
    chainManager?.makeFirstResponder(terminalBlockResponderId);
    setCollapsed(next);
  }, [chainManager, setCollapsed, terminalBlockResponderId]);

  // Compose the affordances cluster ONCE. Ordering: Copy
  // (the feature affordance) → fold cue (the fixed-position landmark
  // at the trailing edge). Mirrors FileBlock / DiffBlock so the
  // user's eye finds the fold cue in the same place across every
  // body kind. All three use the `body-kinds/affordances/` library.
  // Fold-cue labels. Collapsed: the count of lines hidden below the
  // preview ("275 more lines") — the cue tells the reader what they
  // gain by expanding. Expanded: the verb "Collapse" — the cue tells
  // them what the click does. Both are handed to `BlockFoldCue`,
  // which renders the state's label and reserves the wider one's
  // width so toggling never resizes the button. `overThreshold`
  // gates the cue, so the collapsed label always has a real
  // remainder when shown.
  const hiddenLineCount = Math.max(0, lineCount - collapseThreshold);
  const cueCollapsedLabel = `${hiddenLineCount.toLocaleString()} more ${
    hiddenLineCount === 1 ? "line" : "lines"
  }`;
  // Copy is disabled when there's nothing to copy. Static-mode check
  // uses the `data` prop directly. Streaming-mode keeps Copy enabled
  // because content arrives over time via `streamingStore` and the
  // React shell doesn't re-render on those updates — disabling
  // optimistically would lock Copy out as soon as a stream starts
  // empty.
  const isStreaming = streamingStore !== undefined;
  const copyDisabled = !isStreaming && !hasContent(data);
  // Under a chrome the header owns Copy + the whole-block fold, and the
  // terminal has no body-specific controls — so it portals nothing. The
  // standalone composition (gallery) still carries Copy + the fold cue.
  const affordances = embedded ? null : (
    <>
      <BlockCopyButton
        disabled={copyDisabled}
        aria-label="Copy terminal output"
        getText={getCopyText}
      />
      {overThreshold ? (
        <BlockFoldCue
          className="tugx-term-fold-cue"
          data-slot="terminal-fold-cue"
          collapsed={collapsed}
          onToggle={handleFoldToggle}
          collapsedLabel={cueCollapsedLabel}
          expandedLabel="Collapse"
          ariaLabelCollapse="Collapse terminal output"
          ariaLabelExpand="Expand terminal output"
        />
      ) : null}
    </>
  );

  const portaledAffordances =
    embedded && chromeActionsTarget !== null && affordances !== null
      ? createPortal(
          <BlockActionsCluster data-slot="terminal-actions">
            {affordances}
          </BlockActionsCluster>,
          chromeActionsTarget,
        )
      : null;

  // Composed root ref — forwards to both the local `outerRef` (read
  // by the imperative renderer for the current element) AND the
  // responder chain's ref-callback (writes `data-responder-id` on
  // the same element). Same pattern as FileBlock's `composedRootRef`.
  const composedRootRef = (el: HTMLDivElement | null): void => {
    outerRef.current = el;
    terminalBlockResponder.responderRef(el);
  };

  return (
    <terminalBlockResponder.ResponderScope>
      <div
        ref={composedRootRef}
        data-slot={DATA_SLOT_ROOT}
        data-empty="true"
        data-embedded={embedded ? "true" : undefined}
        data-collapsed={overThreshold ? (collapsed ? "true" : "false") : undefined}
        className={
          className === undefined ? "tugx-term" : `tugx-term ${className}`
        }
      >
        {showHeader ? (
          <div
            className="tugx-term-header"
            data-slot={DATA_SLOT_HEADER}
          >
            {headerLabel !== undefined ? (
              <span
                className="tugx-term-header-label"
                data-slot="terminal-header-label"
              >
                {headerLabel}
              </span>
            ) : null}
            <span className="tugx-term-header-spacer" />
            <BlockActionsCluster data-slot="terminal-actions">
              {affordances}
            </BlockActionsCluster>
          </div>
        ) : null}
        {portaledAffordances}
        <div
          ref={bodyRef}
          className="tugx-term-content"
          data-slot="terminal-content"
          data-tugx-findable={findable ? "" : undefined}
        />
      </div>
    </terminalBlockResponder.ResponderScope>
  );
};
