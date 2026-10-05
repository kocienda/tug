/**
 * `BashToolBlock` — Layer-2 wrapper for the Bash tool.
 *
 * Composes `BlockChrome` (header / footer / status) around a
 * smart-picked body kind — usually `TerminalBlock`, but `DiffBlock`
 * when the output looks like a unified diff. Per [Spec S03] / [Table
 * T02]:
 *
 *   - **Header:** terminal icon + tool name "Bash" + the shell
 *     command pulled from `input.command` (truncated with hover-
 *     expand via CSS — no JS state).
 *   - **Body:** `TerminalBlock` fed from
 *     `tool_use_structured.{stdout,stderr}` when present, otherwise
 *     falling back to the plain-text `tool_result.output`. When that
 *     stdout looks like a unified diff (i.e. `git diff`, `git show`,
 *     `git log -p`), `DiffBlock` renders instead — see the
 *     diff-routing helpers below.
 *   - **Footer badges:** "(no output)" hint for empty-success cases and
 *     `durationMs` when known. The exit code and `interrupted` reading
 *     live in the header's result summary, not the footer — repeating
 *     them at the bottom read as a tiny duplicate. The footer chrome is
 *     hidden entirely when neither would render (the dominant
 *     `exit 0 + has output` case).
 *
 * Streaming behavior:
 *
 *   - `status === "streaming"` → header still shows whatever input
 *     fragment has arrived (typically an empty `command` until
 *     enough of the input has streamed in); the body is `null` (the
 *     header dot is the in-flight signal). Once the running command
 *     reports its own progress (`tugtool progress`, `tugtool test
 *     run`), the latest report rides the chrome's live band
 *     ({@link BashLiveBand}) — between header and body, so it reads
 *     while the block is collapsed.
 *   - `status === "ready"` → steady-state render.
 *   - `status === "error"` → chrome paints the error stripe, the
 *     plain-text `tool_result.output` (if any) renders as the inline
 *     error message, and the body still renders the structured /
 *     text output below in case it's diagnostic.
 *
 * Preview mode (`preview === true`):
 *
 *   - The permission dialog mounts this wrapper as the approve/deny
 *     preview of a *pending* `Bash` call. The command has not run, so
 *     the body is `null` and the "(no output)" footer hint is held —
 *     only the header + command (the thing being approved) renders.
 *     See `ToolBlockProps.preview`.
 *
 * Registration:
 *
 *   `session-assistant-renderer-dispatch.ts` imports this module
 *   eagerly and calls `registerToolBlock("bash", BashToolBlock)`
 *   from its own initialization block. Routing the registration
 *   through dispatch (rather than self-registering at the bottom of
 *   this module) avoids the import cycle: this module imports types
 *   from dispatch / the chrome, and the dispatch imports this
 *   wrapper — at top level, the chain has to flow one direction.
 *   Real callers reach `BashToolBlock` via
 *   `resolveToolBlock("Bash")` from the dispatch.
 *
 * Laws:
 *  - [L06] no React state for appearance — chrome owns DOM
 *    attributes; body composition is pure props.
 *  - [L19] file pair (`.tsx` + `.css`), exported props interface,
 *    `data-slot="bash-tool-block"` (delegated to the chrome's
 *    `rootSlot`).
 *  - [L20] reuses the chrome's `--tugx-block-*` and the body's
 *    `--tugx-term-*`; introduces no new tokens beyond the
 *    bash-specific footer-badge slots already in
 *    `--tugx-term-exit-*` and `--tugx-term-interrupted-*`.
 *
 * Decisions:
 *  - [D05] two-layer hybrid — body kind owns the prose-rendering
 *    cost, wrapper owns chrome.
 *
 * @module components/tugways/cards/blocks/bash-tool-block
 */

import "./bash-tool-block.css";

import React from "react";

import { useAnnotatedElement } from "@/components/tugways/annotation-scope";

import {
  TerminalBlock,
  type TerminalData,
} from "@/components/tugways/body-kinds/terminal-block";
import { DiffBlock } from "@/components/tugways/body-kinds/diff-block";
import { parseUnifiedDiffText } from "@/lib/diff/parse-unified-diff";
import type { DiffHunk } from "@/lib/diff/types";
import {
  CommitBlock,
  CommitHeaderTarget,
  parseGitCommit,
  type CommitData,
} from "@/components/tugways/body-kinds/commit-block";

import { BlockChrome } from "../../blocks/block-chrome";
import { BlockNoticeBand, type BlockNotice } from "../../blocks/block-notice";
import { useRunProgress } from "../../blocks/run-progress-context";
import { formatRunProgressLine } from "@/lib/run-progress-store";
import type { ToolResultSummary } from "../../blocks/tool-result-summary";
import type { ToolBlockProps } from "../../blocks/types";

// ---------------------------------------------------------------------------
// Wire-shape narrowings — the structured_result for Bash carries
// stdout / stderr / interrupted + a few flags we don't surface yet.
// The shape is from the v2.1.x stream-json catalog
// (`test-09-bash-auto-approved.jsonl`) and matches Anthropic's
// CC `Bash` tool emission.
// ---------------------------------------------------------------------------

/** Bash tool input (from `tool_use.input`). */
export interface BashToolInput {
  command?: string;
  description?: string;
  /** Optional timeout in ms — not surfaced in the chrome today. */
  timeout?: number;
}

/** Bash tool structured result (from `tool_use_structured`). */
export interface BashStructuredResult {
  stdout?: string;
  stderr?: string;
  interrupted?: boolean;
  isImage?: boolean;
  noOutputExpected?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers — narrow the wrapper-side `unknown` props to the Bash shapes.
// ---------------------------------------------------------------------------

export function narrowBashInput(value: unknown): BashToolInput {
  if (value === null || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  return {
    command: typeof v.command === "string" ? v.command : undefined,
    description: typeof v.description === "string" ? v.description : undefined,
    timeout: typeof v.timeout === "number" ? v.timeout : undefined,
  };
}

export function narrowStructured(value: unknown): BashStructuredResult {
  if (value === null || typeof value !== "object") return {};
  const v = value as Record<string, unknown>;
  return {
    stdout: typeof v.stdout === "string" ? v.stdout : undefined,
    stderr: typeof v.stderr === "string" ? v.stderr : undefined,
    interrupted:
      typeof v.interrupted === "boolean" ? v.interrupted : undefined,
    isImage: typeof v.isImage === "boolean" ? v.isImage : undefined,
    noOutputExpected:
      typeof v.noOutputExpected === "boolean" ? v.noOutputExpected : undefined,
  };
}

/**
 * Compose the `TerminalData` payload for the body. Prefer the
 * structured result; fall back to `textOutput` for `stdout` if the
 * structured shape is absent (older catalogs / drift).
 */
export function composeTerminalData(
  structured: BashStructuredResult | undefined,
  textOutput: string | undefined,
  isError: boolean,
): TerminalData {
  const stdout =
    structured?.stdout ?? (textOutput !== undefined ? textOutput : "");
  const stderr = structured?.stderr ?? "";
  const interrupted = structured?.interrupted === true;
  // Synthesize an exit code: Anthropic's Bash tool result carries
  // `is_error` rather than the underlying shell exit code, so 0
  // signals success and any other indicator (1) signals failure.
  // The actual code is unknown; the badge color is what matters
  // (zero subtle / nonzero strong per [Table T02]).
  const exitCode = interrupted ? undefined : isError ? 1 : 0;
  return {
    stdout,
    stderr,
    exitCode,
    interrupted: interrupted ? true : undefined,
  };
}

/**
 * Synthesize a footer-badge prop bundle for `TerminalBlock` to skip
 * — `BashToolBlock`'s chrome owns the post-mortem badges so we
 * deliberately do NOT pass `exitCode` / `interrupted` into the body.
 * The body just shows stdout/stderr; the chrome footer holds the
 * post-mortem signals.
 */
function bodyDataWithoutFooter(data: TerminalData): TerminalData {
  return { stdout: data.stdout, stderr: data.stderr };
}

// ---------------------------------------------------------------------------
// Unified-diff detection
//
// Smart-pick routing: when the bash output looks like a unified diff (i.e.
// the user ran `git diff`, `git show`, `git log -p`, or any pipeline that
// emits the standard diff shape), the wrapper renders `DiffBlock` instead
// of `TerminalBlock`. The check is heuristic-then-parse:
//
//  1. `isUnifiedDiffOutput(text)` — fast string scan, scoped to the first
//     ~2 KB so a 10 MB log doesn't pay the full regex cost.
//  2. `parseUnifiedDiffText(text)` — actually parses the hunks. If the
//     heuristic matched but no hunks come out (false positive), fall back
//     to `TerminalBlock` so nothing renders blank.
//
// The fallback is what makes this safe to enable by default: the worst
// case for benign bash output is "still renders as terminal" — never a
// regression. Streaming is excluded; partial output can include an `@@`
// marker mid-line and we'd rather wait for the complete payload.
// ---------------------------------------------------------------------------

/**
 * How many leading bytes of `textOutput` the detection regex inspects.
 * Bounded so a multi-MB bash log doesn't pay the full scan cost — the
 * markers we're looking for (commit header, `diff --git`, first `@@`)
 * always appear in the first few lines of a real diff.
 */
const DIFF_DETECT_SCAN_LIMIT = 2048;

/** `diff --git ` line — only `git diff` / `git show` / `git log -p` emit this. */
const DIFF_GIT_PREFIX_RE = /^diff --git /m;
/** Unified-diff hunk header — `@@ -<n>[,<n>] +<n>[,<n>] @@`. */
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;
/** `commit <sha>` opener for `git show` / `git log -p`; 7–40 hex chars. */
const COMMIT_HEADER_RE = /^commit [0-9a-f]{7,40}\b/m;

/**
 * Heuristic gate: does the bash output look like a unified diff?
 *
 * Scans the first ~2 KB for any of three markers — `diff --git `, a
 * full `@@ -n,n +n,n @@` hunk header, or `commit <sha>` at line start.
 * The parser runs after the gate and is the source of truth — this
 * check exists only to skip the parse cost for the dominant non-diff
 * case.
 *
 * Returns false for `undefined` / empty strings.
 */
export function isUnifiedDiffOutput(text: string | undefined): boolean {
  if (text === undefined || text.length === 0) return false;
  const slice = text.length > DIFF_DETECT_SCAN_LIMIT
    ? text.slice(0, DIFF_DETECT_SCAN_LIMIT)
    : text;
  return (
    DIFF_GIT_PREFIX_RE.test(slice) ||
    HUNK_HEADER_RE.test(slice) ||
    COMMIT_HEADER_RE.test(slice)
  );
}

/**
 * Try to parse the bash output as a unified diff. Returns the hunks
 * when the heuristic matches AND the parser yields at least one hunk;
 * returns `null` when either condition fails so the caller falls
 * back to `TerminalBlock`.
 */
export function tryParseBashDiff(
  text: string | undefined,
): DiffHunk[] | null {
  if (!isUnifiedDiffOutput(text)) return null;
  const hunks = parseUnifiedDiffText(text!);
  return hunks.length > 0 ? hunks : null;
}

/**
 * The running command's latest progress report, as one line on the notice
 * band's surface. It subscribes to its own call's entry, so a report a
 * second re-renders this band and nothing else; with no report yet it
 * renders nothing, and the block looks as it always has.
 */
export const BashLiveBand: React.FC<{ toolUseId: string }> = ({ toolUseId }) => {
  const progress = useRunProgress(toolUseId);
  if (progress?.text === undefined) return null;
  return (
    <div data-slot="bash-live-band" className="bash-live-band">
      <BlockNoticeBand tone="info" maxLines={1} text={formatRunProgressLine(progress)} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const BashToolBlock: React.FC<ToolBlockProps> = ({
  toolUseId,
  toolName,
  input,
  structuredResult,
  textOutput,
  isError = false,
  durationMs,
  status,
  phase,
  caution,
  preview = false,
}) => {
  const bashInput = React.useMemo(() => narrowBashInput(input), [input]);
  const structured = React.useMemo(
    () => narrowStructured(structuredResult),
    [structuredResult],
  );
  const terminalData = React.useMemo(
    () => composeTerminalData(structured, textOutput, isError),
    [structured, textOutput, isError],
  );
  const bodyData = React.useMemo(
    () => bodyDataWithoutFooter(terminalData),
    [terminalData],
  );

  const commandRef = useAnnotatedElement<HTMLElement>([bashInput.command]);

  // The command renders on the header's wrapping command row. While the
  // block is collapsed it clamps to `--tugx-toolheader-clamp-lines` via the
  // shared `tool-call-header-clamp` class (a long heredoc would otherwise
  // fill the whole collapsed header); expanding shows the full command above
  // the output, so nothing is ever lost.
  // `data-tugx-findable` opts the command text into transcript Find. It is
  // header text, so it stays searchable while the block is collapsed;
  // `tool-header-projection` projects it in both states. (The commit-receipt
  // variant replaces the command row entirely, and projects only its name.)
  // The paths inside the command line are annotated in place, so a file a
  // command names opens on a click like a file named anywhere else. The
  // ref scans the rendered `<code>`; the command text is its only input.
  const command = bashInput.command !== undefined ? (
    <code
      ref={commandRef}
      data-slot="bash-tool-block-command"
      className="tool-call-header-clamp"
      data-tugx-findable=""
    >
      {bashInput.command}
    </code>
  ) : undefined;

  // On error, the failure rides the notice band so it's readable while
  // collapsed; the full output still renders in the body below (one expand
  // away), so the clamped band never hides detail.
  const notice: BlockNotice | undefined =
    status === "error" && textOutput !== undefined && textOutput.length > 0
      ? { tone: "error", text: textOutput }
      : undefined;

  // Whether the footer would surface anything visible. The exit code and
  // the `interrupted` reading now live in the header's result summary, so
  // the footer no longer repeats them — it carries only the "(no output)"
  // hint and the duration, the two signals the header doesn't show.
  const noBody =
    (terminalData.stdout?.length ?? 0) === 0 &&
    (terminalData.stderr?.length ?? 0) === 0 &&
    status !== "streaming";
  // In preview mode the command has not run — there is no result yet, so
  // the "(no output)" hint would read as a finished, output-less call. Hold
  // it (and the empty body below) so the preview shows only the command.
  const showNoOutputHint =
    !preview &&
    noBody &&
    terminalData.exitCode === 0 &&
    terminalData.interrupted !== true;
  const showDuration = durationMs !== undefined;
  const hasFooterContent = showNoOutputHint || showDuration;
  const footerBadges = hasFooterContent ? (
    <BashFooterBadges
      durationMs={durationMs}
      showNoOutputHint={showNoOutputHint}
    />
  ) : undefined;

  // Body selection. On error, the chrome's error band already shows
  // the failure message (from `textOutput`); rendering a TerminalBlock
  // fed by the same `textOutput` fallback would duplicate the same
  // text. So on error, only render the body when the structured
  // result carries genuinely-distinct stdout / stderr (a process that
  // wrote to its own streams before failing).
  //
  // Diff-routing: when the (already-composed) stdout looks like a
  // unified diff AND the parser yields at least one hunk, render
  // `DiffBlock` instead of `TerminalBlock`. Excluded for streaming
  // (incomplete output may include a stray `@@` marker mid-line) and
  // for the error-with-no-body branch (chrome already shows the
  // failure text). Memoize on the body's stdout so the parse runs
  // once per result, not on every parent re-render.
  const diffHunks = React.useMemo<DiffHunk[] | null>(() => {
    if (status === "streaming") return null;
    return tryParseBashDiff(bodyData.stdout);
  }, [bodyData.stdout, status]);

  // Commit-routing: a successful `git commit` renders the commit receipt
  // (`CommitBlock`) instead of a terminal dump — the same smart-pick idea as
  // diff-routing. Gated on a `ready` status (excludes streaming and the
  // error branch) and on `parseGitCommit` recognizing the `[branch hash]`
  // stdout line, so a failed / dry-run / non-commit command falls through to
  // the normal terminal rendering. The message comes from the command's
  // `-m`, the branch / hash / diffstat from stdout.
  const commit = React.useMemo<CommitData | null>(() => {
    if (status !== "ready") return null;
    const cmd = bashInput.command;
    if (cmd === undefined || !/\bgit\b[\s\S]*\bcommit\b/.test(cmd)) return null;
    return parseGitCommit(cmd, bodyData.stdout ?? "");
  }, [status, bashInput.command, bodyData.stdout]);

  let body: React.ReactNode;
  if (preview) {
    // Preview (permission dialog): the command has not run. Render the
    // header + command only — no body. The result-side surfaces are
    // suppressed because there is no result to show yet.
    body = null;
  } else if (commit !== null) {
    // Git commit receipt — summary + branch/hash badges in the header
    // (see the chrome props below), stat badges + message disclosure here.
    body = <CommitBlock commit={commit} />;
  } else if (status === "streaming") {
    // No body while streaming — the header's lifecycle dot is the
    // in-flight signal ([D02]).
    body = null;
  } else if (diffHunks !== null) {
    body = (
      <DiffBlock
        data={{ source: "hunks", hunks: diffHunks }}
        embedded
        className="bash-tool-block-diff"
        componentStatePreservationKey={`${toolUseId}-body`}
      />
    );
  } else {
    body = (
      <TerminalBlock
        data={bodyData}
        embedded
        findable
        className="bash-tool-block-terminal"
        componentStatePreservationKey={`${toolUseId}-body`}
      />
    );
  }

  // Header one-line result: only `interrupted`. No exit-code badge — the
  // Anthropic Bash result carries `is_error`, not the real shell exit code,
  // so any number we'd show is a synthesized placeholder (always "1"). The
  // real code lives in the error output (e.g. "Exit code 2"), now surfaced in
  // the collapse-visible notice band, so a fabricated "exit 1" in the header
  // would directly contradict it. On failure the lifecycle dot carries the
  // danger color and the notice carries the detail; on success the result is
  // implicit (no "exit 0" noise).
  const resultSummary: ToolResultSummary | undefined =
    terminalData.interrupted === true
      ? { kind: "text", text: "interrupted" }
      : undefined;

  // Commit receipt reshapes the chrome: the "Git Commit" name + the
  // summary/branch/hash header line (CommitHeaderTarget) replace the raw
  // command row, and the body's stat badges carry the result, so the
  // exit-summary and footer are suppressed. This is the `receipt` block
  // variant — it reads the tool defaults today (no receipt-specific emphasis
  // authored yet); the `[data-variant="receipt"]` scope is where any accent
  // treatment would land without touching this wrapper.
  if (commit !== null) {
    return (
      <BlockChrome
        rootSlot="bash-tool-block"
        variant="receipt"
        toolName="Git Commit"
        identity={<CommitHeaderTarget commit={commit} />}
        status={status}
        phase={phase}
        caution={caution}
        copyText={`${commit.hash} ${commit.summary}`}
      >
        {body}
      </BlockChrome>
    );
  }

  return (
    <BlockChrome
      rootSlot="bash-tool-block"
      toolName={toolName}
      command={command}
      resultSummary={resultSummary}
      status={status}
      phase={phase}
      caution={caution}
      notice={notice}
      liveBand={
        status === "streaming" && !preview ? (
          <BashLiveBand toolUseId={toolUseId} />
        ) : undefined
      }
      footerBadges={footerBadges}
    >
      {body}
    </BlockChrome>
  );
};

// ---------------------------------------------------------------------------
// Footer badges — bash-specific, painted from --tugx-term-* tokens
// the body kind already declares (no new --tugx-block-bash-*
// vocabulary needed; the wrapper rides the body's color tokens).
// ---------------------------------------------------------------------------

interface BashFooterBadgesProps {
  durationMs?: number;
  showNoOutputHint: boolean;
}

/**
 * Compose the footer badge row. Two signals can land here:
 *
 *   1. `(no output)` hint — the command succeeded with no stdout /
 *      stderr. Surfaced so the row doesn't read as "missing data"
 *      when the command had nothing to print (e.g. `cd /tmp`).
 *   2. `durationMs` — appended on the right when known.
 *
 * The exit code and the `interrupted` reading are NOT footer signals —
 * the header's result summary already shows them, so repeating them here
 * is redundant (and the "exit N" badge in particular read as a second,
 * tiny duplicate at the bottom of the block).
 *
 * The caller (`BashToolBlock`) is expected to pass `undefined` for
 * `footerBadges` when neither of these would render — that hides the
 * footer chrome entirely so successful runs with output don't paint
 * an empty bar.
 */
const BashFooterBadges: React.FC<BashFooterBadgesProps> = ({
  durationMs,
  showNoOutputHint,
}) => {
  const elements: React.ReactNode[] = [];
  if (showNoOutputHint) {
    elements.push(
      <span
        key="no-output"
        data-slot="bash-tool-block-no-output"
        className="bash-tool-block-no-output"
      >
        (no output)
      </span>,
    );
  }
  if (durationMs !== undefined) {
    elements.push(
      <span
        key="duration"
        data-slot="bash-tool-block-duration"
        className="bash-tool-block-duration"
      >
        {formatBashDuration(durationMs)}
      </span>,
    );
  }
  if (elements.length === 0) return null;
  return <>{elements}</>;
};

/** Compact duration formatter — mirrors `TerminalBlock`'s
 *  `formatDuration` semantics but inlined here so the footer doesn't
 *  cross-import a sibling body's implementation detail. */
export function formatBashDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

