/**
 * tugproto/ingest — the patch protocol between whatever reduces the wire and
 * the page that draws it.
 *
 * Today the sender is the deck's ingest Worker: it holds tugcast's socket,
 * peels and decodes frames, runs every session's reducer, and posts one
 * {@link IngestBatch} of patches per display period. The page answers with
 * {@link IngestControl} messages: the socket's lifecycle, its subscription,
 * outbound frames, the display period, the motion gate, and each session's
 * open, close and local actions. The protocol never names its sender, so a
 * later sender (tugcast itself) can emit the same patches unchanged.
 *
 * Payloads that are deck types — a session's state fields, its transcript
 * entries, its reducer events, its perf records — are type parameters
 * defaulting to `unknown`, because tugproto cannot import the deck. The deck
 * narrows them in one place (`tugdeck/src/lib/ingest/session-patch.ts`).
 *
 * The kind vocabularies are two lists, {@link INGEST_PATCH_KINDS} and
 * {@link INGEST_CONTROL_KINDS}. A compile-time check below rejects a list
 * that disagrees with its union, and `__tests__/ingest-kinds.test.ts` reads
 * this file as text for the same check — so keep one interface per message
 * with its `kind` literal on its own line, and one literal per line in each
 * list.
 *
 * Pure types + pure constants — no React, no DOM, no Node/Bun API.
 *
 * @module tugproto/ingest
 */

import type { FindResultFrame, RenderedMessageWire, RenderFindControl } from "./rendered";

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** tugcast's text handshake reply, as the socket received it. */
export interface IngestHandshake {
  protocol: string;
  version: number;
  [field: string]: unknown;
}

/** The disconnect banner's state, as the socket's owner computes it. */
export interface IngestDisconnectState {
  /** `true` while disconnected or reconnecting. */
  disconnected: boolean;
  /** Seconds until the next reconnect attempt (0 while reconnecting). */
  countdown: number;
  /** The server's close reason, if it gave one. */
  reason: string | null;
  /** `true` while a reconnect attempt is in flight. */
  reconnecting: boolean;
}

/** One write into a session's streaming `PropertyStore`. */
export interface IngestStreamWrite {
  path: string;
  value: unknown;
}

/**
 * One splice of a session's transcript array: remove `deleteCount` entries
 * at `start`, then insert `entries` there. Splices in a list apply in order.
 */
export interface TranscriptSplice<TEntry = unknown> {
  start: number;
  deleteCount: number;
  entries: TEntry[];
}

/**
 * The facts a session's engine owns that its snapshot reads. Each field is
 * present only when it changed since the engine last posted one.
 */
export interface IngestSessionMeta<TPerf = unknown> {
  loadPreviousTarget?: number;
  prependStagingCount?: number;
  lastSentUserMessage?: unknown;
  /** The engine's perf records, without the commit counts the page keeps. */
  perf?: {
    replay: TPerf | null;
    lastReplay: TPerf | null;
    liveTurn: TPerf | null;
    lastLiveTurn: TPerf | null;
  };
}

/**
 * An image's bytes, filed by the sender while it synthesized a replayed user
 * message, for the page's per-card bytes store.
 */
export interface IngestAtomBytes {
  id: string;
  /** Base64 image bytes, no `data:` prefix. */
  content: string;
  mediaType: string;
}

/** A session state change the page publishes locally. */
export interface IngestLocalStateChange {
  tugSessionId: string;
  atMs: number;
  phase: string;
  transportState: string;
  interruptInFlight: boolean;
}

// ---------------------------------------------------------------------------
// Page → sender: controls
// ---------------------------------------------------------------------------

/** Sent once, before anything else. */
export interface IngestInitControl {
  kind: "init";
  wsUrl: string;
  periodMs: number;
}

/** Open the socket (and clear a previous close's intentional latch). */
export interface IngestConnectControl {
  kind: "connect";
}

/** Close the socket on purpose: no reconnect follows. */
export interface IngestCloseControl {
  kind: "close";
}

/** Drop the socket and reconnect now. */
export interface IngestForceReconnectControl {
  kind: "force-reconnect";
}

/** Close the socket as a server hang-up would: the reconnect logic runs. */
export interface IngestForceCloseForTestControl {
  kind: "force-close-for-test";
}

/** The page's accumulated feed subscription. Monotonic: it only grows. */
export interface IngestSubscribeControl {
  kind: "subscribe";
  feeds: number[];
}

/** One outbound frame's payload; `bytes` is transferred. */
export interface IngestSendControl {
  kind: "send";
  feedId: number;
  flags: number;
  bytes: ArrayBuffer;
}

/** The page's visibility, which drives the wire's wake pulse. */
export interface IngestVisibilityControl {
  kind: "visibility";
  visible: boolean;
}

/** The display period the sender paces batches at. */
export interface IngestDisplayPeriodControl {
  kind: "display-period";
  periodMs: number;
}

/** The motion gate closed (or a nested hold arrived): post nothing until release or `capMs`. */
export interface IngestMotionHeldControl {
  kind: "motion";
  held: true;
  capMs: number;
}

/** The motion gate opened: post what accumulated. */
export interface IngestMotionReleasedControl {
  kind: "motion";
  held: false;
}

/** A session mirror opened; `handle` is minted per mirror and never reused. */
export interface IngestSessionOpenControl {
  kind: "session-open";
  handle: string;
  tugSessionId: string;
  displayLabel: string;
  sessionMode: "new" | "resume";
  restoreWindowTurns: number;
  transcriptTurnCap?: number;
}

/** A session mirror was disposed: drop its engine and cancel its timers. */
export interface IngestSessionCloseControl {
  kind: "session-close";
  handle: string;
}

/** A local action, already assembled on the page, for the session's reducer. */
export interface IngestSessionActionControl<TEvent = unknown> {
  kind: "session-action";
  handle: string;
  seq: number;
  event: TEvent;
}

/** A decoded frame a test feeds one session directly. */
export interface IngestSessionTestFrameControl {
  kind: "session-test-frame";
  handle: string;
  seq: number;
  feedId: number;
  decoded: unknown;
}

/**
 * A find query for one session's rendered text, which the host forwards to
 * tugcast and whose answer it routes back to `handle` as a `find-result`.
 */
export interface IngestFindControl {
  kind: "find";
  handle: string;
  requestId: string;
  query: string;
  options: RenderFindControl["options"];
  limit: number;
  units: string[];
  mountedUnits: string[];
}

/**
 * The page applied the batch it was last posted. A host that waits on the
 * page posts its next batch only after this arrives, so a page slower than
 * the period sees fewer, fuller batches rather than a queue that grows.
 */
export interface IngestBatchAppliedControl {
  kind: "batch-applied";
}

export type IngestControl<TEvent = unknown> =
  | IngestInitControl
  | IngestConnectControl
  | IngestCloseControl
  | IngestForceReconnectControl
  | IngestForceCloseForTestControl
  | IngestSubscribeControl
  | IngestSendControl
  | IngestVisibilityControl
  | IngestDisplayPeriodControl
  | IngestMotionHeldControl
  | IngestMotionReleasedControl
  | IngestSessionOpenControl
  | IngestSessionCloseControl
  | IngestSessionActionControl<TEvent>
  | IngestSessionTestFrameControl
  | IngestFindControl
  | IngestBatchAppliedControl;

// ---------------------------------------------------------------------------
// Sender → page: patches
// ---------------------------------------------------------------------------

// Every patch names its session — the open handle of the mirror it is for,
// never a bare `tug_session_id` — or `null` for a page-wide patch.

/** A raw frame on a feed the page decodes itself; `bytes` is transferred. */
export interface IngestFramePatch {
  kind: "frame";
  session: null;
  payload: { feedId: number; bytes: ArrayBuffer };
}

/** The socket's lifecycle, applied in the order the page's lifecycle expects. */
export interface IngestWireStatePatch {
  kind: "wire-state";
  session: null;
  payload: {
    state: "will-open" | "open" | "closed" | "reconnecting";
    handshake?: IngestHandshake;
    closeCode?: number;
    closeReason?: string | null;
  };
}

/** The disconnect banner's state. */
export interface IngestDisconnectStatePatch {
  kind: "disconnect-state";
  session: null;
  payload: IngestDisconnectState;
}

/** A dev-log entry or a session-lifecycle line the page replays into its own stores. */
export interface IngestLogPatch {
  kind: "log";
  session: string | null;
  payload:
    | { level: "debug" | "info" | "warn" | "error"; source: string; message: string; data?: unknown }
    | { lifecycle: { tag: string; fields: Record<string, unknown> } };
}

/** Streamed text and live usage: last-wins per path within a batch. */
export interface IngestStreamPatch {
  kind: "stream";
  session: string;
  payload: { writes: IngestStreamWrite[]; textGrew: boolean };
}

/**
 * A session's structure, as field diffs and transcript splices against what
 * was last posted. It publishes: the mirror notifies once when the batch
 * carrying it has been applied. An open replay fold posts none, and the
 * flush that closes it carries everything the fold reduced.
 */
export interface IngestStructurePatch<TState = unknown, TEntry = unknown, TPerf = unknown> {
  kind: "structure";
  session: string;
  payload: {
    state?: Partial<TState>;
    transcript?: TranscriptSplice<TEntry>[];
    meta?: IngestSessionMeta<TPerf>;
  };
}

/** One run-progress operation for the session's progress store, in batch order. */
export interface IngestProgressPatch {
  kind: "progress";
  session: string;
  payload:
    | { op: "heartbeat"; toolUseId: string; elapsedSeconds: number; nowMs: number }
    | { op: "report"; frame: unknown; nowMs: number; runningJob: boolean }
    | { op: "close"; toolUseId: string }
    | { op: "clear" };
}

/** An effect only the page can carry out. */
export interface IngestEffectPatch {
  kind: "effect";
  session: string;
  payload:
    | { effect: "confirm-written-paths"; paths: string[] }
    | { effect: "local-state-change"; change: IngestLocalStateChange }
    | { effect: "atom-bytes"; entries: IngestAtomBytes[] };
}

/** A decoded CODE_OUTPUT frame routed to a narrow per-session store. */
export interface IngestRoutedFramePatch {
  kind: "routed-frame";
  session: string;
  payload: { feedId: number; type: string; decoded: unknown };
}

/** Every action and test frame through `seq` has been reduced and its patches posted. */
export interface IngestAckPatch {
  kind: "ack";
  session: string;
  payload: { seq: number };
}

/**
 * What a Message's `.rendered` path holds once the engine has written it:
 * `{ pending: true }` before tugcast's first render arrives, a record of
 * tugcast's emission with the engine's `streaming` and `current` facts, or
 * `null` for "parse yourself". A Message never written is the page's to
 * parse, as before.
 */
export type RenderedState =
  | { pending: true }
  | { streaming: boolean; current: boolean; message: RenderedMessageWire }
  | null;

/**
 * tugcast's renders for one session's Messages. Each `message` is the
 * emission as it came — the whole block list, HTML only for new hashes —
 * and the page merges it into the record it holds; a `pending` or `null`
 * state replaces the record.
 */
export interface IngestRenderedBlocksPatch {
  kind: "rendered-blocks";
  session: string;
  payload: { messages: { turnKey: string; messageKey: string; state: RenderedState }[] };
}

/** tugcast's answer to a find query, for the session that asked. */
export interface IngestFindResultPatch {
  kind: "find-result";
  session: string;
  payload: FindResultFrame;
}

export type IngestPatch<TState = unknown, TEntry = unknown, TPerf = unknown> =
  | IngestFramePatch
  | IngestWireStatePatch
  | IngestDisconnectStatePatch
  | IngestLogPatch
  | IngestStreamPatch
  | IngestStructurePatch<TState, TEntry, TPerf>
  | IngestProgressPatch
  | IngestEffectPatch
  | IngestRoutedFramePatch
  | IngestAckPatch
  | IngestRenderedBlocksPatch
  | IngestFindResultPatch;

/** One posted batch; its entries apply in order, in one task. */
export interface IngestBatch<TState = unknown, TEntry = unknown, TPerf = unknown> {
  kind: "batch";
  entries: IngestPatch<TState, TEntry, TPerf>[];
}

// ---------------------------------------------------------------------------
// The kind vocabularies
// ---------------------------------------------------------------------------

/** Every patch kind, one literal per line. */
export const INGEST_PATCH_KINDS = [
  "frame",
  "wire-state",
  "disconnect-state",
  "log",
  "stream",
  "structure",
  "progress",
  "effect",
  "routed-frame",
  "ack",
  "rendered-blocks",
  "find-result",
] as const satisfies readonly IngestPatch["kind"][];

export type IngestPatchKind = (typeof INGEST_PATCH_KINDS)[number];

/** Every control kind, one literal per line. */
export const INGEST_CONTROL_KINDS = [
  "init",
  "connect",
  "close",
  "force-reconnect",
  "force-close-for-test",
  "subscribe",
  "send",
  "visibility",
  "display-period",
  "motion",
  "session-open",
  "session-close",
  "session-action",
  "session-test-frame",
  "find",
  "batch-applied",
] as const satisfies readonly IngestControl["kind"][];

export type IngestControlKind = (typeof INGEST_CONTROL_KINDS)[number];

// The `satisfies` clauses reject a listed kind a union lacks; these reject a
// union kind a list lacks.
type MissingPatchKind = Exclude<IngestPatch["kind"], IngestPatchKind>;
const _patchKindsComplete: [MissingPatchKind] extends [never] ? true : MissingPatchKind = true;
void _patchKindsComplete;
type MissingControlKind = Exclude<IngestControl["kind"], IngestControlKind>;
const _controlKindsComplete: [MissingControlKind] extends [never] ? true : MissingControlKind = true;
void _controlKindsComplete;
