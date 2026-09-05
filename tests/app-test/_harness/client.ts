/**
 * client.ts — Typed wrappers around `evalJS` / `waitForCondition`.
 *
 * Scope of this module
 * --------------------
 * Pure helpers that serialize a call into the shape
 * `window.__tug.<method>(...)`
 * and hand it to the transport. `App` (see `./index.ts`) delegates
 * its public methods here so the wire-format logic lives in one
 * testable place.
 *
 * Every helper takes the {@link HarnessCaller} transport — a minimal
 * `{ evalJS, waitForCondition }` pair — as its first argument rather
 * than a full `App`. That keeps the helpers easy to unit-test with a
 * mock caller and avoids a cyclic import between `client.ts` and
 * `index.ts`.
 *
 * Nothing in this file uses `setTimeout` / `setInterval` — every
 * wait-style assertion is expressed as a `waitForCondition` over a
 * pure boolean expression. [D12] ban.
 */

import type {
  AccessibilityStatus,
  EvalJsOptions,
  InnerNativeVerb,
  MenuItemSnapshot,
  MenuItemState,
  NativeModifier,
  NativeMouseButton,
  ScreenRect,
  ViewportPoint,
  WaitForConditionOptions,
} from "./types";

// ---------------------------------------------------------------------------
// Mirrored surface types
//
// These shapes MIRROR `tugdeck/src/test-surface.ts` and
// `tugdeck/src/deck-trace.ts`. We declare them locally (rather than
// `import type`-ing from the tugdeck source) so the `tests/app-test/`
// tsc run does not have to type-check the full tugdeck React/DOM
// graph. Drift is caught at handshake time via the surface-version
// check ([D11]); the bridge's `SURFACE_VERSION` is the
// single source of truth for wire-compat.
//
// When tugdeck's `SURFACE_VERSION` bumps, the matching shapes here
// must be hand-updated alongside the harness.
// ---------------------------------------------------------------------------

/** Mirrors `tugdeck/src/test-surface.ts` → `CaretState`. */
export type CaretState =
  | {
      kind: "input";
      selectionStart: number;
      selectionEnd: number;
      selectionDirection: "forward" | "backward" | "none";
      value: string;
    }
  | {
      kind: "range";
      anchorPath: readonly number[];
      anchorOffset: number;
      focusPath: readonly number[];
      focusOffset: number;
      text: string;
    };

/** Mirrors `tugdeck/src/test-surface.ts` → `ClickOptions`. */
export interface ClickOptions {
  clientX?: number;
  clientY?: number;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/** Mirrors `tugdeck/src/test-surface.ts` → `ResetOptions`. */
export interface ResetOptions {
  /** Clear DeckState back to empty. */
  deck?: boolean;
  /** Clear registered selection boundaries + pinned card ranges. */
  selectionGuard?: boolean;
  /** Drop per-card Component State Preservation Protocol registries. */
  orchestrator?: boolean;
  /** `deckTrace.clear()`. Preserves the enable flag. */
  trace?: boolean;
  /** Wipe `localStorage` and scoped IndexedDB stores. */
  storage?: boolean;
}

/**
 * Mirrors `tugdeck/src/test-surface.ts` → `SeedDeckStateArgs`.
 *
 * `state` and `cardStates` stay as opaque records here: the harness
 * never inspects them — it forwards them as JSON to the page. Tests
 * that want a typed constructor should build values with a local
 * factory and pass them through.
 */
export interface SeedDeckStateArgs {
  state: unknown;
  cardStates?: Record<string, unknown>;
  focusCardId?: string;
}

/**
 * Mirrors `tugdeck/src/deck-trace.ts` → `DeckTraceEvent`. The wrapper
 * types here are the superset union — tests match on partial shapes
 * via `toContainOrderedSubset` so we do not need the exact
 * narrow-per-kind types to stay in lockstep. The `kind` field is
 * authoritative.
 */
export type DeckTraceEvent = {
  readonly timestamp: number;
  readonly seq: number;
  readonly kind: string;
  readonly [k: string]: unknown;
};

// ---------------------------------------------------------------------------
// Caller interface
// ---------------------------------------------------------------------------

/**
 * Minimal transport the client helpers need. Anything that can
 * round-trip `evalJS` / `waitForCondition` satisfies this shape,
 * which keeps unit tests free from subprocess plumbing.
 *
 * `rpcCall` is the untyped escape hatch for non-`evalJS` RPC verbs
 * (native gestures, accessibility preflight, `getElementScreenBounds`).
 * Each typed client helper knows which `method`/params shape it wants
 * to send and how to interpret the response; the caller just ferries
 * JSON-serializable objects to/from Swift via the RPC transport.
 */
export interface HarnessCaller {
  evalJS<T = unknown>(script: string, opts?: EvalJsOptions): Promise<T>;
  waitForCondition<T = unknown>(
    script: string,
    opts?: WaitForConditionOptions,
  ): Promise<T>;
  rpcCall<T = unknown>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T>;
}

// ---------------------------------------------------------------------------
// Script-fragment helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a value as a JavaScript expression. Uses `JSON.stringify`
 * which covers every value the surface accepts (selectors, cardIds,
 * DeckState, CardStateBag records). `undefined` becomes the bare
 * token `undefined` so method calls preserve "omitted" semantics.
 */
function lit(v: unknown): string {
  if (v === undefined) return "undefined";
  return JSON.stringify(v);
}

/**
 * Wrap a surface call in the standard access path. Throws a helpful
 * error if `window.__tug` is absent — that means the page is not in
 * test mode (DEV + `__tugTestMode` gate on the page).
 *
 * The check is cheap on the page-side (`typeof window.__tug`) and
 * stabilizes the error message shape so harness code doesn't need to
 * depend on Swift's error-translation layer for the "not attached" case.
 */
function callSurface(script: string): string {
  // Defensive IIFE. Two responsibilities:
  // 1. Prevent "return outside function" under evalJS try/catch wrapping.
  // 2. Coerce `undefined` results to `null`. WKWebView's evaluateJavaScript
  //    rejects `undefined` with "JavaScript execution returned a result of
  //    an unsupported type" — so void surface methods (enableDeckTrace,
  //    click, focusElement, reset, seedDeckState, ...) must not leak
  //    their undefined return through.
  return `(function(){\n  if (typeof window.__tug === "undefined") {\n    throw new Error("[tug] window.__tug is not attached (is the page in test mode?)");\n  }\n  var __r = ${script};\n  return typeof __r === "undefined" ? null : __r;\n})()`;
}

// ---------------------------------------------------------------------------
// Gesture wrappers (synthetic DOM sequences via `__tug`)
// ---------------------------------------------------------------------------

/**
 * Dispatch the full pointerdown → mousedown → pointerup → mouseup →
 * click sequence on the element matched by `selector`. Prefer this
 * over direct DOM clicks — production handlers condition on the full
 * sequence (not just `click`).
 */
export function click(
  caller: HarnessCaller,
  selector: string,
  opts?: ClickOptions,
  evalOpts?: EvalJsOptions,
): Promise<void> {
  const script = callSurface(
    `window.__tug.click(${lit(selector)}, ${lit(opts)})`,
  );
  return caller.evalJS<void>(script, evalOpts);
}

/**
 * Type `text` into the input/textarea matched by `selector` using
 * the native-setter pattern. React
 * sees each character's InputEvent.
 */
export function type_(
  caller: HarnessCaller,
  selector: string,
  text: string,
  evalOpts?: EvalJsOptions,
): Promise<void> {
  const script = callSurface(
    `window.__tug.type(${lit(selector)}, ${lit(text)})`,
  );
  return caller.evalJS<void>(script, evalOpts);
}

/**
 * Directly `.focus()` the element matched by `selector`. Escape
 * hatch for the `isTrusted`-gated browser-default focus path ([D09]
 * fidelity limits).
 */
export function focusElement(
  caller: HarnessCaller,
  selector: string,
  evalOpts?: EvalJsOptions,
): Promise<void> {
  const script = callSurface(
    `window.__tug.focusElement(${lit(selector)})`,
  );
  return caller.evalJS<void>(script, evalOpts);
}

// ---------------------------------------------------------------------------
// Reset / seed wrappers
// ---------------------------------------------------------------------------

/**
 * Granular reset per {@link ResetOptions}. Each axis defaults to
 * false; callers opt in exactly what a test case needs ([D01]).
 */
export function reset(
  caller: HarnessCaller,
  opts: ResetOptions,
  evalOpts?: EvalJsOptions,
): Promise<void> {
  const script = callSurface(`window.__tug.reset(${lit(opts)})`);
  return caller.evalJS<void>(script, evalOpts);
}

/**
 * Replace `DeckState` atomically and (optionally) merge card-state
 * bags / run cold-boot focus restore. Thin wrapper over
 * `DeckManager.seedDeckState`.
 */
export function seedDeckState(
  caller: HarnessCaller,
  args: SeedDeckStateArgs,
  evalOpts?: EvalJsOptions,
): Promise<void> {
  const script = callSurface(`window.__tug.seedDeckState(${lit(args)})`);
  return caller.evalJS<void>(script, evalOpts);
}

// ---------------------------------------------------------------------------
// State reads
// ---------------------------------------------------------------------------

/**
 * Read the current "active card" (first-responder card) id.
 */
export function getActiveCardId(
  caller: HarnessCaller,
  evalOpts?: EvalJsOptions,
): Promise<string | null> {
  const script = callSurface(`window.__tug.getActiveCardId()`);
  return caller.evalJS<string | null>(script, evalOpts);
}

/**
 * Read the current focused card id (the card the deck marks as
 * holding DOM focus).
 */
export function getFocusedCardId(
  caller: HarnessCaller,
  evalOpts?: EvalJsOptions,
): Promise<string | null> {
  const script = callSurface(`window.__tug.getFocusedCardId()`);
  return caller.evalJS<string | null>(script, evalOpts);
}

/**
 * Read the caret / selection snapshot for `cardId`. Returns `null`
 * when the card has no registered host root or no classifiable caret
 * state.
 */
export function getCaretState(
  caller: HarnessCaller,
  cardId: string,
  evalOpts?: EvalJsOptions,
): Promise<CaretState | null> {
  const script = callSurface(
    `window.__tug.getCaretState(${lit(cardId)})`,
  );
  return caller.evalJS<CaretState | null>(script, evalOpts);
}

/**
 * Read the value of a persisted form control by its
 * `data-tug-state-key` key.
 */
export function getFormControlValue(
  caller: HarnessCaller,
  cardId: string,
  componentStatePreservationKey: string,
  evalOpts?: EvalJsOptions,
): Promise<string | null> {
  const script = callSurface(
    `window.__tug.getFormControlValue(${lit(cardId)}, ${lit(componentStatePreservationKey)})`,
  );
  return caller.evalJS<string | null>(script, evalOpts);
}

/**
 * Return `true` iff the deck has registered a card-host root for
 * `cardId`.
 */
export function assertHostRootRegistered(
  caller: HarnessCaller,
  cardId: string,
  evalOpts?: EvalJsOptions,
): Promise<boolean> {
  const script = callSurface(
    `window.__tug.assertHostRootRegistered(${lit(cardId)})`,
  );
  return caller.evalJS<boolean>(script, evalOpts);
}

// ---------------------------------------------------------------------------
// Trace access
// ---------------------------------------------------------------------------

/**
 * Pull the DeckTrace ring. `since` returns only entries with
 * `seq > that`.
 */
export function getDeckTrace(
  caller: HarnessCaller,
  opts?: { since?: number },
  evalOpts?: EvalJsOptions,
): Promise<readonly DeckTraceEvent[]> {
  const script = callSurface(
    `window.__tug.getDeckTrace(${lit(opts)})`,
  );
  return caller.evalJS<readonly DeckTraceEvent[]>(script, evalOpts);
}

/**
 * Stamp the current trace sequence counter. Test pattern: take a
 * mark before the action under test, then `getDeckTrace({ since:
 * mark })` to scope the assertion to just this step's output.
 */
export function markDeckTrace(
  caller: HarnessCaller,
  evalOpts?: EvalJsOptions,
): Promise<number> {
  const script = callSurface(`window.__tug.markDeckTrace()`);
  return caller.evalJS<number>(script, evalOpts);
}

/**
 * Drop every buffered trace event. Preserves the enable flag.
 */
export function clearDeckTrace(
  caller: HarnessCaller,
  evalOpts?: EvalJsOptions,
): Promise<void> {
  const script = callSurface(`window.__tug.clearDeckTrace()`);
  return caller.evalJS<void>(script, evalOpts);
}

/**
 * Toggle trace recording. Disabled state is the no-op fast path
 * (see `deck-trace.ts` enable contract).
 */
export function enableDeckTrace(
  caller: HarnessCaller,
  flag: boolean,
  evalOpts?: EvalJsOptions,
): Promise<void> {
  const script = callSurface(
    `window.__tug.enableDeckTrace(${lit(flag)})`,
  );
  return caller.evalJS<void>(script, evalOpts);
}

// ---------------------------------------------------------------------------
// Wait-style assertions
// ---------------------------------------------------------------------------

/**
 * Block until the deck reports `cardId` as the focused card, or
 * until the `waitForCondition` budget elapses (default 2000ms).
 *
 * Implementation note: a pure equality check on the server side,
 * so the condition script is stringified inline. `waitForCondition`
 * returns the truthy value — here we discard it.
 */
export async function expectFocusedCard(
  caller: HarnessCaller,
  cardId: string,
  opts?: WaitForConditionOptions,
): Promise<void> {
  // `window.__tug.getFocusedCardId() === cardId` is the contract. We
  // inline-serialize cardId so the Swift side
  // doesn't need to marshal any bindings — the script is a pure
  // expression.
  const script = `(typeof window.__tug !== "undefined") && (window.__tug.getFocusedCardId() === ${lit(cardId)})`;
  await caller.waitForCondition<boolean>(script, opts);
}

/**
 * Block until `__tug.getCaretState(cardId)` deep-equals the expected
 * snapshot, or the budget elapses. Uses a server-side deep-equal
 * evaluated on the returned JSON — keeps the polled predicate pure.
 *
 * The `expected` value is stringified client-side and compared via
 * `JSON.stringify(actual) === JSON.stringify(expected)` on the page.
 * That works because both sides agree on the `CaretState` shape and
 * every field is a primitive or a readonly array of primitives.
 */
export async function expectCaret(
  caller: HarnessCaller,
  cardId: string,
  expected: CaretState,
  opts?: WaitForConditionOptions,
): Promise<void> {
  // Build the inline expression. We compare the stringifications
  // because the two CaretState variants are flat / shallow enough
  // for JSON to be total. `tug.getCaretState` may return `null` if
  // the card root isn't registered yet; the comparison then yields
  // `"null" === "{...}"` → false, which is exactly the polling
  // behavior we want.
  const expectedJson = JSON.stringify(expected);
  const script =
    `(typeof window.__tug !== "undefined") && ` +
    `(JSON.stringify(window.__tug.getCaretState(${lit(cardId)})) === ${JSON.stringify(expectedJson)})`;
  await caller.waitForCondition<boolean>(script, opts);
}

// ---------------------------------------------------------------------------
// Introspection wrappers (SURFACE_VERSION 1.1.0)
//
// Thin delegates that round-trip through `evalJS` to the page-side
// `window.__tug.*` introspection surface. Unlike the RPC-verb family
// below, nothing here touches CGEvent / AX / accessibility — every
// call is a pure DOM read that could be reproduced by pasting the
// same expression into the WebKit inspector.
// ---------------------------------------------------------------------------

export interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementStateSnapshot {
  tagName: string;
  disabled: boolean;
  readOnly: boolean;
  checked: boolean;
  visible: boolean;
  isFocused: boolean;
}

export interface ActiveElementInfo {
  tagName: string;
  id: string | null;
  cardId: string | null;
  componentStatePreservationKey: string | null;
  selector: string;
}

export type SelectionSnapshot =
  | {
      kind: "input";
      selectionStart: number;
      selectionEnd: number;
      selectionDirection: "forward" | "backward" | "none";
      value: string;
      cardId: string | null;
    }
  | {
      kind: "range";
      text: string;
      isCollapsed: boolean;
      cardId: string | null;
    };

export function getElementText(
  caller: HarnessCaller,
  selector: string,
  evalOpts?: EvalJsOptions,
): Promise<string> {
  const script = callSurface(`window.__tug.getElementText(${lit(selector)})`);
  return caller.evalJS<string>(script, evalOpts);
}

export function getElementValue(
  caller: HarnessCaller,
  selector: string,
  evalOpts?: EvalJsOptions,
): Promise<string> {
  const script = callSurface(`window.__tug.getElementValue(${lit(selector)})`);
  return caller.evalJS<string>(script, evalOpts);
}

export function getElementAttribute(
  caller: HarnessCaller,
  selector: string,
  name: string,
  evalOpts?: EvalJsOptions,
): Promise<string | null> {
  const script = callSurface(
    `window.__tug.getElementAttribute(${lit(selector)}, ${lit(name)})`,
  );
  return caller.evalJS<string | null>(script, evalOpts);
}

export function getElementBounds(
  caller: HarnessCaller,
  selector: string,
  evalOpts?: EvalJsOptions,
): Promise<ElementBounds> {
  const script = callSurface(`window.__tug.getElementBounds(${lit(selector)})`);
  return caller.evalJS<ElementBounds>(script, evalOpts);
}

export function getElementState(
  caller: HarnessCaller,
  selector: string,
  evalOpts?: EvalJsOptions,
): Promise<ElementStateSnapshot> {
  const script = callSurface(`window.__tug.getElementState(${lit(selector)})`);
  return caller.evalJS<ElementStateSnapshot>(script, evalOpts);
}

export function getActiveElement(
  caller: HarnessCaller,
  evalOpts?: EvalJsOptions,
): Promise<ActiveElementInfo | null> {
  const script = callSurface(`window.__tug.getActiveElement()`);
  return caller.evalJS<ActiveElementInfo | null>(script, evalOpts);
}

export function getSelection(
  caller: HarnessCaller,
  cardId?: string,
  evalOpts?: EvalJsOptions,
): Promise<SelectionSnapshot | null> {
  const script = callSurface(
    cardId === undefined
      ? `window.__tug.getSelection()`
      : `window.__tug.getSelection(${lit(cardId)})`,
  );
  return caller.evalJS<SelectionSnapshot | null>(script, evalOpts);
}

export function getComputedStyleValue(
  caller: HarnessCaller,
  selector: string,
  property: string,
  evalOpts?: EvalJsOptions,
): Promise<string> {
  const script = callSurface(
    `window.__tug.getComputedStyleValue(${lit(selector)}, ${lit(property)})`,
  );
  return caller.evalJS<string>(script, evalOpts);
}

/**
 * Register `selector` as a selection boundary under the given
 * `cardId`. Thin wrapper over tugdeck's
 * `selectionGuard.registerBoundary` — see
 * {@link import("../../tugdeck/src/test-surface").TugTestSurface.registerSelectionBoundary}.
 *
 * Real cards register their content area on mount so that
 * `selectionGuard.handleSelectStart` allows WebKit's drag-selection
 * to begin. Test harnesses that inject ad-hoc fixture elements
 * outside of any real card need to register them explicitly — the
 * overlay is otherwise treated as "outside any boundary" and
 * `selectstart` gets preventDefault'd, suppressing drag selection.
 */
export function registerSelectionBoundary(
  caller: HarnessCaller,
  cardId: string,
  selector: string,
  evalOpts?: EvalJsOptions,
): Promise<void> {
  const script = callSurface(
    `window.__tug.registerSelectionBoundary(${lit(cardId)}, ${lit(selector)})`,
  );
  return caller.evalJS<void>(script, evalOpts);
}

export function unregisterSelectionBoundary(
  caller: HarnessCaller,
  cardId: string,
  evalOpts?: EvalJsOptions,
): Promise<void> {
  const script = callSurface(
    `window.__tug.unregisterSelectionBoundary(${lit(cardId)})`,
  );
  return caller.evalJS<void>(script, evalOpts);
}

// ---------------------------------------------------------------------------
// EM-card observation (SURFACE_VERSION 1.2.0)
// ---------------------------------------------------------------------------

/**
 * Mirrors `tugdeck/src/test-surface.ts` → `EmCardState`. Stub
 * fields (`streamState`, `lastTurnSeq`) are stubbed so test code
 * can pin against the final layout, but
 * always carry placeholder values until tugcode integration
 * lands in a later pass.
 */
export interface EmCardState {
  kind: "em";
  engine: string;
  text: string;
  engineSelection: unknown;
  streamState: "idle" | "streaming" | "error";
  lastTurnSeq: number;
}

/**
 * Read an EM card's engine state. Returns `null` when the card
 * is unknown or is not an EM card. The page-side surface fires
 * `invokeSaveCallback` synchronously before reading so the
 * returned state reflects current engine content rather than a
 * stale debounced save.
 */
export function getEmCardState(
  caller: HarnessCaller,
  cardId: string,
  evalOpts?: EvalJsOptions,
): Promise<EmCardState | null> {
  const script = callSurface(
    `window.__tug.getEmCardState(${lit(cardId)})`,
  );
  return caller.evalJS<EmCardState | null>(script, evalOpts);
}

/**
 * Synchronous "has the engine for `cardId` already emitted its
 * `engine-ready` deck-trace event?" probe. Mostly useful inside
 * a `waitForCondition` body — the harness's `awaitEngineReady`
 * wraps it in `waitForCondition` for the blocking variant.
 */
export function isEngineReady(
  caller: HarnessCaller,
  cardId: string,
  evalOpts?: EvalJsOptions,
): Promise<boolean> {
  const script = callSurface(
    `window.__tug.isEngineReady(${lit(cardId)})`,
  );
  return caller.evalJS<boolean>(script, evalOpts);
}

/**
 * Block until the engine for `cardId` has emitted its
 * `engine-ready` event, or until `timeoutMs` (default 2000ms)
 * elapses. Throws `TimeoutError` on budget exceeded — same
 * contract as `expectFocusedCard`. Wraps a `waitForCondition`
 * over `__tug.isEngineReady(cardId)` so polling happens in the
 * RPC layer, not inside `evalJS` (which would freeze the page
 * thread that records the trace event the test is waiting for).
 */
export async function awaitEngineReady(
  caller: HarnessCaller,
  cardId: string,
  opts?: WaitForConditionOptions,
): Promise<void> {
  const script =
    `(typeof window.__tug !== "undefined") && ` +
    `(window.__tug.isEngineReady(${lit(cardId)}) === true)`;
  await caller.waitForCondition<boolean>(script, opts);
}

/**
 * Bind a fake session for a session-card so its content factory skips
 * past the project-picker UI and renders SessionCardBody directly.
 *
 * Production binds via a `spawn_session_ok` CONTROL ack from a live
 * tugcast/tugcode/Claude pipeline. In the in-app harness, that
 * pipeline isn't running for most tests — we just need the editor
 * to mount so we can exercise focus, selection, and persistence
 * behavior. This helper writes synthetic values directly into the
 * `cardSessionBindingStore`, which the existing
 * `cardServicesStore` reconciler picks up and uses to construct the
 * real-shape services bag against the harness's WebSocket
 * connection. The stores stay empty (no frames flow in stub mode);
 * the editor renders and accepts focus.
 *
 * Sentinels (test-deterministic by default):
 *   - `tugSessionId` defaults to `test-session-${cardId}`
 *   - `workspaceKey` defaults to `test-workspace-${cardId}`
 *   - `projectDir`   defaults to `/tmp/test-project`
 *   - `sessionMode`  defaults to `"new"` — the most common test path.
 *                    Tests that exercise resume behavior
 *                    (cold-boot preflight, replay-loading banner)
 *                    pass `"resume"` explicitly.
 */
export function bindSession(
  caller: HarnessCaller,
  cardId: string,
  options?: {
    tugSessionId?: string;
    lineId?: string;
    workspaceKey?: string;
    projectDir?: string;
    sessionMode?: "new" | "resume";
  },
  evalOpts?: EvalJsOptions,
): Promise<void> {
  const optsLit =
    options !== undefined && options !== null
      ? JSON.stringify(options)
      : "undefined";
  const script = callSurface(
    `(window.__tug.bindSession(${lit(cardId)}, ${optsLit}), null)`,
  );
  return caller.evalJS<null>(script, evalOpts).then(() => undefined);
}

/**
 * Fire a REAL `spawn_session(mode=resume)` CONTROL frame over the live
 * connection via `window.__tug.spawnSessionResume` — tugcast spawns a genuine
 * tugcode `--resume` that replays the on-disk JSONL through the
 * `CODE_OUTPUT → SESSION_METADATA` fan-out into the card's
 * `SessionMetadataStore`. The only harness verb that drives the true
 * cold-replay delivery chain (vs. the synthetic `bindSession` or the
 * injected `ingestSessionMetadata`). The fixture JSONL must already sit at
 * `~/.claude/projects/<encode(projectDir)>/<tugSessionId>.jsonl`.
 */
export function spawnSessionResume(
  caller: HarnessCaller,
  cardId: string,
  opts: { tugSessionId: string; projectDir: string },
  evalOpts?: EvalJsOptions,
): Promise<void> {
  const script = callSurface(
    `(window.__tug.spawnSessionResume(${lit(cardId)}, ${lit(opts)}), null)`,
  );
  return caller.evalJS<null>(script, evalOpts).then(() => undefined);
}

/**
 * One step in driving a bound session card's `CodeSessionStore` through
 * the lifecycle matrix — mirrors `SessionDriveAction` on the
 * `test-surface.ts` side (the two graphs are kept structurally
 * identical; the JSON wire is the contract).
 *
 *  - `send` — submit a user message; a mid-turn `send` queues.
 *  - `ingestFrame` — feed a decoded wire frame into the store
 *    (`feedId` is a `FeedId` value — `CODE_OUTPUT` is `0x40`;
 *    `decoded` is the frame payload, with a `tug_session_id`
 *    matching the bound session).
 *  - `interrupt` — `store.interrupt()`.
 *  - `transportClose` / `transportReconnect` — drive the transport
 *    overlay.
 *  - `shellExchange` — settle a completed `$`-route exchange row. The
 *    shell feed is a different store from the one `ingestFrame` reaches,
 *    so a shell row is otherwise only reachable by running a command.
 *  - `arcNote` — deliver a live arc gesture's quiet line ([P12]); the
 *    reducer seats it inside the open turn when one is streaming, or as
 *    its own quiet ink row when none is.
 *  - `restoreShellExchanges` — apply a `list_shell_exchanges_ok` answer
 *    ([P07]) with the ledger rows verbatim, so a test can seat restored ink
 *    at the anchor and clock it was written at.
 */
export type SessionDriveAction =
  | { op: "send"; text: string; atoms?: unknown[]; suppress?: boolean }
  | { op: "ingestFrame"; feedId: number; decoded: unknown }
  | { op: "interrupt" }
  | { op: "transportClose" }
  | { op: "transportReconnect" }
  // Page older turns above the loaded window; inject the response replay
  // bracket via `ingestFrame` afterward.
  | { op: "loadPrevious"; amount: number | "all" }
  | {
      op: "shellExchange";
      exchangeId: string;
      command: string;
      output: string;
      cwd: string;
      exitCode?: number;
      startedAtMs?: number;
    }
  | {
      op: "arcNote";
      exchangeId: string;
      command: string;
      text: string;
      cwd: string;
      timestamp?: number;
    }
  | { op: "restoreShellExchanges"; rows: ReadonlyArray<Record<string, unknown>> };

/**
 * Drive a bound session card's `CodeSessionStore` one step through the
 * lifecycle matrix via `window.__tug.driveSession`. The card must
 * already be bound (`bindSession`); the surface throws otherwise.
 */
export function driveSession(
  caller: HarnessCaller,
  cardId: string,
  action: SessionDriveAction,
  evalOpts?: EvalJsOptions,
): Promise<void> {
  const script = callSurface(
    `(window.__tug.driveSession(${lit(cardId)}, ${lit(action)}), null)`,
  );
  return caller.evalJS<null>(script, evalOpts).then(() => undefined);
}

/**
 * Drop the app's real WebSocket, so the entire recovery path runs:
 * close → `connectionDidClose` → backoff → reconnect →
 * `connectionDidReconnect` → every services bag disposed → restore.
 *
 * Distinct from `driveSession(..., {op: "transportClose"})`, which
 * dispatches into a single card's reducer and exercises none of that.
 *
 * Resolves `false` when the page had no connection to close.
 */
export function connectionClose(
  caller: HarnessCaller,
  evalOpts?: EvalJsOptions,
): Promise<boolean> {
  const script = callSurface(`window.__tug.connectionClose()`);
  return caller.evalJS<boolean>(script, evalOpts).then((ok) => ok === true);
}

/** Mirrors `tugdeck/src/protocol.ts` → `RateLimitInfo`. */
export interface RateLimitInfo {
  status: string;
  resetsAt: number;
  rateLimitType: string;
  overageStatus: string;
  overageDisabledReason?: string;
  isUsingOverage: boolean;
  /** 0–1 window utilization — the fraction the `/usage` gauges key their % on. */
  utilization?: number;
}

/**
 * Drive the app-level, account-global rate-limit store via
 * `window.__tug.ingestRateLimit` — mounts / clears the single deck-wide
 * rate-limit banner ([#step-3.5]) without a live claude limit.
 */
export function ingestRateLimit(
  caller: HarnessCaller,
  info: RateLimitInfo,
  evalOpts?: EvalJsOptions,
): Promise<void> {
  const script = callSurface(`(window.__tug.ingestRateLimit(${lit(info)}), null)`);
  return caller.evalJS<null>(script, evalOpts).then(() => undefined);
}

/**
 * Drive a session card's `SessionMetadataStore` via
 * `window.__tug.ingestSessionMetadata` — feeds a decoded
 * `session_capabilities` / `system_metadata` payload as if it had landed on
 * the SESSION_METADATA feed, so the Z4B effort chip ([#step-4]) can mount and
 * flip its model gate without a live claude handshake. Requires a prior
 * `bindSession(cardId)`.
 */
export function ingestSessionMetadata(
  caller: HarnessCaller,
  cardId: string,
  payload: unknown,
  evalOpts?: EvalJsOptions,
): Promise<void> {
  const script = callSurface(
    `(window.__tug.ingestSessionMetadata(${lit(cardId)}, ${lit(payload)}), null)`,
  );
  return caller.evalJS<null>(script, evalOpts).then(() => undefined);
}

/**
 * Settle a session card's `SideQuestionStore` via
 * `window.__tug.ingestSideQuestionAnswer` — feeds a decoded
 * `side_question_answer` payload as if a matching CODE_OUTPUT frame had
 * landed, so the `/btw` overlay renders its answer without a live claude
 * round-trip. The payload `request_id` must match a pending (loading)
 * exchange. Requires a prior `bindSession(cardId)`.
 */
export function ingestSideQuestionAnswer(
  caller: HarnessCaller,
  cardId: string,
  payload: unknown,
  evalOpts?: EvalJsOptions,
): Promise<void> {
  const script = callSurface(
    `(window.__tug.ingestSideQuestionAnswer(${lit(cardId)}, ${lit(payload)}), null)`,
  );
  return caller.evalJS<null>(script, evalOpts).then(() => undefined);
}

// ---------------------------------------------------------------------------
// RPC-verb wrappers (native gestures, accessibility preflight,
// Swift-computed screen bounds)
//
// These hop to Swift directly via `rpcCall` instead of rendering JS
// into `evalJS`. Swift owns the `CGEvent` post, AX-TCC probe, and
// `CoordMapping` translation — there's nothing the WKWebView side can
// usefully add to the plumbing.
// ---------------------------------------------------------------------------

/**
 * Probe the macOS Accessibility-permission bit for the launched
 * Tug.app binary. Returns `{ trusted, bundlePath, bundleId }`.
 *
 * `prompt: true` (default) shows the "grant in System Settings"
 * dialog on the first call per process. Tests that want a silent
 * re-check pass `prompt: false`. The returned boolean is synchronous:
 * macOS does not block the call on dialog dismissal.
 */
export function checkAccessibilityPermission(
  caller: HarnessCaller,
  opts?: { prompt?: boolean },
): Promise<AccessibilityStatus> {
  const params: Record<string, unknown> = {};
  if (opts?.prompt !== undefined) params.prompt = opts.prompt;
  return caller.rpcCall<AccessibilityStatus>(
    "checkAccessibilityPermission",
    params,
  );
}

/**
 * Resolve `selector` to a screen-CG rect via the Swift bridge — a
 * `getBoundingClientRect()` in viewport space, then corner-by-corner
 * through `CoordMapping.viewportToScreen`. Useful for tests that want
 * to name an exact screen point (tooltip offsets, drag over
 * overlay-hidden targets). Prefer `app.nativeClickAtElement(selector)`
 * when all you need is "click the center of this element".
 */
export function getElementScreenBounds(
  caller: HarnessCaller,
  selector: string,
): Promise<ScreenRect> {
  return caller.rpcCall<ScreenRect>("getElementScreenBounds", { selector });
}

// ---- native menu introspection ----

/**
 * Full recursive snapshot of the app's native main menu, with each item's
 * *validated* enabled state (run through `NSMenuItemValidation` the way
 * AppKit does at open / key-equivalent time). Use to assert menu-validation
 * outcomes without driving a real menu-tracking session.
 */
export function menuSnapshot(caller: HarnessCaller): Promise<MenuItemSnapshot[]> {
  return caller.rpcCall<MenuItemSnapshot[]>("menuSnapshot", {});
}

/**
 * Validated state of a single native menu item addressed by its
 * `NSUserInterfaceItemIdentifier`. Returns `{ found: false }` when no item
 * carries the identifier.
 */
export function menuItemState(
  caller: HarnessCaller,
  identifier: string,
): Promise<MenuItemState> {
  return caller.rpcCall<MenuItemState>("menuItemState", { identifier });
}

// ---- screenshot ----

/**
 * Render the app's WKWebView to a PNG (via `WKWebView.takeSnapshot` — no
 * Screen Recording permission needed) written to a temp file, returning
 * its path. The caller owns the file and should delete it when done.
 */
export function screenshot(
  caller: HarnessCaller,
): Promise<{ path: string }> {
  return caller.rpcCall<{ path: string }>("screenshot", {});
}

// ---- native gestures ----

export interface NativeClickOptions {
  button?: NativeMouseButton;
  clickCount?: number;
  mouseDownDelayMs?: number;
  mouseUpDelayMs?: number;
  /**
   * Whether to activate the app before posting the click (default true). The
   * app-under-test is normally already frontmost, and activating first keeps a
   * stray z-order lag from sending the post to whatever window sits above.
   *
   * Pass `false` to model a click that arrives while the app is in the
   * background — the click that brings it forward is a different event from an
   * ordinary one, and activating first would erase exactly the case under test.
   */
  activateFirst?: boolean;
}

export interface NativeDragOptions {
  button?: NativeMouseButton;
  mouseDownDelayMs?: number;
  mouseUpDelayMs?: number;
}

export function nativeClick(
  caller: HarnessCaller,
  viewportPoint: ViewportPoint,
  opts?: NativeClickOptions,
): Promise<void> {
  return caller.rpcCall<void>(
    "nativeClick",
    buildNativeClickParams(viewportPoint, opts),
  );
}

export async function nativeClickAtElement(
  caller: HarnessCaller,
  selector: string,
  opts?: NativeClickOptions,
): Promise<void> {
  const p = await centerOfElement(caller, selector);
  await nativeClick(caller, p, opts);
}

export function nativeDoubleClick(
  caller: HarnessCaller,
  viewportPoint: ViewportPoint,
  opts?: { button?: NativeMouseButton },
): Promise<void> {
  const params: Record<string, unknown> = { viewportPoint };
  if (opts?.button !== undefined) params.button = opts.button;
  return caller.rpcCall<void>("nativeDoubleClick", params);
}

export async function nativeDoubleClickAtElement(
  caller: HarnessCaller,
  selector: string,
  opts?: { button?: NativeMouseButton },
): Promise<void> {
  const p = await centerOfElement(caller, selector);
  await nativeDoubleClick(caller, p, opts);
}

export function nativeRightClick(
  caller: HarnessCaller,
  viewportPoint: ViewportPoint,
): Promise<void> {
  return caller.rpcCall<void>("nativeRightClick", { viewportPoint });
}

export async function nativeRightClickAtElement(
  caller: HarnessCaller,
  selector: string,
): Promise<void> {
  const p = await centerOfElement(caller, selector);
  await nativeRightClick(caller, p);
}

/**
 * Interpolated drag: `mouseDown` at `from`, a trail of `mouseDragged`
 * events along `from → to`, `mouseUp` at `to`. The Swift handler
 * fixes the trail at 8 interpolation steps with a 20ms inter-step
 * gap (empirically enough for a 40–100px drag in a `contenteditable`
 * on Apple Silicon macOS 13–15, and slow enough that windowserver
 * does not coalesce the events). The trail-step count is currently
 * not exposed through the TS surface — callers always get the
 * 8-step path.
 *
 * Why interpolation, not endpoint-only: a single `mouseDragged` on
 * a WebKit `contenteditable` anchors the selection at `from` but
 * never extends it — WebKit dispatches `selectstart`, then sees
 * `mouseUp` and commits a zero-length selection. A trail along the
 * path lets WebKit's drag-selection extend as the pointer moves.
 *
 * For WebKit paths that still need extra time at the anchor, bump
 * `mouseDownDelayMs` — that is the gap between `mouseDown` and the
 * first `mouseDragged` where WebKit processes the initial anchor.
 */
export function nativeDrag(
  caller: HarnessCaller,
  from: ViewportPoint,
  to: ViewportPoint,
  opts?: NativeDragOptions,
): Promise<void> {
  const params: Record<string, unknown> = { from, to };
  if (opts?.button !== undefined) params.button = opts.button;
  if (opts?.mouseDownDelayMs !== undefined)
    params.mouseDownDelayMs = opts.mouseDownDelayMs;
  if (opts?.mouseUpDelayMs !== undefined)
    params.mouseUpDelayMs = opts.mouseUpDelayMs;
  return caller.rpcCall<void>("nativeDrag", params);
}

/**
 * `to` may be `{x, y}` directly OR `{selector}` which the wrapper
 * resolves via `getElementBounds` → element center.
 */
export async function nativeDragElement(
  caller: HarnessCaller,
  fromSelector: string,
  to: ViewportPoint | { selector: string },
  opts?: NativeDragOptions,
): Promise<void> {
  const fromPoint = await centerOfElement(caller, fromSelector);
  const toPoint =
    "selector" in to ? await centerOfElement(caller, to.selector) : to;
  await nativeDrag(caller, fromPoint, toPoint, opts);
}

/**
 * Trail-only drag — `mouseDown` at `from`, the same 8-step
 * interpolated `mouseDragged` trail along `from → to`, but NO
 * terminal `mouseUp`. The pointer remains "pressed" from WebKit's
 * perspective until a subsequent `nativeMouseUp` fires.
 *
 * Pairs with `nativeMouseUp` to compose gestures that need an
 * interleaved verb between the trail and the release. Canonical
 * use case is mid-drag Escape:
 *
 *     await app.nativeDragElementWithoutRelease(tab, somewhereFar);
 *     await app.nativeKey("Escape");
 *     await app.nativeMouseUp(somewhereFar);
 *
 * The cardDragCoordinator's document-level keydown listener
 * installs at `startDrag` (which fires
 * once the trail crosses the 5px threshold) and is removed at
 * `cleanup` (which the Escape branch invokes), so the Escape
 * keystroke must arrive AFTER the trail begins and BEFORE the
 * mouseUp commits a drop.
 *
 * `opts.mouseUpDelayMs` is accepted for shape symmetry with
 * `nativeDrag` but is unused (no mouseUp is posted).
 */
export function nativeDragWithoutRelease(
  caller: HarnessCaller,
  from: ViewportPoint,
  to: ViewportPoint,
  opts?: NativeDragOptions,
): Promise<void> {
  const params: Record<string, unknown> = { from, to };
  if (opts?.button !== undefined) params.button = opts.button;
  if (opts?.mouseDownDelayMs !== undefined)
    params.mouseDownDelayMs = opts.mouseDownDelayMs;
  if (opts?.mouseUpDelayMs !== undefined)
    params.mouseUpDelayMs = opts.mouseUpDelayMs;
  return caller.rpcCall<void>("nativeDragWithoutRelease", params);
}

/** Element-anchored variant of {@link nativeDragWithoutRelease}. */
export async function nativeDragElementWithoutRelease(
  caller: HarnessCaller,
  fromSelector: string,
  to: ViewportPoint | { selector: string },
  opts?: NativeDragOptions,
): Promise<void> {
  const fromPoint = await centerOfElement(caller, fromSelector);
  const toPoint =
    "selector" in to ? await centerOfElement(caller, to.selector) : to;
  await nativeDragWithoutRelease(caller, fromPoint, toPoint, opts);
}

export function nativeMouseDown(
  caller: HarnessCaller,
  viewportPoint: ViewportPoint,
  opts?: { button?: NativeMouseButton },
): Promise<void> {
  const params: Record<string, unknown> = { viewportPoint };
  if (opts?.button !== undefined) params.button = opts.button;
  return caller.rpcCall<void>("nativeMouseDown", params);
}

export function nativeMouseUp(
  caller: HarnessCaller,
  viewportPoint: ViewportPoint,
  opts?: { button?: NativeMouseButton },
): Promise<void> {
  const params: Record<string, unknown> = { viewportPoint };
  if (opts?.button !== undefined) params.button = opts.button;
  return caller.rpcCall<void>("nativeMouseUp", params);
}

// ---- native keyboard ----

/**
 * Post a single named-key keystroke with optional modifiers. `key`
 * must exist in Swift's `VirtualKeyMap` — ASCII chars (`"a"`, `"!"`)
 * or named keys (`"Enter"`, `"ArrowLeft"`, `"Escape"`).
 */
export function nativeKey(
  caller: HarnessCaller,
  key: string,
  modifiers?: readonly NativeModifier[],
): Promise<void> {
  const params: Record<string, unknown> = { key };
  if (modifiers !== undefined) params.modifiers = modifiers;
  return caller.rpcCall<void>("nativeKey", params);
}

/**
 * Hold `modifiers` down across the awaited `body`, then release them —
 * the introspectable sibling of {@link holdModifier}.
 *
 * `holdModifier` buffers its inner verbs into a single RPC, so nothing inside
 * it can look at the app; that is the right shape for "post this chord" and
 * the wrong one for "what does the UI look like while this key is down". Here
 * the press and the release are separate round trips and `body` receives the
 * ordinary caller, so `evalJS` / `waitForCondition` / `screenshot` all work
 * normally in between. The chord ring is the reason it exists: a Shift+Return
 * default paints dashed until Shift is actually down.
 *
 * The release is in a `finally`, so a failed assertion inside `body` still
 * lets go of the modifier. (Swift backstops the same thing at connection
 * close — a modifier left down at the windowserver turns the next keystroke
 * anywhere on the machine into a system chord.)
 */
export async function withModifiersHeld(
  caller: HarnessCaller,
  modifiers: readonly NativeModifier[],
  body: () => Promise<void>,
): Promise<void> {
  await caller.rpcCall<void>("pressHeldModifiers", { modifiers });
  try {
    await body();
  } finally {
    await caller.rpcCall<void>("releaseHeldModifiers", { modifiers });
  }
}

/**
 * Type an ASCII string. Non-ASCII input is rejected by the Swift
 * side with `NativeTypeAsciiOnlyError` before any events are posted.
 */
export function nativeType(
  caller: HarnessCaller,
  text: string,
): Promise<void> {
  return caller.rpcCall<void>("nativeType", { text });
}

// ---------------------------------------------------------------------------
// App-lifecycle simulation (RPC verbs on the App handle)
//
// Each verb invokes the matching `NSApp` primitive on the Tug.app
// main thread and waits up to 1000ms for the corresponding
// `NSApplication.did...Notification` to fire on the real
// AppDelegate. The harness's RPC timeout defaults to 2000ms so the
// client always sees the typed `AppLifecycleTimeoutError` first if
// the delegate misses, rather than the generic transport timeout.
//
// Per [D07]: these are real lifecycle transitions, not synthesized
// delegate-method invocations — the existing `AppDelegate.application*`
// handlers (which forward to tugdeck via `app-lifecycle` control
// frames) fire as a consequence.
//
// Common pattern: tests pair a resign/become-active or hide/unhide
// to exercise the app-lifecycle → deck cascade. The
// optional `timeoutMs` is for deliberate-timeout test paths (e.g.
// calling `simulateAppHide` while already hidden).
// ---------------------------------------------------------------------------

export interface AppLifecycleOptions {
  /**
   * Server-side bound on how long Swift waits for the matching
   * `NSApplication.did...Notification` after invoking the trigger.
   * Default 1000ms. Pass a much lower value (e.g. 1ms) to deliberately
   * exercise the timeout path.
   */
  timeoutMs?: number;
}

export async function simulateAppResign(
  caller: HarnessCaller,
  opts?: AppLifecycleOptions,
): Promise<void> {
  const params: Record<string, unknown> = {};
  if (opts?.timeoutMs !== undefined) params.timeoutMs = opts.timeoutMs;
  await caller.rpcCall<void>("simulateAppResign", params);
  // Two-stage wait: the Swift primitive returned only when AppKit's
  // `didResignActive` notification fired, but WKWebView's
  // `window.blur` dispatch lags the notification by several
  // milliseconds and CAN BE DROPPED entirely under rapid back-to-back
  // cycling (WebKit's run loop coalesces the focus/blur pair). Wait
  // here until the JS-side `hasFocus` axis flips false — that's the
  // contract the deck-store listener uses to gate save flush + state
  // change, so any test that proceeds past `simulateAppResign`
  // expects this state already settled.
  await caller.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && (window.__tug.getHasFocus() === false)`,
    { timeoutMs: 2000 },
  );
}

export async function simulateAppBecomeActive(
  caller: HarnessCaller,
  opts?: AppLifecycleOptions,
): Promise<void> {
  const params: Record<string, unknown> = {};
  if (opts?.timeoutMs !== undefined) params.timeoutMs = opts.timeoutMs;
  await caller.rpcCall<void>("simulateAppBecomeActive", params);
  // Symmetric wait — see `simulateAppResign` for rationale.
  await caller.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && (window.__tug.getHasFocus() === true)`,
    { timeoutMs: 2000 },
  );
}

export function simulateAppHide(
  caller: HarnessCaller,
  opts?: AppLifecycleOptions,
): Promise<void> {
  const params: Record<string, unknown> = {};
  if (opts?.timeoutMs !== undefined) params.timeoutMs = opts.timeoutMs;
  return caller.rpcCall<void>("simulateAppHide", params);
}

export function simulateAppUnhide(
  caller: HarnessCaller,
  opts?: AppLifecycleOptions,
): Promise<void> {
  const params: Record<string, unknown> = {};
  if (opts?.timeoutMs !== undefined) params.timeoutMs = opts.timeoutMs;
  return caller.rpcCall<void>("simulateAppUnhide", params);
}

// ---------------------------------------------------------------------------
// Tugcode subprocess lifecycle
//
// The harness spawns and tears down a tugcode subprocess that's
// independent of production's tugcast → tugcode-per-AI-session
// path. Spawn/kill is the base API; optional stub-transcript
// wiring extends this over time.
//
// Errors translate to `TugcodeLaunchError` (missing binary,
// already-running, spawn failure, log-file open failure).
// ---------------------------------------------------------------------------

/**
 * Schema version of the transcript document, mirroring tugcode's
 * `TRANSCRIPT_SCHEMA_VERSION` constant in `stub-replay.ts`. Tests
 * that author transcripts inline use this constant so a future
 * schema bump trips a typecheck rather than producing a transcript
 * tugcode silently rejects.
 */
export const TUGCODE_TRANSCRIPT_SCHEMA_VERSION = 1 as const;

/**
 * One replay turn — outputs to emit when the N-th `user_message`
 * arrives over stdin. `index` MUST equal the array position; the
 * loader on the tugcode side rejects the transcript otherwise.
 *
 * `outputs` are tugcode `OutboundMessage` shapes (`assistant_text`
 * / `turn_complete` / etc.). The harness type is `unknown[]` here
 * to avoid coupling `tests/app-test/`'s tsc graph to tugcode's
 * runtime types — round-trip is opaque.
 */
export interface TugcodeTranscriptTurn {
  index: number;
  description?: string;
  outputs: unknown[];
}

/**
 * Transcript document handed to `app.startTugcode({ mode: "stub" })`.
 * Mirrors `tugcode/src/stub-replay.ts::TugcodeTranscript`. Swift
 * round-trips it via `JSONSerialization` to a temp file under
 * $TMPDIR and passes `--stub-transcript=<path>` to tugcode.
 */
export interface TugcodeTranscript {
  schemaVersion: typeof TUGCODE_TRANSCRIPT_SCHEMA_VERSION;
  tugcodeVersion: string;
  turns: TugcodeTranscriptTurn[];
}

export interface StartTugcodeOptions {
  /**
   * "stub" or "live". Stub mode requires `transcript`; the Swift
   * handler refuses to spawn without it.
   */
  mode: "stub" | "live";
  /**
   * Absolute path to the tugcode executable. When omitted, Swift
   * falls back to the `TUGAPP_TUGCODE_BINARY` env var.
   */
  binaryPath?: string;
  /**
   * Absolute path that tugcode's stdout + stderr stream into.
   * When omitted, output goes to `/dev/null`.
   */
  logFilePath?: string;
  /**
   * Stub-replay transcript. Required when `mode === "stub"`.
   *
   * Stub transcript and error injection are supplied on `startTugcode`
   * (a separate seed-then-start RPC was considered but folded into
   * these opts because stub smoke tests know the full transcript at
   * launch). To inject errors, build them as `error`-typed outputs
   * inside the relevant `turn.outputs[]` array — the tugcode replay
   * engine emits them the same way.
   */
  transcript?: TugcodeTranscript;
  /**
   * Project directory passed to tugcode as `--dir <path>`. Mostly
   * relevant in live mode (tugcode hands it to claude as the cwd
   * for tool execution). Stub mode ignores it. When omitted,
   * tugcode uses its own `process.cwd()` (which is the harness's
   * cwd at spawn time — typically not a valid project root).
   */
  dir?: string;
}

export interface StartTugcodeResult {
  /** Pid of the spawned tugcode subprocess. */
  pid: number;
}

export function startTugcode(
  caller: HarnessCaller,
  opts: StartTugcodeOptions,
): Promise<StartTugcodeResult> {
  const params: Record<string, unknown> = { mode: opts.mode };
  if (opts.binaryPath !== undefined) params.binaryPath = opts.binaryPath;
  if (opts.logFilePath !== undefined) params.logFilePath = opts.logFilePath;
  if (opts.transcript !== undefined) {
    params.transcript = opts.transcript as unknown as Record<string, unknown>;
  }
  if (opts.dir !== undefined) params.dir = opts.dir;
  return caller.rpcCall<StartTugcodeResult>("startTugcode", params);
}

export function stopTugcode(caller: HarnessCaller): Promise<void> {
  return caller.rpcCall<void>("stopTugcode", {});
}

/**
 * Append a single JSON IPC frame to tugcode's stdin (the harness
 * appends the newline). Used by tests that drive the tugcode IPC
 * loop directly — typically a `protocol_init` followed by one or
 * more `user_message` frames in stub-replay mode.
 *
 * The line is sent as-is; `JSON.stringify` it client-side first
 * if you have an object. Production tugcode talks via tugcast
 * which also writes JSON-per-line; this verb provides the same
 * shape for tests without needing a tugcast in the loop.
 */
export function writeTugcodeStdin(
  caller: HarnessCaller,
  line: string,
): Promise<void> {
  return caller.rpcCall<void>("writeTugcodeStdin", { line });
}

/**
 * Press every modifier in `modifiers`, run `thunk`, release them in
 * reverse order — all as a single atomic Swift-side call. The inner
 * thunk receives a BUFFERED caller: every `nativeClick` / `nativeKey`
 * / etc. inside the thunk pushes to the buffer instead of posting
 * immediately. When the thunk resolves, the accumulated verbs ship
 * as one `holdModifier` RPC.
 *
 * Why the buffered caller: if each inner verb RPC'd separately,
 * Swift would release the modifier between inner verbs (each call's
 * `NativeEventHandlers` instance is fresh), and the whole point of
 * `holdModifier` is that inner verbs see the modifier already down.
 *
 * Nested `holdModifier` calls are not supported — the buffered caller
 * rejects re-entry. Tests that need nested modifier scopes should
 * flatten the modifier set (`["cmd", "shift"]` instead of two
 * nested scopes).
 */
export async function holdModifier(
  caller: HarnessCaller,
  modifiers: readonly NativeModifier[],
  thunk: (inner: HarnessCaller) => Promise<void>,
): Promise<void> {
  const buffer: InnerNativeVerb[] = [];
  let finalized = false;
  const buffered: HarnessCaller = {
    evalJS<T>(_script: string, _opts?: EvalJsOptions): Promise<T> {
      throw new Error(
        "[tug] holdModifier: evalJS is not supported inside a holdModifier thunk — " +
          "modifier state lives entirely in Swift's CGEventSource, so evalJS mid-scope " +
          "cannot observe the held flag. Route introspection outside the scope.",
      );
    },
    waitForCondition<T>(
      _script: string,
      _opts?: WaitForConditionOptions,
    ): Promise<T> {
      throw new Error(
        "[tug] holdModifier: waitForCondition is not supported inside a holdModifier thunk — " +
          "Swift dispatches every inner verb in one synchronous pass; a wait would deadlock.",
      );
    },
    rpcCall<T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<T> {
      if (finalized) {
        return Promise.reject(
          new Error(
            "[tug] holdModifier: inner RPC issued after the thunk returned",
          ),
        );
      }
      if (method === "holdModifier") {
        return Promise.reject(
          new Error(
            "[tug] holdModifier: nested scopes are not supported — flatten the modifier set",
          ),
        );
      }
      if (!isNativeVerbMethod(method)) {
        return Promise.reject(
          new Error(
            `[tug] holdModifier: only native verbs may run inside a holdModifier thunk (got "${method}")`,
          ),
        );
      }
      buffer.push({ method, ...params } as InnerNativeVerb);
      // Inner verbs have no useful return value (all native verbs
      // return null/void); resolve with undefined cast to T.
      return Promise.resolve(undefined as unknown as T);
    },
  };
  try {
    await thunk(buffered);
  } finally {
    finalized = true;
  }
  if (buffer.length === 0) return;
  await caller.rpcCall<void>("holdModifier", {
    modifiers,
    innerVerbs: buffer,
  });
}

// ---------------------------------------------------------------------------
// RPC-verb internals
// ---------------------------------------------------------------------------

/**
 * Resolve `selector` → an element-center point in CSS viewport coords.
 * Used by every `*AtElement` wrapper. Throws the page-side
 * "[tug] getElementBounds selector matched no element" error on miss.
 *
 * **It also waits, briefly, for the point to actually reach the element.**
 * An app-modal gate — the restore gate above all, which is up for exactly as
 * long as a cold restore holds the one main thread — covers the whole
 * viewport while it is open, so a click posted into that window is spent on
 * the scrim and the gesture that follows it falls on the floor: the composer
 * never focuses, the typing goes nowhere, and the test times out much later
 * waiting for a surface the click was supposed to raise. That is the
 * `tug-sheet` mount red — three arc files whose only fault was clicking a
 * beat too early, and it is a race, which is why one of them was flaky and
 * the others were not.
 *
 * The wait is **advisory**: it polls for the target to become hit-testable
 * and posts the click regardless once the budget runs out. It can therefore
 * only turn a fail into a pass, never the reverse — a target legitimately
 * covered by something that is not its own descendant (a portalled tooltip)
 * costs one bounded wait and then behaves exactly as it did before.
 *
 * The bounds are read *after* the wait, because a gate coming down is a
 * layout change and a point measured under it can be stale by the time it is
 * posted.
 */
async function centerOfElement(
  caller: HarnessCaller,
  selector: string,
): Promise<ViewportPoint> {
  await settleUntilHitTestable(caller, selector);
  const rect = await getElementBounds(caller, selector);
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

/**
 * How long [`settleUntilHitTestable`] waits before posting the click anyway.
 *
 * Scaled by the harness like any other explicit budget, so on a loaded
 * machine — which is when the restore gate is up longest, and exactly when
 * the race bites — it is longer in wall-clock terms. Small enough that a
 * target genuinely covered forever costs one of these per click and no
 * test's own budget.
 */
const HIT_TESTABLE_BUDGET_MS = 5000;

/**
 * Wait, up to that budget, for `selector`'s own center to hit-test to
 * `selector` — that is, for nothing to be sitting on top of it.
 *
 * `elementFromPoint` already honours `pointer-events: none`, so an overlay
 * that is merely animating out does not count as covering anything. A hit
 * that *is* the element, contains it, or is contained by it all count as
 * reaching it: the first is the ordinary case, the second a wrapper whose
 * child fills it, the third the element's own descendant under the point.
 *
 * Swallows its own timeout on purpose — see [`centerOfElement`].
 */
async function settleUntilHitTestable(
  caller: HarnessCaller,
  selector: string,
): Promise<void> {
  const script = `(function () {
  var el = document.querySelector(${lit(selector)});
  if (!el) return true; // let getElementBounds give the real error
  var r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return true;
  var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!hit) return true;
  return hit === el || el.contains(hit) || hit.contains(el);
})()`;
  try {
    await caller.waitForCondition<boolean>(script, {
      timeoutMs: HIT_TESTABLE_BUDGET_MS,
    });
  } catch {
    // Advisory. The click goes out anyway, and whatever the test was going
    // to assert still gets to say what it found.
    //
    // This also swallows `holdModifier`'s buffered caller, which refuses
    // `waitForCondition` outright — deliberately, so the diagnostic a
    // `*AtElement` verb earns inside a modifier scope stays the one
    // `getElementBounds` gives a line later, which is the message that says
    // what to do about it.
  }
}

function buildNativeClickParams(
  viewportPoint: ViewportPoint,
  opts?: NativeClickOptions,
): Record<string, unknown> {
  const params: Record<string, unknown> = { viewportPoint };
  if (opts?.button !== undefined) params.button = opts.button;
  if (opts?.clickCount !== undefined) params.clickCount = opts.clickCount;
  if (opts?.mouseDownDelayMs !== undefined)
    params.mouseDownDelayMs = opts.mouseDownDelayMs;
  if (opts?.mouseUpDelayMs !== undefined)
    params.mouseUpDelayMs = opts.mouseUpDelayMs;
  if (opts?.activateFirst !== undefined)
    params.activateFirst = opts.activateFirst;
  return params;
}

function isNativeVerbMethod(method: string): boolean {
  switch (method) {
    case "nativeClick":
    case "nativeDoubleClick":
    case "nativeRightClick":
    case "nativeDrag":
    case "nativeMouseDown":
    case "nativeMouseUp":
    case "nativeKey":
    case "nativeType":
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Type-level sanity: client wrappers are exhaustive.
// ---------------------------------------------------------------------------

/**
 * The set of `TugTestSurface` methods this client has wrappers for.
 * Checked when `tugdeck/src/test-surface.ts` changes — when a new
 * surface method lands, add its name here AND a helper
 * above. The handshake's `SURFACE_VERSION` is the runtime gate
 * ([D11]); this union is the authoring-time reminder.
 */
export type ClientMethodNames =
  | "click"
  | "type"
  | "focusElement"
  | "reset"
  | "seedDeckState"
  | "getActiveCardId"
  | "getFocusedCardId"
  | "getCaretState"
  | "getFormControlValue"
  | "assertHostRootRegistered"
  | "getDeckTrace"
  | "markDeckTrace"
  | "clearDeckTrace"
  | "enableDeckTrace"
  // Introspection (SURFACE_VERSION 1.1.0)
  | "getElementText"
  | "getElementValue"
  | "getElementAttribute"
  | "getElementBounds"
  | "getElementState"
  | "getActiveElement"
  | "getSelection"
  | "getComputedStyleValue"
  | "registerSelectionBoundary"
  | "unregisterSelectionBoundary"
  // EM-card observation (SURFACE_VERSION 1.2.0)
  | "getEmCardState"
  | "isEngineReady";
