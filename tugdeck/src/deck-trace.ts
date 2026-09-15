/**
 * deck-trace.ts — a bounded, in-memory ring buffer of structured deck
 * events, used to reconstruct focus / activation / lifecycle sequences
 * when diagnosing AT-series regressions inside the real Tug.app
 * WKWebView.
 *
 * ## Why this exists
 *
 * Our production focus bugs are rarely bugs in the focus-calling code
 * itself. They are bugs in why the focus-calling code never runs: an
 * `[A3]` mount-guard that early-returns on its first frame after a
 * destination flip, a `save-callback` that fires from the wrong
 * trigger, a `card-host` that mounts or unmounts a frame later than
 * expected. A narrow `focus-trace` cannot tell "the effect body
 * early-returned" from "the effect body ran but chose the wrong
 * target". A whole-deck trace can.
 *
 * This module records, in order, every focus-adjacent event that
 * matters: first-responder flips, destination-flips (the per-card view
 * of focus-destination bit transitions), `<CardHost>` mount / unmount,
 * every `[A3]` activation-effect run (including early-returns, tagged
 * with the reason), every `.focus()` call site, document-level
 * `focusin` / `focusout`, save callbacks (with the triggering source),
 * selection-restore entries, and a per-commit `commit-tick` beacon so
 * we can align events with React commit boundaries.
 *
 * See Design Decision [D06] ("Instrumentation covers the whole deck,
 * not just focus") for the instrumentation philosophy; the event union
 * below is the contract for consumers.
 *
 * ## API surface
 *
 * This module provides the event union, the ring buffer, and
 * `record` / `dump` / `dumpTable` / `enable` / `mark` / `since` /
 * `clear`. Call sites in the deck install separately. The
 * `window.__deckTrace` global is bound in every build so a developer
 * can drive the trace from the Safari Web Inspector console —
 * including on a release instance, where the always-recorded kinds
 * below have been filling the ring unattended.
 *
 * ## Enable semantics
 *
 * Recording defaults to OFF. Callers opt in via `enable(true)`; a
 * typical flow is `enable(true) → mark() →
 * interact → dumpTable()`. While `enabled === false`, `record` is a
 * single bounds-check and return — callers may leave `record` calls
 * in hot paths without metering concerns. `mark`, `since`, `clear`,
 * and `dump` remain callable regardless of the enable flag (they do
 * not write new events); toggling `enable` never clears the existing
 * buffer.
 *
 * The kinds in `ALWAYS_RECORDED_KINDS` are the exception: they record
 * whether or not anyone opted in. They are records of a *defect*
 * (a scroll displacement, a follow-bottom flip) rather than of an
 * interaction under study, and the sessions that hold the evidence
 * are by definition the ones nobody was watching.
 *
 * ## Bounded ring
 *
 * Capacity is 512 entries. When the 513th event is recorded, the
 * oldest is evicted. The `seq` counter is monotonic over the process
 * lifetime (never rewound) so `since(lastSeq)` returns a strictly
 * forward slice even across evictions; eviction does not renumber.
 *
 * The ring is stored as a pre-allocated array with a head pointer and
 * a `full` flag; we avoid `Array.prototype.shift` (which is O(n) on
 * dense arrays in most engines) by writing in place and re-ordering
 * on `dump`. `dump` returns a fresh array so callers can safely
 * mutate their copy without disturbing the ring.
 *
 * ## Tuglaws
 *
 *   - **L10** — this module owns exactly one responsibility (record
 *     + expose deck events for diagnostic trace).
 *   - **L06** — the module never drives React state; dev-only
 *     diagnostic side effects (console output, DOM access by
 *     serializers) are one-way.
 *
 * @module deck-trace
 */

import { getDeckStore } from "./lib/deck-store-registry";
import type { BeatKind } from "./lib/pane-flip";
import { isFocusDestination } from "./deck-store-selectors";

// ---------------------------------------------------------------------------
// Event shape (`DeckTraceEvent` union)
// ---------------------------------------------------------------------------

/**
 * Source tag on `save-callback` events.
 *
 * Production tags fire from real lifecycle moments — card close
 * (`"close-handoff"`), debounced auto-save (`"debounced"`),
 * visibility change (`"visibilitychange"`, fires on cmd-tab away or
 * app hide), page unload (`"beforeunload"`), window blur
 * (`"window-blur"`), and explicit manual saves (`"manual"`).
 *
 * `"termination"` is the app's own exit — the deck's termination
 * pipeline running before the host tears the process down. It is the
 * one source a card may capture *more* under: text that is queued or
 * pulled back but not visibly in the composer is folded into the saved
 * draft, because there is no next render to put it there.
 *
 * Dev-only tags (`"hmr"`, `"hmr-full-reload"`) fire from the Vite
 * HMR pipeline so the trace ring records HMR-driven save passes
 * with a distinct source for observability. They are dead code in
 * production bundles — `import.meta.hot` is `undefined` outside
 * `vite dev`, so the handlers that emit these tags never run.
 */
export type SaveCallbackSource =
  | "close-handoff"
  | "debounced"
  | "visibilitychange"
  | "beforeunload"
  | "window-blur"
  | "manual"
  | "termination"
  | "hmr"
  | "hmr-full-reload";

/**
 * How a store commit lands — the mutation's own account of the motion it
 * asks for, stamped at the call site and carried to the settle beside the
 * caller tag ([B01], [B02]).
 *
 * `"cross"` is what every arrangement change does: the frames are where the
 * previous state put them, and the settle carries each one from there to its
 * new place. `"cut"` says the frames are already drawn where this commit puts
 * them — a per-frame writer catching the store up after the fact — so there is
 * nothing to carry and the settle declines.
 *
 * Here rather than on the store's own interface for the same reason
 * {@link SaveCallbackSource} is: a tag the store stamps and the trace records
 * belongs where the record it rides is declared, and this module imports
 * nothing from the store.
 *
 * A drop needs no third value. The dragged frame is carried by
 * `zone-drop-landing` and exempted from the settle by `data-pointer-owned`
 * alone, in both the First pass and the Last, so a drop is a `"cross"` with
 * one frame already spoken for.
 */
export type CommitLanding = "cross" | "cut";

/**
 * What a settle arm decided, and the term [B06]'s check is written over.
 *
 * `carried` — the arrangement changed, frames were measured, and the settle
 * will tween them.
 *
 * `unarmed` — the arrangement changed but nothing will tween: reduced motion,
 * or a deck with no measured frames. The move is uncarried and that is worth
 * separating from "nothing moved".
 *
 * `declined` — the commit landed `"cut"`, so the frames are already drawn
 * where it put them and there is nothing to carry ([B01]).
 *
 * `unchanged` — the signature did not move, so the commit changed nothing the
 * imposer reads. Recorded rather than passed over in silence because it is
 * what distinguishes a commit that legitimately armed nothing from a
 * subscriber that never ran at all — the mount-gap defect, which is otherwise
 * indistinguishable from a quiet commit.
 */
export type SettleArmOutcome = "carried" | "unarmed" | "declined" | "unchanged";

/** Entry-point tag on `selection-restore` events. */
export type SelectionRestoreVia =
  | "restoreCardDomSelection"
  | "applyFocusSnapshot";

/**
 * Phase tag on `focus-measurement` events.
 *
 * Recorded at the three observation points around a framework focus-
 * claim site:
 *
 *   - `pre-sync` — immediately before the synchronous `.focus()` /
 *     `paintMirrorAsActive` call. Captures the user-driven gesture's
 *     starting `document.activeElement`.
 *   - `post-sync` — immediately after the synchronous claim. If the
 *     claim survived the same-tick gesture default action (no WebKit
 *     gesture focus-lock), `activeElement` already names the resolved
 *     target. If the claim was swallowed, `activeElement` is unchanged
 *     from `pre-sync`.
 *   - `post-gesture` — recorded one event-loop boundary later (on the
 *     same gesture's `pointerup` or `click` for click-driven sources,
 *     or on the next macrotask for keyboard / programmatic sources).
 *     `activeElement` here names the final landing of the activation;
 *     comparing it against `post-sync` is the [L05] gate that decides
 *     whether the sync-only path is contractual for the source.
 */
export type FocusMeasurementPhase = "pre-sync" | "post-sync" | "post-gesture";

/**
 * Caller tag on `engine-paint-mirror-active` events.
 *
 * Names the path that invoked `paintMirrorAsActive` so the per-source
 * × per-claimant investigation matrix can see which of the four
 * claimants fired for any given activation:
 *
 *   - `onCardActivated` — `useCardStatePreservation.onCardActivated`
 *     (autonomous claim wired in `tug-text-editor/state-preservation.ts`).
 *   - `onRestore` — `useCardStatePreservation.onRestore` `isActive`
 *     branch (cold-boot / cross-pane move autonomous claim).
 *   - `mount-effect-replay` — the editor's mount effect drained a
 *     pending `onRestore` payload whose `onRestore` fired before the
 *     view was constructed.
 *   - `imperative-api` — `entryDelegate.paintMirrorAsActive(...)` /
 *     `tug-text-editor-handle.paintMirrorAsActive(...)` call site
 *     (rare; reserved for explicit imperative consumers).
 *   - `via-engine-hook` — Phase E.11 single-channel dispatcher invoked
 *     the engine hook (`applyBagFocus` → `invokeEnginePaintMirrorAsActive`).
 *     This tag is dead at Step 1 and lights up at Step 3 — recording
 *     the slot now keeps the event union stable across the phase.
 */
export type EnginePaintMirrorActiveCaller =
  | "onCardActivated"
  | "onRestore"
  | "mount-effect-replay"
  | "imperative-api"
  | "via-engine-hook";

/**
 * Delegate-method tag on `macrotask-focus-claim` events.
 *
 * Distinguishes the three `useCardDelegate` handlers in `session-card.tsx`
 * that defer through the `MessageChannel` drain queue and currently
 * call `entryDelegateRef.current?.focus()`:
 *
 *   - `cardDidActivate` — fires after the card becomes the deck-level
 *     first responder. This is the macrotask focus claim that
 *     Phase E.11 retires at #e11-step-3.
 *   - `cardDidMove` — fires after a cross-pane move commits. Re-asserts
 *     focus only when this card is still first responder.
 *   - `cardDidResize` — fires after a resize commits. Same first-
 *     responder gate as `cardDidMove`.
 */
export type MacrotaskFocusClaimDelegate =
  | "cardDidActivate"
  | "cardDidMove"
  | "cardDidResize";

/**
 * Snapshot of the DeckManager store at the moment a trace event is
 * recorded. Surfaces the pieces of state that drive activation /
 * first-responder decisions so an ordering diagnosis ("did
 * destination-flip fire while the store still thought A was active?")
 * does not require inferring state transitions from adjacent events.
 *
 * Null when `getDeckStore()` returns null — i.e. the trace module
 * recorded an event before the `DeckManager` constructor ran and
 * registered its store. This is a transient pre-registration state
 * during boot; once any pane is mounted, the snapshot is populated
 * on every subsequent record call.
 *
 * `activeCardId` is derived: it is the `activeCardId` of the pane
 * whose id equals `activePaneId`. Null when no active pane exists
 * or when the active pane has no active card.
 *
 * `hasFocus` mirrors `state.hasFocus` — whether the tugdeck window
 * owns OS foreground focus. `isFocusDestination(cardId)` returns
 * true only when `hasFocus === true` and `cardId === activeCardId`;
 * matcher readers can reconstruct that bit from the snapshot alone.
 */
export interface DeckTraceStoreSnapshot {
  activePaneId: string | null;
  activeCardId: string | null;
  hasFocus: boolean;
}

/**
 * The tagged union of events recordable in the deck trace. Every
 * event variant carries `{ timestamp, seq, loc?, store? }` in addition
 * to its kind-specific payload; `timestamp` is `performance.now()` (or
 * `Date.now()` when `performance` is unavailable), `seq` is a
 * module-scoped monotonic counter, `loc` is the caller's `file.tsx:line:col`
 * captured via `new Error().stack` at record time (empty string when
 * the engine does not expose a usable stack frame), `store` is a
 * {@link DeckTraceStoreSnapshot} captured synchronously at record
 * time (null when no store is registered).
 *
 * String-valued element fields (e.g. `focusin.el`) are formatted by
 * {@link formatElement} into `tag#id.class[data-card-id=foo]`-style
 * strings at record time so the trace never retains live DOM
 * references past the recording moment.
 */
export type DeckTraceEvent = {
  timestamp: number;
  seq: number;
  loc?: string;
  store?: DeckTraceStoreSnapshot | null;
} & (
  | {
      kind: "fr-flip";
      from: string | null;
      to: string | null;
      trigger: string;
    }
  | {
      kind: "destination-flip";
      cardId: string;
      from: boolean;
      to: boolean;
    }
  | {
      kind: "card-host-mount";
      cardId: string;
      hostStackId: string;
    }
  | {
      kind: "card-host-unmount";
      cardId: string;
      hostStackId: string;
    }
  | {
      kind: "focus-call";
      site: string;
      cardId: string;
      targetSelector: string;
      activeBefore: string;
      activeAfter: string;
      hidden: boolean;
    }
  | {
      kind: "focusin";
      el: string;
      relatedTarget: string | null;
    }
  | {
      kind: "focusout";
      el: string;
      relatedTarget: string | null;
    }
  | {
      kind: "save-callback";
      cardId: string;
      source: SaveCallbackSource;
    }
  | {
      kind: "selection-restore";
      cardId: string;
      via: SelectionRestoreVia;
    }
  | {
      kind: "commit-tick";
      count: number;
    }
  | {
      // Fired by EM-engine factories once their engine has finished
      // mounting and is ready to accept input / publish state.
      // `engine` tags the factory ("tug-prompt-input", "session-card",
      // "gallery-prompt-entry"). Used by harness tests to gate
      // assertions on engine-state surface methods.
      kind: "engine-ready";
      cardId: string;
      engine: string;
    }
  | {
      // Fired when an EM-engine factory's `onCardActivated` callback
      // runs as a result of an activation gesture. `dispatchedFrom`
      // names the trigger row from the activation taxonomy
      // activation-trigger trace sites. Wired at each
      // factory's onCardActivated registration; event shape is
      // defined here, per-card wiring is incremental.
      kind: "engine-activation-dispatched";
      cardId: string;
      engine: string;
      dispatchedFrom: string;
    }
  | {
      // Fired from `CardHost.registerStatePreservationCallbacks` immediately
      // before the persisted `bag.content` is forwarded to the
      // factory's `onRestore`. Captures what the framework knows about
      // the saved state on the cold-boot / cross-pane-mount path:
      // whether `bag.content` is populated and, for EM cards using the
      // engine-state shape, whether a non-null selection range is
      // present in the saved snapshot. Diagnostic for the cold-boot
      // selection-paint gap — lets a
      // trace dump show whether the save side captured a selection at
      // all before any restore work runs.
      kind: "cold-boot-restore-snapshot";
      cardId: string;
      hasContent: boolean;
      engineSelection: { start: number; end: number } | null;
    }
  | {
      // Fired from each EM factory's onRestore implementation
      // immediately after the engine's `restoreState` returns, with
      // `selectionApplied` echoing what was passed in (the saved
      // selection from the bag) and `domSelectionAfter` reading
      // `engine.getSelectedRange()` against the live DOM. Side-by-side
      // these two fields say whether the engine's `setSelectedRange`
      // actually landed the selection in the document. Diagnostic for
      // inactive-paint gap.
      kind: "engine-restore-applied";
      cardId: string;
      engine: string;
      selectionApplied: { start: number; end: number } | null;
      domSelectionAfter: { start: number; end: number } | null;
    }
  | {
      // Wraps each framework focus-claim site (`transferFocusForActivation`
      // focus-element + dispatch-activated branches, `transferFocusAfterMove`,
      // `reactivateCurrentFocusDestination`, CardHost cold-boot RESTORE)
      // with three observations: `pre-sync` (before the claim),
      // `post-sync` (immediately after, same tick), `post-gesture` (one
      // event-loop boundary later — `pointerup` / `click` for click-
      // driven sources, next macrotask otherwise). The triple is the
      // [L05] gate for Phase E.11 Step 1: per-source × per-kind, it
      // surfaces whether the sync `.focus()` survives the gesture
      // default action or is swallowed by WebKit's gesture focus-lock.
      // The `activeElement` strings are formatted by `formatElement`
      // so the trace ring never retains a live DOM reference.
      kind: "focus-measurement";
      phase: FocusMeasurementPhase;
      site: string;
      cardId: string | null;
      activeElement: string;
    }
  | {
      // Fires every time `paintMirrorAsActive` runs in
      // `tug-text-editor/state-preservation.ts`, with `caller` tagging
      // the originating path. Used by Step 1's investigation matrix
      // to see which of the four claimants (engine `onCardActivated`,
      // engine `onRestore`, framework focus-element, macrotask
      // delegate) actually wrote focus for each gesture source.
      kind: "engine-paint-mirror-active";
      cardId: string;
      caller: EnginePaintMirrorActiveCaller;
    }
  | {
      // Symmetry pair for `engine-paint-mirror-active`. Fires every
      // time `paintMirrorAsInactive` runs. Lets the investigation
      // verify deactivation pairs are intact across the Phase E.11
      // refactor — every active claim has a corresponding inactive
      // claim from the previously-active card.
      kind: "engine-paint-mirror-inactive";
      cardId: string;
    }
  | {
      // Fires when `useCardDelegate`'s `MessageChannel`-deferred
      // macrotask handler calls `entryDelegateRef.current?.focus()`
      // in `session-card.tsx`. Distinguishes the macrotask claim from
      // the synchronous framework path on the trace timeline; the
      // Phase E.11 Step 3 grep gate verifies this event is absent
      // for the `cardDidActivate` delegate after the autonomous
      // macrotask claim is retired.
      kind: "macrotask-focus-claim";
      cardId: string;
      delegate: MacrotaskFocusClaimDelegate;
    }
  | {
      // Dev-only invariant probe fired by the CM6 caret layer
      // (`tug-text-editor/caret-layer.ts`). The caret layer only
      // paints while `view.hasFocus`, so when it paints the editor
      // genuinely has DOM focus — and the responder chain's first
      // responder MUST then be that editor's responder. When it is
      // not, the caret is a "UI lie": it tells the user "you are
      // focused here" while chain-routed keyboard actions go
      // elsewhere. Recorded once per divergence transition (not per
      // repaint). Catches the intermittent
      // Shift+Return-does-nothing class of bug — the divergence
      // lands in the trace ring the instant it happens.
      kind: "caret-responder-divergence";
      editorResponderId: string;
      firstResponderId: string | null;
    }
  | {
      // Dev-only invariant probe, the KBF sibling of
      // `caret-responder-divergence` (same source, `caret-layer.ts`). A
      // painted caret and a projected `data-kbf` are mutually exclusive by
      // construction — the projection stands the mode's paint down while the
      // route is `dom-granted` — so a caret painting under the attribute
      // means a route flip escaped its repaint (accessibility mode, where
      // the pair is legal, is exempted at the probe). Recorded once per
      // divergence transition.
      kind: "kbf-caret-divergence";
      editorResponderId: string | null;
    }
  | {
      // Dev-only invariant probe, recorded from the focus manager's
      // projection commit ([#chord-ring]). The double ring — solid or in
      // its chord variant — says "Return fires this", and two controls saying
      // it at once leaves the user no way to tell which one means it.
      // `wearers` is a `|`-joined identifier list (testid, else aria-label,
      // else class) so the report names the offenders. Recorded once per
      // collision transition, not per reprojection.
      kind: "return-promise-collision";
      count: number;
      wearers: string;
    }
  | {
      // Fired by `SmartScroll.engage` / `SmartScroll.disengage` — the
      // typed funnel for follow-bottom intent. `following` is the
      // requested state (true = follow the live edge, false =
      // release it); `source` names the trigger ("block-fold",
      // "diff-view-toggle", ...) so a follow-bottom regression can be
      // traced to who flipped it. Recorded on every call, including
      // calls that find the state already at the requested value —
      // the record of intent is the diagnostic value, not just the
      // record of transitions.
      kind: "follow-bottom";
      following: boolean;
      source: string;
      // The flip's circumstances. All optional so a hand-built record
      // (a unit test, a hand-authored replay) stays valid; SmartScroll
      // fills every one.
      //
      // `source` alone is enough when the trigger is a gesture — the
      // user's hand explains itself. It is NOT enough for
      // `unattributed-scroll-up`, whose whole premise is that
      // SmartScroll could not attribute the move: the record names the
      // rule that fired but says nothing about what moved the
      // scroller, so a field report reduces to "something did this,
      // somewhere." These fields carry what the rule had in hand at
      // the moment it decided.
      /** Which scroller flipped: its `data-tug-scroll-key` and the
       *  enclosing card. Without these a multi-card deck's trace can't
       *  say WHICH transcript stopped following. */
      scrollKey?: string;
      cardId?: string;
      /** Page state at the flip. A scroller in a hidden or unfocused
       *  window is one the user cannot have been scrubbing — which is
       *  exactly the claim `unattributed-scroll-up` makes about them. */
      visibility?: string;
      windowFocused?: boolean;
      /** Position and distance from the live edge at the flip. */
      top?: number;
      dist?: number;
      /** Milliseconds since the last user input carrying scroll intent
       *  (wheel / pointerdown / scroll key), or `null` when none has
       *  ever arrived. A large number under an intent-derived source is
       *  a contradiction worth seeing. */
      sinceInputMs?: number | null;
      /** The delivered `scroll` events leading up to the flip, oldest
       *  first, as `Δms,top,scrollHeight,clientHeight` tuples joined by
       *  `|`. Δms is relative to the flip, so every value is negative.
       *  This is what separates a gesture (a stream of samples) from a
       *  browser clamp (one isolated jump), and a height-driven move (a
       *  `scrollHeight` that changed with it) from a position-only one
       *  (a height identical on both sides). */
      ring?: string;
    }
  | {
      // Fired by `TugListView`'s commit bracket when it finds the
      // scroller somewhere the machine cannot account for. The only
      // actor that moves `scrollTop` with no JavaScript involved is
      // the browser clamping it to a transiently-short document, so
      // this is the record of a clamp: `from` is the position as of
      // the last `scroll` event (the baseline the bracket compares
      // against), `to` is where the commit left it.
      //
      // This is an assertion record, not a repair record. The extent
      // floor makes the clamp impossible by construction, so any
      // record here is a defect in the floor itself: the bracket
      // attributes the move (so intent rules don't misread it as the
      // user) and records it — it never counter-writes the position.
      // Whether a displacement persisted is read from consecutive
      // records: the next record's `from` baseline sitting at this
      // record's `to` means the position genuinely rested there.
      kind: "scroll-displacement";
      from: number;
      to: number;
      scrollHeight: number;
      clientHeight: number;
      following: boolean;
      evicting: boolean;
    }
  | {
      // Fired by `TugListView`'s commit bracket when it lowers the
      // extent floor — the element that pins the scrollable extent so
      // it cannot dip mid-mutation. The floor only lowers when the
      // content genuinely got shorter (a collapsed block, a re-wrap, a
      // cleared session), so this is the declared, attributed shrink
      // Case A of `arc/scroll-height-floor.md` requires: every
      // extent decrease leaves exactly one of these records. `clamped`
      // reports whether the lowering moved `scrollTop` (the browser
      // clamping to the now-shorter maximum) — that move is machine-
      // authored and pinned via `noteExternalWrite`, never repaired.
      kind: "extent-rebase";
      from: number;
      to: number;
      scrollTop: number;
      clientHeight: number;
      clamped: boolean;
      following: boolean;
    }
  | {
      // ---- The motion census ----
      //
      // Fired by `DeckManager.notify` on every store notification.
      // `caller` is the mutating method's own name, stamped at the call
      // site, so a gesture that notifies more than once names each
      // contributor rather than reporting an anonymous count. The census
      // exists because "smooth" is otherwise unfalsifiable: a drop-zone
      // release costs exactly ONE notify, and every extra one re-runs
      // the arrangement signature and re-arms — or worse, retargets —
      // the settle mid-flight.
      //
      // `version` is the post-increment `stateVersion`, which pairs a
      // notify with the arm it provoked.
      //
      // `landing` is how the commit says it wants to land ([B02]). Inside a
      // batch it resolves the same way the caller tag does — the outermost
      // commit's, except that any `"cross"` in the batch wins, because
      // crossing a frame already in place is a no-op tween while cutting one
      // that is not is the defect.
      kind: "store-notify";
      caller: string;
      version: number;
      landing: CommitLanding;
    }
  | {
      // Fired by the deck canvas when the arrangement signature changes.
      // `panes` counts the frames the settle will move; `armed` is false
      // when the subscriber saw a changed signature but declined to
      // animate (a first paint, a deck with no measured frames), which
      // separates "nothing moved" from "something moved without a tween".
      //
      // `landing` is the commit's own account of how it wanted to land and
      // `outcome` is what this arm did about it. The pair is what [B06] is
      // checked over: a `"cut"` that was carried, and a `"cross"` that was
      // declined, are each the settle disagreeing with the commit that
      // provoked it. `armed` is kept beside `outcome` because the census's
      // "N arm(s) (M unarmed)" line is written over it.
      kind: "settle-arm";
      signature: string;
      panes: number;
      armed: boolean;
      landing: CommitLanding;
      outcome: SettleArmOutcome;
    }
  | {
      // Fired when an arm lands on a frame whose settle tween is still in
      // flight. `mode` names how the running tween ended: "snap" is the
      // `snap-to-end` + inline-restore dance that paints one stale frame
      // (the flash this census was built to count); "matched" is the
      // velocity-matched relaunch that replaces it. The bar is zero
      // "snap" records per gesture.
      kind: "settle-retarget";
      paneId: string;
      mode: "snap" | "matched";
      // The beat that was running when the arm landed — the recipe the
      // velocity was read off — or null when no beat was up (a fade-only
      // settle, or a frame whose chain had already finished).
      //
      // The outer two are fades and carry no velocity — `velocityAt` answers 0
      // for a `zeta: null` recipe — so a retarget landing in one relaunches
      // from rest. They are recorded all the same, because which beat was up is
      // what the census reads.
      beat: BeatKind | null;
    }
  | {
      // Fired when a settle releases the session stores' notification hold.
      // `source` names which clock released it: "completion" is the settle's
      // own — after the final beat's last tween has finished and every
      // frame's residue, fold crossing and resize episode have been ended,
      // in that order ([B04] of `three-beat-settle`); "sweep" is the window
      // timer, which is a wedge guard and never the release on the normal
      // path; "unmount" is the canvas leaving mid-gesture. The bar is that
      // a settle which completes releases from "completion", never "sweep".
      kind: "settle-release";
      source: "completion" | "sweep" | "unmount";
    }
  | {
      // Fired when a member's FIRST live reservation report disagrees with
      // the opening bid the arrival commit wrote for it ([P04]). The bid is
      // kept and the report is NOT committed: after [P02] the bid is a
      // measurement of the very panel that is now reporting, taken off-screen
      // at the width the pane went on to take, so the two numbers are supposed
      // to be the same number. A row here is therefore a defect in the
      // measuring render — a style that only applies on screen, a width the
      // measure guessed wrong, an effect the measuring render was supposed to
      // skip and did not — rather than a threshold anybody should be tuning.
      //
      // Always recorded, for the family's reason: it is evidence of a defect
      // in a session nobody was watching, and the arrival it describes has
      // already happened by the time anyone could think to opt in.
      kind: "opening-bid-mismatch";
      memberId: string;
      // The number the arrival commit bid, and the number the live panel
      // first read. Both raw, so the difference is readable without arithmetic.
      bid: number;
      report: number;
    }
  | {
      // One `[dev::session-lifecycle]` line, mirrored into the ring by
      // `logSessionLifecycle`. The browser leg of that stream is the one
      // leg with no durable sink: tugcode's copy reaches `tugcast.log`
      // through its stderr, tugcast's own lines are `tracing::info!`, and
      // the deck's go to a console nobody is attached to. A cold restore
      // emits its whole perf story — `perf.replay_ingest`,
      // `perf.replay_render`, `perf.row_parse` — during the seconds before
      // anyone could open an inspector, so the ring is where it has to
      // land to be readable afterwards.
      kind: "session-lifecycle";
      event: string;
      fields: Record<string, unknown>;
    }
);

/**
 * The payload shape of {@link DeckTrace.record} — the caller provides
 * the variant-specific fields; the module stamps `timestamp`, `seq`,
 * `loc`, and `store` on ingest.
 */
type StampedFields = "timestamp" | "seq" | "loc" | "store";
export type DeckTraceEventInput =
  | Omit<Extract<DeckTraceEvent, { kind: "fr-flip" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "destination-flip" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "card-host-mount" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "card-host-unmount" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "focus-call" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "focusin" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "focusout" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "save-callback" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "selection-restore" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "commit-tick" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "engine-ready" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "engine-activation-dispatched" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "cold-boot-restore-snapshot" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "engine-restore-applied" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "focus-measurement" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "engine-paint-mirror-active" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "engine-paint-mirror-inactive" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "macrotask-focus-claim" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "caret-responder-divergence" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "kbf-caret-divergence" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "return-promise-collision" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "follow-bottom" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "scroll-displacement" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "extent-rebase" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "store-notify" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "settle-arm" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "settle-retarget" }>, StampedFields>
  | Omit<Extract<DeckTraceEvent, { kind: "settle-release" }>, StampedFields>
  | Omit<
      Extract<DeckTraceEvent, { kind: "opening-bid-mismatch" }>,
      StampedFields
    >
  | Omit<Extract<DeckTraceEvent, { kind: "session-lifecycle" }>, StampedFields>;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Ring capacity. Fixed at 512 entries — enough to span typical
 * AT-series reproductions while keeping `dumpTable()` output readable.
 */
export const DECK_TRACE_CAPACITY = 512;

/**
 * Serialize a DOM element (or `null`) to a stable short string for
 * the trace. Shape: `tag#id.class[data-card-id=foo]` — tag is always
 * present; `#id` / `.class*` / selected data-attrs are appended when
 * available. The function must be side-effect-free and tolerant of
 * detached / unusual nodes (e.g. `document`, `Window`); callers may
 * hand in arbitrary focus targets.
 *
 * Data attributes prioritized into the label:
 *   - `data-card-id`
 *   - `data-card-host`
 *   - `data-tug-focus-key`
 *   - `data-tug-state-key`
 *
 * Non-Element inputs (Document, Window, null) collapse to a
 * descriptive tag: `#document`, `#window`, or the empty string for
 * null. We never throw; serialization must not break a trace record.
 */
export function formatElement(el: EventTarget | Element | null): string {
  if (el === null) return "";
  if (typeof Document !== "undefined" && el instanceof Document) return "#document";
  if (typeof Window !== "undefined" && el instanceof Window) return "#window";

  const node = el as Element;
  if (typeof node.tagName !== "string") {
    // Fallback for EventTargets that are not Elements (XHR, AbortSignal, ...).
    return "#non-element";
  }

  let out = node.tagName.toLowerCase();
  const id = node.id;
  if (id) out += `#${id}`;

  const className = node.getAttribute?.("class");
  if (className) {
    const classes = className
      .split(/\s+/)
      .filter((c) => c.length > 0)
      .slice(0, 3);
    if (classes.length > 0) out += `.${classes.join(".")}`;
  }

  const dataKeys = [
    "data-card-id",
    "data-card-host",
    "data-tug-focus-key",
    "data-tug-state-key",
  ];
  const attrs: string[] = [];
  for (const key of dataKeys) {
    const value = node.getAttribute?.(key);
    if (typeof value === "string") {
      attrs.push(`${key}=${value}`);
    }
  }
  if (attrs.length > 0) out += `[${attrs.join(",")}]`;
  return out;
}

function now(): number {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }
  return Date.now();
}

/**
 * Pluck the last `*.ts` / `*.tsx` `file:line:col` match out of a stack
 * frame string. Tolerant of both V8 format (`    at name (url:line:col)`)
 * and JSC format (`name@url:line:col`) — both end with `:line:col` and
 * both can be scanned for the trailing `.ts[x]` file token.
 *
 * Returns `null` when no match — the caller falls through to the next
 * frame or returns an empty-string loc.
 */
function extractLocFromFrame(frame: string): string | null {
  const matches = [...frame.matchAll(/([A-Za-z0-9._-]+\.tsx?):(\d+):(\d+)/g)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1]!;
  return `${last[1]}:${last[2]}:${last[3]}`;
}

/**
 * Capture the caller's `file.tsx:line:col` at record time via
 * `new Error().stack`. Walks frames until it finds one that does not
 * reference `deck-trace` (the module's own call sites), then extracts
 * the short form via {@link extractLocFromFrame}.
 *
 * Returns the empty string when the engine does not expose a usable
 * stack (older browsers, edge-case synthetic calls). The `loc` field
 * on `DeckTraceEvent` is typed as optional so matchers can accept
 * empty-string locations without tightening their assertions.
 */
function captureCallerLoc(): string {
  let stack: string | undefined;
  try {
    stack = new Error().stack;
  } catch {
    return "";
  }
  if (typeof stack !== "string") return "";
  const lines = stack.split("\n");
  // Skip frames inside deck-trace.ts itself; do NOT skip `deck-trace.test.ts`
  // or other files that merely share the prefix. The trailing `:` anchors
  // the match to the file-colon-line form on both V8 and JSC stacks.
  for (const line of lines) {
    if (line.includes("deck-trace.ts:")) continue;
    const loc = extractLocFromFrame(line);
    if (loc !== null) return loc;
  }
  return "";
}

/**
 * Capture a {@link DeckTraceStoreSnapshot} synchronously at record
 * time. Returns `null` when the deck store registry has not yet
 * bound a store (pre-DeckManager boot) or when the snapshot throws
 * unexpectedly — both are transient conditions we tolerate rather
 * than propagating up into the caller's record call.
 *
 * Derives `activeCardId` by looking up the active pane's `activeCardId`
 * in `state.panes` — this matches {@link isFocusDestination}'s model
 * exactly, so readers of the trace can reconstruct "was this card the
 * focus destination at record time?" from the snapshot alone.
 */
function captureStoreSnapshot(): DeckTraceStoreSnapshot | null {
  const store = getDeckStore();
  if (store === null) return null;
  try {
    const state = store.getSnapshot();
    const activePaneId = state.activePaneId ?? null;
    let activeCardId: string | null = null;
    if (activePaneId !== null) {
      const pane = state.panes.find((p) => p.id === activePaneId);
      activeCardId = pane?.activeCardId ?? null;
    }
    return {
      activePaneId,
      activeCardId,
      hasFocus: state.hasFocus,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ring buffer + public API
// ---------------------------------------------------------------------------

/**
 * The live ring. Pre-allocated to {@link DECK_TRACE_CAPACITY} entries
 * once we have observed at least one record; until then `buffer` is
 * empty and we push. After the first wrap we overwrite at `head`.
 *
 * `buffer.length <= DECK_TRACE_CAPACITY` is an invariant. When `full`
 * is true `buffer.length === DECK_TRACE_CAPACITY` and `head` is the
 * index of the oldest (next-to-evict) entry.
 */
const buffer: DeckTraceEvent[] = [];
let head = 0;
let full = false;

/** Monotonic sequence counter. Never rewound; survives eviction. */
let seqCounter = 0;

/** Recording gate. `record` short-circuits when this is false. */
let enabled = false;

/**
 * Event kinds that record regardless of the enable gate.
 *
 * Recording defaults to OFF, which is right for the high-volume focus
 * and commit kinds — they exist to be switched on during a
 * reproduction. Scroll displacement is the opposite case: it is a
 * defect record, it happens without warning, and the sessions that
 * most need it are the ones nobody was watching. Two sessions found
 * stranded thousands of pixels above the live edge held no evidence
 * at all, and the whole diagnosis had to be rebuilt live through
 * `/api/eval`. These kinds are rare by nature (one record per
 * displacement, one per follow-bottom transition, one per attributed
 * extent shrink), so recording them unconditionally costs nothing in
 * the streaming hot path.
 */
const ALWAYS_RECORDED_KINDS: ReadonlySet<DeckTraceEvent["kind"]> = new Set([
  "scroll-displacement",
  "follow-bottom",
  "extent-rebase",
  "session-lifecycle",
  "opening-bid-mismatch",
]);

function appendEvent(
  input: DeckTraceEventInput,
  loc: string,
  store: DeckTraceStoreSnapshot | null,
): void {
  const stamped = {
    ...input,
    timestamp: now(),
    seq: ++seqCounter,
    loc,
    store,
  } as DeckTraceEvent;
  if (full) {
    buffer[head] = stamped;
    head = (head + 1) % DECK_TRACE_CAPACITY;
  } else {
    buffer.push(stamped);
    if (buffer.length === DECK_TRACE_CAPACITY) {
      full = true;
      head = 0;
    }
  }
}

function readOrdered(): DeckTraceEvent[] {
  if (!full) return buffer.slice();
  const out: DeckTraceEvent[] = new Array<DeckTraceEvent>(DECK_TRACE_CAPACITY);
  for (let i = 0; i < DECK_TRACE_CAPACITY; i++) {
    out[i] = buffer[(head + i) % DECK_TRACE_CAPACITY]!;
  }
  return out;
}

/**
 * Public surface exposed to deck wiring and to developers via
 * `window.__deckTrace` (dev builds only).
 *
 * All methods are safe to call regardless of the enable flag — the
 * flag gates only whether {@link DeckTrace.record} writes new events.
 */
export interface DeckTrace {
  /**
   * Record an event. No-op when `enable(false)`; under `enable(true)`
   * the call stamps `timestamp` and `seq` and appends to the ring.
   *
   * The kinds in `ALWAYS_RECORDED_KINDS` — `scroll-displacement`,
   * `follow-bottom`, `extent-rebase`, and `session-lifecycle` — ignore
   * the gate and always record. They are defect and attribution records
   * for events that arrive unannounced, so waiting for someone to switch
   * recording on means having no evidence exactly when it is needed.
   */
  record(event: DeckTraceEventInput): void;
  /** Return a fresh array of every event currently in the ring, oldest-first. */
  dump(): readonly DeckTraceEvent[];
  /**
   * Pretty-print the ring as a table to the console. Intended for
   * `window.__deckTrace.dumpTable()` during manual reproduction.
   */
  dumpTable(): void;
  /**
   * Toggle recording. When called with `true`, subsequent `record`
   * calls write to the ring. When called with `false`, subsequent
   * `record` calls short-circuit. Does NOT clear the existing
   * buffer.
   */
  enable(flag: boolean): void;
  /**
   * Return the current sequence counter. Paired with
   * {@link DeckTrace.since} to slice "events since this mark".
   */
  mark(): number;
  /**
   * Return only events whose `seq` is strictly greater than `seq`.
   * Returns a fresh array.
   */
  since(seq: number): readonly DeckTraceEvent[];
  /**
   * Empty the ring and reset the head pointer. Preserves the
   * `seqCounter` (so successive `since(oldMark)` calls still return
   * a strictly forward slice) and preserves the enable flag.
   */
  clear(): void;
  /**
   * Summarize the motion census over the events since `seq` — the
   * reading instrument for one gesture. Bracket a gesture with
   * `const m = mark()` before and `census(m)` after and the result
   * says what the gesture cost: how many times the store notified and
   * which methods did it, how many settle arms the notifies provoked
   * and how many of those declined to animate, and how each retarget
   * ended its predecessor's tween.
   *
   * The bar a drop-zone release is held to: `notifies === 1`,
   * `arms <= 1`, `retargets.snap === 0`.
   */
  census(seq: number): MotionCensus;
}

/**
 * One gesture's motion cost. `byCaller` names each notifying method
 * with its count, so a release that notifies three times reports which
 * three rather than the bare number.
 */
export interface MotionCensus {
  notifies: number;
  byCaller: Record<string, number>;
  /**
   * Arms that found the arrangement changed — `carried` plus `unarmed`. An
   * arm that declined a cut, or that found the signature unmoved, is not one:
   * it armed no settle, and this is the count "the settle arms once, not once
   * per commit" is written over.
   */
  arms: number;
  /** Arms that saw a changed signature but animated nothing. */
  armsUnarmed: number;
  /**
   * Arms whose outcome contradicts the landing of the commit that provoked
   * them ([B06]): a `"cut"` the settle carried, or a `"cross"` it declined.
   * Zero is the bar — a settle that disagrees with its commit is a defect
   * whichever way it leans, since one of the two is wrong about whether the
   * frames are already drawn.
   */
  landingDisagreements: number;
  /**
   * Notifications that reached no arm at all. Distinct from an arm whose
   * outcome was `"unchanged"`: that one says the subscriber ran and found
   * nothing moved, while this one says the subscriber never ran — the
   * mount-gap defect the arm's own registration comment describes.
   */
  notifiesUnobserved: number;
  /** Every arm in the window, by what it decided. */
  armOutcomes: Record<SettleArmOutcome, number>;
  retargets: { snap: number; matched: number };
}

/**
 * The module's singleton trace instance. Imported by deck wiring as
 * `import { deckTrace } from "./deck-trace"`.
 */
export const deckTrace: DeckTrace = {
  record(event) {
    if (!enabled && !ALWAYS_RECORDED_KINDS.has(event.kind)) return;
    const loc = captureCallerLoc();
    const store = captureStoreSnapshot();
    appendEvent(event, loc, store);
  },
  dump() {
    return readOrdered();
  },
  dumpTable() {
    const rows = readOrdered();
    if (typeof console !== "undefined" && typeof console.table === "function") {
      console.table(rows);
    } else if (typeof console !== "undefined") {
      console.log(rows);
    }
  },
  enable(flag) {
    const next = flag === true;
    if (next === enabled) return;
    enabled = next;
    if (next) {
      installObservers();
    } else {
      uninstallObservers();
    }
  },
  mark() {
    return seqCounter;
  },
  since(seq) {
    const rows = readOrdered();
    const out: DeckTraceEvent[] = [];
    for (const e of rows) {
      if (e.seq > seq) out.push(e);
    }
    return out;
  },
  clear() {
    buffer.length = 0;
    head = 0;
    full = false;
  },
  census(seq) {
    const out: MotionCensus = {
      notifies: 0,
      byCaller: {},
      arms: 0,
      armsUnarmed: 0,
      landingDisagreements: 0,
      notifiesUnobserved: 0,
      armOutcomes: { carried: 0, unarmed: 0, declined: 0, unchanged: 0 },
      retargets: { snap: 0, matched: 0 },
    };
    // One notify provokes at most one arm, and the arm records synchronously
    // inside it, so a notify with no arm before the next one is a notify the
    // subscriber never observed. Counted by carrying the open notify forward
    // rather than by pairing after the fact, which would have to guess at
    // interleavings the ring already puts in order.
    let pendingNotify = false;
    for (const e of this.since(seq)) {
      if (e.kind === "store-notify") {
        if (pendingNotify) out.notifiesUnobserved += 1;
        pendingNotify = true;
        out.notifies += 1;
        out.byCaller[e.caller] = (out.byCaller[e.caller] ?? 0) + 1;
      } else if (e.kind === "settle-arm") {
        pendingNotify = false;
        out.armOutcomes[e.outcome] += 1;
        if (e.outcome === "carried" || e.outcome === "unarmed") {
          out.arms += 1;
          if (!e.armed) out.armsUnarmed += 1;
        }
        if (
          (e.landing === "cut" && e.outcome !== "declined" && e.outcome !== "unchanged") ||
          (e.landing === "cross" && e.outcome === "declined")
        ) {
          out.landingDisagreements += 1;
        }
      } else if (e.kind === "settle-retarget") {
        out.retargets[e.mode] += 1;
      }
    }
    if (pendingNotify) out.notifiesUnobserved += 1;
    return out;
  },
};

// ---------------------------------------------------------------------------
// Observers — destination-flip + document-level focusin/focusout
// ---------------------------------------------------------------------------
//
// The observers attach on `enable(true)` and detach on `enable(false)` so
// traces reflect real user-driven transitions without the instrumentation
// incurring cost when disabled. Both observers are idempotent and safe to
// invoke repeatedly.
//
// **Destination-flip observer.** Subscribes to the deck store and, on
// every notify, diffs `isFocusDestination(cardId)` per known card against
// the previous reading. Flipped cards emit one `destination-flip` event
// each. The per-card prior-state map is reset to the store's current
// readings on install so the first post-install notify does not emit a
// flood of spurious transitions.
//
// **Focusin / focusout observer.** Document-level capture-phase listeners
// record external focus moves (including those WebKit drives back after
// the deck's own focus() call), so a reader of `dumpTable()` can see
// every time the browser committed a focus change — not just the ones
// our own code authored.

/**
 * Module-scope state for the destination-flip observer. `null` when not
 * installed; populated with the store-unsubscribe handle and the
 * previous-readings map while installed.
 */
let destinationFlipDispose: (() => void) | null = null;

/**
 * Module-scope state for the focus-capture observer. `null` when not
 * installed; populated with a disposer that removes both document-level
 * listeners while installed.
 */
let focusObserverDispose: (() => void) | null = null;

/**
 * Build the per-card focus-destination readings from the current deck
 * store snapshot. Used as the baseline on observer install so that the
 * first post-install notify does not emit `destination-flip` events for
 * every card (they've all been "flipped from unknown to their current
 * value" in the eyes of a fresh diff map).
 */
function snapshotDestinations(): Map<string, boolean> {
  const readings = new Map<string, boolean>();
  const store = getDeckStore();
  if (!store) return readings;
  const state = store.getSnapshot();
  for (const card of state.cards) {
    readings.set(card.id, isFocusDestination(card.id, state));
  }
  return readings;
}

function installDestinationFlipObserver(): void {
  if (destinationFlipDispose !== null) return;
  const store = getDeckStore();
  if (!store) return;
  const prevReadings = snapshotDestinations();
  const unsubscribe = store.subscribe(() => {
    const state = store.getSnapshot();
    // Include every card currently in the deck, plus any card we had
    // been tracking that has since been removed (so a removed card's
    // last true-reading flips to false exactly once).
    const seen = new Set<string>();
    for (const card of state.cards) {
      seen.add(card.id);
      const now = isFocusDestination(card.id, state);
      const prev = prevReadings.get(card.id) ?? false;
      if (prev !== now) {
        deckTrace.record({
          kind: "destination-flip",
          cardId: card.id,
          from: prev,
          to: now,
        });
        prevReadings.set(card.id, now);
      } else if (!prevReadings.has(card.id)) {
        prevReadings.set(card.id, now);
      }
    }
    for (const [cardId, prev] of prevReadings) {
      if (seen.has(cardId)) continue;
      if (prev) {
        deckTrace.record({
          kind: "destination-flip",
          cardId,
          from: true,
          to: false,
        });
      }
      prevReadings.delete(cardId);
    }
  });
  destinationFlipDispose = () => {
    unsubscribe();
    prevReadings.clear();
  };
}

function installFocusObserver(): void {
  if (focusObserverDispose !== null) return;
  if (typeof document === "undefined") return;
  const handleFocusIn = (ev: FocusEvent): void => {
    deckTrace.record({
      kind: "focusin",
      el: formatElement(ev.target ?? null),
      relatedTarget:
        ev.relatedTarget !== null ? formatElement(ev.relatedTarget) : null,
    });
  };
  const handleFocusOut = (ev: FocusEvent): void => {
    deckTrace.record({
      kind: "focusout",
      el: formatElement(ev.target ?? null),
      relatedTarget:
        ev.relatedTarget !== null ? formatElement(ev.relatedTarget) : null,
    });
  };
  document.addEventListener("focusin", handleFocusIn, { capture: true });
  document.addEventListener("focusout", handleFocusOut, { capture: true });
  focusObserverDispose = () => {
    document.removeEventListener("focusin", handleFocusIn, { capture: true });
    document.removeEventListener("focusout", handleFocusOut, { capture: true });
  };
}

function installObservers(): void {
  installDestinationFlipObserver();
  installFocusObserver();
}

function uninstallObservers(): void {
  destinationFlipDispose?.();
  destinationFlipDispose = null;
  focusObserverDispose?.();
  focusObserverDispose = null;
}

// ---------------------------------------------------------------------------
// `window.__deckTrace` binding
// ---------------------------------------------------------------------------

/**
 * Global `window.__deckTrace` handle for ad-hoc reproduction from
 * the Safari Web Inspector console. Typed via `declare global` so
 * the assignment does not need to route through `Record<string,
 * unknown>`.
 */
declare global {
  interface Window {
    __deckTrace?: DeckTrace;
  }
}

// Bound in release builds too, not just under `import.meta.env.DEV`.
// The always-recorded kinds put real defect evidence in the ring on
// every build, and a handle that only exists in dev makes that
// evidence unreachable in exactly the sessions that carry it — a
// release instance found stranded hours later is the case the ring
// was added for. The binding is one property assignment; the ring
// itself is allocated either way.
if (typeof window !== "undefined") {
  window.__deckTrace = deckTrace;
}
