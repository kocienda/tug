/**
 * test-surface.ts -- In-app test harness surface (`window.__tug`).
 *
 * Scope of this module
 * --------------------
 * Exports {@link TugTestSurface} — the TypeScript interface the Swift
 * bridge talks to via `evaluateJavaScript` — and
 * {@link createTugTestSurface}, which binds that interface to a live
 * {@link DeckManager} instance. Also contains the `__tugTestMode`
 * guarded attach that installs `window.__tug` from `main.tsx`.
 *
 * Authoritative references
 * ------------------------
 * - [D01]: per-test isolation via granular `reset`.
 * - [D03]: DEBUG-only / release-safe.
 * - [D11]: surface is versioned; harness handshakes.
 *
 * DEV/test-mode gating
 * --------------------
 * The `window.__tug` global is attached only when
 * `import.meta.env.DEV && window.__tugTestMode === true`. The
 * attach site lives in {@link attachTugTestSurface} so `main.tsx`'s
 * boot path stays readable. Release builds never reach the attach
 * path (Vite strips the `if (import.meta.env.DEV && ...)` branch) and
 * production dev builds never reach it either unless the Swift host
 * injects the `__tugTestMode` flag via a DEBUG-only `WKUserScript`
 * ([D03]/[D08]).
 *
 * Versioning
 * ----------
 * {@link SURFACE_VERSION} is a semver string literal baked into the
 * surface. The harness reads it during the handshake ([D11]) and
 * rejects connections whose major version doesn't match. Bump the
 * major on breaking changes, the minor on additive changes, and
 * coordinate with the in-app harness when the wire shape changes.
 */

import type { DeckManager } from "./deck-manager";
import type { DeckState, CardStateBag } from "./layout-tree";
import { DEFAULT_SIDEBAR_SIDE } from "./lib/layout-imposer";
import { deckTrace, type DeckTraceEvent } from "./deck-trace";
import { labFlags } from "./lib/lab-flags";
import { listViewProbeForScroller } from "./components/tugways/tug-list-view";
import { smartScrollForElement } from "./lib/smart-scroll";
import { getDeckStore } from "./lib/deck-store-registry";
import { transferFocusForActivation } from "./focus-transfer";
import { getFocusManager } from "./components/tugways/focus-manager";
import { currentGesture } from "./gesture-interpreter";
import {
  _ingestOverviewFrameForTest,
  _ingestOverviewPageForTest,
  getOverviewStore,
} from "./lib/overview-store";
import { _ingestPulseFrameForTest, getPulseStore } from "./lib/pulse-store";
import {
  ACTIVITY_DESCRIPTORS,
  getSessionActivityStore,
  type ActivityChannel,
} from "./lib/session-activity-store";
import { peekSparklineTape } from "./components/tugways/tug-sparkline";
import { textMeasurer, whenFaceLoaded } from "./lib/font-metrics";
import type { SparklineTapeDebugState } from "./lib/sparkline-tape";
import { nodeToPath, selectionGuard } from "./components/tugways/selection-guard";
import {
  cardSessionBindingStore,
  type CardSessionMode,
} from "./lib/card-session-binding-store";
import { cardServicesStore } from "./lib/card-services-store";
import { getConnection } from "./lib/connection-singleton";
import { sendSpawnSession } from "./lib/session-lifecycle";
import type { AtomSegment } from "./lib/tug-atom-img";
import { dispatchAction, getResponderChainManager } from "./action-dispatch";
import { writeSessionAtomToClipboard } from "./lib/session-atom";
import { resolveSessionIdentity } from "./lib/session-identity";
import { readClipboardViaNative } from "./lib/tug-native-clipboard";
import { parseClipboardSidecar } from "./components/tugways/tug-text-editor/clipboard-filters";
import type { ListOverviewPostsOk, RateLimitInfo } from "./protocol";
import { getTugbankClient } from "./lib/tugbank-singleton";
import { cutDetector } from "./lib/cut-detector";
import { lensSelectionStore } from "./components/lens/lens-selection-store";
import type { TaggedValue } from "./lib/tugbank-client";
import type {
  LiveTurnPerf,
  ReplayIngestPerf,
} from "./lib/code-session-store";
import {
  snapshotRowParseCounters,
  type RowParseCountersSnapshot,
} from "./lib/markdown/parse-counters";
import {
  annotateCounters,
  type AnnotateCountersSnapshot,
} from "./lib/annotator/annotate-counters";

// ---------------------------------------------------------------------------
// Public types (`TugTestSurface`)
// ---------------------------------------------------------------------------

/**
 * The `window.__tug` surface version. Bumped on breaking changes; the
 * Phase 2 harness handshake (see [D11]) asserts compatibility before
 * issuing any other RPC.
 *
 * Matched on major. Minor bumps denote additive fields only.
 *
 * `1.1.0` (harness extensions, 2026-04-24): adds the introspection
 * family — {@link TugTestSurface.getElementText},
 * {@link TugTestSurface.getElementValue},
 * {@link TugTestSurface.getElementAttribute},
 * {@link TugTestSurface.getElementBounds},
 * {@link TugTestSurface.getElementState},
 * {@link TugTestSurface.getActiveElement},
 * {@link TugTestSurface.getSelection},
 * {@link TugTestSurface.getComputedStyleValue}. The native-gesture
 * and keyboard-control families live out-of-band on the RPC bridge
 * (see `tugapp/Sources/TestHarness/NativeEventHandlers.swift`) — JS
 * cannot post `CGEvent`s, so there is nothing for `__tug` to expose
 * for those verbs. Major stays `1`; additive.
 *
 * `1.2.0`: adds EM-card
 * observation surface — {@link TugTestSurface.getEmCardState} and
 * {@link TugTestSurface.awaitEngineReady}. `getEngineSelection` and
 * `drainTugcodeTurn` are not separate surface entry points: the former is
 * subsumed by `getEmCardState().engineSelection`, the latter
 * requires tugcast-bypass plumbing not yet in place. Tugcode
 * lifecycle delegates (`startTugcode` / `stopTugcode` / etc.)
 * live as RPC verbs on the App handle in `_harness/index.ts`,
 * not on `__tug.*` — page-side delegates would be a layering
 * violation (only Swift can spawn subprocesses). Major stays `1`;
 * additive.
 *
 * `1.3.0`: adds
 * {@link TugTestSurface.getCardStateBag} (full bag introspection
 * for [AT0017] saveState-RPC-parity) and {@link TugTestSurface.closePane}
 * (whole-pane teardown for [AT0019] flush coverage). Markdown content
 * fixtures for [AT0014] / [AT0023] ride through a separate
 * `fixture-markdown-50kb` card registration that bakes 50KB of
 * static content on mount — no test-specific surface needed.
 * Additive; major stays `1`.
 *
 * `1.4.0`: adds
 * {@link TugTestSurface.appReload} and
 * {@link TugTestSurface.getReadyGen}. `appReload` invokes the
 * same `dispatchAction({ action: "reload" })` path the
 * `Maker > Reload` menu fires — `prepareForReload` →
 * synchronous flush → `location.reload()`. `getReadyGen` returns
 * a generation counter that {@link attachTugTestSurface}
 * increments at every page boot, persisted across reloads via
 * `sessionStorage`. The bun-side `app.appReload()` records the
 * pre-reload value, fires `appReload`, and polls `getReadyGen`
 * until it advances — that's the "the new page is up" signal,
 * tolerant of mid-navigation `evaluateJavaScript` errors.
 * Additive; major stays `1`.
 *
 * `1.7.0`: adds {@link TugTestSurface.ingestRateLimit} — drives the
 * app-level, account-global rate-limit store so the banner app-test
 * ([#step-3.5]) can mount / clear the deck-wide banner without a live
 * claude limit. Additive; major stays `1`.
 *
 * `1.8.0`: adds {@link TugTestSurface.ingestSessionMetadata} — drives a dev
 * card's `SessionMetadataStore` with a decoded `session_capabilities` /
 * `system_metadata` payload, so the Z4B effort-chip app-test ([#step-4]) can
 * mount the chip and exercise its model gate without a live claude handshake.
 * The chip reads its own `SESSION_SIDEBAND` FeedStore, which the
 * `driveSession`/`ingestFrame` (CodeSessionStore) path does not reach.
 * Additive; major stays `1`.
 *
 * `1.10.0`: adds `ingestGitDiff` — drives a session card's `GitDiffStore` with
 * a decoded `git_diff_response` payload, so the `/diff` sheet app-test
 * ([#step-10b]) can render the per-file accordion without a live tugcast git
 * round-trip (which [#step-10a]'s subprocess test proves). Additive; major
 * stays `1`. **Removed in `2.0.0`.**
 *
 * `1.12.0`: adds {@link TugTestSurface.getSessionPerf} — reads a bound dev
 * card's perf instrumentation (replay-ingest / live-turn commit counters +
 * row-parse counters) so the resume-performance baseline and budget
 * app-tests assert internal splits without scraping the log stream.
 * Additive; major stays `1`.
 *
 * `1.14.0`: adds {@link TugTestSurface.ingestSideQuestionAnswer} — settles a
 * session card's `SideQuestionStore` with a decoded `side_question_answer`
 * payload, so the `/btw` overlay app-test can render an answer (and assert the
 * transcript stays clean) without a live claude round-trip. Additive; major
 * stays `1`.
 *
 * `1.15.0`: adds {@link TugTestSurface.reprojectFocus} — asks the focus engine
 * to reproject its DOM marks from current state, so a test can prove the marks
 * are a convergent image of that state (reproject, diff, expect no change)
 * rather than a residue of the transitions that wrote them. Additive; major
 * stays `1`.
 *
 * `1.17.0`: adds {@link TugTestSurface.publishPulseFrame} — delivers a PULSE
 * frame body as if it arrived over the wire, so a test can put a beat on
 * screen without a live commentator behind it.
 *
 * `1.16.0`: adds {@link TugTestSurface.currentGesture} — the live pointer
 * gesture's classification record, so a test can assert what the interpreter
 * decided (activation, promotion, placement, the named reasons) rather than
 * only the downstream effects. Additive; major stays `1`.
 *
 * `1.18.0`: adds {@link TugTestSurface.setTranscriptEvictionDisabled} — the
 * tile-ledger cell's A/B arm (scrolling-memory-diet §G2): renders session
 * transcripts with `evictOffscreen` withheld so the lab can compare graphics
 * backing store between the evicted and full-inline DOM at identical layer
 * height. Additive; major stays `1`.
 *
 * `1.19.0`: adds {@link TugTestSurface.activateCard} — the raise gesture as
 * a surface verb (mirrors `closePane`), for the pane-occlusion cell
 * ([AT0332]): a fully-buried pane cannot be reached by a click, so the test
 * raises it the way a Lens Cards row does, through
 * `DeckManager.activateCard`. Additive; major stays `1`.
 *
 * `1.20.0`: adds {@link TugTestSurface.getScrollDisplacementCount} and
 * {@link TugTestSurface.forceCommitClamp} — the displacement bracket's two
 * seams. The reader returns the count as a number rather than by scraping
 * `data-scroll-displacements`; the clamp simulator reproduces a real
 * commit-scoped browser clamp from *inside* a React commit, which `evalJS`
 * cannot reach from outside. Both resolve the scroller by its
 * `data-tug-scroll-key` selector. Additive; major stays `1`.
 *
 * `1.21.0`: adds {@link TugTestSurface.setTranscriptFollowBottom} — forces a
 * scroller's follow-bottom flag through the scroller registry. The
 * disengaged-at-the-bottom state cannot be reached by `scrollTop` assignment
 * (a downward assignment into the band re-engages before the test can assert),
 * and that state is precisely the one the field reports describe. Additive;
 * major stays `1`.
 *
 * `1.22.0`: adds {@link TugTestSurface.getListConservation} — the eviction
 * height-accounting probe. Returns the per-eviction ledger-vs-live records
 * accumulated since mount plus a same-moment audit of every mounted cell, so
 * a test can measure the document height error a window swap introduced
 * rather than inferring it from `scrollTop` symptoms. Additive; major
 * stays `1`.
 *
 * `1.23.0`: {@link TugTestSurface.getListConservation} additionally returns
 * `floor` — the extent floor's current height and calibrated bottom inset,
 * so a test can assert the floor is standing (height tracks the settled
 * extent) rather than inferring its presence from the absence of
 * displacements. Additive; major stays `1`.
 *
 * `1.24.0`: the displacement bracket is an assertion layer. A clamp armed
 * through {@link TugTestSurface.forceCommitClamp} is witnessed — counted,
 * traced, attributed via `noteExternalWrite` — and the position is left
 * where the browser put it; nothing counter-writes it back. The
 * `scroll-displacement` trace event loses its `repaired` and
 * `priorRepairHeld` fields with the machinery. Behavioral; major stays `1`
 * because every surface method keeps its signature.
 *
 * `1.25.0`: {@link TugTestSurface.deleteTugbankValue} — the deletion half of
 * `setTugbankValue`, for the domains where a key's absence is the meaningful
 * state (a keymap override reset is a `DELETE`). Additive; major stays `1`.
 *
 * `2.0.0`: REMOVES `ingestGitDiff` and the per-card `GitDiffStore` behind it.
 * The `/diff` sheet it was built for is gone (`/diff` opens the Project Diff
 * card), and every remaining diff surface sources its own store off the shared
 * unfiltered feed in `changeset-diff-store` — so the card-scoped store had no
 * reader left and its GIT_DIFF feed subscription was waking per card for
 * nothing. A removal is breaking by the rule above, hence the major; no
 * consumer gates on this constant, and the harness's own surface version
 * (`_harness/index.ts`) is a separate number that does not move.
 *
 * `2.1.0`: adds {@link TugTestSurface.publishOverviewPost} — delivers a OVERVIEW
 * frame body as if it arrived over the wire, so a test can put a Observer post
 * with its refs on the card without a live Observer behind it. Additive; major
 * stays `2`.
 *
 * `2.2.0`: adds {@link TugTestSurface.recordActivity} — records units on a
 * session's activity channel through the real `SessionActivityStore`, so a test
 * can drive a live sparkline tape deterministically instead of waiting on a
 * real stream. Additive; major stays `2`.
 *
 * `2.3.0`: adds {@link TugTestSurface.getPaneRecord} — a pane's STORED
 * position, size, slot, and width stamp, so a test can assert what a derived
 * presentation did NOT write. Additive; major stays `2`.
 *
 * `2.4.0`: adds {@link TugTestSurface.publishSessionUpdated} — delivers a
 * `session_updated` ledger row through the real action dispatch, so a test can
 * rename a session the way the wire does and watch every identity surface
 * repaint. Additive; major stays `2`.
 *
 * `2.5.0`: adds {@link TugTestSurface.copySessionAtom} — writes a session atom
 * to the real pasteboard through the production writer, so a test can assert
 * the flavors and the paste round-trip without driving a context menu.
 * Additive; major stays `2`.
 *
 * `2.6.0`: adds {@link TugTestSurface.measureFaceAdvance} — the advance of a
 * string in the face an element actually renders in, through the production
 * `font-metrics` pair, so a width constant derived from a type size can be
 * pinned against the real render instead of against a fallback. Additive;
 * major stays `2`.
 *
 * `2.7.0`: adds {@link TugTestSurface.publishOverviewPostsPage} — hands a
 * `list_overview_posts_ok` body to the production CONTROL-response bus, the
 * page sibling of `publishOverviewPost`'s feed frame. It exists because
 * `publishOverviewPost` cannot reach paging at all: it routes to the client
 * store's fold and never touches the wire, so nothing it publishes is ever
 * persisted and no amount of it seeds a ledger to page through. This enters
 * the production chain one function later than a wire response does, and
 * drives the real correlation, dedupe, prepend, and scroll compensation.
 * Additive; major stays `2`.
 *
 * `2.8.0`: adds {@link TugTestSurface.getTugbankValue} — the read counterpart
 * to `setTugbankValue`. A card's per-card view settings resolve from the deck
 * defaults until the first change and are card-local afterwards, and the two
 * states look identical on screen; only the store says which one is in force.
 * Additive; major stays `2`.
 *
 * `2.9.0`: adds the cut-detector trio — {@link TugTestSurface.armCutDetector},
 * {@link TugTestSurface.disarmCutDetector}, and
 * {@link TugTestSurface.takeCutRecords}. The deck promises every layout change
 * travels rather than jumps; armed, the detector samples each imposed frame per
 * animation frame and records any that changed geometry with nothing animating
 * it, which is the only way a test can hold the deck to that promise across a
 * whole gesture rather than at two sampled instants. Additive; major stays `2`.
 *
 * `2.10.0`: adds {@link TugTestSurface.setLayoutSelection} and
 * {@link TugTestSurface.getLayoutSelection}. The layout selection is what the
 * deck's slot and width verbs act on, and it is built by pointer gestures with
 * modifiers held in a rail's list — reproducible, but a long way from the
 * behavior under test when what is under test is the VERB. These two write and
 * read the set directly so a chord can be driven against a known selection.
 * Additive; major stays `2`.
 *
 * `2.11.0`: adds {@link TugTestSurface.probeBatchGesture}. The gesture
 * transaction is a store-layer contract — nested batches join the outer one,
 * a throw still fires the pending notify, a batch that mutates nothing
 * notifies nobody — and `DeckManager` is browser-coupled (window timers,
 * tugbank, lifecycle), so no unit test constructs one to check that. The probe
 * drives the live store and hands back the subscriber-call count, which is the
 * only place those semantics can be asserted against the real object.
 * Additive; major stays `2`.
 */
export const SURFACE_VERSION = "2.12.0" as const;

/**
 * `sessionStorage` key for the cross-reload generation counter.
 * `attachTugTestSurface` increments it on every page boot. The bun
 * harness's `app.appReload()` records the pre-reload value and
 * polls until it advances; that's the deterministic "the new page
 * has booted and `__tug` is ready again" signal. Survives
 * `location.reload()` because `sessionStorage` is per-tab/origin
 * and not cleared by reload (only by tab close), so the new page
 * sees the previous value and increments past it.
 */
const READY_GEN_STORAGE_KEY = "__tugReadyGen";

/**
 * `sessionStorage` key for the cross-reload deck-trace enable flag.
 * `enableDeckTrace` writes it; `attachTugTestSurface` reads it on
 * every page boot and re-applies `deckTrace.enable(true)` so a
 * harness `app.appReload()` resumes recording without the test
 * having to re-enable the trace on the reloaded page. Same
 * per-tab/origin survival semantics as {@link READY_GEN_STORAGE_KEY}.
 */
const DECK_TRACE_ENABLED_STORAGE_KEY = "__tugDeckTraceEnabled";

/**
 * Snapshot of the caret / selection for a single card, as returned by
 * {@link TugTestSurface.getCaretState}. Two variants cover the axes we
 * care about:
 *
 *   - `input` — the active element is a `<input>` / `<textarea>` with
 *     `data-tug-state-key`, and the snapshot carries the control's
 *     own `selectionStart` / `selectionEnd` / `selectionDirection` plus
 *     `value`.
 *   - `range` — the live DOM Range for the card, as published by the
 *     card's component to `selectionGuard`, serialized as
 *     `anchorPath`/`focusPath` rooted at the registered card-host
 *     element (same path shape as
 *     {@link import("./layout-tree").DomSelectionSnapshot}) and the
 *     Range's plain-text content.
 *
 * `null` means we could not classify the current focus/selection
 * inside the card.
 */
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

/**
 * Options for {@link TugTestSurface.click}. Coordinates are optional
 * (defaults to the target element's bounding-rect center). Modifiers
 * are threaded through to every synthesized pointer/mouse event so
 * handlers that condition on Meta/Shift see a consistent bit.
 */
export interface ClickOptions {
  clientX?: number;
  clientY?: number;
  metaKey?: boolean;
  shiftKey?: boolean;
}

/**
 * Per-axis reset options. Every axis defaults to false — callers opt in
 * exactly the axes a test case needs ([D01]).
 */
export interface ResetOptions {
  /** Clear DeckState back to empty (one empty pane, no cards). */
  deck?: boolean;
  /** Clear registered selection boundaries + pinned card Ranges. */
  selectionGuard?: boolean;
  /** Drop per-card Component State Preservation Protocol registries. */
  orchestrator?: boolean;
  /** `deckTrace.clear()` — preserves the enable flag. */
  trace?: boolean;
  /** Wipe `localStorage` (and any scoped IndexedDB stores the deck owns). */
  storage?: boolean;
}

/**
 * Arguments for {@link TugTestSurface.seedDeckState}. Mirrors the
 * `DeckManager.seedDeckState` contract: atomic state replace, optional
 * card-state-bag merge, optional cold-boot focus restore.
 */
export interface SeedDeckStateArgs {
  state: DeckState;
  cardStates?: Record<string, CardStateBag>;
  focusCardId?: string;
}

/**
 * One step in driving a bound session card's `CodeSessionStore` through
 * the lifecycle matrix — consumed by {@link TugTestSurface.driveSession}.
 *
 *  - `send` — submit a user message (`store.send`); a mid-turn `send`
 *    queues, exactly as the prompt-entry does.
 *  - `ingestFrame` — feed a decoded wire frame into the store as if it
 *    arrived off the connection (`feedId` is a `FeedId` value;
 *    `decoded` carries a matching `tug_session_id`). Drives
 *    STREAMING / TOOL_WORK / AWAITING_USER / COMPLETE / ERRORED /
 *    REPLAYING.
 *  - `interrupt` — `store.interrupt()`.
 *  - `transportClose` / `transportReconnect` — drive the transport
 *    overlay without touching the real shared connection.
 *  - `loadPrevious` — `store.loadPrevious(amount)`; pages older turns above
 *    the loaded window (the response replay bracket is then injected via
 *    `ingestFrame`). Exercises backward paging and the prepend path.
 *  - `shellExchange` — settle a completed `$`-route exchange row
 *    (`store.ingestShellExchange` with `phase: "complete"`). The shell feed
 *    is a different store from the one `ingestFrame` reaches, so a shell row
 *    — and the command blocks that claim one, like the `/commit` receipt —
 *    is otherwise only reachable by executing a real command.
 */
export type SessionDriveAction =
  | { op: "send"; text: string; atoms?: AtomSegment[]; suppress?: boolean }
  | { op: "ingestFrame"; feedId: number; decoded: unknown }
  | { op: "interrupt" }
  | { op: "transportClose" }
  | { op: "transportReconnect" }
  | { op: "loadPrevious"; amount: number | "all" }
  | {
      op: "shellExchange";
      exchangeId: string;
      command: string;
      output: string;
      cwd: string;
      exitCode?: number;
      startedAtMs?: number;
    };

/**
 * Viewport-relative DOMRect shape returned by
 * {@link TugTestSurface.getElementBounds}. Flat POD so it survives
 * JSON transport over the `evalJS` bridge. `{x, y}` is the top-left
 * corner in CSS viewport coords (Y-down). Callers that need SCREEN
 * coords (for naming a pixel to pass to `nativeClick`) read
 * `app.getElementScreenBounds(selector)` on the harness side — that
 * hop goes through Swift's `CoordMapping` and is not derivable from
 * these viewport values alone.
 */
export interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Compact bundle of per-element state flags returned by
 * {@link TugTestSurface.getElementState}. The field set covers the
 * state surfaces tests actually branch on: enabled/disabled,
 * read-only, checked, visible (layout-bounds + `offsetParent`), plus
 * the tag name and focus bit.
 *
 * `visible` is a layout-probed boolean — an element with zero width or
 * height, or a detached `offsetParent`, is considered not visible. It
 * does NOT check `visibility: hidden` / `opacity: 0` / CSS-clipped
 * ancestors; callers that need finer-grained paint assertions use
 * {@link TugTestSurface.getComputedStyleValue}.
 */
export interface ElementStateSnapshot {
  tagName: string;
  disabled: boolean;
  readOnly: boolean;
  checked: boolean;
  visible: boolean;
  isFocused: boolean;
}

/**
 * Description of `document.activeElement` returned by
 * {@link TugTestSurface.getActiveElement}. `null` when the body is the
 * active element (no explicit focus).
 *
 * `cardId` is the nearest ancestor's `data-card-id`; `componentStatePreservationKey` is
 * the element's own `data-tug-state-key`. Both default to `null`
 * when absent. `selector` is a best-effort locator ("#id" if the
 * element has an id, else "tag[data-card-id=...]" when inside a card)
 * — useful for logging but NOT intended as a round-trip selector that
 * the harness re-uses.
 */
export interface ActiveElementInfo {
  tagName: string;
  id: string | null;
  cardId: string | null;
  componentStatePreservationKey: string | null;
  selector: string;
}

/**
 * Snapshot of an engine-managed (EM) card's state, as returned by
 * {@link TugTestSurface.getEmCardState}. EM cards are factories
 * whose `useCardStatePreservation`'s `onSave` returns a structured
 * engine state object (text, selection, atoms — see
 * `lib/tug-text-engine.ts::TugTextEditingState`). The framework
 * stashes that object as `bag.content`; this surface method
 * reads it back and tags it with the card's `componentId` so
 * tests can branch on engine flavor.
 *
 * `streamState` and `lastTurnSeq` are stub fields while the
 * harness's tugcode is not wired into tugdeck's production AI session
 * path, so no streaming activity is observable from this surface
 * today. The fields are present so test code can pin against them
 * now without rewriting when a later integration adds the real
 * values.
 */
export interface EmCardState {
  kind: "em";
  /**
   * The card's `componentId` — e.g. `"gallery-prompt-input"`,
   * `"gallery-prompt-entry"`, `"session-card"`. Tagged so tests can
   * branch on engine flavor without consulting deck state
   * separately.
   */
  engine: string;
  /**
   * Plain-text content of the engine's current document. Read
   * from `bag.content.text` (the engine's `captureState()` shape
   * for TugTextEngine). Empty string when the engine has no
   * `text` field captured.
   */
  text: string;
  /**
   * Engine-specific selection snapshot, as captured by
   * `engine.captureState().selection`. Shape varies by engine —
   * the surface does not normalize. `null` when no selection.
   */
  engineSelection: unknown;
  /**
   * Streaming status. Stub (always `"idle"`) until real tugcode
   * integration is wired.
   */
  streamState: "idle" | "streaming" | "error";
  /**
   * Last completed turn sequence number. Stub (always `0`) until
   * wired to the session pipeline.
   */
  lastTurnSeq: number;
}

/**
 * Selection snapshot returned by {@link TugTestSurface.getSelection}.
 * Superset of {@link CaretState} — covers the page-wide `Selection`
 * object (contentEditable, arbitrary spans) in addition to form
 * controls. `null` when no selection is active.
 *
 * `kind` discriminates:
 *   - `"input"` — the focused element is a form control and the
 *     selection is its `selectionStart`/`End` range.
 *   - `"range"` — there is a live `Selection` with at least one
 *     range; we serialize the first range's text + collapsed flag.
 *     `cardId` is populated if the range's start node sits inside a
 *     `[data-card-id]` subtree.
 */
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

/**
 * `window.__tug` — the in-app test harness surface. Every method is
 * synchronous or returns a JSON-serializable value so the Swift-side
 * `evalJS` round-trip never has to marshal custom types.
 *
 * Additive changes bump {@link SURFACE_VERSION}'s minor; breaking
 * changes bump the major and need coordinated app + harness updates.
 */
export interface TugTestSurface {
  readonly version: typeof SURFACE_VERSION;

  // ---- State seeding ----
  seedDeckState(args: SeedDeckStateArgs): void;

  /**
   * Set a tugbank value locally and notify subscribers (SURFACE_VERSION
   * 1.11.0). Drives `useTugbankValue` consumers in-process — no tugcast / disk
   * round-trip — so a test can populate state the picker reads, e.g. the
   * `dev.tugtool.dev / recent-projects` list to exercise the session picker's
   * Recents list as a keyboard cycle stop. No-op (dev-warn) if the tugbank
   * client singleton is not yet installed.
   */
  setTugbankValue(domain: string, key: string, value: TaggedValue): void;

  /**
   * Delete a tugbank key locally and notify subscribers — the counterpart to
   * {@link setTugbankValue}, for the domains where a key's *absence* carries
   * meaning. `dev.tugtool.keymap` is the case: an override reset is a
   * deletion, so a test that could only write values could never drive one.
   */
  deleteTugbankValue(domain: string, key: string): void;

  /**
   * Read a tugbank value out of the client cache (SURFACE_VERSION 2.8.0), or
   * `null` when the key is unset. The read counterpart to
   * {@link setTugbankValue}: a test that drives a card's own settings needs to
   * assert what the card PERSISTED, and reading the store is the only way to
   * tell "the card owns these now" from "the card is still following the deck
   * defaults" — the two look identical on screen.
   */
  getTugbankValue(domain: string, key: string): TaggedValue | null;

  // ---- Granular reset ([D01]) ----
  reset(opts: ResetOptions): void;

  // ---- Gesture drivers (synthetic DOM event sequences) ----
  click(selector: string, opts?: ClickOptions): void;
  type(selector: string, text: string): void;
  focusElement(selector: string): void;

  // ---- State reads ----
  /**
   * The STORED geometry record of a pane (SURFACE_VERSION 2.3.0), or `null`
   * when no pane holds that id.
   *
   * Deliberately the store's values rather than the painted frame's: a
   * derived pane — imposed, pinned, or standing in bullseye — is painted
   * somewhere the store never said, and the whole point of reading here is to
   * assert what the store was NOT asked to change. A test that wants the
   * frame measures `getBoundingClientRect()` instead.
   */
  getPaneRecord(paneId: string): {
    position: { x: number; y: number };
    size: { width: number; height: number };
    slot: number | null;
    widthPreset: string | null;
  } | null;
  getActiveCardId(): string | null;
  getFocusedCardId(): string | null;
  /**
   * Force the responder chain's first responder to `responderId`
   * (SURFACE_VERSION 1.9.0). The sanctioned `makeFirstResponder`
   * primitive, exposed for tests that must construct the documented
   * divergence between DOM focus and chain first responder — a state
   * pointerdown/focusin promotion cannot reach because both axes are
   * driven off the same DOM walk. The canonical case: a pane-modal
   * sheet holds chain first responder in one pane while the keyboard
   * caret sits in another pane's editor. No-op (and dev-warn) if
   * `responderId` is not a registered node. See `responder-chain.md`
   * §"Bringing DOM focus in sync with chain state".
   */
  setFirstResponder(responderId: string): void;

  /** The chain's current first responder id, or `null`. */
  getFirstResponderId(): string | null;
  getCaretState(cardId: string): CaretState | null;
  getFormControlValue(cardId: string, componentStatePreservationKey: string): string | null;
  assertHostRootRegistered(cardId: string): boolean;

  // ---- Trace access ----
  getDeckTrace(opts?: { since?: number }): readonly DeckTraceEvent[];
  markDeckTrace(): number;
  clearDeckTrace(): void;
  enableDeckTrace(flag: boolean): void;

  /**
   * Lab flag (SURFACE_VERSION 1.18.0): render session transcripts with
   * `evictOffscreen` withheld — the full inline DOM at full layer height.
   * The tile-ledger cell's A/B arm (scrolling-memory-diet §G2).
   */
  setTranscriptEvictionDisabled(disabled: boolean): void;

  /**
   * Displacements a list-view scroller has recorded since mount
   * (SURFACE_VERSION 1.20.0) — `scrollTop` changes across a commit
   * that the machine could not account for. `selector` names the
   * scroll container, e.g.
   * `[data-tug-scroll-key="session-card-transcript"]`.
   *
   * Same number the `data-scroll-displacements` attribute carries;
   * this reads it as a number rather than by DOM scraping. Throws
   * when the selector does not resolve to a list-view scroller.
   */
  getScrollDisplacementCount(selector: string): number;

  /**
   * Arm a one-shot commit-scoped browser clamp on a list-view
   * scroller (SURFACE_VERSION 1.20.0).
   *
   * The extent floor makes a real commit-scoped clamp impossible by
   * construction, which leaves the assertion layer with no natural
   * trigger to test against — and `evalJS` runs outside any React
   * commit, so a test cannot reproduce one from outside. On the next
   * commit the list view takes the floor down, briefly shortens its
   * top spacer, and forces layout, so the browser clamps `scrollTop`
   * exactly as the original defect did, then restores both in the
   * same synchronous block. The witness faces the genuine article: a
   * real clamp, commit-scoped, machine-caused — and it records it
   * without counter-writing the position.
   *
   * Drive it from a position where a clamp is geometrically possible
   * — near the bottom of an evicting transcript with a large top
   * spacer, so the shrink actually lowers the scroll maximum below
   * `scrollTop`.
   */
  forceCommitClamp(selector: string): void;

  /**
   * Force a scroller's follow-bottom flag (SURFACE_VERSION 1.21.0).
   *
   * Required, not a convenience. The established way to reach a
   * scroll state in these tests is direct `scrollTop` assignment,
   * which is attribution-identical to the native scrollbar's pointer
   * silence. But the disengaged-at-the-bottom state cannot be built
   * that way: a *downward* assignment into the at-bottom band emits a
   * scroll event that satisfies `idle-reengage`, so follow-bottom
   * comes back on before the test can assert anything. The state
   * heals itself out from under any attempt to construct it.
   *
   * That state is exactly what the field reports describe — a user
   * parked at the live edge with follow-bottom off, for whom every
   * append silently fails to arrive — so it has to be reachable.
   */
  setTranscriptFollowBottom(selector: string, engaged: boolean): void;

  /**
   * The eviction height-accounting probe (SURFACE_VERSION 1.22.0).
   *
   * `events` is the per-eviction record list accumulated since mount:
   * for every commit where rows departed the rendered window into a
   * spacer, the sum the spacer charged for them (`sumLedger`) against
   * the extent they actually occupied while mounted (`sumLive`), with
   * `delta = sumLedger - sumLive` — negative means the document SHRANK
   * by that much at that swap. `audit` is a same-moment ledger-vs-live
   * comparison of every currently mounted cell.
   */
  getListConservation(selector: string): {
    events: unknown[];
    audit: unknown;
    ring: unknown[];
    floor: { height: number; inset: number };
  };

  // ---- Introspection (SURFACE_VERSION 1.1.0, harness Phase A) ----
  getElementText(selector: string): string;
  getElementValue(selector: string): string;
  getElementAttribute(selector: string, name: string): string | null;
  getElementBounds(selector: string): ElementBounds;
  getElementState(selector: string): ElementStateSnapshot;
  getActiveElement(): ActiveElementInfo | null;
  getSelection(cardId?: string): SelectionSnapshot | null;
  getComputedStyleValue(selector: string, property: string): string;

  /**
   * The focus engine's watchdog report: `violations` counts genuine
   * incoherence (a granted surface gone — the engine lied), `reasserted`
   * counts route corrections, and `steals` is the attributed per-offender
   * ledger of raw focus writes the watchdog corrected. `null` when no
   * `FocusManager` is mounted. Tests assert `violations === 0` and steal
   * BUDGETS (the ledger stays flat across interactions where no raw focus
   * write should occur).
   */
  getFocusInvariantReport(): {
    violations: number;
    reasserted: number;
    steals: Record<string, number>;
    last: {
      ringed: string;
      active: string;
      keyCard: string | null;
      reason: string;
    } | null;
  } | null;

  /**
   * Ask the focus engine to reproject its DOM marks from current state.
   *
   * The projection is a pure derivation applied by a convergence pass, so
   * running it again from unchanged state must change nothing. That is the
   * property this exposes: a test can reproject and diff the marks, which is
   * how "the DOM is an image of engine state" is falsifiable rather than
   * merely asserted. No-op when no `FocusManager` is mounted.
   */
  reprojectFocus(): void;

  /**
   * The KBF **manual bit** — the one derivation input that is stored rather
   * than derived, and so the only one whose exits have to be written.
   *
   * The projected `data-kbf` attribute answers *is the mode painting* —
   * engagement with no caret granted — which is the user-visible fact and
   * what most assertions want. It cannot answer *why the mode is on*: inside
   * a trapped surface the mode is on from the trap whatever the bit says, so
   * a test that means to pin the bit's own lifecycle — set by ⌥⇥ inside a
   * sheet, cleared when the sheet is left — has to read it directly. `null`
   * when no `FocusManager` is mounted.
   */
  kbfManual(): boolean | null;

  /**
   * The KBF **engagement truth** ({@link FocusManager.kbfEngaged}) — is the
   * mode on, whether or not it is painting. Diverges from the `data-kbf`
   * attribute exactly while a caret is granted inside an engaged mode (a
   * seeded sheet on open, a ⌘F grant, `Enter` at a parked stop): the mode
   * stays on, the paint stands down. An assertion about the mode's *state*
   * reads this; an assertion about what the user *sees* reads the attribute.
   * `null` when no `FocusManager` is mounted.
   */
  kbfEngaged(): boolean | null;

  /**
   * The live pointer gesture's classification, or `null` between gestures.
   *
   * One record per gesture, computed once at capture-phase pointerdown and read
   * by every consumer. Exposing it lets a test assert the decision itself —
   * that a click on bare canvas classified `deselect` while a click that merely
   * missed every pane classified `chrome` — instead of inferring it from what
   * happened afterward.
   */
  currentGesture(): {
    gestureId: number;
    button: number;
    site: string;
    paneId: string | null;
    cardId: string | null;
    activation: string;
    promotion: string;
    placement: string;
    preventMousedownDefault: boolean;
    reasons: string[];
  } | null;

  /**
   * Deliver a PULSE frame body as if it had arrived over the wire
   * (SURFACE_VERSION 1.17.0).
   *
   * `payloadJson` is the emitter's own shape —
   * `{"type":"pulse","text":…,"scopes":[…],"beat":N,"at":ms}`. The bytes go
   * through the production parser and fold, so this puts a real beat on the
   * strip without a live commentator.
   *
   * Returns `false` when no store is attached. A `true` return only means the
   * bytes were handed over: the parser drops a malformed body silently, so
   * assert on what rendered, never on this alone.
   */
  publishPulseFrame(payloadJson: string): boolean;

  /**
   * Deliver a OVERVIEW frame body as if it had arrived over the wire
   * (SURFACE_VERSION 2.1.0).
   *
   * `payloadJson` is the post the Observer or the Operator writes —
   * `{"id":…,"at_ms":…,"author":"observer"|"operator"|"user","body":…,"refs":[…]}`.
   * The bytes go through the production parser and the production fold, so what
   * the card renders is what a live author would have produced.
   *
   * Returns `false` when no store is attached or the JSON does not parse. A
   * `true` return only means the bytes were handed over: the frame parser drops
   * a malformed post silently, so assert on what rendered, never on this alone.
   */
  publishOverviewPost(payloadJson: string): boolean;

  /**
   * Deliver a `list_overview_posts_ok` response as if tugcast had broadcast it
   * (SURFACE_VERSION 2.7.0).
   *
   * `payloadJson` is the response body —
   * `{"posts":[…],"has_more":true,"before_id":123}`. A body with a
   * `before_id` is a PAGE and prepends; one without is a tail and replaces.
   * The bytes go through `publishListOverviewPostsOk`, the same bus
   * `action-dispatch` publishes a wire response on, so the store's branch,
   * its dedupe, and the card's prepend compensation are all the production
   * ones. A page body additionally arms the store's page correlation, the way
   * `loadOlder` does — without that a page is correctly dropped as nobody's,
   * and calling the real `loadOlder` instead would put a request on the wire
   * and race tugcast's own answer for it.
   *
   * The sibling of {@link TugTestSurface.publishOverviewPost}, and necessary
   * for the same reason it is insufficient: that verb routes to the client
   * store's fold and never reaches tugcast, so nothing it publishes is
   * persisted and no amount of it builds a ledger to page through.
   *
   * Returns `false` when the JSON does not parse or carries no `posts` array.
   */
  publishOverviewPostsPage(payloadJson: string): boolean;

  /**
   * Deliver a `session_updated` ledger row as if it had arrived over the wire
   * (SURFACE_VERSION 2.4.0).
   *
   * `payloadJson` is the frame body the supervisor pushes after any ledger
   * write — `{"session_id":…,"fields":{"name":…,"name_user_set":true,"tag":…}}`.
   * The bytes go through `dispatchAction`, which is the production entry point:
   * the real decoder, the real name / tag store writes, and the real
   * session-ledger bus. There is no fixture and no mock — a `/rename` reaches
   * the client on exactly this frame, so a test that publishes one is renaming
   * the session the way the user does.
   *
   * Returns `false` only when the JSON does not parse. A `true` return means
   * the bytes were handed over; the decoder drops a malformed row with a
   * console warning, so assert on what rendered, never on this alone.
   */
  publishSessionUpdated(payloadJson: string): boolean;

  /**
   * Write the session atom for `sessionId` to the system pasteboard
   * (SURFACE_VERSION 2.5.0).
   *
   * Drives `writeSessionAtomToClipboard` — the exact function the chip's
   * right-click Copy handler calls — so both flavors go out through the
   * production path: the citation as `text/plain` and the atom sidecar on the
   * private `dev.tug.prompt-atoms` type. Identity resolves through the bare
   * resolver, which is a snapshot, which is correct here: a clipboard write is
   * a one-shot non-React caller.
   *
   * This exists because the menu GESTURE is not reachable from the harness,
   * not because the write is hard to reach. Returns `false` when the native
   * pasteboard bridge is unavailable.
   */
  copySessionAtom(sessionId: string): boolean;

  /**
   * Read the atom sidecar back off the system pasteboard and parse it with the
   * production parser (SURFACE_VERSION 2.5.0), returning
   * `{text, atoms: [{type, label, value}]}` — or `null` when the pasteboard
   * carries no sidecar or it fails validation.
   *
   * This closes the copy round trip through the REAL pasteboard: the native
   * write put the sidecar on the private `dev.tug.prompt-atoms` type, and this
   * reads it back through `readClipboardViaNative` + `parseClipboardSidecar`,
   * the same two functions the editor's paste handler calls. It exists because
   * `pbpaste` cannot see a private pasteboard type, so a test otherwise has no
   * way to assert the flavor was written at all.
   */
  readClipboardAtoms(): Promise<{
    text: string;
    atoms: Array<{ type: string; label: string; value: string }>;
  } | null>;

  /**
   * Record activity units on a session's channel, exactly as a live `ACTIVITY`
   * frame would (SURFACE_VERSION 2.2.0).
   *
   * This drives the REAL `SessionActivityStore.record` — the same entry point
   * the wire uses — so everything downstream is production: the meters, their
   * binning, the dominant-channel hysteresis, and every sparkline tape bound to
   * that session. There is no fixture and no mock; what a test sees is what a
   * stream would have produced.
   *
   * Returns `false` when no store is attached or the channel name is not one
   * the store knows.
   */
  recordActivity(session: string, channel: string, units: number): boolean;

  /**
   * The live state of the sparkline tape drawn under the first element matching
   * `selector` (SURFACE_VERSION 2.2.0), or `null` when nothing is mounted there.
   *
   * The tape's state is deliberately outside React and outside the DOM — that
   * is what makes an idle tape free — so it is otherwise unreachable from a
   * real-app test. `lastV` is what the pen is holding at the right edge, which
   * is how a test sees a stalled stream drain to baseline through the real
   * store rather than through a reconstructed one.
   */
  sparklineTapeState(selector: string): SparklineTapeDebugState | null;

  /**
   * The advance of `text` in the face `selector`'s element ACTUALLY renders in
   * (SURFACE_VERSION 2.6.0), or `null` when nothing matches.
   *
   * Goes through the production `whenFaceLoaded` + `textMeasurer` pair, so it
   * asks for the element's own face and waits for that face before measuring —
   * a test that measured on its own would be reporting the fallback's metrics
   * whenever it ran early, which is the trap `lib/font-metrics.ts` exists to
   * close. This is how a width constant derived from a type size (the
   * Overview's `ch`-derived rail widths) is pinned against the real render.
   */
  measureFaceAdvance(selector: string, text: string): Promise<number | null>;

  /**
   * Register an element as a selection boundary on behalf of a test
   * harness. Mirrors `useSelectionBoundary`'s call into
   * `selectionGuard.registerBoundary(cardId, element)` — the same
   * mechanism a real card uses on mount so WebKit's drag-selection
   * isn't blocked by `selectionGuard.handleSelectStart`.
   *
   * Needed because in-app smoke tests inject ad-hoc fixture
   * overlays outside of any real card; without registering the
   * overlay as a boundary, `selectstart` is preventDefault'd and
   * drag selection never begins. The companion
   * {@link TugTestSurface.unregisterSelectionBoundary} cleans up.
   */
  registerSelectionBoundary(cardId: string, selector: string): void;
  unregisterSelectionBoundary(cardId: string): void;

  // ---- Reload primitives (SURFACE_VERSION 1.4.0) ----

  /**
   * Trigger a soft reload via the same code path as the
   * `Maker > Reload` menu: `dispatchAction({action:"reload"})`,
   * which routes through the registered handler in
   * `action-dispatch.ts` —
   * `prepareForReload().then(() => location.reload())`. The
   * `prepareForReload` chain saves layout, drains every card's
   * save callback, and synchronously flushes dirty state through
   * tugcast to tugbank disk before the page navigates ([L23]).
   *
   * The action handler dedupes via a module-scoped `reloadPending`
   * flag, so a second `appReload()` in the same JS context is a
   * silent no-op. The flag resets on the new page (fresh module
   * instance), so subsequent reloads after a successful round-trip
   * work.
   *
   * Returns synchronously after kicking off the
   * `prepareForReload` Promise — `location.reload()` fires from
   * the `.then()` once the flush completes. Callers that need to
   * wait for the new page must poll {@link getReadyGen} for an
   * advancing value (the bun-side `app.appReload()` wrapper does
   * this).
   */
  appReload(): void;

  /**
   * Drop the real WebSocket, so the whole recovery path runs.
   *
   * This is the only op that exercises what a transport close
   * actually does to the deck. `driveSession`'s `transportClose`
   * dispatches into one card's reducer and never reaches
   * `ConnectionLifecycle`, `cardSessionBindingStore.clearAll()`, or
   * `restoreSessions` — it pins the reducer contract and nothing
   * else. This one closes the socket without the `intentionalClose`
   * latch, so the close, the backoff, the reconnect, the disposal of
   * every services bag, and the restore all happen for real.
   *
   * Returns `false` when there is no connection to close.
   */
  connectionClose(): boolean;

  // ---- Generic control-action dispatch (SURFACE_VERSION 1.5.0) ----

  /**
   * Fire a control-action dispatch through the same path the native
   * Swift host uses for menu items and keyboard shortcuts:
   * `action-dispatch.ts`'s `dispatchAction({ action })`. Routes
   * through any registered handler (e.g. `show-component-gallery`,
   * `add-card-to-active-pane`, `close`, `reload`). Extra payload
   * fields (e.g. `show-card`'s `component`) ride along via the
   * optional second argument, exactly as they would on the wire.
   *
   * Returns `true` if a handler ran (registered + chain reached a
   * matching responder), `false` otherwise. Most actions delegate to
   * `responderChainManagerRef.sendToFirstResponder(...)` internally —
   * so a `false` return commonly means "no first responder is set
   * AND no responder up the chain handles this action," which is the
   * useful signal for tests that need to verify an action stays
   * reachable across deck mutations.
   */
  dispatchControlAction(
    actionName: string,
    payload?: Record<string, unknown>,
  ): void;

  /**
   * Return the current "ready generation" — a counter
   * {@link attachTugTestSurface} increments on every page boot,
   * persisted across `location.reload()` via `sessionStorage`.
   *
   * The bun harness reads this BEFORE calling {@link appReload},
   * fires the reload, and then polls until `getReadyGen()`
   * returns a strictly greater value. That's the deterministic
   * "the new page has booted and `__tug` is online again"
   * signal — robust against the mid-navigation
   * `evaluateJavaScript` errors WKWebView can produce while the
   * page transitions.
   *
   * Returns `0` when no value is stored yet (first attach in a
   * fresh tab); `attachTugTestSurface` writes a `1` immediately,
   * so a caller observing `0` at any point after the surface is
   * attached has hit a page-storage misconfiguration.
   */
  getReadyGen(): number;

  // ---- EM-card observation (SURFACE_VERSION 1.2.0) ----

  /**
   * Read an EM card's engine state. Returns `null` when the card
   * is unknown OR is not an EM card (no `bag.content` written by
   * an `onSave`-returning-engine-state factory). The returned
   * shape's `engine` field tags the factory by `componentId`.
   *
   * Fires {@link DeckManager.invokeSaveCallback} synchronously
   * before reading so the bag reflects the engine's current
   * state, not the last debounced save (which may be hundreds of
   * ms stale). The cost is one engine `captureState()` call —
   * negligible — and the alternative would force tests to
   * manually drive a save before every read.
   */
  getEmCardState(cardId: string): EmCardState | null;

  /**
   * Synchronous "has the engine for `cardId` already emitted its
   * `engine-ready` event?" probe. Returns `true` when the deck-
   * trace ring contains an `engine-ready` event for the card,
   * `false` otherwise. The matching emit site lives at each EM-
   * engine factory's mount-time engine init (wired first in
   * `tug-prompt-input.tsx`; session-card / gallery-prompt-entry
   * follow as they pick up their own sites).
   *
   * The harness's `awaitEngineReady` wraps this in
   * `waitForCondition` for the blocking variant — the JS surface
   * itself stays synchronous because evalJS-side busy-waits
   * can't observe trace ring writes from the same thread. The
   * trace ring is bounded but generous (512); the event survives
   * for any realistic test setup window.
   */
  isEngineReady(cardId: string): boolean;

  /**
   * Bind a fake session for a session card so it skips past the
   * project-picker UI and renders SessionCardBody directly. Without a
   * binding, `useSessionCardServices` returns `null` and session-card
   * shows the picker; production sets the binding from a
   * `spawn_session_ok` CONTROL ack that requires a live tugcast +
   * tugcode + Claude pipeline. Tests that exercise dev-specific
   * behavior — focus, selection, persistence, app-lifecycle
   * round-trips — don't need real session frames; they need the
   * editor to mount. This helper writes synthetic values directly
   * into `cardSessionBindingStore` so the existing services
   * reconciler constructs the real-shape services bag against the
   * harness's WebSocket connection. The stores stay empty (no
   * frames flow), but the editor renders and accepts focus.
   *
   * `tugSessionId` and `workspaceKey` default to deterministic
   * test-only sentinels so the same call shape works across every
   * dev test. Pass overrides only when a test specifically needs
   * a non-default value (e.g. testing workspace-key isolation
   * across sibling cards).
   *
   * Test-mode-only. Available when `window.__tugTestMode === true`.
   */
  bindSession(
    cardId: string,
    options?: {
      tugSessionId?: string;
      workspaceKey?: string;
      projectDir?: string;
      /**
       * `"new" | "resume"` — the user's session-mode intent at
       * card-open time. Threaded onto `CodeSessionSnapshot.sessionMode`
       * by `cardServicesStore` so pure derivations (e.g.
       * `deriveSessionCardBannerSpec`) can branch on it. Defaults to
       * `"new"` so existing tests, which model the fresh-bind path,
       * keep their current semantics; tests that exercise resume
       * behavior (cold-boot preflight, replay-loading banner, etc.)
       * pass `"resume"` explicitly.
       */
      sessionMode?: CardSessionMode;
    },
  ): void;

  // ---- Real cold-replay spawn (SURFACE_VERSION 1.13.0) ----

  /**
   * Fire a REAL `spawn_session(mode=resume)` CONTROL frame over the live
   * shared connection — the production `sendSpawnSession` path — so tugcast
   * spawns a genuine tugcode `--resume` subprocess that replays the on-disk
   * JSONL through `translateJsonlSession` → tugcast `CODE_OUTPUT →
   * SESSION_SIDEBAND` fan-out → `SessionMetadataStore`.
   *
   * This is the ONLY surface verb that drives the genuine cold-replay
   * delivery chain end-to-end. Unlike `bindSession` (which writes a
   * synthetic binding and never spawns tugcode) and
   * `driveSession`/`ingestSessionMetadata` (which inject frames straight
   * into the client store, bypassing tugcast's fan-out), this exercises the
   * real model-delivery ordering/no-clobber path — the one a pre-cooked
   * `SESSION_SIDEBAND` frame would fake-pass.
   *
   * The caller must place the fixture JSONL on disk first, at
   * `~/.claude/projects/<encode(projectDir)>/<tugSessionId>.jsonl` (the
   * legacy un-forked resume resolves the claude id to `tugSessionId`). The
   * spawn is asymmetric: the binding lands on the server's `spawn_session_ok`
   * ack, and the replayed `SESSION_SIDEBAND` arrives shortly after. The
   * caller waits on the rendered Z2 readouts, not on this call.
   *
   * Throws if the shared connection is unavailable.
   */
  spawnSessionResume(
    cardId: string,
    opts: { tugSessionId: string; projectDir: string },
  ): void;

  // ---- Dev lifecycle-matrix driving (SURFACE_VERSION 1.6.0) ----

  /**
   * Drive a bound session card's `CodeSessionStore` one step through the
   * lifecycle matrix. Resolves the card's services via
   * `cardServicesStore`; throws if the card is not bound (call
   * `bindSession` first). See {@link SessionDriveAction} for
   * the step vocabulary.
   *
   * The app-test matrix-coordination test drives a session card through
   * every distinct matrix row with this and asserts the rendered
   * Z1 / Z2 / Z5 zones. Test-mode-only.
   */
  /**
   * Ink-restore truth for one card, read from the stores rather than the DOM
   * ([P07]) — see the implementation for why the DOM cannot answer this.
   */
  inkRestoreFacts(cardId: string): {
    shellTurns: number;
    commands: string[];
    restore: {
      ledgerTotal: number;
      applied: number;
      complete: boolean;
      answered: boolean;
    };
  };
  /**
   * Re-ask the shell ledger for one card's ink rows — the refresh a
   * "load previous" page performs, and the only way a restored copy of a
   * landing reaches a transcript that already holds the live one.
   */
  refreshInkRestore(cardId: string): void;
  driveSession(cardId: string, action: SessionDriveAction): void;

  /**
   * Drive the app-level, account-global rate-limit store with a quota as if a
   * live `rate_limit_event` had landed ([#step-3.5]). Account-global, so it is
   * NOT card-scoped — one call drives the single deck-wide banner. Used by the
   * banner app-test to mount / clear the banner without a live claude limit.
   */
  ingestRateLimit(info: RateLimitInfo): void;

  /**
   * Drive the app-level, account-global usage store with a `UsageSnapshot` as
   * if a `claude -p "/usage"` response had landed on the USAGE feed — so the
   * `/usage` sheet renders its gauges + contribution tables without a live
   * `claude` invocation.
   */
  ingestUsage(payload: unknown): void;

  /**
   * Drive a session card's `SessionMetadataStore` with a decoded SESSION_SIDEBAND
   * payload (`session_capabilities` or `system_metadata`) as if it had landed
   * on the feed ([#step-4]). Resolves the card's services via
   * `cardServicesStore`; throws if the card is not bound (call `bindSession`
   * first). Used by the effort-chip app-test to mount the chip and flip its
   * model gate without a live claude handshake — the chip reads its own
   * SESSION_SIDEBAND FeedStore, unreachable by `driveSession`.
   */
  ingestSessionMetadata(cardId: string, payload: unknown): void;

  /**
   * Settle a bound session card's `SideQuestionStore` with a decoded
   * `side_question_answer` payload, as if a matching CODE_OUTPUT frame had
   * landed — so the `/btw` overlay renders its answer without a live claude
   * round-trip. The payload's `request_id` must match a pending (loading)
   * exchange (i.e. a prior `/btw` ask). Requires a prior `bindSession`.
   */
  ingestSideQuestionAnswer(cardId: string, payload: unknown): void;

  /**
   * Read a bound session card's perf instrumentation: the
   * `CodeSessionStore` replay-ingest / live-turn commit counters plus
   * the (app-global) row-parse counters. Pure read — the
   * resume-performance baseline and budget app-tests assert internal
   * splits (commit counts, parse-once) through this instead of
   * scraping the log stream. Requires a prior bound session.
   */
  getSessionPerf(cardId: string): {
    replay: ReplayIngestPerf | null;
    lastReplay: ReplayIngestPerf | null;
    liveTurn: LiveTurnPerf | null;
    lastLiveTurn: LiveTurnPerf | null;
    rowParse: RowParseCountersSnapshot;
    annotate: AnnotateCountersSnapshot;
  };

  /**
   * Read the deck's current `hasFocus` state. The deck's
   * `installDeckStoreFocusListeners` flips this to `true` on
   * `window.focus` and `false` on `window.blur`; reading it from
   * the harness gives a synchronous probe for "has the JS-side
   * focus event fired and drained?" — useful after
   * `simulateAppResign` / `simulateAppBecomeActive` to confirm
   * WKWebView actually dispatched the blur/focus event (not just
   * AppKit's `did...Active` notification, which the Swift
   * primitive already waits for). Under rapid back-to-back
   * lifecycle simulations WebKit's window event dispatch can
   * lag the AppKit notification by several milliseconds.
   */
  getHasFocus(): boolean;

  /**
   * Read a card's full {@link CardStateBag} from the deck's in-
   * memory cache. Returns `null` when no bag exists. Does NOT
   * force a save first — callers wanting fresh state should call
   * `window.tugdeck.saveState()` (or trigger a will-phase save)
   * first. Used by [AT0017] saveState-RPC-parity
   * audit for structural diffs of the bag across save paths.
   */
  getCardStateBag(cardId: string): CardStateBag | null;

  /**
   * Close an entire pane by id. Mirrors `deckManager.handlePaneClosed`,
   * the entry point a "close every card in this pane" UI affordance
   * would call. Used by [AT0019] pane-teardown-flush
   * audit so a multi-card pane's `_closePane` flush loop can be
   * exercised directly rather than driven through the per-tab close
   * button (which routes through `_removeCard` and only delegates to
   * `_closePane` for the last surviving card in a single-card pane).
   */
  closePane(paneId: string): void;

  /**
   * Raise/activate a card by id — the same `DeckManager.activateCard`
   * mutation a Lens Cards-row click commits. SURFACE_VERSION 1.19.0, for
   * the pane-occlusion cell ([AT0332]): a fully-buried pane presents no
   * clickable pixels, so raise-from-buried is driven here.
   */
  activateCard(cardId: string): void;

  /**
   * Arm the cut detector (SURFACE_VERSION 2.9.0) — start sampling every
   * imposed frame's rect once per animation frame, recording any pane that
   * changes geometry while nothing is animating it.
   *
   * The deck's promise is that a layout change travels rather than jumps, and
   * this is how a test holds it to that. Armed only between this call and
   * {@link TugTestSurface.disarmCutDetector}; nothing samples at rest.
   */
  armCutDetector(): void;

  /** Stop the cut detector and drop its sampling state. */
  disarmCutDetector(): void;

  /**
   * Exercise the store's gesture transaction (SURFACE_VERSION 2.11.0) and
   * report how many times subscribers were told.
   *
   * `shape` picks the case: `"single"` batches one mutation, `"nested"`
   * batches two mutations with an inner batch around the second,
   * `"throws"` batches a mutation and then throws, and `"empty"` batches
   * nothing at all. The mutation used is a bullseye toggle — it notifies,
   * persists nothing, and is undone by the probe before it returns, so the
   * deck is left exactly as it was found.
   *
   * Returns the number of subscriber notifications the probe observed,
   * and — for `"throws"` — whether the exception escaped as it should.
   */
  probeBatchGesture(shape: "single" | "nested" | "throws" | "empty"): {
    notifies: number;
    threw: boolean;
  };

  /**
   * Hand back every cut recorded since the last take and clear the buffer.
   * Each record names the pane and the per-axis delta it jumped by.
   */
  takeCutRecords(): unknown[];

  /**
   * Put the layout selection on exactly these cards (SURFACE_VERSION 2.10.0),
   * anchored on the last of them — the state a run of ⌘/⇧ clicks in the Lens's
   * Cards list would leave behind.
   *
   * An empty array clears it, which is how a test drives the resolver's
   * first-responder fallback rather than its selection rung.
   */
  setLayoutSelection(cardIds: readonly string[]): void;

  /** The layout selection's card ids, in selection order. */
  getLayoutSelection(): readonly string[];
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a CSS selector against `document`. Throws a descriptive
 * error (rather than silently swallowing) so harness-side tests fail
 * loudly on a stale selector. Keeping the throw centralized also
 * means the Swift bridge sees a consistent error shape surfaced by
 * `evalJS` when a selector goes stale.
 */
function queryRequired(selector: string): HTMLElement {
  const el = document.querySelector(selector);
  if (el === null) {
    throw new Error(`[tug] selector matched no element: ${selector}`);
  }
  if (!(el instanceof HTMLElement)) {
    throw new Error(`[tug] selector matched a non-HTMLElement: ${selector}`);
  }
  return el;
}

/**
 * Compute a click's default `clientX` / `clientY` from the target's
 * bounding-rect center. Matches what a user-space click on the
 * element's visual center would produce, and keeps our synthetic
 * clicks deterministic against any element's current layout.
 */
function defaultClickPoint(el: HTMLElement): { clientX: number; clientY: number } {
  const rect = el.getBoundingClientRect();
  return {
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
}

/**
 * Re-hydrate the `Map<string, CardStateBag>` shape that
 * `DeckManager.seedDeckState` consumes from the plain-object
 * `Record<string, CardStateBag>` that survives JSON transport over
 * the Swift `evalJS` bridge. Absent / empty input produces
 * `undefined` so `seedDeckState` treats it as a no-op pass.
 */
function cardStatesRecordToMap(
  rec: Record<string, CardStateBag> | undefined,
): Map<string, CardStateBag> | undefined {
  if (rec === undefined) return undefined;
  const keys = Object.keys(rec);
  if (keys.length === 0) return undefined;
  const map = new Map<string, CardStateBag>();
  for (const key of keys) {
    map.set(key, rec[key]);
  }
  return map;
}

/**
 * Build an empty-but-valid {@link DeckState}: one pane with no cards is
 * NOT valid (invariant 3 forbids empty panes), so the safe empty deck
 * is literally zero panes, zero cards, no `activePaneId`.
 */
function makeEmptyDeckState(): DeckState {
  return {
    cards: [],
    panes: [],
    imposition: { sidebars: { lens: { side: DEFAULT_SIDEBAR_SIDE } } },
    hasFocus: typeof document !== "undefined" ? document.hasFocus() : false,
  };
}

/**
 * Narrow `document.activeElement` to a form-control that sits inside
 * `cardRoot` and carries a `data-tug-state-key` key. Returns
 * `null` when the active element is outside the card subtree or is
 * not a recognized form control.
 *
 * Mirrors the "form-control focus" classification that `CardHost`'s
 * {@link import("./components/chrome/card-host").captureFocus} uses
 * when building `bag.focus`. Keeping the two in sync is important
 * because a `kind: "input"` caret-state read is what a test uses to
 * assert "this form-control has focus and its caret is here".
 */
function activeFormControlIn(
  cardRoot: HTMLElement,
): HTMLInputElement | HTMLTextAreaElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  if (!cardRoot.contains(active)) return null;
  if (active.getAttribute("data-tug-state-key") === null) return null;
  if (active instanceof HTMLInputElement) return active;
  if (active instanceof HTMLTextAreaElement) return active;
  return null;
}

/**
 * Read the selection direction off an `HTMLInputElement` /
 * `HTMLTextAreaElement`, normalizing the nullable browser field to
 * the surface's {@link CaretState} `"forward" | "backward" | "none"`
 * union. Browsers that return `null` (rare — WebKit returns
 * `"none"`) get normalized to `"none"`.
 */
function readSelectionDirection(
  el: HTMLInputElement | HTMLTextAreaElement,
): "forward" | "backward" | "none" {
  const dir = el.selectionDirection;
  if (dir === "forward" || dir === "backward") return dir;
  return "none";
}

// ---------------------------------------------------------------------------
// createTugTestSurface
// ---------------------------------------------------------------------------

/**
 * Build a {@link TugTestSurface} bound to the supplied {@link DeckManager}.
 *
 * The returned object is a closure-over-`deck`; callers hand it out as
 * `window.__tug` via {@link attachTugTestSurface}. No module-level state
 * lives here — every surface method reaches into `deck` or the relevant
 * singleton (`selectionGuard`, `deckTrace`) on each call so rebuilding
 * the surface per test is just `createTugTestSurface(newDeck)`.
 */
export function createTugTestSurface(deck: DeckManager): TugTestSurface {
  // --- reset axis effects ([D01]: each axis idempotent) ---
  const resetDeckAxis = (): void => {
    // Seed with an empty DeckState. Goes through the same atomic
    // replace path as a real seed so component registries for
    // departing cards get discarded, subscribers notify once, and
    // the snapshot transitions cleanly for useSyncExternalStore.
    deck.seedDeckState({ state: makeEmptyDeckState() });
  };

  const resetSelectionGuardAxis = (): void => {
    selectionGuard.reset();
  };

  const resetOrchestratorAxis = (): void => {
    // Component State Preservation Protocol registries are owned by
    // the deck-manager (see `componentStatePreservationRegistries`).
    // They have no public
    // "clear" API because production never wants one — the only
    // legitimate drop is when a card leaves the deck. The `deck`
    // axis's `seedDeckState({ state: empty })` already discards
    // registries for every card that departs; calling it here
    // gives the orchestrator axis the same idempotent "drop all"
    // effect. If `resetDeckAxis` already ran in this same `reset`
    // call the deck is already empty — the seed is a cheap no-op
    // then, which matches the [D01] contract that every axis is
    // safe to call when already in its reset state.
    deck.seedDeckState({ state: makeEmptyDeckState() });
  };

  const resetTraceAxis = (): void => {
    deckTrace.clear();
  };

  const resetStorageAxis = (): void => {
    // `localStorage.clear()` is synchronous and deterministic; that
    // covers every persisted value tugdeck currently writes
    // (notably `td-theme`). Scoped IndexedDB is a placeholder —
    // tugdeck has no durable IDB today (see MEMORY: IndexedDB is
    // unwanted infra), but wire the shape now so a future IDB
    // consumer lands its cleanup here without widening the surface.
    try {
      localStorage.clear();
    } catch {
      /* storage unavailable (e.g. private mode); nothing to clear. */
    }
  };

  // --- event synthesis ---
  const synthesizeClick = (el: HTMLElement, opts?: ClickOptions): void => {
    const { clientX, clientY } = opts?.clientX !== undefined && opts?.clientY !== undefined
      ? { clientX: opts.clientX, clientY: opts.clientY }
      : defaultClickPoint(el);
    const metaKey = opts?.metaKey === true;
    const shiftKey = opts?.shiftKey === true;

    // Common init for the "pressed" phase (pointerdown + mousedown).
    const pressedInit: PointerEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX,
      clientY,
      button: 0,
      buttons: 1,
      pointerType: "mouse",
      pointerId: 1,
      isPrimary: true,
      metaKey,
      shiftKey,
    };
    // Common init for the "released" phase. `buttons: 0` reflects
    // the post-release state where no mouse button is depressed.
    const releasedInit: PointerEventInit = {
      ...pressedInit,
      buttons: 0,
    };

    // 1. pointerdown  2. mousedown  3. pointerup  4. mouseup  5. click.
    //    Natural DOM ordering for a full click.
    el.dispatchEvent(new PointerEvent("pointerdown", pressedInit));
    el.dispatchEvent(new MouseEvent("mousedown", pressedInit));
    el.dispatchEvent(new PointerEvent("pointerup", releasedInit));
    el.dispatchEvent(new MouseEvent("mouseup", releasedInit));
    el.dispatchEvent(new MouseEvent("click", releasedInit));
  };

  const synthesizeType = (
    el: HTMLInputElement | HTMLTextAreaElement,
    text: string,
  ): void => {
    // React's synthetic-event system only sees a value change when
    // the underlying native setter is what wrote the property —
    // assigning `el.value = "..."` directly bypasses the prototype
    // descriptor React installed and the onChange handler never
    // fires. The native-setter pattern is the canonical workaround.
    const proto =
      el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    const nativeSetter = descriptor?.set;
    if (!nativeSetter) {
      throw new Error(
        "[tug] native `value` setter is missing on prototype; cannot synthesize typing",
      );
    }
    for (const ch of text) {
      nativeSetter.call(el, el.value + ch);
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: false,
          composed: true,
          inputType: "insertText",
          data: ch,
        }),
      );
    }
  };

  return {
    version: SURFACE_VERSION,

    // ---- state seeding ----
    seedDeckState(args: SeedDeckStateArgs): void {
      deck.seedDeckState({
        state: args.state,
        cardStates: cardStatesRecordToMap(args.cardStates),
        focusCardId: args.focusCardId,
      });
    },

    setTugbankValue(domain: string, key: string, value: TaggedValue): void {
      const client = getTugbankClient();
      if (client === null) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(
            `[test-surface] setTugbankValue(${domain}/${key}): no tugbank client installed`,
          );
        }
        return;
      }
      client.setLocalValue(domain, key, value);
    },

    /**
     * Drop a tugbank key, as a `DELETE` arriving from another process would.
     * The counterpart to {@link setTugbankValue}, for the domains where a
     * key's *absence* is the meaningful state — a keymap override reset is a
     * deletion, and a test that could only write values could never drive it.
     */
    deleteTugbankValue(domain: string, key: string): void {
      const client = getTugbankClient();
      if (client === null) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(
            `[test-surface] deleteTugbankValue(${domain}/${key}): no tugbank client installed`,
          );
        }
        return;
      }
      client.deleteLocalValue(domain, key);
    },

    /** Read one tugbank value from the client cache, or `null` when unset. */
    getTugbankValue(domain: string, key: string): TaggedValue | null {
      const client = getTugbankClient();
      if (client === null) return null;
      return client.get(domain, key) ?? null;
    },

    // ---- granular reset ----
    reset(opts: ResetOptions): void {
      // Order matters: trace last so any earlier axis' subscriber
      // side-effects remain visible to a test that inspects the
      // trace during reset debugging. Storage first so a later
      // axis that reads storage (none today, but keeps the order
      // future-proof) sees the cleared state.
      if (opts.storage === true) resetStorageAxis();
      if (opts.deck === true) resetDeckAxis();
      if (opts.selectionGuard === true) resetSelectionGuardAxis();
      if (opts.orchestrator === true) resetOrchestratorAxis();
      if (opts.trace === true) resetTraceAxis();
    },

    // ---- gesture drivers ----
    click(selector: string, opts?: ClickOptions): void {
      const el = queryRequired(selector);
      synthesizeClick(el, opts);
    },

    type(selector: string, text: string): void {
      const el = queryRequired(selector);
      if (
        !(el instanceof HTMLInputElement) &&
        !(el instanceof HTMLTextAreaElement)
      ) {
        throw new Error(
          `[tug] type: selector must match <input> or <textarea>: ${selector}`,
        );
      }
      synthesizeType(el, text);
    },

    focusElement(selector: string): void {
      const el = queryRequired(selector);
      // Direct `.focus()` — fallback
      // for paths where synthesized pointerdown cannot drive
      // browser-default focus. Matches [D09] fidelity limits.
      el.focus();
    },

    // ---- state reads ----
    getPaneRecord(paneId: string) {
      const pane = deck.getSnapshot().panes.find((p) => p.id === paneId);
      if (pane === undefined) return null;
      return {
        position: { ...pane.position },
        size: { ...pane.size },
        slot: pane.slot ?? null,
        widthPreset: pane.widthPreset ?? null,
      };
    },

    getActiveCardId(): string | null {
      // "Active card" in the surface's vocabulary is the composite
      // first-responder: the card the user perceives as active.
      // `getFirstResponderCardId` is the deck-manager's name for
      // exactly that bit.
      return deck.getFirstResponderCardId();
    },

    setFirstResponder(responderId: string): void {
      // Sanctioned `makeFirstResponder`, test-only. Lets a test pin the
      // chain first responder to a node in one pane while the keyboard
      // caret stays in another — the DOM-focus/chain divergence that
      // pointerdown/focusin promotion cannot produce. `makeFirstResponder`
      // no-ops with a dev-warn for an unregistered id.
      getResponderChainManager()?.makeFirstResponder(responderId);
    },

    getFirstResponderId(): string | null {
      return getResponderChainManager()?.getFirstResponder() ?? null;
    },

    getFocusedCardId(): string | null {
      return deck.getFocusedCardId();
    },

    getCaretState(cardId: string): CaretState | null {
      const cardRoot = deck.peekCardHostRoot(cardId);
      if (cardRoot === null) return null;

      // Variant 1: active element is a keyed form-control inside
      // the card. Return its selection shape directly.
      const input = activeFormControlIn(cardRoot);
      if (input !== null) {
        return {
          kind: "input",
          selectionStart: input.selectionStart ?? 0,
          selectionEnd: input.selectionEnd ?? 0,
          selectionDirection: readSelectionDirection(input),
          value: input.value,
        };
      }

      // Variant 2: the card has a published DOM Range in
      // `selectionGuard`. Serialize it with paths rooted at the
      // card's registered host element. `nodeToPath` returns
      // `null` if the range's nodes are no longer inside the host
      // subtree — treat that as "no caret state available" rather
      // than synthesizing a bogus snapshot.
      const range = selectionGuard.getCardRange(cardId);
      if (range === undefined) return null;
      const anchorPath = nodeToPath(cardRoot, range.startContainer);
      const focusPath = nodeToPath(cardRoot, range.endContainer);
      if (anchorPath === null || focusPath === null) return null;
      return {
        kind: "range",
        anchorPath,
        anchorOffset: range.startOffset,
        focusPath,
        focusOffset: range.endOffset,
        text: range.toString(),
      };
    },

    getFormControlValue(cardId: string, componentStatePreservationKey: string): string | null {
      const cardRoot = deck.peekCardHostRoot(cardId);
      if (cardRoot === null) return null;
      // `CSS.escape` is important: componentStatePreservationKeys are authored
      // strings and can technically contain characters that would
      // otherwise be interpreted as selector syntax.
      const selector = `[data-tug-state-key="${CSS.escape(componentStatePreservationKey)}"]`;
      const el = cardRoot.querySelector(selector);
      if (el === null) return null;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement
      ) {
        return el.value;
      }
      return null;
    },

    assertHostRootRegistered(cardId: string): boolean {
      return deck.peekCardHostRoot(cardId) !== null;
    },

    // ---- trace access ----
    getDeckTrace(opts?: { since?: number }): readonly DeckTraceEvent[] {
      if (opts?.since !== undefined) return deckTrace.since(opts.since);
      return deckTrace.dump();
    },

    markDeckTrace(): number {
      return deckTrace.mark();
    },

    clearDeckTrace(): void {
      deckTrace.clear();
    },

    setTranscriptEvictionDisabled(disabled: boolean): void {
      labFlags.setTranscriptEvictionDisabled(disabled);
    },

    getScrollDisplacementCount(selector: string): number {
      const probe = listViewProbeForScroller(queryRequired(selector));
      if (probe === null) {
        throw new Error(
          `getScrollDisplacementCount: ${selector} is not a list-view scroller`,
        );
      }
      return probe.displacementCount();
    },

    forceCommitClamp(selector: string): void {
      const probe = listViewProbeForScroller(queryRequired(selector));
      if (probe === null) {
        throw new Error(
          `forceCommitClamp: ${selector} is not a list-view scroller`,
        );
      }
      probe.forceCommitClamp();
    },

    setTranscriptFollowBottom(selector: string, engaged: boolean): void {
      const ss = smartScrollForElement(queryRequired(selector));
      if (ss === null) {
        throw new Error(
          `setTranscriptFollowBottom: ${selector} has no SmartScroll`,
        );
      }
      if (engaged) ss.engage("test-surface");
      else ss.disengage("test-surface");
    },

    getListConservation(selector: string): {
      events: unknown[];
      audit: unknown;
      ring: unknown[];
      floor: { height: number; inset: number };
    } {
      const probe = listViewProbeForScroller(queryRequired(selector));
      if (probe === null) {
        throw new Error(
          `getListConservation: ${selector} is not a list-view scroller`,
        );
      }
      return {
        events: probe.conservationEvents(),
        audit: probe.auditLedger(),
        ring: probe.geometryRing(),
        floor: probe.extentFloor(),
      };
    },

    enableDeckTrace(flag: boolean): void {
      deckTrace.enable(flag);
      // Persist so the flag survives an in-process `appReload()`:
      // `attachTugTestSurface` re-applies it on the reloaded page's
      // boot. Without this, recording silently stops after a reload
      // and trace-gated assertions (e.g. `awaitEngineReady`) time out.
      writeDeckTraceEnabled(flag);
    },

    // ---- introspection (SURFACE_VERSION 1.1.0) ----

    getElementText(selector: string): string {
      const el = queryRequired(selector);
      // Form controls don't meaningfully have `.textContent` — return
      // their `.value` so tests can write a uniform assertion against
      // whatever kind of element a selector happens to resolve to.
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement
      ) {
        return el.value;
      }
      return el.textContent ?? "";
    },

    getElementValue(selector: string): string {
      const el = queryRequired(selector);
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      ) {
        return el.value;
      }
      throw new Error(
        `[tug] getElementValue: selector must match <input>/<textarea>/<select>: ${selector}`,
      );
    },

    getElementAttribute(selector: string, name: string): string | null {
      const el = queryRequired(selector);
      return el.getAttribute(name);
    },

    getElementBounds(selector: string): ElementBounds {
      const el = queryRequired(selector);
      const r = el.getBoundingClientRect();
      // Flatten the live DOMRect (whose `toJSON` is non-standard
      // across browsers) into a plain POD for stable JSON transport.
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    },

    getElementState(selector: string): ElementStateSnapshot {
      const el = queryRequired(selector);
      const rect = el.getBoundingClientRect();
      // Layout-visibility probe: non-zero layout box AND attached to
      // the render tree (`offsetParent` is null for `display:none`
      // descendants; `<body>` is a special case that has no
      // offsetParent yet is still visible).
      const hasSize = rect.width > 0 && rect.height > 0;
      const attached = el.offsetParent !== null || el === document.body;
      const visible = hasSize && attached;
      // `disabled` / `readOnly` / `checked` exist on
      // HTMLInputElement/Textarea/Select/Button — branch via
      // instanceof so we return stable false rather than reading
      // undefined on non-form elements.
      const disabled =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLButtonElement ||
        el instanceof HTMLSelectElement
          ? el.disabled
          : false;
      const readOnly =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? el.readOnly
          : false;
      const checked =
        el instanceof HTMLInputElement &&
        (el.type === "checkbox" || el.type === "radio")
          ? el.checked
          : false;
      return {
        tagName: el.tagName,
        disabled,
        readOnly,
        checked,
        visible,
        isFocused: document.activeElement === el,
      };
    },

    getActiveElement(): ActiveElementInfo | null {
      const active = document.activeElement;
      if (
        active === null ||
        active === document.body ||
        !(active instanceof HTMLElement)
      ) {
        return null;
      }
      const cardEl = active.closest("[data-card-id]");
      const cardId =
        cardEl instanceof HTMLElement
          ? cardEl.getAttribute("data-card-id")
          : null;
      const componentStatePreservationKey = active.getAttribute("data-tug-state-key");
      const id = active.id !== "" ? active.id : null;
      // Best-effort selector: id is stable when present; otherwise
      // scope by cardId and tag. We don't promise it re-resolves.
      const selector =
        id !== null
          ? `#${CSS.escape(id)}`
          : cardId !== null
          ? `[data-card-id="${CSS.escape(cardId)}"] ${active.tagName.toLowerCase()}`
          : active.tagName.toLowerCase();
      return {
        tagName: active.tagName,
        id,
        cardId,
        componentStatePreservationKey,
        selector,
      };
    },

    getFocusInvariantReport() {
      return getFocusManager()?.focusInvariantReport() ?? null;
    },

    reprojectFocus(): void {
      getFocusManager()?.reproject();
    },

    kbfManual(): boolean | null {
      return getFocusManager()?.kbfManual() ?? null;
    },

    kbfEngaged(): boolean | null {
      return getFocusManager()?.kbfEngaged() ?? null;
    },

    currentGesture() {
      const g = currentGesture();
      if (g === null) return null;
      // `promotion.to` is an Element — flattened to its kind so the record
      // survives the harness's JSON round trip.
      return {
        gestureId: g.gestureId,
        button: g.button,
        site: g.site,
        paneId: g.paneId,
        cardId: g.cardId,
        activation: g.activation,
        promotion: g.promotion.kind,
        placement: g.placement,
        preventMousedownDefault: g.preventMousedownDefault,
        reasons: g.reasons,
      };
    },

    publishPulseFrame(payloadJson: string): boolean {
      if (getPulseStore() === null) return false;
      try {
        _ingestPulseFrameForTest(JSON.parse(payloadJson));
      } catch {
        return false;
      }
      return true;
    },

    recordActivity(session: string, channel: string, units: number): boolean {
      const store = getSessionActivityStore();
      if (store === null) return false;
      if (!(channel in ACTIVITY_DESCRIPTORS)) return false;
      // `Date.now()`, deliberately, and NOT `performance.now()`: the meters bin
      // on ABSOLUTE wall-clock indices, and this has to stamp the same clock
      // the live frame handler stamps or the units land in a bin the series
      // never reaches — the recording would silently do nothing.
      store.record(session, channel as ActivityChannel, units, Date.now());
      return true;
    },

    sparklineTapeState(selector: string): SparklineTapeDebugState | null {
      const container = document.querySelector(selector);
      if (container === null) return null;
      return peekSparklineTape(container)?.debugState() ?? null;
    },

    async measureFaceAdvance(
      selector: string,
      text: string,
    ): Promise<number | null> {
      const el = document.querySelector(selector);
      if (!(el instanceof HTMLElement)) return null;
      await whenFaceLoaded(el, text);
      return textMeasurer(el)?.(text) ?? null;
    },

    publishOverviewPost(payloadJson: string): boolean {
      if (getOverviewStore() === null) return false;
      try {
        _ingestOverviewFrameForTest(JSON.parse(payloadJson));
      } catch {
        return false;
      }
      return true;
    },

    publishOverviewPostsPage(payloadJson: string): boolean {
      if (getOverviewStore() === null) return false;
      let body: unknown;
      try {
        body = JSON.parse(payloadJson);
      } catch {
        return false;
      }
      if (
        body === null ||
        typeof body !== "object" ||
        !Array.isArray((body as ListOverviewPostsOk).posts)
      ) {
        return false;
      }
      _ingestOverviewPageForTest(body as ListOverviewPostsOk);
      return true;
    },

    copySessionAtom(sessionId: string): boolean {
      return writeSessionAtomToClipboard(resolveSessionIdentity(sessionId));
    },

    async readClipboardAtoms(): Promise<{
      text: string;
      atoms: Array<{ type: string; label: string; value: string }>;
    } | null> {
      const { atoms } = await readClipboardViaNative();
      if (atoms === "") return null;
      const sidecar = parseClipboardSidecar(atoms);
      if (sidecar === null) return null;
      return {
        text: sidecar.text,
        atoms: sidecar.atoms.map((a) => ({
          type: a.segment.type,
          label: a.segment.label,
          value: a.segment.value,
        })),
      };
    },

    publishSessionUpdated(payloadJson: string): boolean {
      let body: unknown;
      try {
        body = JSON.parse(payloadJson);
      } catch {
        return false;
      }
      if (typeof body !== "object" || body === null) return false;
      dispatchAction({
        ...(body as Record<string, unknown>),
        action: "session_updated",
      });
      return true;
    },

    getSelection(cardId?: string): SelectionSnapshot | null {
      if (cardId !== undefined) {
        // Card-scoped: mirrors getCaretState(cardId)'s form-control
        // variant and augments with a contentEditable fallback.
        const cardRoot = deck.peekCardHostRoot(cardId);
        if (cardRoot === null) return null;
        const input = activeFormControlIn(cardRoot);
        if (input !== null) {
          return {
            kind: "input",
            selectionStart: input.selectionStart ?? 0,
            selectionEnd: input.selectionEnd ?? 0,
            selectionDirection: readSelectionDirection(input),
            value: input.value,
            cardId,
          };
        }
        const sel = window.getSelection();
        if (sel === null || sel.rangeCount === 0) return null;
        const range = sel.getRangeAt(0);
        if (!cardRoot.contains(range.startContainer)) return null;
        return {
          kind: "range",
          text: range.toString(),
          isCollapsed: range.collapsed,
          cardId,
        };
      }

      // Page-wide: prefer the focused form control when possible.
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement
      ) {
        const cardEl = active.closest("[data-card-id]");
        const containingCardId =
          cardEl instanceof HTMLElement
            ? cardEl.getAttribute("data-card-id")
            : null;
        return {
          kind: "input",
          selectionStart: active.selectionStart ?? 0,
          selectionEnd: active.selectionEnd ?? 0,
          selectionDirection: readSelectionDirection(active),
          value: active.value,
          cardId: containingCardId,
        };
      }
      const sel = window.getSelection();
      if (sel === null || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      let containingCardId: string | null = null;
      const startNode = range.startContainer;
      // Selection anchors inside text nodes; walk up to the nearest
      // element to query `closest("[data-card-id]")`.
      const elStart =
        startNode.nodeType === Node.ELEMENT_NODE
          ? (startNode as Element)
          : startNode.parentElement;
      if (elStart !== null) {
        const cardEl = elStart.closest("[data-card-id]");
        if (cardEl instanceof HTMLElement) {
          containingCardId = cardEl.getAttribute("data-card-id");
        }
      }
      return {
        kind: "range",
        text: range.toString(),
        isCollapsed: range.collapsed,
        cardId: containingCardId,
      };
    },

    getComputedStyleValue(selector: string, property: string): string {
      const el = queryRequired(selector);
      return window.getComputedStyle(el).getPropertyValue(property);
    },

    registerSelectionBoundary(cardId: string, selector: string): void {
      const el = queryRequired(selector);
      selectionGuard.registerBoundary(cardId, el);
    },

    unregisterSelectionBoundary(cardId: string): void {
      selectionGuard.unregisterBoundary(cardId);
    },

    // ---- Reload primitives (SURFACE_VERSION 1.4.0) ----

    appReload(): void {
      // Same dispatch the `Maker > Reload` menu fires (see
      // `action-dispatch.ts` `registerAction("reload", ...)`).
      // Routing through `dispatchAction` rather than calling
      // `prepareForReload` + `location.reload()` directly keeps the
      // dedup guard (`reloadPending`) and any future reload-side
      // bookkeeping in one place. [L23]
      dispatchAction({ action: "reload" });
    },

    connectionClose(): boolean {
      const connection = getConnection();
      if (!connection) return false;
      connection._forceCloseForTest();
      return true;
    },

    dispatchControlAction(
      actionName: string,
      payload?: Record<string, unknown>,
    ): void {
      dispatchAction({ ...payload, action: actionName });
    },

    getReadyGen(): number {
      return readReadyGen();
    },

    // ---- EM-card observation (SURFACE_VERSION 1.2.0) ----

    getEmCardState(cardId: string): EmCardState | null {
      // Force a save so the bag reflects current engine state
      // rather than a stale snapshot from the last debounced /
      // visibilitychange flush. `invokeSaveCallback` no-ops if no
      // save callback is registered for the cardId, so this is
      // safe even when the card has no engine.
      deck.invokeSaveCallback(cardId, "manual");
      const bag = deck.getCardState(cardId);
      if (bag === undefined || bag.content === undefined) return null;

      // Look up the card's componentId for the `engine` tag.
      // `getSnapshot()` reads the same `cards[]` array reactive
      // consumers see, so a card that was just removed is a
      // miss — return null in that race rather than synthesizing
      // a partial state.
      const snapshot = deck.getSnapshot();
      const card = snapshot.cards.find((c) => c.id === cardId);
      if (card === undefined) return null;

      // EM persistence comes in two production shapes plus a
      // historical migration target:
      //
      //   - Raw `TugTextEditingState`: `{ text, atoms, selection }`.
      //     A standalone editor with its own
      //     `useCardStatePreservation` returns this directly.
      //
      //   - TugPromptEntry wrapper (current):
      //     `{ route, draft: TugTextEditingState | null }`.
      //     This is what `TugPromptEntry` (and every card hosting it
      //     — `gallery-prompt-entry`, session-card) returns. Reach into
      //     `draft` to get the engine state.
      //
      //   - TugPromptEntry legacy wrapper:
      //     `{ currentRoute, perRoute: { [route]: TugTextEditingState } }`.
      //     The pre-Step-15 shape, still readable for back-compat so
      //     a snapshot saved on an older build round-trips through a
      //     newer test-surface read. The production path migrates
      //     these forward via `coerceRestorePayload`.
      //
      // Detection is shape-based rather than componentId-based so a
      // future EM factory that adopts any shape works automatically.
      const content = bag.content as Record<string, unknown>;
      let engineState: Record<string, unknown> = content;
      if (
        typeof content.route === "string" &&
        "draft" in content
      ) {
        // New simplified wrapper — `{ route, draft }`.
        if (typeof content.draft === "object" && content.draft !== null) {
          engineState = content.draft as Record<string, unknown>;
        } else {
          engineState = {};
        }
      } else if (
        typeof content.currentRoute === "string" &&
        typeof content.perRoute === "object" &&
        content.perRoute !== null
      ) {
        // Legacy wrapper — `{ currentRoute, perRoute }`.
        const perRoute = content.perRoute as Record<string, unknown>;
        const route = content.currentRoute as string;
        const inner = perRoute[route];
        if (typeof inner === "object" && inner !== null) {
          engineState = inner as Record<string, unknown>;
        }
      }
      const text = typeof engineState.text === "string" ? engineState.text : "";
      const selection =
        "selection" in engineState ? engineState.selection : null;

      return {
        kind: "em",
        engine: card.componentId,
        text,
        engineSelection: selection,
        streamState: "idle",
        lastTurnSeq: 0,
      };
    },

    isEngineReady(cardId: string): boolean {
      // Walk the trace ring in reverse — the most-recent
      // `engine-ready` for `cardId` is what the test cares about
      // (older entries from a different mount cycle are
      // irrelevant once a new engine for the same id has reported
      // ready).
      const events = deckTrace.dump();
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.kind === "engine-ready" && e.cardId === cardId) return true;
      }
      return false;
    },

    bindSession(
      cardId: string,
      options?: {
        tugSessionId?: string;
        workspaceKey?: string;
        projectDir?: string;
        sessionMode?: CardSessionMode;
      },
    ): void {
      cardSessionBindingStore.setBinding(cardId, {
        tugSessionId: options?.tugSessionId ?? `test-session-${cardId}`,
        workspaceKey: options?.workspaceKey ?? `test-workspace-${cardId}`,
        projectDir: options?.projectDir ?? "/tmp/test-project",
        sessionMode: options?.sessionMode ?? "new",
      });
    },

    spawnSessionResume(
      cardId: string,
      opts: { tugSessionId: string; projectDir: string },
    ): void {
      const connection = getConnection();
      if (connection === null) {
        throw new Error(
          "spawnSessionResume: shared connection unavailable — the app must " +
            "be connected before a real spawn_session can be driven",
        );
      }
      // The genuine production CONTROL frame. tugcast acks with
      // `spawn_session_ok` (which populates the binding) and spawns a real
      // tugcode `--resume` that replays the on-disk JSONL through the
      // fan-out. No synthetic binding, no injected frame.
      sendSpawnSession(
        connection,
        cardId,
        opts.tugSessionId,
        opts.projectDir,
        "resume",
      );
    },

    /**
     * Ink-restore truth for one card, read from the **stores** rather than
     * the DOM ([P07]).
     *
     * A transcript is windowed and its rows are virtualized, so counting
     * `[data-slot=...]` elements answers "what is painted", not "what was
     * restored" — and those two diverging silently is precisely how a
     * ledgered `/commit` receipt went missing three times without a red test.
     * `shellTurns` counts ink turns in the committed transcript; `restore` is
     * the store's own census of the last answer.
     */
    inkRestoreFacts(cardId: string): {
      shellTurns: number;
      commands: string[];
      restore: {
        ledgerTotal: number;
        applied: number;
        complete: boolean;
        answered: boolean;
      };
    } {
      const services = cardServicesStore.getServices(cardId);
      if (services === null) {
        throw new Error(`inkRestoreFacts: card "${cardId}" has no bound session`);
      }
      const turns = services.codeSessionStore
        .getSnapshot()
        .transcript.filter((t) => t.origin === "shell");
      return {
        shellTurns: turns.length,
        commands: turns.map((t) => {
          const msg = t.messages[0] as { command?: unknown } | undefined;
          return typeof msg?.command === "string" ? msg.command : "";
        }),
        restore: services.shellSessionStore.getSnapshot().restore,
      };
    },

    /**
     * Re-ask the shell ledger for this card's ink rows — the same refresh a
     * "load previous" page or the load bar's Retry performs.
     *
     * A landing's receipt exists twice: the live row the initiating deck
     * painted, and the ledger row a restore replays. Only a refresh brings the
     * second one into a transcript that already holds the first, so this is
     * the one gesture that can prove they are one turn rather than two.
     */
    refreshInkRestore(cardId: string): void {
      const services = cardServicesStore.getServices(cardId);
      if (services === null) {
        throw new Error(`refreshInkRestore: card "${cardId}" has no bound session`);
      }
      services.shellSessionStore.refreshRestore();
    },

    driveSession(cardId: string, action: SessionDriveAction): void {
      const services = cardServicesStore.getServices(cardId);
      if (services === null) {
        throw new Error(
          `driveSession: card "${cardId}" has no bound session — ` +
            `call bindSession("${cardId}") first`,
        );
      }
      const store = services.codeSessionStore;
      switch (action.op) {
        case "send":
          store.send(action.text, action.atoms ?? [], { suppress: action.suppress === true });
          return;
        case "ingestFrame":
          store._ingestFrameForTest(action.feedId, action.decoded);
          return;
        case "interrupt":
          store.interrupt();
          return;
        case "transportClose":
          store._simulateTransportForTest("close");
          return;
        case "transportReconnect":
          store._simulateTransportForTest("reconnect");
          return;
        case "loadPrevious":
          store.loadPrevious(action.amount);
          return;
        case "shellExchange": {
          const startedAtMs = action.startedAtMs ?? Date.now();
          store.ingestShellExchange({
            phase: "complete",
            exchangeId: action.exchangeId,
            command: action.command,
            output: action.output,
            exitCode: action.exitCode ?? 0,
            cwd: action.cwd,
            cwdAfter: null,
            startedAtMs,
            settledAtMs: startedAtMs,
          });
          return;
        }
        default: {
          const exhaustive: never = action;
          throw new Error(
            `driveSession: unknown action ${JSON.stringify(exhaustive)}`,
          );
        }
      }
    },

    ingestRateLimit(info: RateLimitInfo): void {
      deck.getRateLimitStore()._ingestForTest(info);
    },

    ingestUsage(payload: unknown): void {
      deck.getUsageStore()._ingestForTest(payload);
    },

    ingestSessionMetadata(cardId: string, payload: unknown): void {
      const services = cardServicesStore.getServices(cardId);
      if (services === null) {
        throw new Error(
          `ingestSessionMetadata: card "${cardId}" has no bound session — ` +
            `call bindSession("${cardId}") first`,
        );
      }
      services.sessionMetadataStore._ingestForTest(payload);
    },

    ingestSideQuestionAnswer(cardId: string, payload: unknown): void {
      const services = cardServicesStore.getServices(cardId);
      if (services === null) {
        throw new Error(
          `ingestSideQuestionAnswer: card "${cardId}" has no bound session — ` +
            `call bindSession("${cardId}") first`,
        );
      }
      services.sideQuestionStore._ingestForTest(payload);
    },

    getSessionPerf(cardId: string): {
      replay: ReplayIngestPerf | null;
      lastReplay: ReplayIngestPerf | null;
      liveTurn: LiveTurnPerf | null;
      lastLiveTurn: LiveTurnPerf | null;
      rowParse: RowParseCountersSnapshot;
      annotate: AnnotateCountersSnapshot;
    } {
      const services = cardServicesStore.getServices(cardId);
      if (services === null) {
        throw new Error(
          `getSessionPerf: card "${cardId}" has no bound session — ` +
            `call bindSession("${cardId}") first`,
        );
      }
      return {
        ...services.codeSessionStore._getPerfForDevPanel(),
        rowParse: snapshotRowParseCounters(),
        annotate: annotateCounters(),
      };
    },

    getHasFocus(): boolean {
      return deck.getSnapshot().hasFocus;
    },

    getCardStateBag(cardId: string): CardStateBag | null {
      const bag = deck.getCardState(cardId);
      return bag === undefined ? null : bag;
    },

    closePane(paneId: string): void {
      deck.handlePaneClosed(paneId);
    },

    activateCard(cardId: string): void {
      // The full raise, not just the first-responder flip:
      // `transferFocusForActivation` commits `store.activateCard` (which
      // reorders the panes array — the z-raise) inside `flushSync`, the
      // same path a real activation click takes through
      // `pane-focus-controller`. `DeckManager.activateCard` alone would
      // flip the responder and leave the pane buried.
      const store = getDeckStore();
      if (store === null) return;
      transferFocusForActivation({
        outgoingCardId: store.getFirstResponderCardId(),
        incomingCardId: cardId,
        store,
        commitMutation: () => store.activateCard(cardId),
      });
    },

    armCutDetector(): void {
      cutDetector.arm();
    },

    disarmCutDetector(): void {
      cutDetector.disarm();
    },

    probeBatchGesture(
      shape: "single" | "nested" | "throws" | "empty",
    ): { notifies: number; threw: boolean } {
      const store = getDeckStore();
      if (store === null) return { notifies: -1, threw: false };
      const paneId = store.getSnapshot().panes[0]?.id;
      if (paneId === undefined) return { notifies: -1, threw: false };
      // Bullseye is the right mutation to probe with: it notifies, it
      // persists nothing, and toggling it twice is the identity — so the
      // probe can count notifications without leaving a mark on the deck.
      const mutate = (): void => store.toggleBullseye(paneId);

      let notifies = 0;
      const unsubscribe = store.subscribe(() => {
        notifies += 1;
      });
      let threw = false;
      try {
        switch (shape) {
          case "single":
            store.batchGesture(() => {
              mutate();
              mutate();
            });
            break;
          case "nested":
            store.batchGesture(() => {
              mutate();
              store.batchGesture(() => {
                mutate();
              });
            });
            break;
          case "throws":
            try {
              store.batchGesture(() => {
                mutate();
                mutate();
                throw new Error("probe");
              });
            } catch {
              threw = true;
            }
            break;
          case "empty":
            store.batchGesture(() => {});
            break;
        }
      } finally {
        unsubscribe();
      }
      return { notifies, threw };
    },

    takeCutRecords(): unknown[] {
      return cutDetector.take();
    },

    setLayoutSelection(cardIds: readonly string[]): void {
      if (cardIds.length === 0) {
        lensSelectionStore.clear();
        return;
      }
      lensSelectionStore.pickOnly(cardIds[0]);
      for (const cardId of cardIds.slice(1)) lensSelectionStore.toggle(cardId);
    },

    getLayoutSelection(): readonly string[] {
      return lensSelectionStore.getSnapshot().ids;
    },
  };
}

// ---------------------------------------------------------------------------
// Ready-generation helpers (SURFACE_VERSION 1.4.0)
// ---------------------------------------------------------------------------

/**
 * Read the current ready-gen counter from `sessionStorage`. Returns
 * `0` when the slot is missing or unparseable. Defensive parsing
 * because `sessionStorage` values are user-controllable in principle —
 * the harness never writes garbage, but a malformed value should
 * round-trip as a fresh start rather than a thrown exception that
 * tears down the whole test surface.
 */
function readReadyGen(): number {
  if (typeof sessionStorage === "undefined") return 0;
  const raw = sessionStorage.getItem(READY_GEN_STORAGE_KEY);
  if (raw === null) return 0;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Increment the ready-gen counter and write it back. Called by
 * {@link attachTugTestSurface} on every page boot — including the
 * one after a `location.reload()`. The bun harness's
 * `app.appReload()` reads the counter pre-reload and polls until it
 * advances post-reload to confirm the new page is online.
 *
 * Silent no-op when `sessionStorage` is unavailable (non-browser
 * environments running tests against this module).
 */
function bumpReadyGen(): void {
  if (typeof sessionStorage === "undefined") return;
  const next = readReadyGen() + 1;
  sessionStorage.setItem(READY_GEN_STORAGE_KEY, String(next));
}

/**
 * Read the persisted deck-trace enable flag. Returns `false` when
 * the slot is missing, unparseable, or `sessionStorage` is
 * unavailable — a fresh page starts with recording off.
 */
function readDeckTraceEnabled(): boolean {
  if (typeof sessionStorage === "undefined") return false;
  return sessionStorage.getItem(DECK_TRACE_ENABLED_STORAGE_KEY) === "1";
}

/**
 * Persist the deck-trace enable flag so it survives a
 * `location.reload()` (via `app.appReload()`). Silent no-op when
 * `sessionStorage` is unavailable.
 */
function writeDeckTraceEnabled(flag: boolean): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(DECK_TRACE_ENABLED_STORAGE_KEY, flag ? "1" : "0");
}

// ---------------------------------------------------------------------------
// `window.__tug` binding — DEV + __tugTestMode only
// ---------------------------------------------------------------------------

/**
 * Global `window.__tug` handle, typed via `declare global` so the
 * attach below reads as a plain assignment rather than routing
 * through `Record<string, unknown>`.
 */
declare global {
  interface Window {
    /**
     * In-app test harness surface. Attached ONLY when
     * `import.meta.env.DEV && window.__tugTestMode === true` at
     * {@link attachTugTestSurface} time. Release builds never
     * populate it because the attach branch is tree-shaken; DEV
     * builds that aren't in test mode leave it `undefined` so
     * app code that accidentally reads `window.__tug` in prod
     * never sees a surface it shouldn't be using.
     */
    __tug?: TugTestSurface;
  }
}

/**
 * Install `window.__tug` from `main.tsx`, gated by BOTH the
 * DEV build flag and the `__tugTestMode` boot flag.
 *
 * The double guard is deliberate ([D03]):
 *
 *   - `import.meta.env.DEV` lets Vite tree-shake the entire branch
 *     (including `createTugTestSurface` and its transitive imports)
 *     out of release bundles.
 *   - `window.__tugTestMode === true` is set by the Swift host's
 *     DEBUG-only `WKUserScript` at `atDocumentStart` ([D08]), so
 *     even dev builds loaded in a normal (non-harness) browser
 *     never install the surface.
 *
 * The attach is idempotent: calling it a second time overwrites the
 * previous `window.__tug` with a surface bound to the newly-supplied
 * deck. In practice the app calls it exactly once per page
 * load from `main.tsx`; the idempotence exists for hot-reload
 * scenarios where the DeckManager instance changes mid-session.
 */
export function attachTugTestSurface(deck: DeckManager): void {
  // Gate on `window.__tugTestMode` only. Production users never have this
  // global set (it is injected by a DEBUG-only `WKUserScript` in Tug.app —
  // see `tugapp/Sources/TestHarness/TestHarnessUserScript.swift`), so the
  // attach is a no-op in production. Dropping the `import.meta.env.DEV`
  // half of the previous gate lets the in-app harness drive a prod-built
  // `dist/` (no Vite) — the launch path that runs `vite build` once and
  // serves static files is ~700ms faster than the dev-server path.
  if (typeof window !== "undefined" && window.__tugTestMode === true) {
    window.__tug = createTugTestSurface(deck);
    // Advance the ready-gen counter so the bun harness's
    // `app.appReload()` can detect post-reload re-attach by
    // polling for a strictly greater value than the pre-reload
    // read. The counter persists across `location.reload()` via
    // `sessionStorage` (per-tab/origin, not cleared by reload),
    // so the new page increments past the old.
    bumpReadyGen();
    // Re-apply the deck-trace enable flag across an in-process
    // `appReload()`. A test enables the trace once; the reload
    // resets the module-level `enabled` flag, so without this the
    // reloaded page records nothing and trace-gated waits
    // (`awaitEngineReady`, `getDeckTrace` assertions) hang.
    if (readDeckTraceEnabled()) {
      deckTrace.enable(true);
    }
  }
}
