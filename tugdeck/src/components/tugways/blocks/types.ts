/**
 * Shared types for the Dev assistant-rendering tool-block layer.
 *
 * These contracts are consumed by:
 *   - `session-assistant-renderer-dispatch.ts` — the registry + dispatch logic
 *   - every per-tool block in `./blocks/*.tsx`
 *   - every body-kind primitive under `../body-kinds/*.tsx`
 *
 * Laws: [L19] component authoring guide — every wrapper that consumes
 *       `ToolBlockProps` and renders a body owns its `data-slot`,
 *       its CSS file, and its slot tokens; this module defines the
 *       contract those wrappers conform to.
 *       [L20] component-token sovereignty — each consumer of these
 *       types owns its own scoped tokens; this types module declares
 *       no tokens.
 *
 * @module components/tugways/blocks/types
 */

import type React from "react";

import type { PropertyStore } from "@/lib/property-store";
import type { CodeSessionStore, ToolUseMessage } from "@/lib/code-session-store";
import type { ToolCallPhase } from "@/lib/code-session-store/tool-call-phase-visual";

// ---------------------------------------------------------------------------
// Caution flag — drift detection per drift-fallback decision.
// ---------------------------------------------------------------------------

/**
 * Surfaces a caution badge to the user when the dispatch encountered drift:
 * an unknown tool name, an unknown structured-result shape, or a version
 * mismatch against the pinned stream-json catalog. The caution badge is
 * rendered both inline at the offending event and as an aggregate count in
 * the card chrome.
 */
export interface CautionFlag {
  reason: "unknown_tool" | "unknown_shape" | "version_drift";
  detail?: string;
}

// ---------------------------------------------------------------------------
// Body-kind contract — every Layer-1 body-kind primitive conforms to this.
// ---------------------------------------------------------------------------

/**
 * Every body-kind primitive (`TerminalBlock`, `DiffBlock`, `FileBlock`, etc.)
 * accepts these props. `data` is the typed payload — each body kind narrows
 * `TData` to its own shape. `streamingStore` + `streamingPath` opt the body
 * into the streaming-binding contract: bodies that participate read the
 * store value synchronously on mount and observe for updates with rAF
 * coalescing; bodies that don't render once on completion and ignore both
 * fields.
 *
 * Collapse state is controlled — the body never owns its own boolean. The
 * host (typically a `ToolBlockProps`-shaped wrapper) owns `collapsed`
 * and dispatches `onToggleCollapsed` when the user clicks the affordance.
 */
export interface BodyKindProps<TData = unknown> {
  /** The typed payload this body kind renders. */
  data: TData;
  /**
   * Optional `PropertyStore` for streaming-binding mode. When set, the body
   * subscribes to live updates per the streaming-binding contract; when
   * unset, it renders once from `data`.
   */
  streamingStore?: PropertyStore;
  /** PropertyStore path key for streaming mode. Default `"text"`. */
  streamingPath?: string;
  /**
   * Initial collapse state. Bodies that support collapse honor this; bodies
   * that don't support collapse ignore it.
   */
  collapsed?: boolean;
  /** Toggle callback. Called when the user activates the collapse affordance. */
  onToggleCollapsed?: (next: boolean) => void;
  /** Forwarded class name; cascade-scoped customization happens here. */
  className?: string;
  /**
   * Opt-in key for the Component State Preservation Protocol. When set,
   * the body kind persists its uncontrolled state (`collapsed`, inner
   * scroll position, view-toggle selection — whatever the body kind
   * carries) into `bag.components` and restores from there on mount.
   * Undefined opts out; gallery / standalone usage typically leaves
   * this unset. Body kinds that ignore the prop quietly drop it
   * (preservation is a feature, not a contract). See
   * `use-component-state-preservation.tsx`. [A9]
   */
  componentStatePreservationKey?: string;
}

/**
 * Subagent tool-call nesting map ([#step-17-5]). Keyed by an `Agent`
 * call's `toolUseId`; the value is that subagent's child tool calls
 * (the ones whose `ToolUseMessage.parentToolUseId` points back at the
 * key), in producer order. The substrate's `turn.messages` /
 * `activeTurn.messages` stays flat — this map is a pure derivation
 * built once by the transcript view and threaded down through the
 * dispatch so each `AgentTranscriptBlock` can resolve its own
 * children (and pass the map further down for arbitrarily deep
 * nesting).
 */
export type ChildToolCallsMap = ReadonlyMap<
  string,
  ReadonlyArray<ToolUseMessage>
>;

// ---------------------------------------------------------------------------
// Tool-block contract — every Layer-2 per-tool block conforms to this.
// ---------------------------------------------------------------------------

/**
 * Wrapper-level lifecycle state. Distinguishes the placeholder phase (input
 * still streaming, no body to render yet), the steady-state render, and
 * the error state from `tool_result.is_error`.
 */
export type ToolBlockStatus = "streaming" | "ready" | "error";

/**
 * Props passed to every per-tool block. The wrapper composes a body kind
 * via `data` selection (each wrapper picks its own body) and adds chrome:
 * header (icon + tool name + args summary), footer (badges), and any
 * tool-specific interactions.
 *
 * `input` may arrive partial during streaming — the wrapper must handle
 * `undefined` and partial-shape values by showing the streaming placeholder
 * until the input completes (or `tool_use_structured` arrives).
 */
export interface ToolBlockProps<TInput = unknown, TStructured = unknown> {
  /** Stable identifier joining tool_use ↔ tool_result. */
  toolUseId: string;
  /** Canonical tool name as emitted on the wire (case may vary). */
  toolName: string;
  /** Owning turn's sequence number; used for ordering across concurrent calls. */
  seq: number;
  /** Tool input as it arrives. May be empty / partial during streaming. */
  input?: TInput;
  /** Plain-text output from `tool_result.output`. */
  textOutput?: string;
  /** Typed output from `tool_use_structured.structured_result`, when present. */
  structuredResult?: TStructured;
  /** True when `tool_result.is_error === true`. */
  isError?: boolean;
  /** Wall-clock duration; usually computed by the wrapper from start/end timestamps. */
  durationMs?: number;
  /** Lifecycle state per the streaming → ready → error progression. */
  status: ToolBlockStatus;
  /**
   * Header-indicator lifecycle phase — the richer reading the leftmost
   * `pulsing-dot` paints. Distinct from `status`: `status` drives body
   * composition (streaming placeholder vs body vs error band) and stays
   * `streaming | ready | error`; `phase` splits those into the dot's
   * five lifecycle poses (`in_flight | awaiting | success | error |
   * interrupted`, plus a quiescent `idle`). Derived by
   * `deriveToolCallPhase` in the dispatch from the store status plus the
   * awaiting-dialog join ([Q01]) and the interruption signal ([D03]).
   * Optional so standalone / gallery mounts that don't compute it fall
   * back to a status-derived default at the chrome.
   */
  phase?: ToolCallPhase;
  /** Drift caution; rendered as an inline chip on the wrapper chrome. */
  caution?: CautionFlag;
  /**
   * Recursion depth — `0` for a top-level tool call, incremented by
   * one each time a wrapper dispatches a *nested* tool call (today
   * only `TaskToolBlock` → `AgentTranscriptBlock` does this, per
   * [D17]). Wrappers that never recurse ignore it; `TaskToolBlock`
   * reads it to drive the `AgentTranscriptBlock` depth-cap collapse.
   * Threaded by `dispatchToolCallState`'s optional `depth` argument.
   */
  depth?: number;
  /**
   * Subagent tool-call nesting map ([#step-17-5]). Threaded by
   * `dispatchToolCallState`'s optional `childToolCallsByParent`
   * argument. `TaskToolBlock` reads it: it resolves *its own* children
   * (`childToolCallsByParent.get(toolUseId)`) to merge into the
   * `AgentTranscriptBlock` entries, and passes the whole map down so
   * deeper subagents resolve theirs. Non-recursing wrappers ignore it.
   */
  childToolCallsByParent?: ChildToolCallsMap;
  /**
   * True when this call's turn was stopped (committed non-`complete`)
   * while the call was still in flight ([D03]). The dispatch already
   * folds it into `phase` for this block; it rides on the props only so
   * a recursing wrapper (`TaskToolBlock`) can forward it to its subagent
   * children's own `dispatchToolCallState`, so their pending dots flip
   * to `interrupted` instead of staying stuck `in_flight`. Non-recursing
   * wrappers ignore it.
   */
  turnInterrupted?: boolean;
  /**
   * Optional `CodeSessionStore` handle. Threaded by the transcript
   * view through `dispatchToolCallState` for wrappers that need to
   * round-trip something *outside* the normal tool channel — today
   * the only consumer is `AskUserQuestionToolBlock`'s salvage path,
   * which posts the user's answers as a fresh user turn via
   * `session.send` when Claude Code rejected the tool call.
   *
   * Optional because most wrappers don't need it; the few that do
   * defensively guard a missing reference (the standalone gallery
   * mount, for instance, supplies no session).
   */
  session?: CodeSessionStore;
  /**
   * Preview mode — the call has NOT run yet. Set by the permission
   * dialog when it renders a wrapper as the approve/deny preview of a
   * pending tool call: the input has arrived but there is (and can be)
   * no result. Wrappers MUST suppress every result-side surface that
   * would otherwise read as a finished call — `BashToolBlock`'s
   * "(no output)" footer hint and its empty `TerminalBlock` body are
   * the canonical examples. The header + input side renders normally
   * (that IS the command/args being approved). Transcript mounts leave
   * this `undefined`; only `dispatchToolCallState`'s `preview` argument
   * threads it on. Defaults to "not a preview."
   */
  preview?: boolean;
}

/**
 * A tool-block React component. Each entry in the dispatch registry maps
 * a lowercased tool name to one of these. Wrappers are React components,
 * not classes — `React.ComponentType` lets the dispatch hand the same
 * reference back to consumers that mount with JSX.
 */
export type ToolBlockFactory = React.ComponentType<ToolBlockProps>;

// ---------------------------------------------------------------------------
// Re-export the `ToolUseMessage` shape so the dispatch and wrapper-side
// code can read the same type via this module.
// ---------------------------------------------------------------------------

export type { ToolUseMessage };
