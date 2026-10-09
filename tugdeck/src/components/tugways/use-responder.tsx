/**
 * useResponder -- hook for registering a component as a responder node.
 *
 * Reads the ResponderChainManager from ResponderChainContext and the nearest
 * parent responder ID from ResponderParentContext. Registers the caller as a
 * node on mount, unregisters on unmount. Returns a stable ResponderScope
 * component that provides this node's ID as the parent context for children
 * and a stable `responderRef` callback that the caller attaches to its
 * root DOM element; the hook uses that ref to write a `data-responder-id`
 * attribute so the chain can resolve "innermost responder under the event
 * target" without a React tree walk (see ResponderChainManager.findResponderForTarget).
 *
 * Registration uses useLayoutEffect ([D41], Rule of Tug #3) so the node is
 * registered during the commit phase (after DOM mutations, before paint).
 * Combined with useSyncExternalStore-driven SyncLane renders ([D01]), this
 * guarantees all responder registrations complete before the next browser
 * event fires, eliminating the timing gap between imperative state mutations
 * and React rendering.
 *
 * ## Where `parentId` comes from (and why portals matter)
 *
 * `parentId` is sourced in this priority order:
 *   1. The explicit `options.parentId` if the caller passes one.
 *   2. Otherwise, the value of `ResponderParentContext` at the call site
 *      (which is always the nearest enclosing `<ResponderScope>`'s
 *      registered id).
 *
 * Critically, the React-context lookup is independent of DOM placement.
 * A subtree portaled out of its parent's DOM via `createPortal(jsx,
 * targetElsewhere)` still reads the consumer's React-tree
 * `ResponderParentContext`. This is by design: chain dispatches walk
 * `parentId` (the React-tree axis), so a portaled modal still routes
 * dispatches up to its conceptual parent even though its rendered DOM
 * has no responder ancestor.
 *
 * The chain's two walks — `walkFromNode(id)` via `parentId` (chain
 * dispatch) and `findResponderForTarget(node)` via DOM `parentElement`
 * (pointer/focus promotion) — answer different questions and can return
 * different ancestors for portaled subtrees. Both are correct; per
 * `tugplan-dev-overlay-framework.md` [D03], use the right walk for
 * the job.
 *
 * Consumers that need to override the React-tree default (e.g.,
 * `CardHost` re-parenting `cardId` onto its host pane's `stackId`) pass
 * `options.parentId` explicitly; that override is what makes
 * portaled-content dispatch reach handlers that live "above" the React
 * placement.
 *
 * See `tugplan-dev-overlay-framework.md` (#mental-model) for the
 * five-subsystem architecture this hook participates in (portals,
 * chain, focus events, pane focus controller, focus-discipline
 * markers).
 *
 * [D02] Nested context for parent discovery
 * [D03] useResponder uses useLayoutEffect for registration
 * [D41] Use useLayoutEffect for registrations that events depend on
 *
 */

import React, { useCallback, useContext, useLayoutEffect, useRef } from "react";
import { ResponderChainContext, ResponderParentContext } from "./responder-chain";
import type { ActionHandler, ResponderKind, ResponderNode, TugAction } from "./responder-chain";

// Re-export for backward compatibility — existing consumers import from here.
export { ResponderParentContext } from "./responder-chain";

// ---- UseResponderOptions ----

/**
 * Options for useResponder.
 *
 * Generic on `Extra extends string` so consumers can opt into action
 * names outside the production `TugAction` vocabulary (see
 * `action-vocabulary.ts`'s docstring). Production call sites use
 * `useResponder({ ... })` with the default `never` and see only
 * production action names in autocomplete; galleries and demos use
 * `useResponder<GalleryAction>({ ... })` to register handlers for
 * their opt-in names.
 */
export interface UseResponderOptions<Extra extends string = never> {
  /** Stable string ID for this responder node. Should be a constant at the call site. */
  id: string;
  /**
   * Partial map of TugAction names to handler functions (primary
   * dispatch path). A responder registers handlers for only the
   * subset of actions it cares about; other actions walk past it in
   * the chain.
   *
   * Handlers may return `void` (standard case) or `() => void` — an
   * optional "continuation" callback that the caller will invoke at a
   * later commit point (e.g. after a menu activation blink). The sync
   * portion of the handler (clipboard writes, state capture) runs
   * inline; the deferred portion runs from the continuation.
   *
   * [D02] Handler signature is (event: ActionEvent) => void | (() => void)
   * (#s05-use-responder-options)
   */
  actions?: Partial<Record<TugAction<Extra>, ActionHandler<Extra>>>;
  /**
   * Advisory canHandle function for actions not in the actions map.
   * Consulted by canHandle() and validateAction() queries only -- never by dispatch().
   *
   * Optional — when omitted, the hook skips installing the wrapper
   * closure entirely and the responder node's `canHandle` field
   * stays `undefined`, which the chain treats as "no advisory
   * override." Callers who genuinely need runtime-determined
   * capabilities (e.g. DeckCanvas as last-resort responder) provide
   * this function; all other responders leave it out.
   */
  canHandle?: (action: TugAction<Extra>) => boolean;
  /** Per-action enabled-state query. Defaults to true if omitted. */
  validateAction?: (action: TugAction<Extra>) => boolean;
  /**
   * Per-action display-state query — the checkmark/toggle/value sibling of
   * `validateAction`. Returns a boolean for a check state, a string for a
   * current value, `undefined` for "nothing to show". Consulted only by
   * `queryActionState()` queries, never by dispatch.
   */
  queryActionState?: (action: TugAction<Extra>) => boolean | string | undefined;
  /**
   * Optional tier tag for `getKeyResponderOfKind` walks. Most
   * responders leave this unset; tier-defining nodes opt in (e.g.,
   * `TugCard` passes `kind: "card"`). Captured at mount and stored on
   * the registered node — changing it later would require
   * re-registration, which is fine because the tier of a responder is
   * a structural property of its identity, not a per-render toggle.
   *
   * See design doc for the design.
   */
  kind?: ResponderKind;
  /**
   * Optional explicit parent responder id. When omitted (the default),
   * the hook reads `parentId` from `ResponderParentContext`, which
   * follows the React tree — sufficient for the common case where the
   * responder's DOM also sits inside its React parent's scope.
   *
   * Override this when the responder's DOM output is portaled out of
   * its React parent, so the chain matches the rendered DOM
   * relationship instead of the React tree. The primary consumer is
   * `CardHost` after 11.6.1a Piece 1 (Card content lives in a
   * flat deck-level list in the React tree but is portaled into the
   * host stack's content div) — passing `parentId: hostStackId`
   * re-parents the chain to the stack's tug-pane responder so
   * `NEXT_TAB` / `PREVIOUS_TAB` / `FOCUS_PROMPT` / etc. walk to the
   * right handler.
   *
   * Passing `null` explicitly pins the responder as a root node
   * (`parentId = null`), same as when there is no context-provided
   * parent.
   */
  parentId?: string | null;
  /**
   * Optional substrate-supplied focus callback.
   *
   * Forwarded into the registered `ResponderNode.focus` field. Invoked
   * by `manager.focusResponder(id)` after `makeFirstResponder(id)` runs
   * — so chain-driven focus restoration lands DOM focus on the right
   * element without `focusResponder` having to special-case substrates
   * with non-trivial focus surfaces (CodeMirror's `view.focus()`,
   * shadow-DOM hosts, contenteditable invariants).
   *
   * Substrates that own a non-trivial focus surface supply the
   * callback (e.g., `TugTextEditor` passes `() => view.focus()`).
   * Generic responders (text inputs, buttons, generic containers)
   * omit the option; `focusResponder` falls back to a DOM walk that
   * focuses the responder's `[data-responder-id]` element or its
   * first tabbable descendant.
   *
   * Per `tugplan-session-popup-bindings.md` [D03] (#focus-contract). Like
   * `canHandle` / `validateAction` / `kind`, `focus` is a structural
   * property captured at mount; changing it on a later render does
   * not re-register and the change has no effect. This matches the
   * "structure of the responder's identity" semantics — substrates
   * either own a focus surface or they don't, and that doesn't change
   * mid-life.
   */
  focus?: () => void;
}

// ---- useResponder ----

/**
 * Return type of useResponder.
 *
 * - `ResponderScope`: stable wrapper component that provides this
 *   responder's id as the parent context for children.
 * - `responderRef`: stable ref callback to attach to the component's
 *   root DOM element. The hook writes `data-responder-id="<id>"` on
 *   that element so the chain can resolve "innermost responder under
 *   this DOM node" via findResponderForTarget. Elements with no
 *   registered responder simply have no attribute.
 */
export interface UseResponderResult {
  ResponderScope: React.FC<{ children: React.ReactNode }>;
  responderRef: (el: Element | null) => void;
}

/**
 * Register the calling component as a responder node. **Strict form.**
 *
 * Must be called inside a <ResponderChainProvider>. Throws a descriptive
 * error if the manager context is null — programming error, not a valid
 * runtime state for components that intend to register as responders.
 *
 * Use this for components where chain participation is load-bearing for
 * correctness — tug-pane, tug-prompt-input, deck-canvas, any responder
 * whose actions must be routable from the chain. The throw catches
 * "I forgot the provider" bugs at mount rather than letting them
 * silently degrade into a no-op at runtime.
 *
 * For leaf controls that must render in standalone previews and tests
 * without a chain provider (TugInput, TugTextarea, TugValueInput), use
 * {@link useOptionalResponder} instead. It has the same signature and
 * return shape but skips the registration step when the manager is
 * absent, so the component can participate in the chain when mounted
 * inside a provider and quietly stand alone otherwise — without
 * splitting its JSX into a plain/responder two-path render that would
 * flip React's component identity on provider transitions.
 *
 * Returns { ResponderScope, responderRef }.
 * - `ResponderScope` is a stable wrapper component that provides this
 *   responder's ID as the parent context for its children. The component
 *   has a stable function identity across re-renders (held in a ref) so
 *   React does not unmount/remount children when the parent re-renders.
 * - `responderRef` is a stable ref callback the caller attaches to its
 *   root DOM element. The hook writes `data-responder-id` on that
 *   element so the chain's first-responder promotion can walk the DOM
 *   from an event target and find this node.
 *
 * Each component using useResponder must:
 *   1. Render <ResponderScope> around the subtree that should treat
 *      this node as its parent responder.
 *   2. Attach responderRef to its root DOM element so the chain can
 *      resolve it during pointerdown capture.
 */
export function useResponder<Extra extends string = never>(
  options: UseResponderOptions<Extra>,
): UseResponderResult {
  const manager = useContext(ResponderChainContext);

  if (manager === null) {
    throw new Error("useResponder must be used inside a <ResponderChainProvider>");
  }

  // Delegate to useOptionalResponder for the actual body. Both hooks
  // share one implementation; the only difference is the top-level
  // throw above. useContext is called again inside
  // useOptionalResponder — cheap and correct, and keeps the hook call
  // order stable per caller (strict vs tolerant callers each use
  // exactly one of these entry points per component, so their
  // per-component call orders never mix).
  return useOptionalResponder(options);
}

/**
 * Register the calling component as a responder node. **Tolerant form.**
 *
 * Same signature and return shape as {@link useResponder}. Same behavior
 * when rendered inside a <ResponderChainProvider>: registers the node,
 * writes `data-responder-id`, returns a stable ResponderScope. But when
 * the manager context is null, this hook gracefully no-ops instead of
 * throwing — the layout effect skips the registration call, the ref
 * callback skips the attribute write, and the returned ResponderScope
 * is still stable but has no effect because no descendant will resolve
 * the parent context to a registered node.
 *
 * Intended for leaf controls that must render in both contexts:
 * - Inside a provider (real app, gallery demos, integration tests): the
 *   control registers and participates in the chain like any other
 *   responder. Actions dispatched through the chain reach the control
 *   and drive its behavior.
 * - Outside a provider (standalone previews, unit tests that don't set
 *   up a chain, pre-mount snapshots): the control still renders
 *   correctly, handles its own DOM events directly, and silently
 *   degrades its chain features (chain-dispatched actions have nowhere
 *   to go; the `data-responder-id` attribute is omitted).
 *
 * The critical property this hook enables is **state preservation
 * across provider transitions**. A test that mounts the control
 * standalone, wraps it in a provider mid-run, then unwraps the
 * provider, does not trigger a component-type flip at the leaf
 * component's position in the tree. React reconciles the same DOM
 * element through the transition, so caret position, focus,
 * selection, and any uncontrolled text state all survive. This is the
 * reason the hook exists: the old pattern of splitting a leaf control
 * into `TugXxxPlain` and `TugXxxWithResponder` component types created
 * exactly this footgun — switching between them on provider presence
 * unmounted the subtree and destroyed user-visible input state.
 *
 * On manager transition (null → non-null or vice versa):
 * - `useContext(ResponderChainContext)` picks up the new value; the
 *   hook re-renders.
 * - The layout effect's dependency array includes `manager`, so the
 *   effect runs its cleanup (unregistering from the old manager, if
 *   any) and re-runs with the new manager (registering, if non-null).
 * - The `responderRef` callback's useCallback deps include `manager`,
 *   so its identity changes on transition. React calls the previous
 *   callback with `null` (removing `data-responder-id` from the
 *   element) and then calls the new callback with the element (which
 *   writes the attribute only if the new manager is non-null).
 * - The DOM element itself is never replaced — it stays mounted across
 *   the transition, preserving all user-visible state.
 */
export function useOptionalResponder<Extra extends string = never>(
  options: UseResponderOptions<Extra>,
): UseResponderResult {
  const manager = useContext(ResponderChainContext);

  // Allow an explicit `parentId` override (portal consumers: see
  // `UseResponderOptions.parentId` JSDoc). Context-provided value is
  // the default.
  const contextParentId = useContext(ResponderParentContext);
  const parentId =
    options.parentId !== undefined ? options.parentId : contextParentId;

  // Keep a ref to the latest options so the cleanup effect always sees the
  // correct id without needing to tear down and re-register on every render.
  // Also: the proxy actions map installed into the chain reads from this
  // ref on every dispatch, so handler identity changes between renders
  // are reflected without re-registering (closes the stale-closure
  // loophole described in the audit doc section 2.5 / R5).
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Capture whether the caller provided `canHandle` / `validateAction`
  // at mount time. The hook uses these flags to decide whether to
  // install live-lookup closures for those fields or to leave them
  // undefined on the registered node. Leaving them undefined lets the
  // chain's dispatch/query code skip the advisory-override branch
  // entirely, which is the expected behavior for the vast majority of
  // responders that don't need runtime capability overrides.
  //
  // Design note: the flag is captured once at mount (not read live
  // from optionsRef). A caller that adds `canHandle` after the fact
  // would need to re-register to have it take effect — which is fine,
  // because `canHandle` existence is a structural property of the
  // responder's identity, not a per-render toggle. The R5 live-proxy
  // mechanism handles handler identity changes; this flag handles
  // structural shape changes, which are not expected to happen.
  const hasCanHandleAtMount = useRef(options.canHandle !== undefined);
  const hasValidateActionAtMount = useRef(options.validateAction !== undefined);
  const hasQueryActionStateAtMount = useRef(
    options.queryActionState !== undefined,
  );
  // The tier tag is a structural property of the responder, captured
  // at mount. Changing it later does not re-register; that matches
  // canHandle / validateAction and is the right behavior because a
  // responder's tier is its identity, not a per-render toggle.
  const kindAtMount = useRef(options.kind);
  // Same shape as `kindAtMount`: the focus callback is a structural
  // property captured at mount per [D03] (#focus-contract). Substrates
  // either own a non-trivial focus surface or they don't — that's
  // identity, not per-render state. The captured value at mount is
  // what the registered node carries; changing the option on a later
  // render does not re-register and the change has no effect.
  //
  // We intentionally do NOT proxy through `optionsRef` here (unlike
  // `actions`, which we proxy so handler identity changes flow
  // through). The focus callback is meant to invoke a stable surface
  // method (e.g., `view.focus()` on a CM6 EditorView held in a ref);
  // the substrate captures whichever ref it needs in the closure it
  // hands us at registration time. The closure is the substrate's
  // responsibility to set up correctly per [L07].
  const focusAtMount = useRef(options.focus);

  // Tracks the DOM element the responderRef callback was most
  // recently called with. Declared up here (rather than alongside
  // responderRef below) so the registration layout effect can read
  // it at effect time to close the stale-focus timing hole.
  const currentElementRef = useRef<Element | null>(null);

  // The element THIS hook last stamped with `data-responder-id`. Distinct
  // from `currentElementRef` (which is nulled on every detach): the stamp
  // survives a detach/attach cycle so the manager-less branch of the ref
  // callback can tell its own stamp from another consumer's on a shared
  // element — only the writer may un-write.
  const stampedElementRef = useRef<Element | null>(null);

  // Register during the commit phase (useLayoutEffect), unregister on unmount.
  // useLayoutEffect fires synchronously after all DOM mutations but before the
  // browser paints, ensuring the responder is registered before any keyboard or
  // pointer event handler can fire. This is the Rule of Tug #3 / [D41] contract.
  //
  // manager and parentId are stable references:
  //   - manager is the singleton from context, never replaced.
  //   - parentId changes only if an ancestor re-registers with a new ID,
  //     which is not a normal runtime condition.
  //
  // The `actions` we register is a live Proxy: rather than capturing the
  // current actions map at registration time, every access reads from
  // optionsRef.current.actions. This means a caller that forgets to
  // useCallback-wrap their handlers still gets correct dispatch — the
  // manager always sees the current render's handlers.
  useLayoutEffect(() => {
    // No manager in scope → nothing to register, no cleanup needed.
    // The effect's dep array still includes `manager`, so a later
    // transition to a non-null manager will re-run this effect and
    // register the node at that point. The early return returns
    // `undefined` as the cleanup slot, which React correctly
    // interprets as "nothing to clean up on the next run."
    if (manager === null) return;

    const id = optionsRef.current.id;
    // Live-lookup proxy: every access reads from optionsRef.current.actions
    // so re-renders with new handler identities are reflected without
    // re-registering the node. Closes the stale-closure loophole
    // documented in R5 of the audit.
    const liveActions = new Proxy(
      {} as Partial<Record<TugAction<Extra>, ActionHandler<Extra>>>,
      {
        get(_, prop: string | symbol): ActionHandler<Extra> | undefined {
          if (typeof prop !== "string") return undefined;
          const actions = optionsRef.current.actions;
          return actions ? actions[prop as TugAction<Extra>] : undefined;
        },
        has(_, prop: string | symbol): boolean {
          if (typeof prop !== "string") return false;
          const actions = optionsRef.current.actions;
          return actions ? prop in actions : false;
        },
        ownKeys(): ArrayLike<string | symbol> {
          const actions = optionsRef.current.actions;
          return actions ? Reflect.ownKeys(actions) : [];
        },
        getOwnPropertyDescriptor(_, prop: string | symbol) {
          if (typeof prop !== "string") return undefined;
          const actions = optionsRef.current.actions;
          if (actions && prop in actions) {
            return {
              enumerable: true,
              configurable: true,
              value: actions[prop as TugAction<Extra>],
            };
          }
          return undefined;
        },
      },
    );
    // Build the node without always installing canHandle/validateAction
    // wrapper closures. Callers who did not provide those fields get
    // `undefined` on the node, which the chain treats as "no advisory
    // override" and skips in dispatch/query walks. Only callers who
    // actually supplied a function pay the closure cost, and for
    // those we still read via optionsRef so handler identity changes
    // are reflected without re-registering.
    const node: ResponderNode<Extra> = {
      id,
      parentId,
      actions: liveActions,
    };
    if (hasCanHandleAtMount.current) {
      node.canHandle = (action: TugAction<Extra>) =>
        optionsRef.current.canHandle?.(action) ?? false;
    }
    if (hasValidateActionAtMount.current) {
      node.validateAction = (action: TugAction<Extra>) =>
        optionsRef.current.validateAction?.(action) ?? true;
    }
    if (hasQueryActionStateAtMount.current) {
      node.queryActionState = (action: TugAction<Extra>) =>
        optionsRef.current.queryActionState?.(action);
    }
    if (kindAtMount.current !== undefined) {
      node.kind = kindAtMount.current;
    }
    if (focusAtMount.current !== undefined) {
      node.focus = focusAtMount.current;
    }
    manager.register(node);

    // ---- Stale-focus re-promotion ----
    //
    // Close the autoFocus / any-pre-registration-focus timing hole.
    //
    // React's `autoFocus` prop and some synchronous focus flows fire
    // `element.focus()` during the commit mutation phase — BEFORE ref
    // callbacks run and BEFORE layout effects. That means when
    // `focusin` fires, the newly-mounted responder's
    // `data-responder-id` attribute hasn't been written yet, and the
    // newly-mounted responder node isn't in the manager yet. The
    // chain provider's document-level focusin listener walks from the
    // focus target up through the DOM, skips past the un-instrumented
    // element, and promotes some ancestor responder instead.
    // Concretely: an autoFocus'd input inside a freshly mounted sheet
    // leaves first responder on the CARD, not the input, and a later
    // ⌘A routes to the card's selectAll handler instead of the
    // input's.
    //
    // The fix runs here, at the point where registration completes.
    // If `document.activeElement` is inside this responder's DOM
    // element, that means focus has already landed here but the
    // earlier focusin promotion couldn't find us. Re-run promotion
    // now: `findResponderForTarget(activeEl)` walks from the focused
    // element up — and this time it stops at the newly-registered
    // node (or an inner child that also just registered). The walk
    // is innermost-first, so if a deeper child has also just
    // registered, the child wins, which is what we want.
    const el = currentElementRef.current;
    if (el && typeof document !== "undefined") {
      const activeEl = document.activeElement;
      if (activeEl && el.contains(activeEl)) {
        const resolvedId = manager.findResponderForTarget(activeEl);
        if (
          resolvedId !== null &&
          resolvedId !== manager.getFirstResponder()
        ) {
          manager.makeFirstResponder(resolvedId);
        }
      }
    }

    return () => {
      manager.unregister(id);
    };
  }, [manager, parentId]);

  // Build the ResponderScope component exactly once and hold it in a ref.
  // This gives the component a stable function identity across re-renders,
  // preventing React from unmounting and remounting children. The closure
  // captures options.id at creation time; since IDs should be stable string
  // literals at each call site, this is always correct.
  const scopeRef = useRef<React.FC<{ children: React.ReactNode }> | null>(null);
  if (scopeRef.current === null) {
    const nodeId = options.id;
    scopeRef.current = function ResponderScope({ children }: { children: React.ReactNode }) {
      return (
        <ResponderParentContext.Provider value={nodeId}>
          {children}
        </ResponderParentContext.Provider>
      );
    };
  }

  // Stable ref callback that writes `data-responder-id` to the host
  // element — but only when a chain manager is in scope. When there
  // is no manager, the attribute is omitted so devtools cannot see an
  // orphaned id that points at nothing, and so existing tests that
  // assert "no data-responder-id when rendered standalone" continue
  // to pass.
  //
  // `manager` is in the useCallback dependency array: on a provider
  // transition (null ↔ non-null) the callback identity changes, which
  // triggers React's standard ref-callback lifecycle — detach, then a
  // re-attach through the new callback, which writes the attribute
  // when the new manager is non-null and removes it when the manager
  // is null. The DOM element itself is never replaced; only the
  // attribute flips on transition. This is how state survives the
  // transition — the element is the same element across provider
  // changes.
  //
  // Idempotent under detach/attach cycles: a `null` call does no DOM work —
  // a detached element is either about to be re-attached (an ancestor
  // recomposed the ref, e.g. a Radix `asChild` slot, which recreates its
  // composed ref every render) or discarded with the attribute on it. The
  // attach call is the single writer: it removes this hook's own stamp when
  // no manager is in scope (never another consumer's stamp on a shared
  // element) and otherwise writes only a value that actually differs, so a
  // re-attach to the same element under the same manager is zero DOM
  // mutations — no style invalidation, no recalc bill.
  const responderRef = useCallback((el: Element | null) => {
    if (el) {
      const stamped = stampedElementRef.current;
      if (stamped && stamped !== el) {
        stamped.removeAttribute("data-responder-id");
        stampedElementRef.current = null;
      }
      if (manager !== null) {
        if (el.getAttribute("data-responder-id") !== options.id) {
          el.setAttribute("data-responder-id", options.id);
        }
        stampedElementRef.current = el;
      } else if (stampedElementRef.current === el) {
        el.removeAttribute("data-responder-id");
        stampedElementRef.current = null;
      }
    }
    currentElementRef.current = el;
  }, [options.id, manager]);

  return { ResponderScope: scopeRef.current, responderRef };
}
