/**
 * `AgentTranscriptBlock` — Layer-1 body kind for a subagent run.
 *
 * Renders the transcript of a `Task` / `Agent` tool call: the
 * subagent's content entries (text answers and any nested tool
 * calls), wrapped in identity / status chrome. `TaskToolBlock`
 * ([#step-17]) composes it `embedded`.
 *
 * Recursion ([D17]):
 *  - The body iterates the subagent's `entries[]`. A `text` entry
 *    renders as prose; a `tool_use` entry routes back through the
 *    *same* dispatch (`dispatchToolCallState`) at `depth + 1`, so a
 *    nested tool call gets its real per-tool block — and a nested
 *    `Agent` call resolves to `TaskToolBlock` → `AgentTranscriptBlock`
 *    again, one level deeper.
 *  - Recursion is bounded by `maxDepth` (default {@link AGENT_MAX_DEPTH}
 *    = 3). An `AgentTranscriptBlock` rendered past the cap
 *    (`depth > maxDepth`) starts *collapsed* — it shows only its
 *    header plus a "+N nested calls" `BlockFoldCue`. The user can
 *    still expand it, but nothing auto-expands past the cap, so a
 *    pathologically deep input can never melt the layout. Collapse is
 *    logical UI state ([L06]) persisted through the [A9] axis.
 *
 * Composition (mirrors `JsonTreeBlock` / `FileBlock`):
 *  - Header (standalone only) — agent type + duration + tool-call
 *    count, and a trailing actions cluster (the fold cue + Copy).
 *    Lifecycle status is the host chrome's header dot ([D02]) — this
 *    body kind paints no status text. In `embedded` mode the header is
 *    suppressed (the host `BlockChrome` owns identity); the
 *    nested-calls fold cue portals into the host chrome's actions slot
 *    only when the chrome is not itself collapsible (a nested call with
 *    no chrome chevron), per `BlockFoldSuppressedContext`.
 *  - Body — the `entries[]` column, or, when collapsed, nothing (the
 *    fold cue in the actions cluster is the sole affordance).
 *  - Footer — a thin token-summary strip; renders in both modes.
 *
 * Text rendering: a `text` entry renders as pre-wrapped prose. When
 * the [#step-3] assistant-text renderer ships, text entries can route
 * through it; until then prose is honest and dependency-free — this
 * body kind deliberately does not embed the virtualized
 * `TugMarkdownView` (it owns its own scroll container and imperative
 * ref contract, wrong for short inline entries).
 *
 * What this body kind does NOT do:
 *  - Render a text-entry surface ([#bk-conformance] item 2) — it
 *    *displays* a finished subagent run, it carries no input field.
 *  - Fold `parent_tool_use_id`-tagged sibling events into `entries[]`
 *    — that association is reducer work and out of scope here. The
 *    body kind renders whatever `entries[]` the wrapper composed.
 *
 * Laws:
 *  - [L06] collapse is logical state (which rows exist) → React state;
 *    hover colours are pure CSS.
 *  - [L11] owns no responder. Copy is a `BlockCopyButton`; the fold
 *    cue is a `BlockFoldCue` — both self-contained controls.
 *  - [L19] file pair (`.tsx` + `.css`), exported props interface,
 *    `data-slot="agent-transcript-body"` on the root, this docstring.
 *  - [L20] component-token sovereignty — owns `--tugx-agent-*`;
 *    consumes `--tugx-block-*` for the shared block scaffold.
 *  - [L23] collapse state survives reload via the [A9]
 *    component-state axis (`useBlockFoldState`).
 *
 * Decisions:
 *  - [D05] two-layer split: this body kind owns transcript rendering;
 *    `TaskToolBlock` owns chrome.
 *  - [D17] recursion runs through the same dispatch, depth-bounded.
 *
 * @module components/tugways/body-kinds/agent-transcript-block
 */

import "./agent-transcript-block.css";

import React from "react";
import { createPortal } from "react-dom";

import { dispatchToolCallState } from "@/components/tugways/cards/session-assistant-renderer-dispatch";
import { useChromeActionsTarget } from "@/components/tugways/blocks/block-chrome";
import {
  ToolBlockHistoryCollapse,
  ToolCallMetaProvider,
  ToolUseIdContext,
} from "@/components/tugways/blocks/collapse-context";
import { collapseDefaultForMessage } from "@/components/tugways/cards/blocks/tool-collapse-defaults";
import type { ChildToolCallsMap } from "@/components/tugways/blocks/types";
import { toolCallToMarkdown } from "@/lib/turn-entry-markdown";
import { TugMarkdownBlock } from "@/components/tugways/tug-markdown-block";
import type { ToolUseMessage } from "@/lib/code-session-store";
import {
  BlockActionsCluster,
  BlockCopyButton,
  BlockFoldCue,
  BlockFoldSuppressedContext,
  useBlockFoldState,
} from "./affordances";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One entry in a subagent transcript — a text answer or a nested tool call. */
export type AgentTranscriptEntry =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; toolCall: ToolUseMessage };

/** Structured subagent-run data — the body's render input. */
export interface AgentTranscriptData {
  /** Subagent type, e.g. "Explore" / "Plan". */
  agentType?: string;
  /** Run status as emitted on the wire, e.g. "completed" / "in_progress". */
  status?: string;
  /** Total wall-clock duration of the subagent run, in milliseconds. */
  durationMs?: number;
  /** Total tool-call count the subagent made. */
  toolUseCount?: number;
  /** Total token spend of the subagent run. */
  totalTokens?: number;
  /** The subagent's content entries, in producer order. */
  entries: readonly AgentTranscriptEntry[];
}

export interface AgentTranscriptBlockProps {
  /**
   * The subagent-run data. When undefined (or `entries` is empty AND
   * there is no header-worthy metadata) the block renders an empty
   * `data-slot="agent-transcript-body"` marker for layout consistency.
   */
  data?: AgentTranscriptData;

  /**
   * [D17] recursion depth — `0` at the top-level `Agent` call,
   * incremented each level deeper. Drives the depth-cap collapse
   * default and is threaded onto nested `dispatchToolCallState` calls.
   *
   * @default 0
   */
  depth?: number;

  /**
   * Recursion depth past which the block starts collapsed.
   *
   * @default AGENT_MAX_DEPTH (3)
   */
  maxDepth?: number;

  /**
   * Subagent-nesting map ([#step-17-5]) — `parentToolUseId → children[]`,
   * built once by the transcript view. Threaded through so a
   * `tool_use` entry that is *itself* an `Agent` resolves its own
   * children when it recurses. `undefined` when this transcript has no
   * reducer-linked children to wire (gallery / standalone).
   */
  childToolCallsByParent?: ChildToolCallsMap;

  /**
   * True when the host turn was stopped while still in flight ([D03]).
   * Threaded onto each `tool_use` entry's nested `dispatchToolCallState`
   * so a subagent child still `pending` at the stop reads `interrupted`
   * rather than a stuck `in_flight` dot. `undefined` outside a live
   * transcript (gallery / standalone).
   *
   * @default false
   */
  turnInterrupted?: boolean;

  /**
   * Optional identity label shown at the leading edge of the
   * standalone header. Ignored in `embedded` mode — the host owns
   * identity there.
   */
  label?: string;

  /**
   * "Embedded" mode — composed inside a host that already paints a
   * container and a header (e.g. `BlockChrome` in
   * `TaskToolBlock`). When `true` the standalone frame + header are
   * dropped and the actions cluster portals into the host chrome's
   * actions slot. MUST be used under a `BlockChrome`.
   *
   * @default false
   */
  embedded?: boolean;

  /** Forwarded class name for cascade-scoped customization. */
  className?: string;

  /**
   * Opt-in key for the [A9] Component State Preservation Protocol.
   * When set, AgentTranscriptBlock persists its collapse state into
   * `bag.components` so a Maker > Reload restores it. Undefined
   * opts out (gallery, standalone).
   */
  componentStatePreservationKey?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default recursion depth past which an `AgentTranscriptBlock` starts
 * collapsed. Per [D17]: no real-session subagent depth > 1 was
 * observed in the audit corpus, so 3 is generous paranoia headroom —
 * depth 0–3 render expanded, depth 4+ start folded.
 */
export const AGENT_MAX_DEPTH = 3;

/** Stable empty children map for the nested-call Copy serializer. */
const EMPTY_CHILDREN: ChildToolCallsMap = new Map();

const DATA_SLOT_ROOT = "agent-transcript-body";
const DATA_SLOT_HEADER = "agent-transcript-header";
const DATA_SLOT_ENTRIES = "agent-transcript-entries";
const DATA_SLOT_ACTIONS = "agent-transcript-actions";

// ---------------------------------------------------------------------------
// Pure helpers — exported because tests pin them
// ---------------------------------------------------------------------------

/**
 * Whether an `AgentTranscriptBlock` at `depth` should *start*
 * collapsed — `true` once `depth` exceeds `maxDepth`. This is the
 * [D17] depth cap: it bounds auto-expansion, it does not hide data
 * (the user can still expand a folded block).
 */
export function shouldCollapseAgentDepth(
  depth: number,
  maxDepth: number = AGENT_MAX_DEPTH,
): boolean {
  return depth > maxDepth;
}

/** Count the nested tool-call entries in a transcript. */
export function countNestedToolCalls(data: AgentTranscriptData): number {
  let count = 0;
  for (const entry of data.entries) {
    if (entry.kind === "tool_use") count += 1;
  }
  return count;
}

/** Compose the fold-cue label, e.g. "1 nested call" / "3 nested calls". */
export function composeNestedCallsLabel(count: number): string {
  return `${count.toLocaleString()} nested ${count === 1 ? "call" : "calls"}`;
}

/** Compose the header tool-count label, e.g. "1 tool call" / "5 tool calls". */
export function composeAgentToolCountLabel(
  count: number | undefined,
): string | undefined {
  if (count === undefined) return undefined;
  return `${count.toLocaleString()} tool ${count === 1 ? "call" : "calls"}`;
}

/**
 * Compact duration label for the header — `"850 ms"`, `"3.6 s"`,
 * `"2m 05s"`. Returns `undefined` for an unknown / invalid duration.
 */
export function composeAgentDurationLabel(
  ms: number | undefined,
): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * Serialize a subagent transcript to plain text for the Copy
 * affordance — an identity line, then each entry: text verbatim, a
 * nested tool call as `[tool: {name}]`.
 */
export function composeAgentTranscriptText(data: AgentTranscriptData): string {
  const lines: string[] = [];
  const identity = [data.agentType, data.status].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  if (identity.length > 0) lines.push(identity.join(" · "));
  for (const entry of data.entries) {
    if (entry.kind === "text") {
      lines.push(entry.text);
    } else {
      lines.push(`[tool: ${entry.toolCall.toolName}]`);
    }
  }
  return lines.join("\n");
}

/** Whether `data` carries anything worth rendering (entries or metadata). */
function hasRenderableContent(data: AgentTranscriptData): boolean {
  return (
    data.entries.length > 0 ||
    data.agentType !== undefined ||
    data.status !== undefined ||
    data.durationMs !== undefined ||
    data.toolUseCount !== undefined ||
    data.totalTokens !== undefined
  );
}

// ---------------------------------------------------------------------------
// Entry renderer
// ---------------------------------------------------------------------------

interface AgentEntryViewProps {
  entry: AgentTranscriptEntry;
  /** Recursion depth of the *parent* block — nested calls dispatch at +1. */
  depth: number;
  /** Subagent-nesting map, threaded on to nested dispatch ([#step-17-5]). */
  childToolCallsByParent: ChildToolCallsMap | undefined;
  /** Host turn stopped mid-run — flips a still-pending child to `interrupted` ([D03]). */
  turnInterrupted: boolean;
}

/**
 * Render one transcript entry. A `text` entry renders as real markdown
 * (`TugMarkdownBlock`) — the agent's prose and final answer are
 * markdown exactly like top-level assistant text, so they get the same
 * pretty rendering, not a pre-wrapped monospace dump. A `tool_use`
 * entry routes back through the same dispatch at
 * `depth + 1` so it gets its real per-tool block ([D17]) — and the
 * subagent-nesting map rides along so a nested `Agent` resolves its
 * own children ([#step-17-5]).
 *
 * The nested call is wrapped in its own collapse context — the same
 * `ToolUseIdContext` + `ToolCallMetaProvider` + `ToolBlockHistoryCollapse`
 * trio the top-level transcript dispatch applies — keyed by the child's
 * own `toolUseId`. Without this wrapper a nested `BlockChrome` reads the
 * PARENT Agent's collapse handle (the nearest provider up the tree), so
 * every child's chevron toggled the whole Agent. Its own handle makes the
 * child fold independently, one indent level deeper, and its collapse
 * boolean persists through the same card-scoped [A9] expansion registry.
 */
const AgentEntryView: React.FC<AgentEntryViewProps> = ({
  entry,
  depth,
  childToolCallsByParent,
  turnInterrupted,
}) => {
  if (entry.kind === "text") {
    return (
      <div
        className="tugx-agent-text"
        data-slot="agent-transcript-text"
        data-agent-entry-kind="text"
      >
        {/* Static-mode markdown: parsed once at mount. The parent keys
            this entry on the text length, so a changed answer (e.g. the
            real structured result replacing a composed one on reload)
            remounts and re-parses. */}
        <TugMarkdownBlock
          key={`md-${entry.text.length}`}
          initialText={entry.text}
        />
      </div>
    );
  }
  const call = entry.toolCall;
  const { Component, props } = dispatchToolCallState(
    call,
    depth + 1,
    childToolCallsByParent,
    undefined,
    false,
    turnInterrupted,
  );
  return (
    <div
      className="tugx-agent-tool"
      data-slot="agent-transcript-tool"
      data-agent-entry-kind="tool_use"
    >
      <ToolUseIdContext.Provider value={call.toolUseId}>
        <ToolCallMetaProvider
          toolUseId={call.toolUseId}
          toolName={call.toolName}
          status={call.status}
          startedAtMs={call.createdAt}
          toolWallMs={call.toolWallMs}
        >
          <ToolBlockHistoryCollapse
            toolUseId={call.toolUseId}
            defaultCollapsed={collapseDefaultForMessage(call)}
            copyText={() =>
              toolCallToMarkdown(call, childToolCallsByParent ?? EMPTY_CHILDREN)
            }
          >
            <Component {...props} />
          </ToolBlockHistoryCollapse>
        </ToolCallMetaProvider>
      </ToolUseIdContext.Provider>
    </div>
  );
};

// ---------------------------------------------------------------------------
// React component
// ---------------------------------------------------------------------------

export const AgentTranscriptBlock: React.FC<AgentTranscriptBlockProps> = ({
  data,
  depth = 0,
  maxDepth = AGENT_MAX_DEPTH,
  childToolCallsByParent,
  turnInterrupted = false,
  label,
  embedded = false,
  className,
  componentStatePreservationKey,
}) => {
  // ---- Collapse state — logical UI state, React-owned per [L06] ------
  //
  // Owned by `useBlockFoldState` (shared with the other fold-bearing
  // body kinds): mount-in-saved-state, [A9] capture, and the toggle.
  // AgentTranscriptBlock is purely uncontrolled — no `collapsed` prop —
  // so it supplies only the default: collapsed once rendered past the
  // [D17] depth cap. A saved fold wins over the depth default so a
  // Maker > Reload restores the user's explicit choice.
  const { collapsed, setCollapsed } = useBlockFoldState({
    defaultCollapsed: shouldCollapseAgentDepth(depth, maxDepth),
    componentStatePreservationKey,
  });

  // Fold ownership — the chrome publishes `BlockFoldSuppressedContext`
  // truthy when it is itself collapsible (a history-collapse-wrapped
  // top-level block, whose chevron mounts/unmounts this whole body).
  // In that case the chrome chevron is the single fold and the
  // transcript's own nested-calls cue would be a duplicate, so it is
  // suppressed. When falsey — a *nested* tool call dispatched at
  // `depth + 1`, which gets no chrome chevron — the inner cue is the
  // sole fold and the [D17] depth-cap default-collapse is the only
  // safety bounding deep nesting, so the cue is kept. (`useBlockFoldState`
  // already forces `collapsed = false` under suppression, so the
  // entries render open at the top level with no cue.)
  const foldSuppressed = React.useContext(BlockFoldSuppressedContext);

  // ---- Copy source ---------------------------------------------------
  //
  // `dataRef` carries the live data so `BlockCopyButton`'s `getText`
  // closure reads the freshest transcript at fire time ([L07]).
  const dataRef = React.useRef<AgentTranscriptData | undefined>(data);
  React.useLayoutEffect(() => {
    dataRef.current = data;
  }, [data]);
  const getTranscriptText = React.useCallback(
    () =>
      dataRef.current === undefined
        ? ""
        : composeAgentTranscriptText(dataRef.current),
    [],
  );

  // ---- Chrome actions target (embedded composition) ------------------
  const chromeActionsTarget = useChromeActionsTarget();

  // Dev-mode misconfiguration check — `embedded={true}` requires a
  // parent `BlockChrome`. Mirrors the other body kinds'
  // deferred-warn pattern.
  React.useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (!embedded) return;
    if (chromeActionsTarget !== null) return;
    const handle = window.setTimeout(() => {
      console.warn(
        "AgentTranscriptBlock: `embedded={true}` requires a parent " +
          "`BlockChrome`. Without one the actions cluster (fold " +
          "cue, Copy) has nowhere to portal and the user loses access " +
          "to it silently. Either compose under a chrome or set " +
          "`embedded={false}`.",
      );
    }, 0);
    return () => {
      window.clearTimeout(handle);
    };
  }, [embedded, chromeActionsTarget]);

  // ---- Empty data: layout-consistent marker --------------------------
  if (data === undefined || !hasRenderableContent(data)) {
    return (
      <div
        data-slot={DATA_SLOT_ROOT}
        data-empty="true"
        data-embedded={embedded ? "true" : undefined}
        className={
          className === undefined
            ? "tugx-agent"
            : `tugx-agent ${className}`
        }
      />
    );
  }

  const rootClass =
    "tugx-agent" + (className === undefined ? "" : ` ${className}`);

  const durationLabel = composeAgentDurationLabel(data.durationMs);
  const toolCountLabel = composeAgentToolCountLabel(data.toolUseCount);
  const nestedCallCount = countNestedToolCalls(data);

  // The nested-calls fold cue — the transcript's body-specific fold,
  // kept ONLY when the chrome doesn't already own the fold (`!foldSuppressed`):
  // standalone (gallery) and nested-call compositions keep it; a
  // top-level embedded transcript under a collapsible chrome drops it
  // (the chrome chevron is the single fold).
  const nestedFoldCue = foldSuppressed ? null : (
    <BlockFoldCue
      collapsed={collapsed}
      onToggle={setCollapsed}
      collapsedLabel={composeNestedCallsLabel(nestedCallCount)}
      ariaLabelCollapse="Collapse subagent transcript"
      ariaLabelExpand="Expand subagent transcript"
      data-slot="agent-transcript-fold-cue"
      className="tugx-agent-fold-cue"
    />
  );
  const actions = (
    <>
      {nestedFoldCue}
      <BlockCopyButton
        data-slot="agent-transcript-copy"
        aria-label="Copy subagent transcript"
        getText={getTranscriptText}
      />
    </>
  );

  // Embedded: portal only the body-specific nested-calls fold, and only
  // when it survives suppression (a nested transcript with no chrome
  // chevron). When the chrome owns the fold there is nothing to portal.
  const portaledActions =
    embedded && chromeActionsTarget !== null && nestedFoldCue !== null
      ? createPortal(
          <BlockActionsCluster data-slot={DATA_SLOT_ACTIONS}>
            {nestedFoldCue}
          </BlockActionsCluster>,
          chromeActionsTarget,
        )
      : null;

  return (
    <div
      data-slot={DATA_SLOT_ROOT}
      data-empty="false"
      data-embedded={embedded ? "true" : undefined}
      data-collapsed={collapsed ? "true" : "false"}
      className={rootClass}
    >
      {embedded ? null : (
        <div className="tugx-agent-header" data-slot={DATA_SLOT_HEADER}>
          {label !== undefined ? (
            <span className="tugx-agent-label" data-slot="agent-transcript-label">
              {label}
            </span>
          ) : null}
          {data.agentType !== undefined ? (
            <span
              className="tugx-agent-type"
              data-slot="agent-transcript-type"
            >
              {data.agentType}
            </span>
          ) : null}
          {durationLabel !== undefined ? (
            <span
              className="tugx-agent-duration"
              data-slot="agent-transcript-duration"
            >
              {durationLabel}
            </span>
          ) : null}
          {toolCountLabel !== undefined ? (
            <span
              className="tugx-agent-tool-count"
              data-slot="agent-transcript-tool-count"
            >
              {toolCountLabel}
            </span>
          ) : null}
          <span className="tugx-agent-header-spacer" />
          <BlockActionsCluster data-slot={DATA_SLOT_ACTIONS}>
            {actions}
          </BlockActionsCluster>
        </div>
      )}
      {portaledActions}

      {collapsed ? null : (
        <div className="tugx-agent-entries" data-slot={DATA_SLOT_ENTRIES}>
          {data.entries.map((entry, index) => (
            <AgentEntryView
              key={
                entry.kind === "tool_use"
                  ? `tool:${entry.toolCall.toolUseId}`
                  : `text:${index}`
              }
              entry={entry}
              depth={depth}
              childToolCallsByParent={childToolCallsByParent}
              turnInterrupted={turnInterrupted}
            />
          ))}
        </div>
      )}

    </div>
  );
};
