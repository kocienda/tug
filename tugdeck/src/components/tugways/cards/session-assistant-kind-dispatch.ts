/**
 * session-assistant-kind-dispatch.ts — the kind-level half of the assistant
 * renderer dispatch: `KIND_RENDERERS`, the `dispatch(input, context)` router
 * over every `RenderInput` kind, and the `assistantRendererDispatch` facade.
 *
 * The tool-call half — the wrapper registry, aliases, drift detection, and
 * `dispatchToolCallState` — lives in `session-assistant-renderer-dispatch.ts`,
 * and `dispatch` routes `tool_call` there. The split is the import graph's:
 * `PermissionDialog` previews a pending call through `dispatchToolCallState`,
 * and this table names `PermissionDialog` as the `permission` renderer, so
 * the two halves in one module imported each other.
 *
 * @module components/tugways/cards/session-assistant-kind-dispatch
 */

import React from "react";

import { PermissionDialog } from "@/components/tugways/chrome/session-permission-dialog";
import { SessionInitBanner } from "@/components/tugways/chrome/session-init-banner";
import { SessionErrorBlock } from "@/components/tugways/chrome/session-error-block";
import {
  detectVersionDrift,
  dispatchToolCallState,
  registeredTools,
  resolveToolBlock,
  type DispatchContext,
  type DispatchResult,
  type RenderInput,
  type RenderInputKind,
} from "./session-assistant-renderer-dispatch";
import type { ToolBlockFactory } from "../blocks/types";

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
export const KIND_RENDERERS: {
  readonly [K in Exclude<RenderInputKind, "tool_call">]: React.ComponentType<any>;
} = {
  assistant_text: makeScaffoldRenderer("assistant_text"),
  thinking: makeScaffoldRenderer("thinking"),
  user_text: makeScaffoldRenderer("user_text"),
  permission: PermissionDialog,
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
