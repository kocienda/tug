/**
 * useResponderForm — the consumer-side companion to `useResponder` for
 * components that host multiple interactive controls (checkboxes,
 * switches, radio groups, choice groups, option groups, tabs,
 * accordions, sliders, inputs, etc.) all dispatching actions through
 * the responder chain.
 *
 * Design: a single hook call registers the hosting component as a
 * responder node and exposes a declarative bindings map that routes
 * each dispatched action — keyed by the sender id — back to a React
 * state setter. The consumer writes one hook call instead of
 * hand-assembling a setters record, a useCallback'd handler, a
 * useResponder registration, and ResponderScope/responderRef plumbing
 * for every card.
 *
 * ## senderId hygiene via useId (gensym-style)
 *
 * Before: consumers wrote hardcoded string senderIds like
 * `senderId="cb-1"` on the control and `{"cb-1": setCb1}` in the
 * handler. Typos were silent runtime failures because the handler's
 * map lookup just returned undefined. The two sites were coupled
 * only by string equality, not by the type system.
 *
 * After: consumers call `useId()` at the top of the component to
 * generate an opaque, unique, stable sender id per control, bind it
 * to a variable, and reference the variable in both places. Variable
 * name typos are compile errors. The id itself is never typed as a
 * string literal — it is gensym'd by React and stored in a variable.
 *
 * ```ts
 * export function MyCard() {
 *   const [cb1, setCb1] = useState(false);
 *   const [cb2, setCb2] = useState(true);
 *   const [rg,  setRg]  = useState("a");
 *
 *   const cb1Id = useId();
 *   const cb2Id = useId();
 *   const rgId  = useId();
 *
 *   const { ResponderScope, responderRef } = useResponderForm({
 *     toggle: {
 *       [cb1Id]: setCb1,
 *       [cb2Id]: setCb2,
 *     },
 *     selectValue: {
 *       [rgId]: setRg,
 *     },
 *   });
 *
 *   return (
 *     <ResponderScope>
 *       <div ref={responderRef}>
 *         <TugCheckbox checked={cb1} senderId={cb1Id} />
 *         <TugCheckbox checked={cb2} senderId={cb2Id} />
 *         <TugRadioGroup value={rg} senderId={rgId}>...</TugRadioGroup>
 *       </div>
 *     </ResponderScope>
 *   );
 * }
 * ```
 *
 * ## Action-to-binding-slot mapping
 *
 * One action can carry multiple payload shapes (e.g. `setValue` is the
 * catch-all used by sliders with `number`, inputs with `string`, and
 * option groups with `string[]`). The bindings map has one slot per
 * (action, payload-type) combination so each binding's setter is
 * typed correctly and the hook can apply the right narrower when a
 * dispatch arrives:
 *
 * | Slot                  | Chain action  | Payload type | Setter signature                            | Used by                   |
 * |-----------------------|---------------|--------------|---------------------------------------------|---------------------------|
 * | `toggle`              | toggle        | boolean      | `(v: boolean) => void`                      | checkbox, switch          |
 * | `selectValue`         | selectValue   | string       | `(v: string) => void`                       | radio group, choice group |
 * | `setValueNumber`      | setValue      | number       | `(v: number, phase: ActionPhase) => void`   | slider, value-input       |
 * | `setValueString`      | setValue      | string       | `(v: string, phase: ActionPhase) => void`   | text input, textarea      |
 * | `setValueStringArray` | setValue      | string[]     | `(v: string[], phase: ActionPhase) => void` | option group              |
 * | `selectTab`           | selectTab     | string       | `(v: string) => void`                       | tab bar                   |
 * | `closeTab`            | closeTab      | string       | `(v: string) => void`                       | tab bar                   |
 * | `addTab`              | addTab        | string       | `(v: string) => void`                       | tab bar `+` popup         |
 * | `toggleSectionSingle` | toggleSection | string       | `(v: string) => void`                       | single-expand accordion   |
 * | `toggleSectionMulti`  | toggleSection | string[]     | `(v: string[]) => void`                     | multi-expand accordion    |
 *
 * Slots for actions not yet migrated (A2.3 onward) are present in the
 * type so downstream migrations can start using the helper
 * immediately without needing to extend the hook.
 *
 * ## Phase-aware setValue slots
 *
 * The `setValue*` slots pass `event.phase` to the bound setter as a
 * second argument. Phases are `"discrete" | "begin" | "change" |
 * "commit" | "cancel"` (see `ActionPhase`). This lets sliders drive a
 * ref-based live preview on `"change"` and only persist state on
 * `"commit"` / `"discrete"`, without forking the slot for each control
 * type. Consumers that don't care about phase can declare
 * `(v: number) => void` — TypeScript accepts the narrower parameter
 * list because function parameters are contravariant: a unary setter
 * is assignable to the wider `(v, phase) => void` slot signature.
 * The phase is passed at runtime but ignored.
 *
 * ## Dispatches from unbound senders
 *
 * The hook installs a responder-chain handler **only** for actions
 * whose binding slot is populated. A form declaring just
 * `{toggle: {...}}` doesn't intercept `selectValue`, `setValue`,
 * `selectTab`, `closeTab`, or `toggleSection` — those walk past this
 * node to the next responder as intended. This matters because the
 * chain walker breaks on the first registered handler
 * (responder-chain.ts), so installing dead handlers would silently
 * swallow dispatches bubbling from descendants.
 *
 * For actions the form does handle: if a dispatch arrives with a
 * sender id that isn't in the bindings slot, the handler early-
 * returns and the dispatch is still marked handled (because the
 * walker considers the presence of the handler, not its return
 * value). That's the "unbound sender" case — in development it logs
 * with a gray `[responder-form] unbound sender` marker so typos or
 * missing bindings are visible without silently corrupting state.
 *
 * ## Reactive bindings
 *
 * The bindings map is read through a ref inside stable useCallback
 * handlers, so consumers can safely recompute the bindings on every
 * render (e.g. including newly-added controls) without re-registering
 * the responder node. This mirrors the live-proxy pattern in
 * `useResponder` itself.
 *
 * Laws: [L06] appearance via CSS/DOM, never React state,
 *       [L07] handlers access state through refs,
 *       [L11] controls emit actions; responders handle actions,
 *       [L19] component authoring guide
 */

import React, { useCallback, useId, useRef } from "react";
import type { ActionEvent, ActionHandler, ActionPhase, TugAction } from "./responder-chain";
import { TUG_ACTIONS } from "./action-vocabulary";
import { useOptionalResponder } from "./use-responder";

// ---- Types ----

/**
 * Declarative map from dispatch-slot name to an object of
 * senderId → setter. Each slot corresponds to a specific
 * (chain action, payload type) combination; see the table in the
 * module docstring.
 *
 * Slots are all optional — consumers specify only the slots they
 * need. Missing slots mean "this form doesn't handle this action";
 * dispatches with that action walk past this responder in the chain.
 */
export interface TugResponderFormBindings {
  /** toggle action (boolean payload) — checkbox, switch. */
  toggle?: Record<string, (value: boolean) => void>;
  /** selectValue action (string payload) — radio group, choice group. */
  selectValue?: Record<string, (value: string) => void>;
  /**
   * setValue action with number payload — slider, value-input.
   *
   * **Phase awareness.** Sliders dispatch `setValue` with phases
   * `"begin" | "change" | "commit"` during a pointer drag, `"cancel"`
   * on Escape-mid-drag, and `"discrete"` for keyboard changes
   * (arrows, Home/End, PageUp/PageDown) or for bare value-input
   * edits. Setters bound to this slot receive the phase as a second
   * argument so handlers can branch between live preview (change) and
   * committed values (commit / discrete) — e.g. drive a local ref for
   * transient preview and only persist on commit, rolling back to
   * the begin snapshot on cancel.
   *
   * Consumers that don't care about phases can declare `(v: number) => void`
   * and TypeScript accepts it (narrower parameter list is assignable to
   * the wider slot signature). The phase is passed but ignored.
   */
  setValueNumber?: Record<string, (value: number, phase: ActionPhase) => void>;
  /**
   * setValue action with string payload — text input, textarea.
   *
   * Receives phase as a second argument (text inputs are typically
   * `"discrete"`, but the slot carries phase for symmetry with
   * `setValueNumber` so future pre-commit input widgets can flow
   * without extending the hook).
   */
  setValueString?: Record<string, (value: string, phase: ActionPhase) => void>;
  /**
   * setValue action with string[] payload — option group.
   *
   * Receives phase as a second argument for consistency; option
   * groups currently always dispatch `"discrete"`.
   */
  setValueStringArray?: Record<string, (value: string[], phase: ActionPhase) => void>;
  /** selectTab action (string payload) — tab bar. */
  selectTab?: Record<string, (value: string) => void>;
  /** closeTab action (string payload) — tab bar. */
  closeTab?: Record<string, (value: string) => void>;
  /** addTab action (string payload — componentId) — tab bar `+` popup. */
  addTab?: Record<string, (value: string) => void>;
  /**
   * toggleSection action with single-value payload — single-expand accordion.
   *
   * **The payload can be an empty string `""`** when the user collapses
   * the currently open item in a collapsible single-mode accordion
   * (Radix reports "no open item" as an empty string). Setters bound
   * to this slot must handle that sentinel — for example by storing
   * the empty string and rendering a "no open section" state, or by
   * explicitly checking `v === ""` and taking a different branch.
   */
  toggleSectionSingle?: Record<string, (value: string) => void>;
  /** toggleSection action with multi-value payload — multi-expand accordion. */
  toggleSectionMulti?: Record<string, (value: string[]) => void>;

  /**
   * Optional explicit parent responder id. Forwarded to
   * `useOptionalResponder` so this form registers as a child of
   * the named responder instead of the responder above FileBlock /
   * the component in the React tree.
   *
   * Use this when the form is a sibling-hook of another responder
   * registered in the same component (e.g., FileBlock registers its
   * own `fileBlockResponder` for FIND / FIND_NEXT / FIND_PREVIOUS,
   * and the find row's checkbox form needs to register as a child
   * of that responder so a chain walk from the find input reaches
   * fileBlockResponder). Without this, both hooks read
   * `ResponderParentContext` at hook-call time and end up as
   * siblings under the same outer parent — the chain walk from
   * inside the form never reaches the other responder.
   *
   * Passing `null` pins the responder as a chain root.
   */
  parentId?: string | null;
}

/** Return shape of useResponderForm — same as useResponder. */
export interface UseResponderFormResult {
  /** Wrapper component that provides this form's responder id to its subtree. */
  ResponderScope: React.FC<{ children: React.ReactNode }>;
  /** Ref callback to attach to the form's root DOM element so the chain can resolve it. */
  responderRef: (el: Element | null) => void;
}

// ---- Development warning helper ----

function devEnv(): boolean {
  // Use a permissive check — we want this to be a no-op in any
  // environment that lacks process.env.NODE_ENV (browsers, etc.)
  // but still fire in typical dev builds.
  try {
    return (globalThis as any).process?.env?.NODE_ENV !== "production";
  } catch {
    return true;
  }
}

function logUnbound(action: string, sender: unknown): void {
  if (!devEnv()) return;
  if (typeof console === "undefined") return;
  console.log(
    `%c[responder-form] unbound sender: ${action} sender=${JSON.stringify(sender)}`,
    "color:#888",
  );
}

// ---- Hook ----

/**
 * Register the calling component as a responder node whose actions
 * are defined declaratively by a bindings map. See the module
 * docstring for the full API and rationale.
 */
export function useResponderForm(bindings: TugResponderFormBindings): UseResponderFormResult {
  // Mirror bindings through a ref so handlers (which are stable via
  // useCallback([])) always see the current render's bindings
  // without re-registering the responder node. This is the same
  // pattern useResponder uses for its live-proxy actions map.
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  // ---- Action handlers ----
  //
  // Each handler pulls the sender off the event, looks up the
  // matching setter in its slot, narrows the payload, and calls the
  // setter. Unbound senders hit the dev warning and early-return.
  //
  // setValue has three slots (number / string / string[]); its
  // handler checks each in turn by sender. This means a single
  // sender id can only appear in ONE of the setValue slots — that's
  // the consumer's responsibility to enforce (and easy: each
  // control type calls useId() separately, so collisions are
  // structurally impossible).

  const handleToggle = useCallback((event: ActionEvent) => {
    const sender = typeof event.sender === "string" ? event.sender : null;
    if (!sender) return;
    const setter = bindingsRef.current.toggle?.[sender];
    if (!setter) {
      logUnbound("toggle", event.sender);
      return;
    }
    if (typeof event.value !== "boolean") return;
    setter(event.value);
  }, []);

  const handleSelectValue = useCallback((event: ActionEvent) => {
    const sender = typeof event.sender === "string" ? event.sender : null;
    if (!sender) return;
    const setter = bindingsRef.current.selectValue?.[sender];
    if (!setter) {
      logUnbound("select-value", event.sender);
      return;
    }
    if (typeof event.value !== "string") return;
    setter(event.value);
  }, []);

  const handleSetValue = useCallback((event: ActionEvent) => {
    const sender = typeof event.sender === "string" ? event.sender : null;
    if (!sender) return;
    const b = bindingsRef.current;

    // Try number slot first.
    const numberSetter = b.setValueNumber?.[sender];
    if (numberSetter !== undefined) {
      if (typeof event.value !== "number") return;
      numberSetter(event.value, event.phase);
      return;
    }

    // Then string.
    const stringSetter = b.setValueString?.[sender];
    if (stringSetter !== undefined) {
      if (typeof event.value !== "string") return;
      stringSetter(event.value, event.phase);
      return;
    }

    // Then string[].
    const stringArraySetter = b.setValueStringArray?.[sender];
    if (stringArraySetter !== undefined) {
      if (!Array.isArray(event.value)) return;
      if (!event.value.every((x) => typeof x === "string")) return;
      stringArraySetter(event.value, event.phase);
      return;
    }

    logUnbound("set-value", event.sender);
  }, []);

  const handleSelectTab = useCallback((event: ActionEvent) => {
    const sender = typeof event.sender === "string" ? event.sender : null;
    if (!sender) return;
    const setter = bindingsRef.current.selectTab?.[sender];
    if (!setter) {
      logUnbound("select-tab", event.sender);
      return;
    }
    if (typeof event.value !== "string") return;
    setter(event.value);
  }, []);

  const handleCloseTab = useCallback((event: ActionEvent) => {
    const sender = typeof event.sender === "string" ? event.sender : null;
    if (!sender) return;
    const setter = bindingsRef.current.closeTab?.[sender];
    if (!setter) {
      logUnbound("close-tab", event.sender);
      return;
    }
    if (typeof event.value !== "string") return;
    setter(event.value);
  }, []);

  const handleAddTab = useCallback((event: ActionEvent) => {
    const sender = typeof event.sender === "string" ? event.sender : null;
    if (!sender) return;
    const setter = bindingsRef.current.addTab?.[sender];
    if (!setter) {
      logUnbound("add-tab", event.sender);
      return;
    }
    if (typeof event.value !== "string") return;
    setter(event.value);
  }, []);

  const handleToggleSection = useCallback((event: ActionEvent) => {
    const sender = typeof event.sender === "string" ? event.sender : null;
    if (!sender) return;
    const b = bindingsRef.current;

    const singleSetter = b.toggleSectionSingle?.[sender];
    if (singleSetter !== undefined) {
      if (typeof event.value !== "string") return;
      singleSetter(event.value);
      return;
    }

    const multiSetter = b.toggleSectionMulti?.[sender];
    if (multiSetter !== undefined) {
      if (!Array.isArray(event.value)) return;
      if (!event.value.every((x) => typeof x === "string")) return;
      multiSetter(event.value);
      return;
    }

    logUnbound("toggle-section", event.sender);
  }, []);

  // ---- Register as a responder ----
  //
  // Only install handlers for actions whose binding slot is actually
  // populated. This matters because the chain walker breaks on the
  // first registered handler it finds
  // (responder-chain.ts:sendToFirstResponderForContinuation): `handler(event);
  // handled = true; break;`. If we installed all six handlers
  // unconditionally, a form that only declares `{toggle: {...}}` would
  // still intercept — and silently drop — every `selectValue`,
  // `setValue`, `selectTab`, `closeTab`, and `toggleSection` dispatch
  // bubbling up from a nested descendant. By only registering the
  // handlers whose slots the consumer provided, unrelated actions
  // walk past this node to the next responder as intended.
  //
  // useResponder installs a live-lookup Proxy over
  // `optionsRef.current.actions`, so reads happen on every dispatch.
  // This means a consumer whose bindings map grows new slots across
  // renders (e.g. conditional controls) will have their handlers
  // start dispatching as soon as the slot appears — no
  // re-registration needed.
  const actions: Partial<Record<TugAction, ActionHandler>> = {};
  if (bindings.toggle) actions[TUG_ACTIONS.TOGGLE] = handleToggle;
  if (bindings.selectValue) actions[TUG_ACTIONS.SELECT_VALUE] = handleSelectValue;
  if (
    bindings.setValueNumber ||
    bindings.setValueString ||
    bindings.setValueStringArray
  ) {
    actions[TUG_ACTIONS.SET_VALUE] = handleSetValue;
  }
  if (bindings.selectTab) actions[TUG_ACTIONS.SELECT_TAB] = handleSelectTab;
  if (bindings.closeTab) actions[TUG_ACTIONS.CLOSE_TAB] = handleCloseTab;
  if (bindings.addTab) actions[TUG_ACTIONS.ADD_TAB] = handleAddTab;
  if (bindings.toggleSectionSingle || bindings.toggleSectionMulti) {
    actions[TUG_ACTIONS.TOGGLE_SECTION] = handleToggleSection;
  }

  const id = useId();
  // Tolerant of no-provider environments (gallery cards, unit tests
  // without a chain) so consumers can host form controls in any
  // context — same posture as TugInput / TugCheckbox via
  // `useOptionalResponder`. Inside a provider the form participates
  // in the chain like any other responder; outside one the responder
  // registration silently no-ops and the controls degrade to native
  // DOM events.
  //
  // `parentId` is forwarded so a form that sits alongside another
  // responder in the same component can opt into being its child
  // instead of inheriting the outer context (which would make both
  // hooks register as siblings under the same grandparent — and
  // chain walks from inside the form would never reach the sibling).
  return useOptionalResponder({ id, actions, parentId: bindings.parentId });
}
