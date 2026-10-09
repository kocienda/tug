/**
 * session-assistant-renderer-dispatch.ts — pure routing layer that maps a
 * `RenderInput` (a discriminated union of things-to-render produced by
 * the transcript view from `TurnEntry` fields, in-flight streaming
 * content, and chrome-shaped events) to a renderer component plus
 * props.
 *
 * The dispatch is the seam between `CodeSessionStore` (state) and the
 * Layer-1/Layer-2 rendering tree (presentation). The store stays
 * unchanged by this seam — it produces `TurnEntry` records as it
 * always has — and the transcript view becomes a thin walker that
 * unfolds each turn into the kinds the dispatch knows how to route.
 *
 * # Contract
 *
 * - `dispatch(input, context)` returns `{ Component, props, caution? }`
 *   for any `RenderInput`. It NEVER throws; an unrouteable input falls
 *   back to the scaffold for its kind (for future-proofing) or, for
 *   `tool_call`, to `DefaultToolBlock` with a caution reason.
 * - `resolveToolBlock(name)` looks up by lowercased tool name with
 *   alias resolution. Returns `DefaultToolBlock` for misses.
 * - `registeredTools()` enumerates the canonical names of every
 *   wrapper in the registry (excluding aliases and the default
 *   fallback). Test-facing.
 *
 * # Registry & aliases
 *
 * The registry is a module-static `Map<string, ToolBlockFactory>`
 * keyed on lowercased canonical names. The alias map handles
 * historical renames (most importantly `task → agent`, since real
 * Claude Code now emits `Agent` rather than the historical `Task` —
 * see the empirical session audit) and synonyms (`multiedit → edit`).
 *
 * # Drift detection (caution flags)
 *
 * Three drift signals are detected and surfaced as a `caution` —
 * inline at the offending event (the tool-block chrome paints a
 * `SessionCautionBadge` from the threaded `caution` prop) and, in
 * aggregate, on the card chrome (`SessionRouteIndicatorBadge` counts
 * `summarizeDrift`'s events):
 *
 *  - `unknown_tool` — a `tool_call` whose name is not in the registry
 *    and not an audit-confirmed default route.
 *  - `unknown_shape` — a registered wrapper whose present
 *    `structured_result` fails its shallow top-level shape schema
 *    (`STRUCTURED_RESULT_SCHEMAS` / `checkStructuredShape`). The call
 *    falls back to `DefaultToolBlock` — `JsonTreeBlock` over the raw
 *    payload — per [D04].
 *  - `version_drift` — a `system_metadata` event whose `version`
 *    is on a different `major.minor` line than `VALIDATED_CC_VERSION`
 *    (a patch difference within the validated line is not drift —
 *    see `versionLine`).
 *
 * `detectToolCallDrift` and `detectVersionDrift` are the per-event
 * detectors; `summarizeDrift` walks a whole transcript with them to
 * produce the card-chrome aggregate. Every distinct drift event is
 * logged once via `logDriftEvent` for triage.
 *
 * The unknown-tool flag is suppressed when the name resolves through
 * an alias OR when the name is in the audit-confirmed default-routed
 * list (see `AUDIT_CONFIRMED_DEFAULT_TOOLS`) — those tools are *known*
 * to route through `DefaultToolBlock` by design rather than because
 * they're surprising.
 *
 * # Kind-renderer scaffolds
 *
 * For the kinds whose real renderers haven't shipped yet (`thinking`,
 * `permission`, `question`, `cost`, etc.), the dispatch routes to a
 * tiny `ScaffoldRenderer` that prints `data-slot="scaffold-{kind}"`
 * and the kind name. Each follow-on step replaces its kind's entry in
 * `KIND_RENDERERS` with the real component. The scaffolds make the
 * dispatch wiring testable from day one and the wiring sites cheap to
 * upgrade — the test suite asserts equality against `KIND_RENDERERS`,
 * so the test stays correct as long as the test imports the same
 * symbol.
 *
 * @module components/tugways/cards/session-assistant-renderer-dispatch
 */

import React from "react";

import type { PropertyStore } from "@/components/tugways/property-store";
import type {
  CodeSessionStore,
  ControlRequestForward,
  CostSnapshot,
  ToolUseMessage,
} from "@/lib/code-session-store";
import { deriveToolCallPhase } from "@/lib/code-session-store/tool-call-phase-visual";

import { DefaultToolBlock } from "./blocks/default-tool-block";
import { PermissionDialog } from "@/components/tugways/chrome/session-permission-dialog";
import { SessionInitBanner } from "@/components/tugways/chrome/session-init-banner";
import { SessionErrorBlock } from "@/components/tugways/chrome/session-error-block";
import {
  defaultIntentToolNames,
  hiddenToolNames,
} from "./session-tool-visibility-policy";
import type {
  CautionFlag,
  ChildToolCallsMap,
  ToolBlockFactory,
} from "../blocks/types";

// ---------------------------------------------------------------------------
// RenderInput — discriminated union the dispatch routes.
// ---------------------------------------------------------------------------

/**
 * Discriminated input for the dispatch. Each kind is produced by the
 * transcript view from a specific source: TurnEntry fields, in-flight
 * streaming content, or chrome-shaped events.
 */
export type RenderInput =
  | {
      kind: "assistant_text";
      text: string;
      status: "streaming" | "complete";
      msgId: string;
    }
  | {
      kind: "thinking";
      text: string;
      status: "streaming" | "complete";
      msgId: string;
    }
  | {
      kind: "tool_call";
      toolCall: ToolUseMessage;
    }
  | {
      kind: "user_text";
      text: string;
      submitAt: number;
    }
  | {
      kind: "permission";
      request: ControlRequestForward;
      /**
       * Set when this is a *committed* permission record being
       * re-rendered as a permanent transcript artifact ([D13]) — the
       * decision the user already made. Omitted for a live pending
       * request (the dialog reads the live store instead).
       */
      resolvedDecision?: "allow" | "deny";
    }
  | {
      kind: "cost";
      cost: CostSnapshot;
      cumulative?: CostSnapshot;
    }
  | {
      kind: "system_metadata";
      metadata: unknown;
      previousMetadata?: unknown;
    }
  | {
      kind: "error";
      message: string;
      recoverable: boolean;
    };

export type RenderInputKind = RenderInput["kind"];

// ---------------------------------------------------------------------------
// DispatchResult, DispatchContext.
// ---------------------------------------------------------------------------

/**
 * The dispatch's return value. `Component` is the React component to
 * mount; `props` is the prop bag. `caution` is set when the dispatch
 * detected drift (unknown tool, etc.); the consumer surfaces it as an
 * inline badge plus an aggregate counter on the card chrome.
 *
 * `Component`'s prop type is `any` by design: the dispatch is opaque
 * over the prop shape — every kind has its own renderer, every tool
 * wrapper has its own (registry-supplied) prop interface, and the
 * dispatch's job is just to hand back a matched (Component, props)
 * pair that the consumer mounts as `<Component {...props} />`. A
 * narrower type would force an artificial common interface on
 * unrelated renderers, and the spec ([Spec S01]) was always written
 * this way for that reason.
 */
export interface DispatchResult {
  Component: React.ComponentType<any>;
  props: Record<string, unknown>;
  caution?: CautionFlag;
}

/**
 * Context passed into `dispatch`. Contains the per-card streaming
 * `PropertyStore` (consumed by streaming-binding bodies) and the
 * `CodeSessionStore` handle (read-only access for renderers that
 * need it). `depth` is for `AgentTranscriptBlock` recursion.
 *
 * `previousMetadata` for the on-change comparison rides on the
 * `system_metadata` `RenderInput` itself, not on this context — so
 * the dispatch is fully stateless across calls.
 */
export interface DispatchContext {
  store: PropertyStore;
  session: CodeSessionStore;
  depth?: number;
}

// ---------------------------------------------------------------------------
// Tool-block registry and aliases.
// ---------------------------------------------------------------------------

/**
 * Module-static registry. Keys are lowercased canonical tool names.
 * Real per-tool blocks register themselves via `registerToolBlock`
 * as they ship (BashToolBlock at #step-6, ReadToolBlock at #step-8,
 * EditToolBlock at #step-11 — `multiedit` aliases to it — etc.). Until
 * they ship, the registry contains only the audit-confirmed routes —
 * every `tool_call` not in the registry lands on `DefaultToolBlock`
 * with a caution flag.
 */
const TOOL_BLOCK_REGISTRY = new Map<string, ToolBlockFactory>();

/**
 * Tool-name aliases — historical renames and synonyms that should
 * resolve to a canonical wrapper. Keys and values are lowercased.
 *
 * Entries:
 *  - `task` → `agent`: Claude Code renamed its `Task` tool to `Agent`;
 *    the empirical session audit confirms current sessions emit
 *    `Agent`, so `task` is a backward-compat alias.
 *  - `multiedit` → `edit`: a single Edit wrapper renders both the
 *    Edit and MultiEdit tools (per Table T02).
 *  - `enterworktree` / `exitworktree` → `worktree`: a single
 *    `WorktreeToolBlock` handles both verbs and branches internally
 *    on `toolName` ([#step-24-3-2]).
 *  - `tasklist` / `taskget` / `taskoutput` / `taskstop` → `taskmgmt`:
 *    a single `TaskMgmtToolBlock` handles all four background-task
 *    management verbs and branches internally on `toolName`
 *    ([#step-24-3-3]). The canonical `taskmgmt` is wrapper-internal
 *    — there is no Anthropic wire tool named `TaskMgmt`; the
 *    canonical name exists solely as the registry key for the
 *    shared wrapper.
 *  - `croncreate` / `crondelete` / `cronlist` → `cron`: a single
 *    `CronToolBlock` handles all three cron-family verbs and
 *    branches internally on `toolName` ([#step-24-3-4]). Canonical
 *    `cron` is wrapper-internal; there is no Anthropic wire tool
 *    named bare `Cron`.
 *
 * Exported for the registrations module
 * (`session-assistant-renderer-registrations.ts`), whose
 * `hasBespokeWrapper` resolves aliases against the same map.
 */
export const TOOL_ALIASES: ReadonlyMap<string, string> = new Map([
  ["task", "agent"],
  ["multiedit", "edit"],
  ["enterworktree", "worktree"],
  ["exitworktree", "worktree"],
  ["tasklist", "taskmgmt"],
  ["taskget", "taskmgmt"],
  ["taskoutput", "taskmgmt"],
  ["taskstop", "taskmgmt"],
  ["croncreate", "cron"],
  ["crondelete", "cron"],
  ["cronlist", "cron"],
]);

/**
 * Audit-confirmed tool names that route through `DefaultToolBlock`
 * by design. These suppress the `unknown_tool` caution because they
 * are *known* tools whose JsonTree-based default rendering is
 * sufficient.
 *
 * Derived from the `default-intent` bucket of `TOOL_VISIBILITY_POLICY`
 * — see `session-tool-visibility-policy.ts` for the full table and the
 * editing protocol. Per [D101]: every entry's classification (and
 * the follow-on step that promises a bespoke wrapper) is defended in
 * the policy file's per-row `rationale`.
 */
const AUDIT_CONFIRMED_DEFAULT_TOOLS: ReadonlySet<string> =
  defaultIntentToolNames();

/**
 * Lowercased canonical names of tools whose per-call events paint
 * zero ink in the transcript. Derived from the `hidden` bucket of
 * `TOOL_VISIBILITY_POLICY` ([D101]). `resolveToolBlock` checks this
 * set *before* the registry so a hidden name always returns
 * `NullToolBlock` — never the registry's bespoke factory and never
 * `DefaultToolBlock`. `detectToolCallDrift` checks this set so a
 * hidden tool also never raises an `unknown_tool` caution.
 *
 * Per [D100], `taskcreate` and `taskupdate` are hidden — the TASKS
 * status-bar cell is the sole surface for the post-`TodoWrite` task
 * system. Per [D101], control-channel tools like `toolsearch` /
 * `schedulewakeup` / `enterplanmode` / `exitplanmode` /
 * `pushnotification` are hidden — they are user-irrelevant plumbing
 * whose user-visible event lives elsewhere (a chrome banner, a
 * notification, etc.).
 */
const HIDDEN_TOOL_NAMES: ReadonlySet<string> = hiddenToolNames();

/**
 * Shared silent factory for the `hidden` policy bucket. Returning
 * `null` leaves no DOM child for the row — `session-card-transcript-tool-calls`
 * iterates and renders each tool block, and a null return adds zero
 * markup. The container itself (`.session-transcript-tool-calls`) stays
 * present in the assistant turn, so a turn whose only tool calls
 * are hidden events shows the prose / thinking content with no
 * tool-call rows underneath.
 *
 * Exported so tests can reference the same factory the dispatch
 * returns (rather than constructing their own `() => null` and
 * comparing by reference, which would fail since the dispatch now
 * returns this module-static).
 */
export const NullToolBlock: ToolBlockFactory = () => null;

/**
 * Register a tool block. Called by tool-block modules at import
 * time as they ship. The name is lowercased before insertion so the
 * registry key vocabulary is uniform.
 *
 * Idempotent: re-registering the same name overwrites the existing
 * entry, which is the right behavior for HMR and for tests that need
 * to swap a wrapper out.
 */
export function registerToolBlock(
  name: string,
  factory: ToolBlockFactory,
): void {
  TOOL_BLOCK_REGISTRY.set(name.toLowerCase(), factory);
}

/**
 * Test-only: clear the registry. Used by the dispatch test to start
 * each test from a known empty state. Production code never calls
 * this.
 */
export function _resetToolBlockRegistryForTests(): void {
  TOOL_BLOCK_REGISTRY.clear();
}

/**
 * Resolve a tool block by name. Case-insensitive. Aliases are
 * resolved before lookup. Returns `DefaultToolBlock` for misses —
 * never returns `undefined`.
 *
 * Resolution order (first match wins):
 *  1. `HIDDEN_TOOL_NAMES` ([D101]) — return `NullToolBlock` so the
 *     transcript paints no row for this call.
 *  2. `TOOL_BLOCK_REGISTRY` — bespoke wrapper for this tool.
 *  3. `DefaultToolBlock` — JsonTree fallback.
 *
 * The hidden check is *first* by design: it must override any
 * accidental registry entry for a hidden name (defensive — keeps the
 * policy file authoritative even if a future registration mistakes
 * the bucket).
 */
export function resolveToolBlock(toolName: string): ToolBlockFactory {
  const lower = toolName.toLowerCase();
  const canonical = TOOL_ALIASES.get(lower) ?? lower;
  if (HIDDEN_TOOL_NAMES.has(canonical)) return NullToolBlock;
  return TOOL_BLOCK_REGISTRY.get(canonical) ?? DefaultToolBlock;
}

/**
 * Enumerate the canonical names of every registered wrapper. Aliases
 * and `DefaultToolBlock` are NOT included — only the wrappers that
 * are explicitly registered. The test suite uses this to verify the
 * registry's coverage matches Table T02 at phase exit.
 */
export function registeredTools(): ReadonlyArray<string> {
  return Array.from(TOOL_BLOCK_REGISTRY.keys()).sort();
}

// ---------------------------------------------------------------------------
// Drift detection — validated catalog version, structured-result
// schemas, per-event detectors, the transcript-wide aggregate, and
// triage logging.
// ---------------------------------------------------------------------------

/**
 * The Claude Code stream-json version the Dev renderers were last
 * validated against — the most recent `just capture-capabilities`
 * baseline. `SessionRouteIndicatorBadge` displays it as the "validated against"
 * reference, and `versionDriftCaution` compares its `major.minor`
 * line against the running session's.
 *
 * Build-time constant. Bump it whenever a fresh capture advances the
 * golden catalog. Note that `version_drift` keys on the `major.minor`
 * *line* (see `versionLine`), so a stale patch number here is
 * harmless for drift detection — it only shows as a slightly old
 * "validated against" figure until the next capture. `system_metadata`
 * emits the bare version (`"2.1.147"`), so the constant carries no
 * `v` prefix. This is the render-time complement to
 * `dev.md#p15-stream-json-version-gate`'s server-side telemetry.
 */
export const VALIDATED_CC_VERSION = "2.1.147";

/**
 * Expected runtime type for a required top-level field in a tool's
 * `structured_result`. `"array"` is checked via `Array.isArray`; the
 * rest map onto `typeof`. `"object"` excludes arrays and `null`.
 */
export type StructuredFieldType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array";

/**
 * A tool's structured-result shape contract — the load-bearing
 * top-level fields a bespoke wrapper needs present and correctly
 * typed to render its rich body. Shallow by decision ([D04]): only
 * top-level field presence + type, never deep validation. A tool
 * whose every structured field is optional (Bash / Edit / Glob /
 * Grep / Agent all narrow defensively and degrade gracefully) has no
 * entry — there is no shape it can meaningfully *fail*.
 */
export type StructuredResultSchema = Readonly<
  Record<string, StructuredFieldType>
>;

/**
 * Per-tool structured-result schemas, keyed by canonical (lowercased)
 * tool name. Only `read` has a load-bearing required field: its
 * `FileBlock` body needs `structured_result.file` to be an object
 * (the file payload). `file.content` is deliberately NOT required —
 * an image Read legitimately omits it (`type` distinguishes), so
 * requiring it would false-positive once image reads ship. The check
 * stays at the top level per [D04]'s "field presence and types at
 * top level, not deep validation."
 */
const STRUCTURED_RESULT_SCHEMAS: ReadonlyMap<string, StructuredResultSchema> =
  new Map([["read", { file: "object" }]]);

/**
 * Shallow shape check ([D04]). Returns a human-readable mismatch
 * detail when `value` (a present `structured_result`) fails `schema`
 * — a missing required field, or one of the wrong type — and `null`
 * when every required field is present and correctly typed.
 *
 * Only the top-level fields named in `schema` are inspected; extra
 * fields and nested shapes are not validated. Callers gate on the
 * `structured_result` being a present object before calling — an
 * absent / `null` result is the streaming or no-structured-event
 * case the wrapper handles with its placeholder, not drift.
 */
export function checkStructuredShape(
  value: Record<string, unknown>,
  schema: StructuredResultSchema,
): string | null {
  for (const [field, expected] of Object.entries(schema)) {
    const actual = value[field];
    if (actual === undefined) {
      return `${field}: missing`;
    }
    const ok =
      expected === "array"
        ? Array.isArray(actual)
        : expected === "object"
          ? actual !== null &&
            typeof actual === "object" &&
            !Array.isArray(actual)
          : typeof actual === expected;
    if (!ok) {
      const got = Array.isArray(actual)
        ? "array"
        : actual === null
          ? "null"
          : typeof actual;
      return `${field}: expected ${expected}, got ${got}`;
    }
  }
  return null;
}

/**
 * Pull `system_metadata.version` from a metadata payload. Returns the
 * version string, or `null` when the payload is not an object or
 * carries no string `version`.
 */
export function extractMetadataVersion(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== "object") return null;
  const version = (metadata as Record<string, unknown>).version;
  return typeof version === "string" ? version : null;
}

/**
 * The `major.minor` line of a version string — `"2.1.148"` → `"2.1"`.
 * A version with fewer than two dotted segments is returned whole.
 * Drift compares lines, not patches: Anthropic ships Claude Code patch
 * releases almost daily and they essentially never change stream-json
 * shapes, whereas a minor bump is where event shapes have historically
 * diverged. Comparing lines keeps the badge quiet through normal daily
 * churn and loud only at the rare, meaningful boundary.
 */
export function versionLine(version: string): string {
  const parts = version.split(".");
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : version;
}

/**
 * `version_drift` detector over a bare version string — compares its
 * `major.minor` line against `VALIDATED_CC_VERSION`'s. Returns a
 * `CautionFlag` when the lines differ, `null` when they match (any
 * patch difference within the validated line included) or `version`
 * is `null` (a session with no captured version yet).
 */
export function versionDriftCaution(version: string | null): CautionFlag | null {
  if (version === null) return null;
  if (versionLine(version) === versionLine(VALIDATED_CC_VERSION)) return null;
  return {
    reason: "version_drift",
    detail: `${version} ≠ ${VALIDATED_CC_VERSION}`,
  };
}

/**
 * `version_drift` detector over a raw `system_metadata` payload —
 * extracts `version` and defers to `versionDriftCaution`. Consumed by
 * the `dispatch` `system_metadata` branch.
 */
export function detectVersionDrift(metadata: unknown): CautionFlag | null {
  return versionDriftCaution(extractMetadataVersion(metadata));
}

/**
 * Per-tool-call drift detector — the single source of truth for
 * tool-call drift. Returns a `CautionFlag` when the call is drifted,
 * `null` otherwise. Pure over the static registry.
 *
 *  - `unknown_tool` — the name resolves to no registered wrapper and
 *    is not an audit-confirmed default route.
 *  - `unknown_shape` — a registered (or audit-confirmed) tool with a
 *    shape schema whose present `structured_result` fails the shallow
 *    top-level check. Skipped for errored calls (an error result
 *    legitimately carries no / a divergent structured payload) and
 *    for absent results (streaming — the wrapper's placeholder owns
 *    that window, not drift).
 *
 * Consumed both by `dispatchToolCallState` (which routes a drifted
 * call to `DefaultToolBlock`) and by `summarizeDrift` (the
 * card-chrome aggregate counter).
 */
export function detectToolCallDrift(
  toolCall: ToolUseMessage,
): CautionFlag | null {
  const lower = toolCall.toolName.toLowerCase();
  const canonical = TOOL_ALIASES.get(lower) ?? lower;

  // Hidden tools ([D101]) are *known* — by policy, not by audit — so
  // they never raise `unknown_tool`. They also resolve to
  // `NullToolBlock`, which has no `structured_result` schema, so the
  // shape check below is a no-op for them.
  if (
    !TOOL_BLOCK_REGISTRY.has(canonical) &&
    !AUDIT_CONFIRMED_DEFAULT_TOOLS.has(canonical) &&
    !HIDDEN_TOOL_NAMES.has(canonical)
  ) {
    return { reason: "unknown_tool", detail: toolCall.toolName };
  }

  if (toolCall.status !== "error") {
    const schema = STRUCTURED_RESULT_SCHEMAS.get(canonical);
    const result = toolCall.structuredResult;
    if (schema !== undefined && result !== null && typeof result === "object") {
      const mismatch = checkStructuredShape(
        result as Record<string, unknown>,
        schema,
      );
      if (mismatch !== null) {
        return {
          reason: "unknown_shape",
          detail: `${toolCall.toolName}: ${mismatch}`,
        };
      }
    }
  }
  return null;
}

/**
 * A single drift occurrence — the unit `logDriftEvent` logs for
 * triage and `SessionDriftCaution` lists in its click-expand popover.
 */
export interface DriftEvent {
  /** The drift caution — reason + human-readable detail. */
  caution: CautionFlag;
  /** Offending tool name, when the drift is a tool call. */
  toolName?: string;
  /** Offending `tool_use` id — stable per occurrence — for tool drift. */
  toolUseId?: string;
  /** Drifted runtime version, when the drift is `version_drift`. */
  version?: string;
}

/**
 * The transcript-wide drift aggregate — `count` is the card-chrome
 * "drift detected: N events" figure; `events` backs the click-expand
 * list.
 */
export interface DriftSummary {
  count: number;
  events: ReadonlyArray<DriftEvent>;
}

/**
 * Walk a session's tool calls plus its runtime version and collect
 * every drift event — the aggregate the card-chrome caution chip
 * (`SessionDriftCaution`) surfaces. Pure over the static registry.
 *
 * `toolCalls` is the flat per-session tool-call list (every committed
 * turn's `toolCalls` concatenated, in transcript order); `version` is
 * the live `system_metadata.version` (`null` before the metadata
 * event lands). Version drift, when present, is appended last.
 */
export function summarizeDrift(args: {
  toolCalls: ReadonlyArray<ToolUseMessage>;
  version: string | null;
}): DriftSummary {
  const events: DriftEvent[] = [];
  for (const toolCall of args.toolCalls) {
    const caution = detectToolCallDrift(toolCall);
    if (caution !== null) {
      events.push({
        caution,
        toolName: toolCall.toolName,
        toolUseId: toolCall.toolUseId,
      });
    }
  }
  const versionCaution = versionDriftCaution(args.version);
  if (versionCaution !== null) {
    events.push({
      caution: versionCaution,
      version: args.version ?? undefined,
    });
  }
  return { count: events.length, events };
}

/**
 * Drift keys already logged this session. Dedupes the console-log so
 * a drift event is reported once for triage rather than on every
 * re-render that re-detects it (drift detection is pure and re-runs
 * freely). Drift is rare, so this set stays small.
 */
const loggedDriftKeys = new Set<string>();

/**
 * Test-only: clear the drift-log dedup set so each test starts from a
 * known state. Production code never calls this.
 */
export function _resetDriftLogForTests(): void {
  loggedDriftKeys.clear();
}

/** Stable per-occurrence dedup key for a drift event. */
function driftLogKey(event: DriftEvent): string {
  if (event.caution.reason === "version_drift") {
    return `version:${event.version ?? event.caution.detail ?? ""}`;
  }
  return `${event.toolUseId ?? ""}:${event.caution.reason}`;
}

/**
 * Log a drift event to the console for triage — once per distinct
 * occurrence. Emits `console.warn` with the reason, tool name,
 * version, and the caution-detail summary: the breadcrumb a user
 * needs to report a stream-json shape divergence. Re-calling with an
 * already-logged event is a no-op.
 */
export function logDriftEvent(event: DriftEvent): void {
  const key = driftLogKey(event);
  if (loggedDriftKeys.has(key)) return;
  loggedDriftKeys.add(key);
  console.warn("[dev drift] stream-json drift detected", {
    reason: event.caution.reason,
    toolName: event.toolName,
    version: event.version,
    summary: event.caution.detail,
  });
}

// ---------------------------------------------------------------------------
// Kind-renderer scaffolds.
//
// Each entry in `KIND_RENDERERS` is the renderer for one `RenderInput`
// kind. Today most are scaffolds — small functional components that
// render an inert `data-slot` div. Each follow-on step replaces its
// kind's entry with the real renderer:
//
//   assistant_text → real component lands at #step-3 (markdown extensions
//                    + transformer pass — assistant text is rendered via
//                    the existing TugMarkdownBlock; the AssistantTurnRenderer
//                    is the chrome wrapper around it)
//   thinking       → ThinkingBlock at #step-4
//   tool_call      → handled separately via the registry — never via
//                    KIND_RENDERERS
//   user_text      → existing user-row primitive (no separate renderer
//                    needed; routes here for symmetry)
//   permission     → PermissionDialog (real renderer; #step-18)
//   (question has no KIND_RENDERERS entry — the AskUserQuestion tool
//    block owns both the live and answered surfaces in place)
//   cost           → CostChrome at #step-20
//   system_metadata→ SessionInitBanner at #step-29
//   error          → ErrorBlock at #step-29
// ---------------------------------------------------------------------------

/**
 * Scaffold renderer factory. Returns a named functional component that
 * prints `data-slot="scaffold-{kind}"` plus the kind label. Each kind
 * that doesn't have a real renderer yet uses one of these so the
 * dispatch wiring is exercisable and the test suite can assert
 * Component reference equality against `KIND_RENDERERS[kind]`.
 *
 * The displayName is set so React DevTools shows the kind name —
 * helpful when debugging an unwired path before the real renderer
 * lands.
 */
function makeScaffoldRenderer(kind: RenderInputKind): React.ComponentType<any> {
  const Component: React.FC<any> = () => {
    return React.createElement("div", {
      "data-slot": `scaffold-${kind}`,
    });
  };
  Component.displayName = `Scaffold(${kind})`;
  return Component;
}

/**
 * Per-kind renderer table. Tests assert against entries here. As real
 * renderers ship, each step replaces its entry with the real
 * component reference.
 *
 * `tool_call` is intentionally omitted because tool-call dispatch
 * goes through `resolveToolBlock` — every tool routes through
 * either a registered wrapper or `DefaultToolBlock`, so there's no
 * meaningful kind-level scaffold for it.
 */
/**
 * Lazy indirection for `PermissionDialog` to break a module cycle.
 *
 * `PermissionDialog` imports `dispatchToolCallState` + `hasBespokeWrapper`
 * from this file ([#step-24-3-7], to route bespoke wrappers through
 * the dialog preview). Combined with the dispatch importing
 * `PermissionDialog` for `KIND_RENDERERS.permission`, that's a cycle.
 * Direct `permission: PermissionDialog` here would read the binding at
 * module-load time; when the dialog test loads `PermissionDialog`
 * first, the dialog module triggers the dispatch to load mid-evaluation
 * and the read of `PermissionDialog` hits a TDZ error.
 *
 * The indirection: defining the wrapper function captures
 * `PermissionDialog` as a closure binding — NOT a value read. The read
 * happens when the wrapper is rendered (called via `React.createElement`),
 * which is after both modules have finished initializing. Same shape /
 * same semantics from the consumer's perspective (renders the dialog
 * with the forwarded props); only the timing of the reference read
 * shifts to render time.
 *
 * `QuestionDialog` doesn't have the cycle (no dispatch import) but
 * gets the same indirection for symmetry — and to insulate it against
 * a future change that adds a dispatch import on the question side.
 */
const PermissionDialogLazy: React.ComponentType<any> = (props) =>
  React.createElement(PermissionDialog, props);
PermissionDialogLazy.displayName = "PermissionDialog(lazy)";

export const KIND_RENDERERS: {
  readonly [K in Exclude<RenderInputKind, "tool_call">]: React.ComponentType<any>;
} = {
  assistant_text: makeScaffoldRenderer("assistant_text"),
  thinking: makeScaffoldRenderer("thinking"),
  user_text: makeScaffoldRenderer("user_text"),
  permission: PermissionDialogLazy,
  cost: makeScaffoldRenderer("cost"),
  // SessionInitBanner ([#step-29], [D03]) — reads metadata +
  // previousMetadata from the input and renders only when something
  // user-visible changed. Identical-shape metadata events render to
  // null without re-mounting.
  system_metadata: SessionInitBanner,
  // ErrorBlock ([#step-29]) — recoverable / non-recoverable variants
  // surface with caution / danger tones and a Retry / Copy action.
  error: SessionErrorBlock,
};

// ---------------------------------------------------------------------------
// dispatch — the load-bearing routing function.
// ---------------------------------------------------------------------------

/**
 * Route a `RenderInput` to a renderer + props. Pure function over the
 * static registry; never throws. Returns `caution` when drift is
 * detected.
 */
export function dispatch(
  input: RenderInput,
  context: DispatchContext,
): DispatchResult {
  if (input.kind === "tool_call") {
    return dispatchToolCallState(input.toolCall);
  }
  if (input.kind === "system_metadata") {
    // Version-drift check ([D04]): a `system_metadata.version` that
    // diverges from the pinned catalog raises a `version_drift`
    // caution, threaded onto the props so a real `system_metadata`
    // renderer (the #step-29 SessionInitBanner) can paint the inline
    // marker, and returned on the result so the card-chrome aggregate
    // counts it.
    const caution = detectVersionDrift(input.metadata) ?? undefined;
    return {
      Component: KIND_RENDERERS.system_metadata,
      props: { input, context, caution },
      caution,
    };
  }
  // Everything else routes through KIND_RENDERERS. The exhaustive
  // check below makes this branch type-safe — every kind in
  // RenderInput must have a corresponding entry.
  const Component = KIND_RENDERERS[input.kind];
  return {
    Component,
    props: { input, context },
  };
}

/**
 * Read the plain-text output from a stored `ToolUseMessage.result`.
 * Returns `undefined` when nothing readable is present.
 *
 * The reducer's `handleToolResult` stores `event.output` (the literal
 * stdout string from the wire's `tool_result` event) directly into
 * `ToolUseMessage.result`, so the live shape is a bare `string`. We
 * also accept the wrapped `{ output: string }` shape for forward-
 * compat with future reducer changes that might preserve the full
 * `tool_result` payload, and for tests that historically constructed
 * the wrapped form. Anything else collapses to `undefined`.
 */
/**
 * Claude Code wraps a tool's error payload in
 * `<tool_use_error>…</tool_use_error>` before returning it as the result
 * `output`. Those tags are a transport artifact, never meant for display —
 * strip them (and trim the result) so the failure reads as plain text in the
 * notice band and the body. Output without the wrapper is returned verbatim,
 * preserving any meaningful leading/trailing whitespace.
 */
function stripToolUseErrorTags(text: string): string {
  if (!/<\/?tool_use_error>/.test(text)) return text;
  return text.replace(/<\/?tool_use_error>/g, "").trim();
}

export function extractTextOutput(result: unknown): string | undefined {
  const raw =
    typeof result === "string"
      ? result
      : result !== null &&
          typeof result === "object" &&
          typeof (result as Record<string, unknown>).output === "string"
        ? ((result as Record<string, unknown>).output as string)
        : undefined;
  return raw === undefined ? undefined : stripToolUseErrorTags(raw);
}

/**
 * Generic interruption signal for the header phase ([D03]). A tool's
 * `structured_result` may carry an `interrupted: true` flag (bash
 * surfaces it when a command is killed mid-run; other long-running
 * tools may too). Returns `true` only for an explicit boolean `true`;
 * any other shape — absent field, non-boolean, no structured result —
 * is "not interrupted." Tools that never carry the flag simply read
 * `false`, leaving the phase to fall out of `status` alone.
 */
function extractInterrupted(structuredResult: unknown): boolean {
  if (structuredResult === null || typeof structuredResult !== "object") {
    return false;
  }
  return (structuredResult as Record<string, unknown>).interrupted === true;
}

/**
 * The block factory a call actually renders through — the routing half of
 * {@link dispatchToolCallState}, without composing props.
 *
 * Not the same question as {@link resolveToolBlock}, which answers "what is
 * this tool's wrapper?" from the name alone. This answers "what will the
 * transcript mount for THIS call?", so it accounts for drift: an unknown
 * tool, or a registered wrapper whose `structured_result` failed its shape
 * schema, renders `DefaultToolBlock` no matter what the registry holds.
 *
 * The search index projects a call's header and body through this, so the
 * text it counts is the text the DOM will show ([P04] of find-foundations —
 * index and paint must stay symmetric).
 */
export function renderedToolBlock(toolCall: ToolUseMessage): ToolBlockFactory {
  const lower = toolCall.toolName.toLowerCase();
  const canonical = TOOL_ALIASES.get(lower) ?? lower;
  if (HIDDEN_TOOL_NAMES.has(canonical)) return NullToolBlock;
  if (detectToolCallDrift(toolCall) !== null) return DefaultToolBlock;
  return TOOL_BLOCK_REGISTRY.get(canonical) ?? DefaultToolBlock;
}

/**
 * Tool-call dispatch — looks up the tool name in the registry, with
 * alias resolution. A call that `detectToolCallDrift` flags (unknown
 * tool name, or a registered wrapper whose `structured_result` fails
 * its shallow shape schema) routes to `DefaultToolBlock` with the
 * caution threaded onto the props and returned on the result.
 *
 * Exported so the transcript view can route a `ToolUseMessage` (from
 * `TurnEntry.messages` or `ActiveTurnSnapshot.messages`) to a
 * `(Component, props)` pair without fabricating a full
 * `DispatchContext` — the tool-call branch never consumed it.
 *
 * No `msgId` parameter per [D16]. The Message is the identity: tool
 * blocks read what they need (`toolUseId`, `toolName`, `input`,
 * `result`, `structuredResult`) from the `ToolUseMessage` they
 * receive. Under [D07] each `ToolUseMessage` carries its own
 * `messageKey`; the underlying claude `msg_id` is metadata on the
 * Message, not a routing key.
 *
 * `depth` (default `0`) is the [D17] recursion depth: `AgentTranscriptBlock`
 * passes `depth + 1` when it routes a *nested* tool call, so a nested
 * `Agent` (→ `TaskToolBlock` → `AgentTranscriptBlock`) knows how deep it
 * is and can collapse past the depth cap. Top-level callers omit it.
 *
 * `childToolCallsByParent` ([#step-17-5]) is the subagent-nesting map —
 * the transcript view builds it once from the flat tool-call list and
 * threads it through here so `TaskToolBlock` can resolve a subagent's
 * child tool calls. Top-level callers that have no subagents omit it.
 *
 * `preview` (default `false`) marks an approve/deny preview of a
 * pending tool call — the `PermissionDialog` sets it so the resolved
 * wrapper renders the input/command side without painting a finished
 * call's result surfaces (see `ToolBlockProps.preview`).
 */
export function dispatchToolCallState(
  toolCall: ToolUseMessage,
  depth = 0,
  childToolCallsByParent?: ChildToolCallsMap,
  session?: CodeSessionStore,
  awaiting = false,
  turnInterrupted = false,
  preview = false,
): DispatchResult {
  const lower = toolCall.toolName.toLowerCase();
  const canonical = TOOL_ALIASES.get(lower) ?? lower;

  // Compose the props the wrapper expects (see ToolBlockProps in
  // ./blocks/types.ts). Status maps the store's `pending |
  // done | error` to the wrapper's `streaming | ready | error`.
  const status =
    toolCall.status === "pending"
      ? "streaming"
      : toolCall.status === "error"
        ? "error"
        : "ready";

  // Header-indicator phase ([D03]). Richer than `status`: the leftmost
  // pulsing-dot needs `in_flight | awaiting | success | error |
  // interrupted`. `awaiting` (the permission/question hold) is the
  // caller's to supply — the transcript view id-joins the live
  // snapshot's `pendingApproval` / `pendingQuestion` `tool_use_id`
  // against this call and passes the result here ([Q01], #step-6).
  //
  // The interruption signal has two sources, per `ToolCallPhaseInput`:
  // a generic structured-result flag (bash and any tool that surfaces
  // `interrupted: true` when killed mid-run), OR the turn itself being
  // stopped while this call was still in flight. The latter is the
  // caller's to supply (`turnInterrupted`) and applies only to a call
  // that never finished (`status === "pending"`): a turn that commits
  // non-`complete` leaves its still-running tools without a result, so
  // their dot must read `interrupted`, not stay stuck `in_flight`. A
  // call that already reached `done` / `error` keeps its own terminal.
  const phase = deriveToolCallPhase({
    status: toolCall.status,
    interrupted:
      extractInterrupted(toolCall.structuredResult) ||
      (turnInterrupted && toolCall.status === "pending"),
    awaiting,
  });

  const baseProps = {
    toolUseId: toolCall.toolUseId,
    toolName: toolCall.toolName,
    seq: 0, // populated by the transcript view from event ordering
    input: toolCall.input,
    structuredResult: toolCall.structuredResult,
    textOutput: extractTextOutput(toolCall.result),
    isError: toolCall.status === "error",
    status,
    phase,
    depth,
    childToolCallsByParent,
    session,
    // Forwarded so a recursing wrapper (`TaskToolBlock` →
    // `AgentTranscriptBlock`) can carry the turn-stopped signal down to
    // its subagent children's own `dispatchToolCallState`, so their
    // pending dots flip to `interrupted` too ([D17]).
    turnInterrupted,
    preview,
  };

  // Hidden tools ([D101]) short-circuit ahead of drift detection and
  // registry lookup — they render no DOM and carry no caution. The
  // check mirrors `resolveToolBlock`'s ordering so both entry points
  // converge on the same factory.
  if (HIDDEN_TOOL_NAMES.has(canonical)) {
    return { Component: NullToolBlock, props: baseProps };
  }

  const caution = detectToolCallDrift(toolCall);
  if (caution !== null) {
    // Drift — an unknown tool name, or a registered wrapper whose
    // `structured_result` failed its shallow shape schema. Either way
    // the [D04] fallback is `DefaultToolBlock` (`JsonTreeBlock` over
    // the raw payload); the caution is threaded onto the props so the
    // wrapper chrome paints the inline `SessionCautionBadge`, and
    // returned on the result so the card-chrome aggregate counts it.
    return {
      Component: DefaultToolBlock,
      props: { ...baseProps, caution },
      caution,
    };
  }

  const factory = TOOL_BLOCK_REGISTRY.get(canonical);
  if (factory !== undefined) {
    // Registered wrapper, shape intact — route to the bespoke wrapper.
    return { Component: factory, props: baseProps };
  }

  // Audit-confirmed long-tail tool — known to route through
  // `DefaultToolBlock` by design, so no caution.
  return { Component: DefaultToolBlock, props: baseProps };
}

// ---------------------------------------------------------------------------
// AssistantRendererDispatch interface — re-exposes the module surface
// as an object so consumers that prefer instance-style access (per
// Spec S01) can use it.
// ---------------------------------------------------------------------------

/**
 * Object-style facade over the module functions. Useful for tests and
 * for consumers that want to pass the dispatcher around as a single
 * value. The functions are also re-exported individually so
 * tree-shaking works naturally for consumers that only need one.
 */
export interface AssistantRendererDispatch {
  dispatch(input: RenderInput, context: DispatchContext): DispatchResult;
  resolveToolBlock(toolName: string): ToolBlockFactory;
  registeredTools(): ReadonlyArray<string>;
}

export const assistantRendererDispatch: AssistantRendererDispatch = {
  dispatch,
  resolveToolBlock,
  registeredTools,
};
