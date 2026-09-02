/**
 * `SessionTranscriptDataSource` — adapter that surfaces a `CodeSessionStore`
 * snapshot as a `TugListViewDataSource`.
 *
 * Row contract — three cell kinds, message-derived rows (Spec S01, [P01]):
 *
 *   Rows derive from each turn's `messages` stream, not a fixed per-turn
 *   template. Walking a turn's `messages` ({@link walkTurnGroups}):
 *
 *   - `user`  — one row per `user_message` Message, wherever it appears
 *               in the stream. A normal turn opens with one; a steered
 *               (merged) message lands as another `user` row mid-turn
 *               ([P07]). Carries the submission's text + timestamp.
 *               A wake / continuation / orphan turn has none.
 *   - `assistant` — one row per maximal contiguous run of non-`user_message`
 *               Messages. The renderer iterates that run and dispatches each
 *               Message kind to its inline surface (`assistant_text` →
 *               `TugMarkdownBlock`; `assistant_thinking` →
 *               `SessionThinkingBlock`; `tool_use` → tool block;
 *               `system_note` → subdued note / divider). The in-flight turn
 *               always carries a trailing `assistant` row (the live progress
 *               row / forthcoming continuation) even before any assistant
 *               Message has streamed.
 *   - `ghost` — one per `queuedSends` entry, painted at the foot for the
 *               retractable queued-send overlay.
 *
 *   For today's single-user turns (one head `user_message`, then assistant
 *   content) the walk yields the identical `[user, assistant]` pair — the
 *   projection is behavior-preserving.
 *
 * Index layout (in flat-row order):
 *
 *   committed turn rows  one or more rows per committed turn, in
 *                        `messages` order (a wake turn is a single
 *                        `assistant` row; a normal turn is `user` +
 *                        `assistant`; a merged turn interleaves more).
 *   in-flight turn rows  the same message-derived shape for `activeTurn`
 *                        (only when present), with a guaranteed trailing
 *                        `assistant` row.
 *   ghost rows           one per `queuedSends` entry, at the tail.
 *
 *   The last two are pending submissions, so committed `shell` rows at the
 *   transcript's tail merge INTO that block by timestamp rather than sitting
 *   above all of it — a `$` exchange run after the user hit submit paints
 *   below their message, where the commit will seat it ([D111]).
 *
 * **Single `"assistant"` kind, zero remounts per turn.** Earlier revisions
 * split the assistant row into `"code-streaming"` and `"code-committed"`
 * with a corresponding two-entry `cellRenderers` map. That split
 * forced React to swap component types at every `turn_complete`,
 * unmounting the cell wrapper and tearing down its `TugMarkdownBlock`
 * subtree — manifesting as a user-visible scroll jump because
 * `scrollHeight` collapsed below `clientHeight` for a frame and the
 * browser silently clamped `scrollTop` to 0. The unified kind plus a
 * stable per-turn `turnKey` (generated at `handleSend`, copied onto
 * `TurnEntry` at `handleTurnComplete`) gives the React reconciler an
 * identical key + identical component type on either side of
 * `turn_complete`, so the cell wrapper survives unchanged.
 *
 * The adapter does *not* hold its own subscription against the
 * `CodeSessionStore`; `subscribe` proxies straight through, and reads
 * always go through `codeSessionStore.getSnapshot()` (memoized between
 * dispatches per [L02], [D11]). `getVersion()` returns the snapshot
 * reference, which is `Object.is`-stable between non-mutating
 * dispatches and changes identity on every reducer tick.
 *
 * Cell renderers downstream call `rowAt(index)` to read the typed row
 * payload without round-tripping through the snapshot themselves.
 *
 * Laws / decisions:
 *  - [L02] data source enters React via `useSyncExternalStore` only;
 *    the adapter exposes the `subscribe` / `getVersion` shape that
 *    contract requires.
 *  - [L23] preserves user-visible state (scroll position AND content)
 *    across what was previously a teardown event. The cell wrapper
 *    now survives every transition within a turn's life — the
 *    in-flight → committed boundary (in-session, [L26]) AND the
 *    cold-boot rehydration boundary (cross-session).
 *  - [L26] mount identity stable across the in-flight → committed
 *    transition: the React key (`${turnKey}-assistant`), the rendered
 *    component (`AssistantTurnCell`), and the renderer lambda in
 *    `cellRenderers` are all byte-identical across the boundary.
 *    L23 falls out of L26 here — preserved mount identity is
 *    upstream of preserved state.
 *  - [D02] single-section flat list; flat indices, no `IndexPath`.
 *  - [D07] sequence-substrate row decisions are driven by the presence
 *    (or absence) of a `user_message` Message at the head of
 *    `turn.messages` / `activeTurn.messages` — the [D06] empty-text
 *    sentinel retires.
 */

import { useEffect, useMemo } from "react";

import { recordRowMemoHit } from "@/lib/markdown/parse-counters";
import type { CodeSessionStore } from "@/lib/code-session-store";
import type {
  ActiveTurnSnapshot,
  CodeSessionSnapshot,
  QueuedSend,
  TurnEntry,
  UserMessage,
} from "@/lib/code-session-store";
import type { TurnOrigin } from "@/lib/code-session-store/types";
import { isInkOrigin } from "@/lib/code-session-store/types";
import { deriveContextWindows } from "@/lib/code-session-store/end-state";
import type { ContextWindowStep } from "@/lib/code-session-store/end-state";
import { agentTokensForTurn } from "@/lib/code-session-store/select-jobs";
import {
  matchesArcReceipt,
  parseArcReceipt,
} from "@/components/tugways/cards/session-arc-receipt-block";
import { parseJoinReceipt } from "@/components/tugways/cards/session-join-receipt-block";
import { matchesJoinReceipt } from "@/lib/landing-mode";
import type { TugListViewDataSource } from "@/components/tugways/tug-list-view";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Kinds the transcript adapter emits, matched against the
 * `cellRenderers` map the Session card registers.
 *
 * **One kind per row identity** ([L26]). The assistant row uses a
 * single `"assistant"` kind for its entire life — both while streaming and
 * after commit. Earlier revisions split the row into `"code-streaming"`
 * and `"code-committed"`, but that forced the `cellRenderers` map to
 * hold two separate entries for what is structurally one row. With two
 * entries, a future maintainer writing two inline lambdas — perfectly
 * idiomatic React — silently re-introduces a scroll-jump-to-top
 * regression: each kind resolves to a different function identity,
 * which is an L26 violation on the renderer-reference axis, so React
 * unmounts the cell wrapper at the `turn_complete` boundary even
 * though it should survive intact. The unified kind eliminates that
 * class of bug at the source: the map literally cannot hold two
 * entries because the row only reports one kind. The render component
 * branches on row payload presence (`row.turn !== undefined` ⇒
 * committed) for the small chrome differences that genuinely vary
 * by phase.
 *
 * `"ghost"` is a third kind, and — unlike a `code-*` split — a sound
 * one: a ghost row is a *standalone* row (one queued send, no turn
 * pair), a genuinely distinct identity, not one row's life split in
 * two. It never morphs in place into a `user` / `assistant` row: when a
 * queued send flushes, its ghost row (keyed `${turnKey}-ghost`)
 * unmounts and the in-flight pair (keyed `${turnKey}-user` / `-assistant`)
 * mounts — a real queued -> sent transition, correctly a remount.
 */
export type SessionTranscriptCellKind =
  | "user"
  | "assistant"
  | "ghost"
  | "shell"
  | "refs";

/**
 * Typed row descriptor returned by `rowAt(index)`. Cell renderers
 * narrow on `kind` and read the matching payload field — `turn` for
 * any committed row (`user` or `assistant`), `activeTurn` for any in-flight
 * row. The unified `"assistant"` kind covers both in-flight and committed
 * assistant rows; the renderer distinguishes the two by
 * `row.turn !== undefined`.
 */
export interface SessionRowDescriptor {
  kind: SessionTranscriptCellKind;
  /** Set for every committed row (`user` and `assistant`). */
  turn?: TurnEntry;
  /**
   * The committed turn's signed per-turn token count — `window(N) −
   * window(N−1)` from the transcript window-walk (`deriveContextWindows`),
   * with zero-usage carry-forward. Set only on the bracket's **last**
   * assistant row ([P02]) — the single place the Z1B per-turn badge
   * renders. `undefined` for user rows, earlier assistant runs of a
   * merged turn, and in-flight rows. Negative at a `/compact` turn.
   */
  perTurnTokens?: number;
  /**
   * Total tokens spent by the subagents this turn launched — computed
   * by `agentTokensForTurn` from the job ledger (live, climbing with
   * `task_progress` ticks) or the turn-attached structured results
   * (reload). Kept SEPARATE from `perTurnTokens`: subagents burn their
   * tokens in their own contexts, which never enter the main session's
   * window — Z1B shows the two figures side by side rather than one
   * misleading sum. Set only where `perTurnTokens` is set; `0` when the
   * turn launched no agents.
   */
  agentTokens?: number;
  /**
   * Set for every in-flight row (`user` and `assistant`). Carries the
   * substrate's `ActiveTurnSnapshot` so the cell can read the live
   * Message sequence + the user submission (when present) without
   * a second snapshot read.
   */
  activeTurn?: ActiveTurnSnapshot;
  /**
   * The specific `user_message` this row renders (Spec S01). For a
   * turn opener this is the head message; for a merged/steered mid-turn
   * row it is that message — never re-derived from `messages[0]`. Set
   * on every `user` row (committed or in-flight); `undefined` otherwise.
   */
  userMessage?: UserMessage;
  /**
   * Half-open `[messageStart, messageEnd)` slice of the owning turn's
   * `messages` that an `assistant` row renders — its maximal non-user
   * run (Spec S01). The cell slices `turn.messages` / `activeTurn.messages`
   * by these indices, so the descriptor keeps the stable full-array
   * reference (the memo gate stays reference-stable for committed rows).
   * `undefined` for non-assistant rows; an empty slice
   * (`messageStart === messageEnd`) for the in-flight turn's forthcoming
   * trailing row.
   */
  messageStart?: number;
  messageEnd?: number;
  /**
   * True on the bracket's last `assistant` row — the row that carries
   * the committed-turn end-state chrome (Z1B) and per-turn badge ([P02]).
   * A single-assistant turn's only row is its last. `false`/`undefined`
   * on user rows, earlier assistant runs, and ghost rows.
   */
  isLastAssistantOfTurn?: boolean;
  /** Set for a `ghost` row only — the queued send it paints. */
  queued?: QueuedSend;
  /**
   * Set on a `shell` row: whether this row's `arc stopped` receipt has been
   * answered by a later row (Spec S04). `false` on every other shell row and
   * absent on every other kind.
   *
   * It rides the descriptor rather than an accessor beside
   * {@link SessionTranscriptDataSource.shellOrdinalForRow} because it is the
   * one row fact that changes **retroactively**: a join receipt arriving now
   * demotes a stop row from twenty turns ago. An accessor read inside the cell
   * is invisible to the `React.memo` gate; the descriptor is what the gate
   * compares.
   */
  arcStopSuperseded?: boolean;
  /**
   * Stable per-turn React-key seed. Present on every row (committed,
   * in-flight, or ghost). The unified `AssistantTurnCell` derives its
   * per-Message streaming paths from this key plus each Message's
   * `messageKey`. Crucially, the value is byte-identical across the
   * inflight → committed transition (the reducer copies it from
   * `pendingTurn` onto `TurnEntry`), so the cell's children observe
   * the same PropertyStore paths forever — no streaming-subscription
   * re-init, no DOM reset, no `scrollHeight` collapse.
   */
  turnKey: string;
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

/**
 * One logical message group within a turn → one transcript row
 * (Spec S01). A `user` group wraps a single `user_message`; an
 * `assistant` group wraps a maximal contiguous run of non-`user_message`
 * Messages, rendered inline.
 */
export interface RowGroup {
  kind: "user" | "assistant" | "shell" | "refs";
  /** Inclusive start index into the turn's `messages`. */
  start: number;
  /**
   * Exclusive end index. A `user` group is always `[start, start+1)`.
   * The synthetic trailing `assistant` row on the in-flight turn (the
   * forthcoming response, before any assistant Message has streamed)
   * has `start === end === messages.length` — an empty slice.
   */
  end: number;
}

/**
 * Group a turn's `messages` into rows per Spec S01: each `user_message`
 * opens a `user` group; each maximal run of non-user Messages forms one
 * `assistant` group, in arrival order.
 *
 * `ensureTrailingAssistant` (the in-flight turn) guarantees a final
 * `assistant` row even before any assistant Message has streamed — the
 * row that shows the live progress indicator and, after a mid-turn steer,
 * the forthcoming continuation. A committed turn renders exactly its
 * Messages with no synthetic row.
 */
export function walkTurnGroups(
  messages: ReadonlyArray<TurnEntry["messages"][number]>,
  ensureTrailingAssistant: boolean,
  origin?: TurnOrigin,
): RowGroup[] {
  // An ink turn is a single row — never split into user/assistant runs
  // ([P06]). Its one message (a shell exchange, a refs run) is the row.
  if (origin === "shell") {
    return [{ kind: "shell", start: 0, end: messages.length }];
  }
  if (origin === "refs") {
    return [{ kind: "refs", start: 0, end: messages.length }];
  }
  const groups: RowGroup[] = [];
  const n = messages.length;
  let i = 0;
  while (i < n) {
    if (messages[i].kind === "user_message") {
      groups.push({ kind: "user", start: i, end: i + 1 });
      i += 1;
      continue;
    }
    const start = i;
    while (i < n && messages[i].kind !== "user_message") i += 1;
    groups.push({ kind: "assistant", start, end: i });
  }
  if (
    ensureTrailingAssistant &&
    (groups.length === 0 || groups[groups.length - 1].kind === "user")
  ) {
    groups.push({ kind: "assistant", start: n, end: n });
  }
  return groups;
}

/**
 * Per-flat-row descriptor — the projection's source of truth. Every
 * `idForIndex` / `kindForIndex` / `rowAt` read resolves through the
 * slot array, so the message walk happens once per snapshot (memoized
 * in {@link SessionTranscriptDataSource.layout}).
 */
export interface RowSlot {
  /** Cell kind the renderer narrows on. */
  cellKind: SessionTranscriptCellKind;
  /** The message group this row renders (`undefined` for a ghost row). */
  group?: RowGroup;
  /** Owning committed turn index; `-1` for an in-flight or ghost row. */
  turnIndex: number;
  /** True when this row belongs to the in-flight (`activeTurn`) turn. */
  active: boolean;
  /** `queuedSends` index for a ghost row; `-1` otherwise. */
  queuedIndex: number;
  /**
   * 0-based ordinal of this `assistant` run within its turn; `-1` for a
   * non-assistant row. The first run (ordinal 0) keys as
   * `${turnKey}-assistant` — the no-remount React key that survives
   * inflight → committed ([L26]); later runs (merged turns only) key as
   * `${turnKey}-assistant-${ordinal}`, stable under append.
   */
  assistantRunOrdinal: number;
  /**
   * True on the turn's last `assistant` run — the per-turn-telemetry /
   * end-state anchor ([P02]). Always false for non-assistant rows.
   */
  isLastAssistantOfTurn: boolean;
  /**
   * 0-based ordinal of this `user` row *within its turn*; `-1` for a
   * non-user row. Mirrors {@link assistantRunOrdinal}. A normal turn's
   * opener is `0`; steering merges additional user messages into the turn,
   * which get `1`, `2`, … in send-order. Combined with the session-true
   * turn number this forms the durable badge address ([P09]): `#u{turn}`
   * when `0`, `#u{turn}.{ordinal+1}` otherwise. Durable across reopen — it
   * keys on the turn's own fixed message order, not the loaded window.
   */
  userRowOrdinal: number;
  /**
   * 1-based ordinal of this `shell` row among ALL shell rows in the
   * session; `0` for a non-shell row. Unlike the user/assistant address
   * (which counts *turns* and needs the window's `firstLoadedTurnIndex`
   * base), the shell counter is its own sequence — `#s1`, `#s2`, …
   * independent of the surrounding Claude turns. It needs no window base
   * because the shell ledger restores the WHOLE session's exchanges
   * ([P07], `list_shell_exchanges` sends no window), so every shell row
   * is always loaded and the count is complete and durable.
   */
  shellRowOrdinal: number;
  /**
   * 1-based ordinal of this `refs` row — the number behind its `#r{n}`
   * badge; `0` for a non-refs row. Assigned in the same single pass as
   * {@link shellRowOrdinal} and complete for the same reason: the refs
   * ledger restores the session's latest run whole, so every refs row is
   * always loaded.
   */
  refsRowOrdinal: number;
  /**
   * True on a `shell` row carrying an `arc stopped` receipt that a **later**
   * row in the same session has answered — a join receipt for the same dash,
   * or a later arc receipt for it (Spec S04). `false` everywhere else.
   *
   * Derived, never written: a stop receipt's bytes are a frozen record of what
   * the server said at that moment, and this says only that the transcript
   * itself went on to contradict its instruction. The last stop for a dash is
   * never superseded, so an arc that stopped and stayed stopped keeps its live
   * red sentence — which is what makes the demotion mean something.
   */
  arcStopSuperseded: boolean;
}

/**
 * Precomputed row layout for one snapshot. The data source memoizes
 * this per snapshot identity ({@link SessionTranscriptDataSource.layout})
 * so per-`rowAt` calls don't re-walk the transcript.
 */
export interface RowLayout {
  /** Total number of rows the data source exposes for this snapshot. */
  totalRows: number;
  /** Per-flat-row slot descriptor, in flat-row order. */
  slots: ReadonlyArray<RowSlot>;
  /**
   * For each turnIndex, the flat row index where that committed turn's
   * first row lives. The turn-depth / restore-anchor helpers resolve a
   * turn to its first row through this.
   */
  turnStartRow: ReadonlyArray<number>;
  /** Parallel to {@link turnStartRow}: the number of rows each committed turn contributes. */
  turnRowCount: ReadonlyArray<number>;
  /** Flat row index where the in-flight rows start; -1 if no in-flight. */
  activeStartRow: number;
  /** Flat row index where ghost rows start; equals {@link totalRows} when there are no ghosts. */
  ghostStartRow: number;
}

/**
 * Append the slots for one turn's message groups, returning the updated
 * assistant-run ordinal bookkeeping. Shared by the committed and
 * in-flight walks so both number their assistant runs identically.
 */
function pushTurnSlots(
  slots: RowSlot[],
  groups: ReadonlyArray<RowGroup>,
  turnIndex: number,
  active: boolean,
): void {
  let lastAssistantGroupIndex = -1;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].kind === "assistant") lastAssistantGroupIndex = i;
  }
  let assistantOrdinal = 0;
  let userOrdinal = 0;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const isAssistant = group.kind === "assistant";
    const isUser = group.kind === "user";
    slots.push({
      cellKind: group.kind,
      group,
      turnIndex,
      active,
      queuedIndex: -1,
      assistantRunOrdinal: isAssistant ? assistantOrdinal : -1,
      userRowOrdinal: isUser ? userOrdinal : -1,
      isLastAssistantOfTurn: isAssistant && i === lastAssistantGroupIndex,
      // Session-wide 1-based shell counter, assigned in a single pass
      // in `buildCommittedLayout` (a per-turn walk can't see the
      // cross-turn running count, and only committed turns can be
      // shell rows); `0` until then and for non-shell rows.
      shellRowOrdinal: 0,
      refsRowOrdinal: 0,
      // Set by the supersession pass in `buildCommittedLayout` for the same
      // reason: it needs the rows that come *after* this one, which a per-turn
      // walk cannot see.
      arcStopSuperseded: false,
    });
    if (isAssistant) assistantOrdinal += 1;
    if (isUser) userOrdinal += 1;
  }
}

/**
 * The committed-turns portion of a {@link RowLayout} — everything
 * derivable from `snap.transcript` alone. Split out so the expensive
 * whole-transcript walk memoizes on the transcript array's identity
 * (which changes only at turn boundaries), while streaming deltas —
 * which replace the snapshot per notify — recompute only the cheap
 * in-flight/ghost tail in {@link composeRowLayout}.
 */
interface CommittedLayout {
  slots: ReadonlyArray<RowSlot>;
  turnStartRow: ReadonlyArray<number>;
  turnRowCount: ReadonlyArray<number>;
}

/** Walk the committed turns into row slots, shell ordinals included. */
function buildCommittedLayout(
  transcript: ReadonlyArray<TurnEntry>,
): CommittedLayout {
  const slots: RowSlot[] = [];
  const turnStartRow: number[] = new Array(transcript.length);
  const turnRowCount: number[] = new Array(transcript.length);
  for (let t = 0; t < transcript.length; t++) {
    turnStartRow[t] = slots.length;
    pushTurnSlots(slots, walkTurnGroups(transcript[t].messages, false, transcript[t].origin), t, false);
    turnRowCount[t] = slots.length - turnStartRow[t];
  }
  // Number the shell rows in one pass: a session-wide 1-based counter in
  // flat-row (timestamp-interleave) order. The whole session's shell
  // exchanges are always loaded ([P07]), so this count is complete —
  // `#s1`, `#s2`, … a sequence of its own, independent of the Claude turns
  // interleaved among them. Only committed turns can be shell rows, so
  // the numbering lives entirely in this walk.
  // The refs rows carry their own `#r` sequence in the same pass, for the
  // same reason: the refs ledger restores the session's latest run whole.
  let shellCount = 0;
  let refsCount = 0;
  for (const slot of slots) {
    if (slot.cellKind === "shell") {
      shellCount += 1;
      slot.shellRowOrdinal = shellCount;
    } else if (slot.cellKind === "refs") {
      refsCount += 1;
      slot.refsRowOrdinal = refsCount;
    }
  }
  // Then, in a second walk, demote the stop receipts a later row has answered
  // (Spec S04). It reads the rows *after* each candidate, so it cannot ride
  // the forward pass above.
  markSupersededArcStops(slots, transcript);
  return { slots, turnStartRow, turnRowCount };
}

/**
 * Spec S04 — mark every `arc stopped` receipt a later row has answered.
 *
 * A stop receipt is frozen text: the server wrote `resume with tugtool dash run
 * <name>` at a moment when that was the truth, and a transcript replays its
 * rows from the record forever. So the arc that stopped, was resumed, and
 * joined leaves a red instruction standing over work that has already landed.
 * What supersedes it is a fact the same transcript already carries — a join
 * receipt for that dash, or a later arc receipt for it — and this pass reads it
 * rather than rewriting anything.
 *
 * One backward walk, carrying the dash names already seen as a superseder, so
 * the whole thing is O(rows) beside the ordinal pass it follows. The **last**
 * stop for a dash is never superseded, because nothing later answers it: an arc
 * that stopped and stayed stopped keeps its live sentence, which is the only
 * reason the demotion carries information.
 *
 * A row whose output does not parse contributes nothing in either direction. A
 * join receipt that fails to parse therefore leaves a stop it should have
 * answered still live — the safe direction, since a stale instruction is a
 * nuisance and a demoted live one is a lost instruction ([R02]).
 */
function markSupersededArcStops(
  slots: ReadonlyArray<RowSlot>,
  transcript: ReadonlyArray<TurnEntry>,
): void {
  const answered = new Set<string>();
  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i];
    if (slot.cellKind !== "shell") continue;
    const group = slot.group;
    if (group === undefined) continue;
    // The same access `ShellTurnCell` makes: a shell row is one message, the
    // whole turn.
    const message = transcript[slot.turnIndex]?.messages[group.start];
    if (message === undefined || message.kind !== "shell_exchange") continue;

    if (matchesJoinReceipt(message.command)) {
      const join = parseJoinReceipt(message.output);
      if (join !== null) answered.add(join.dash);
      continue;
    }
    if (!matchesArcReceipt(message.command)) continue;
    const arc = parseArcReceipt(message.output);
    if (arc === null) continue;
    if (arc.outcome === "stopped") {
      if (answered.has(arc.dash)) slot.arcStopSuperseded = true;
    }
    // A complete arc answers an earlier stop, and so does a later stop: both
    // say the run went on past the sentence the earlier row is still giving.
    answered.add(arc.dash);
  }
}

/**
 * The pending (not-yet-committed) submissions, in submission order: the
 * in-flight turn first, then one entry per queued send. Each carries the
 * wall-clock the user posted it, which is what a trailing committed shell
 * row sorts against in {@link composeRowLayout}.
 */
interface PendingItem {
  kind: "active" | "ghost";
  /** `queuedSends` index for a ghost; `-1` for the in-flight turn. */
  queuedIndex: number;
  submitAt: number;
}

/**
 * The trailing run of committed `shell`-origin turns whose exchange started
 * AFTER `firstSubmitAt` — the rows that belong below a pending submission
 * rather than above it. Returns the turn indices in transcript order (each
 * shell turn is exactly one row, {@link walkTurnGroups}), empty when the
 * transcript's tail isn't shell or every trailing shell row predates the
 * submission.
 *
 * The walk mirrors `appendTurnInterleavingInk` in the reducer exactly:
 * it stops at the first non-shell turn, and it moves a shell row only when
 * that row's timestamp is strictly greater. Because it is the same rule,
 * the row lands live where the commit will later seat it — no re-order,
 * no jump, at `turn_complete`.
 */
function trailingInkAfter(
  transcript: ReadonlyArray<TurnEntry>,
  firstSubmitAt: number,
): number[] {
  const moved: number[] = [];
  for (let t = transcript.length - 1; t >= 0; t--) {
    const turn = transcript[t];
    if (!isInkOrigin(turn.origin)) break;
    if (turnSortTs(turn) <= firstSubmitAt) break;
    moved.push(t);
  }
  return moved.reverse();
}

/** A turn's sort key: its opener Message's creation time. Mirrors the reducer's. */
function turnSortTs(turn: TurnEntry): number {
  return turn.messages[0]?.createdAt ?? turn.endedAt;
}

/**
 * Complete a {@link RowLayout} from a (possibly memoized) committed
 * walk plus the snapshot's in-flight turn and ghost rows — the cheap
 * per-snapshot tail, O(active-turn messages + queued sends).
 *
 * The tail is not a plain append. A `$`-route exchange commits into the
 * transcript the moment it starts ([D111]), while a submission the user
 * has already made sits OUTSIDE the committed transcript until its turn
 * ends — so appending would paint a shell command the user ran *after*
 * hitting submit above the message they submitted, until the turn
 * completed and the reducer's interleave slid it back. Here the trailing
 * shell rows are merged into the pending block by timestamp under the
 * same rule the commit uses, so the live order is the final order.
 */
function composeRowLayout(
  committed: CommittedLayout,
  snap: CodeSessionSnapshot,
): RowLayout {
  // A suppressed in-flight turn (the `/compact` seed) contributes zero
  // rows — it streams to claude but never shows in the transcript.
  const active =
    snap.activeTurn !== null && snap.activeTurn.suppressed
      ? null
      : snap.activeTurn;
  const pending: PendingItem[] = [];
  if (active !== null) {
    pending.push({ kind: "active", queuedIndex: -1, submitAt: active.submitAt });
  }
  for (let q = 0; q < snap.queuedSends.length; q++) {
    pending.push({
      kind: "ghost",
      queuedIndex: q,
      submitAt: snap.queuedSends[q].queuedAt,
    });
  }
  if (pending.length === 0) {
    return {
      totalRows: committed.slots.length,
      slots: committed.slots,
      turnStartRow: committed.turnStartRow,
      turnRowCount: committed.turnRowCount,
      activeStartRow: -1,
      ghostStartRow: committed.slots.length,
    };
  }

  const moved = trailingInkAfter(snap.transcript, pending[0].submitAt);
  const cutRow =
    moved.length === 0
      ? committed.slots.length
      : committed.turnStartRow[moved[0]];
  // Patch only the moved turns' start rows; every turn ahead of the cut
  // keeps the memoized walk's index, so the copy is skipped when nothing moves.
  const movedStartRow: number[] =
    moved.length === 0 ? [] : committed.turnStartRow.slice();

  const tail: RowSlot[] = [];
  let activeStartRow = -1;
  let ghostStartRow = -1;
  let m = 0;
  const emitInk = (turnIndex: number): void => {
    movedStartRow[turnIndex] = cutRow + tail.length;
    // An ink turn is exactly one row, so its slot is the one at its start.
    tail.push(committed.slots[committed.turnStartRow[turnIndex]]);
    m += 1;
  };
  for (const item of pending) {
    // Ink rows that started before (or exactly at) this submission belong
    // above it — the reducer slides a committing turn left only past rows
    // strictly newer than itself.
    while (m < moved.length && turnSortTs(snap.transcript[moved[m]]) <= item.submitAt) {
      emitInk(moved[m]);
    }
    if (item.kind === "active") {
      activeStartRow = cutRow + tail.length;
      pushTurnSlots(tail, walkTurnGroups(active!.messages, true), -1, true);
      continue;
    }
    if (ghostStartRow === -1) ghostStartRow = cutRow + tail.length;
    tail.push({
      cellKind: "ghost",
      turnIndex: -1,
      active: false,
      queuedIndex: item.queuedIndex,
      assistantRunOrdinal: -1,
      userRowOrdinal: -1,
      isLastAssistantOfTurn: false,
      shellRowOrdinal: 0,
      refsRowOrdinal: 0,
      // A ghost row is a queued send, never a receipt.
      arcStopSuperseded: false,
    });
  }
  // Anything left is newer than every pending submission — it sits at the foot.
  while (m < moved.length) emitInk(moved[m]);

  const slots = committed.slots.slice(0, cutRow).concat(tail);
  return {
    totalRows: slots.length,
    slots,
    turnStartRow: moved.length === 0 ? committed.turnStartRow : movedStartRow,
    turnRowCount: committed.turnRowCount,
    activeStartRow,
    ghostStartRow: ghostStartRow === -1 ? slots.length : ghostStartRow,
  };
}

/**
 * Build the {@link RowLayout} for `snap`. Pure function — exported
 * for unit-test reuse. Walks each turn's `messages` once into row
 * groups (Spec S01), then accounts for the in-flight turn and ghosts.
 */
export function buildRowLayout(snap: CodeSessionSnapshot): RowLayout {
  return composeRowLayout(buildCommittedLayout(snap.transcript), snap);
}

// ---------------------------------------------------------------------------
// Index-layout helpers
// ---------------------------------------------------------------------------

/**
 * Sum the flat-row count contributed by the turns before `turnIndex`
 * (variable per turn — message-derived under Spec S01). Shared prefix
 * walk for the two row-index helpers below.
 */
function rowsBeforeTurn(
  turnIndex: number,
  transcript: ReadonlyArray<TurnEntry>,
): number {
  let cursor = 0;
  for (let i = 0; i < turnIndex; i++) {
    cursor += walkTurnGroups(transcript[i].messages, false, transcript[i].origin).length;
  }
  return cursor;
}

/**
 * List-view row index of committed turn `turnIndex`'s **first** user row
 * — the turn opener (`#u`) — or `-1` when the turn has no user row (a
 * wake / continuation / orphan). Kind-open: it locates the first `user`
 * group in the turn's message walk, with no origin/boolean assumption.
 * A merged turn's later user rows are not separately addressed here
 * ([P05] — merged messages aren't independent nav targets in v1).
 *
 * The transcript renders each row's `#NNNN` sequence badge as
 * `rowIndex + 1`.
 */
export function userRowIndexForTurn(
  turnIndex: number,
  transcript: ReadonlyArray<TurnEntry>,
): number {
  if (turnIndex < 0 || turnIndex >= transcript.length) return -1;
  const groups = walkTurnGroups(transcript[turnIndex].messages, false, transcript[turnIndex].origin);
  const offset = groups.findIndex((g) => g.kind === "user");
  if (offset === -1) return -1;
  return rowsBeforeTurn(turnIndex, transcript) + offset;
}

/**
 * List-view row index of committed turn `turnIndex`'s **last** assistant
 * row — the per-turn-telemetry anchor ([P02]): the per-turn token badge
 * and the popover's `#a{turn}` scroll target both ride the bracket's
 * final assistant row. For a single-assistant turn the last run IS the
 * only run, so this is behavior-preserving; for a merged turn it lands
 * on the continuation, not the first response. Every committed turn has
 * at least one assistant row; the `cursor` fallback covers the
 * degenerate case of a turn with no assistant content.
 */
export function assistantRowIndexForTurn(
  turnIndex: number,
  transcript: ReadonlyArray<TurnEntry>,
): number {
  if (turnIndex < 0 || turnIndex >= transcript.length) return -1;
  const cursor = rowsBeforeTurn(turnIndex, transcript);
  const groups = walkTurnGroups(transcript[turnIndex].messages, false, transcript[turnIndex].origin);
  let lastAssistant = -1;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].kind === "assistant") lastAssistant = i;
  }
  return lastAssistant === -1 ? cursor : cursor + lastAssistant;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Class-shaped adapter so consumers (and cell renderers) can narrow the
 * `TugListViewDataSource` generic parameter to `SessionTranscriptDataSource`
 * and call `rowAt(index)` without casting — mirrors the gallery card's
 * pattern.
 */
export class SessionTranscriptDataSource implements TugListViewDataSource {
  constructor(private readonly _codeSessionStore: CodeSessionStore) {}

  /**
   * Memo of the transcript window-walk, keyed by snapshot identity.
   * `rowAt` is called once per visible row per render; recomputing the
   * O(turns) walk on every call would be O(rows × turns) of pointless
   * churn (plus a fresh `cost[]` allocation each time). The snapshot
   * reference is `Object.is`-stable between dispatches, so caching on
   * it recomputes exactly once per change and shares the result
   * across every `rowAt` call in the same render.
   */
  private _windowsMemo: {
    snapshot: CodeSessionSnapshot;
    windows: ReadonlyArray<ContextWindowStep>;
  } | null = null;

  /**
   * Memo of the per-snapshot {@link RowLayout}. Same reference-stability
   * contract as `_windowsMemo`: recomputed exactly once per snapshot
   * identity.
   */
  private _layoutMemo: {
    snapshot: CodeSessionSnapshot;
    layout: RowLayout;
  } | null = null;

  /**
   * Memo of the committed-turns walk, keyed on the transcript array's
   * identity — which changes only at turn boundaries, NOT per streaming
   * delta. During a stream each new snapshot re-runs only the cheap
   * in-flight/ghost tail against this cached walk, so a token burst
   * costs O(active-turn messages) instead of O(whole transcript). The
   * cached slot objects are reused verbatim across compositions, which
   * also keeps committed cells' props reference-identical for their
   * `React.memo` guards.
   */
  private _committedMemo: {
    transcript: ReadonlyArray<TurnEntry>;
    committed: CommittedLayout;
  } | null = null;

  /**
   * The per-turn context-window walk for `snap`, computed once per
   * snapshot and reused. See {@link _windowsMemo}.
   */
  private contextWindows(
    snap: CodeSessionSnapshot,
  ): ReadonlyArray<ContextWindowStep> {
    if (this._windowsMemo !== null && this._windowsMemo.snapshot === snap) {
      return this._windowsMemo.windows;
    }
    const windows = deriveContextWindows(
      snap.transcript.map((t) => t.cost),
      snap.sessionInitTokens ?? 0,
      snap.transcript.map((t) => t.compactionPostTotal ?? null),
    );
    this._windowsMemo = { snapshot: snap, windows };
    return windows;
  }

  /**
   * The {@link RowLayout} for `snap`, computed once per snapshot and
   * reused. See {@link _layoutMemo}.
   */
  private layout(snap: CodeSessionSnapshot): RowLayout {
    if (this._layoutMemo !== null && this._layoutMemo.snapshot === snap) {
      return this._layoutMemo.layout;
    }
    let committed: CommittedLayout;
    if (
      this._committedMemo !== null &&
      this._committedMemo.transcript === snap.transcript
    ) {
      committed = this._committedMemo.committed;
    } else {
      committed = buildCommittedLayout(snap.transcript);
      this._committedMemo = { transcript: snap.transcript, committed };
    }
    const layout = composeRowLayout(committed, snap);
    this._layoutMemo = { snapshot: snap, layout };
    return layout;
  }

  /**
   * Total number of rows the data source exposes for the current
   * snapshot. Variable per turn — wake turns occupy a single row
   * (just the `assistant` row, no user row), normal turns
   * occupy two. See {@link RowLayout} for the per-turn shape.
   */
  numberOfItems(): number {
    return this.layout(this._codeSessionStore.getSnapshot()).totalRows;
  }

  /**
   * Whether older turns precede the loaded window — the signal the
   * "load previous" affordance keys off. Derived from the recency-window
   * metadata recorded at `replay_complete`; `false` when no window was
   * reported (a full / legacy load has everything). Deliberate
   * pagination is not a "hole": absence of older turns here means they
   * simply haven't been paged in yet.
   */
  hasOlder(): boolean {
    return (
      this._codeSessionStore.getSnapshot().replayWindow?.hasOlder ?? false
    );
  }

  /**
   * Absolute index (counting from the oldest committed turn) of the
   * oldest turn currently loaded, or `null` when no window was reported.
   * A load-previous request pages the older range that ends here.
   */
  oldestLoadedTurnIndex(): number | null {
    return (
      this._codeSessionStore.getSnapshot().replayWindow?.firstLoadedTurnIndex ??
      null
    );
  }

  /**
   * Turn-aware anchor depth ([P06]). Given the flat row index of the topmost
   * visible row, return its distance from the end in **turns** — the count of
   * turns from the anchored turn (inclusive) down to the newest loaded turn —
   * or `undefined` when the row is not a committed-turn row (an in-flight or
   * ghost row). The loaded window is always bottom-contiguous, so this depth
   * is invariant across a reload: it both sizes the resume window and
   * re-finds the anchored turn, with no row↔turn unit to bridge.
   */
  turnDepthFromEnd(rowIndex: number): number | undefined {
    const snap = this._codeSessionStore.getSnapshot();
    const n = snap.transcript.length;
    if (n === 0) return undefined;
    const layout = this.layout(snap);
    const slot = layout.slots[rowIndex];
    // Only a committed-turn row has a turn depth (an in-flight or ghost
    // row has `turnIndex === -1`).
    if (slot === undefined || slot.active || slot.cellKind === "ghost") {
      return undefined;
    }
    return n - slot.turnIndex;
  }

  /**
   * Inverse of {@link turnDepthFromEnd}: the flat row index of the anchored
   * turn's **first** row in the current window, or `null` when that turn is
   * older than everything loaded (the window must page in more turns first).
   * Both save (offset basis) and restore (relocation) resolve through this,
   * so the persisted pixel offset is measured within the anchored turn and
   * reproduces exactly.
   */
  rowIndexForTurnDepthFromEnd(turnDepth: number): number | null {
    const snap = this._codeSessionStore.getSnapshot();
    const n = snap.transcript.length;
    if (n === 0) return null;
    const turnIndex = n - turnDepth;
    if (turnIndex < 0) return null;
    const clamped = Math.min(turnIndex, n - 1);
    return this.layout(snap).turnStartRow[clamped];
  }

  /**
   * Window-relative turn index for a flat row — the value added to
   * `replayWindow.firstLoadedTurnIndex` to number a row by its true
   * session turn. A committed row reports its turn's local index; an
   * in-flight row reports `transcript.length` (the active turn is the next
   * turn after the last committed one, so its 1-based number lands at
   * `totalTurns + 1`). Used by the `#t…m…` transcript address ([P04]).
   */
  localTurnIndexForRow(index: number): number {
    const snap = this._codeSessionStore.getSnapshot();
    const n = snap.transcript.length;
    if (n === 0) return 0;
    const layout = this.layout(snap);
    const slot = layout.slots[index];
    if (slot !== undefined && !slot.active && slot.cellKind !== "ghost") {
      return slot.turnIndex;
    }
    // In-flight / ghost rows belong to the next (not-yet-committed) turn.
    return n;
  }

  /**
   * The 0-based per-kind ordinal of a row *within its turn* ([P09]) — the
   * second component of the durable badge address. A `user` row reports
   * its {@link RowSlot.userRowOrdinal}, an `assistant` row its
   * {@link RowSlot.assistantRunOrdinal}; `0` for the sole/first of its
   * kind (badge omits the suffix), `1`/`2`/… for steered messages or
   * extra assistant runs merged into the turn. `0` for a ghost or
   * out-of-range row. Combined with the session-true turn number it is
   * durable across reopen/paging (it keys on the turn's own message
   * order, not the loaded window). Reads the memoized per-snapshot layout.
   */
  withinTurnOrdinalForRow(index: number): number {
    const slot = this.layout(this._codeSessionStore.getSnapshot()).slots[index];
    if (slot === undefined) return 0;
    if (slot.cellKind === "user") return Math.max(0, slot.userRowOrdinal);
    if (slot.cellKind === "assistant") return Math.max(0, slot.assistantRunOrdinal);
    return 0;
  }

  /**
   * 1-based session-wide shell counter for a `shell` row — the number
   * behind its `#s{n}` badge. Its own sequence, independent of the Claude
   * turn numbers (unlike {@link localTurnIndexForRow}, it needs no window
   * base: the shell ledger restores the whole session's exchanges, so the
   * count is always complete). `0` for a non-shell / out-of-range row.
   */
  shellOrdinalForRow(index: number): number {
    const slot = this.layout(this._codeSessionStore.getSnapshot()).slots[index];
    return slot?.shellRowOrdinal ?? 0;
  }

  /**
   * 1-based session-wide refs counter for a `refs` row — the number behind
   * its `#r{n}` badge. Its own sequence, on the same terms as
   * {@link shellOrdinalForRow}. `0` for a non-refs / out-of-range row.
   */
  refsOrdinalForRow(index: number): number {
    const slot = this.layout(this._codeSessionStore.getSnapshot()).slots[index];
    return slot?.refsRowOrdinal ?? 0;
  }

  /**
   * Stable React-key seed per the id-stability protocol, derived from
   * the row's {@link RowSlot}:
   *
   *  - `user` row: the `user_message`'s own `messageKey`. For a turn's
   *    head submission this is `${turnKey}-user` (so the committed and
   *    in-flight head rows key identically). A merged/steered message
   *    carries its own queue-time key, so its row is distinct ([P04]) —
   *    never re-derived under the host turn's key.
   *  - `assistant` row: `${turnKey}-assistant` for the turn's first
   *    assistant run (ordinal 0) — the no-remount key that survives
   *    inflight → committed ([L26]); later runs (merged turns only) key
   *    as `${turnKey}-assistant-${ordinal}`, stable under append. A wake
   *    turn's single run is ordinal 0, so it keys `${turnKey}-assistant`;
   *    the `${turnKey}-user` key is never minted for it.
   *  - `ghost` row: `${turnKey}-ghost`, distinct from `-user`/`-assistant`
   *    so a queued send flushing into an in-flight row is a clean
   *    unmount + mount (a real transition, not the seamless
   *    inflight → committed one).
   *
   * `turnKey` is generated once at `handleSend` or `handleWakeStarted`
   * and copied unchanged onto `TurnEntry` at `handleTurnComplete` —
   * so the in-flight row's id is byte-identical to the committed row's
   * id for the same turn. React sees the same key + the same component
   * type (the cellRenderers map holds one entry for the unified
   * `"assistant"` kind), so the cell wrapper survives the
   * inflight → committed transition with no unmount.
   *
   * `msgId` is the wire-correlation identifier and is intentionally
   * NOT used as the assistant key: it isn't assigned until the first
   * streaming frame lands, which is mid-turn, so any id derived from it
   * would change during the turn and trigger a remount.
   */
  idForIndex(index: number): string {
    const snap = this._codeSessionStore.getSnapshot();
    const layout = this.layout(snap);
    const slot = layout.slots[index];

    if (slot.cellKind === "ghost") {
      return `${snap.queuedSends[slot.queuedIndex].turnKey}-ghost`;
    }

    const turnKey = slot.active
      ? snap.activeTurn!.turnKey
      : snap.transcript[slot.turnIndex].turnKey;

    if (slot.cellKind === "user") {
      const messages = slot.active
        ? snap.activeTurn!.messages
        : snap.transcript[slot.turnIndex].messages;
      return messages[slot.group!.start].messageKey;
    }

    return slot.assistantRunOrdinal === 0
      ? `${turnKey}-assistant`
      : `${turnKey}-assistant-${slot.assistantRunOrdinal}`;
  }

  /**
   * Cell-renderer kind. Three values:
   *  - `"user"` for the user-half row of a normal committed/in-flight
   *    turn. Never returned for a wake turn (which has no user row).
   *  - `"assistant"` for every assistant row, in-flight or committed,
   *    wake or normal. Unified kind across all assistant phases per
   *    [L26] (eliminates the lambda-identity trap that would otherwise
   *    re-mount the cell wrapper at `turn_complete`).
   *  - `"ghost"` for each queued-send row.
   */
  kindForIndex(index: number): SessionTranscriptCellKind {
    const layout = this.layout(this._codeSessionStore.getSnapshot());
    return layout.slots[index].cellKind;
  }

  /**
   * Typed row descriptor for `index`. Cell renderers call this from
   * inside `useSyncExternalStore`-bound props rather than peeking at
   * the snapshot themselves so the adapter remains the single seam
   * between `CodeSessionStore` and the list view.
   *
   * Wake turns produce a single `{kind:"assistant", turn, ...}` descriptor —
   * no separate user-row descriptor exists. A merged turn produces a
   * `user` descriptor per `user_message` and an `assistant` descriptor per
   * non-user run (Spec S01); each carries the slice / message it renders.
   */
  rowAt(index: number): SessionRowDescriptor {
    const snap = this._codeSessionStore.getSnapshot();
    const layout = this.layout(snap);
    const slot = layout.slots[index];

    // Ghost row.
    if (slot.cellKind === "ghost") {
      const queued = snap.queuedSends[slot.queuedIndex];
      return { kind: "ghost", queued, turnKey: queued.turnKey };
    }

    const group = slot.group!;

    // In-flight turn row — the live `activeTurn` projection is the
    // message source. No per-turn token figure until the bracket commits.
    if (slot.active) {
      const active = snap.activeTurn!;
      if (slot.cellKind === "user") {
        return {
          kind: "user",
          activeTurn: active,
          userMessage: active.messages[group.start] as UserMessage,
          turnKey: active.turnKey,
        };
      }
      return {
        kind: "assistant",
        activeTurn: active,
        messageStart: group.start,
        messageEnd: group.end,
        isLastAssistantOfTurn: slot.isLastAssistantOfTurn,
        turnKey: active.turnKey,
      };
    }

    // Committed turn row.
    const turn = snap.transcript[slot.turnIndex];
    // Shell exchange ([P06]) — one row, the whole turn; the cell reads the
    // single `shell_exchange` Message off `turn.messages[0]`.
    if (slot.cellKind === "shell") {
      return {
        kind: "shell",
        turn,
        turnKey: turn.turnKey,
        arcStopSuperseded: slot.arcStopSuperseded,
      };
    }
    // Refs run — one row, the whole turn; the cell reads the single
    // `refs_result` Message off `turn.messages[0]`.
    if (slot.cellKind === "refs") {
      return { kind: "refs", turn, turnKey: turn.turnKey };
    }
    if (slot.cellKind === "user") {
      return {
        kind: "user",
        turn,
        userMessage: turn.messages[group.start] as UserMessage,
        turnKey: turn.turnKey,
      };
    }
    // Assistant row. The signed per-turn token delta is a bracket
    // quantity (window(N) − window(N−1), carry-forward over any
    // zero-usage turn), so it rides only the bracket's last assistant
    // row ([P02]). Subagent spend rides ALONGSIDE it, never folded in:
    // an agent's tokens burn in a separate context that never enters
    // the main session's window, so Z1B shows the main figure and the
    // agent figure as distinct readouts (`agentTokensForTurn` — the
    // composed/streaming agent totals, climbing live via
    // `task_progress` ticks, durable on reload).
    const windows = this.contextWindows(snap);
    const basePerTurn = slot.isLastAssistantOfTurn
      ? windows[slot.turnIndex]?.perTurn
      : undefined;
    return {
      kind: "assistant",
      turn,
      messageStart: group.start,
      messageEnd: group.end,
      isLastAssistantOfTurn: slot.isLastAssistantOfTurn,
      perTurnTokens: basePerTurn,
      agentTokens:
        basePerTurn !== undefined
          ? agentTokensForTurn(turn.messages, snap.jobs)
          : undefined,
      turnKey: turn.turnKey,
    };
  }

  /**
   * Proxies straight to the underlying store. The list view's
   * `useSyncExternalStore` consumes this; on every reducer dispatch
   * the listener fires, the list view re-reads `getVersion()`, and
   * because that returns a fresh snapshot reference React rerenders.
   */
  subscribe(listener: () => void): () => void {
    return this._codeSessionStore.subscribe(listener);
  }

  /**
   * Returns the current `CodeSessionStore` snapshot. The reference is
   * `Object.is`-stable across non-mutating dispatches (per
   * `CodeSessionStore.getSnapshot`'s memoization contract) and changes
   * identity on every state-changing dispatch — exactly the shape
   * `TugListViewDataSource.getVersion` expects.
   */
  getVersion(): CodeSessionSnapshot {
    return this._codeSessionStore.getSnapshot();
  }
}

// ---------------------------------------------------------------------------
// Row-data equality — the memoization gate for transcript cells
// ---------------------------------------------------------------------------

/**
 * Field-wise equality over the row data a transcript cell renders
 * from. Finalized rows are immutable, so their fields are
 * reference-stable across snapshots (`turn` is the committed
 * `TurnEntry` reference, `userMessage` a frozen Message reference, the
 * slice indices primitives, `queued` the queue entry reference) — equal
 * fields mean the cell would render identical output. The in-flight
 * row's `activeTurn` projection (and its `userMessage`) is rebuilt per
 * snapshot, so it compares unequal whenever any state changed — exactly
 * the one row that must stay live.
 */
export function sameTranscriptRowData(
  a: SessionRowDescriptor,
  b: SessionRowDescriptor,
): boolean {
  return (
    a.kind === b.kind &&
    a.turnKey === b.turnKey &&
    a.turn === b.turn &&
    a.activeTurn === b.activeTurn &&
    a.userMessage === b.userMessage &&
    a.messageStart === b.messageStart &&
    a.messageEnd === b.messageEnd &&
    a.isLastAssistantOfTurn === b.isLastAssistantOfTurn &&
    a.queued === b.queued &&
    a.perTurnTokens === b.perTurnTokens &&
    a.agentTokens === b.agentTokens &&
    // The exception that proves this function's rule. Every field above is
    // reference-stable *because a finalized row is immutable* — but this one
    // is derived across rows, so a join receipt landing later flips an earlier
    // stop row's value while its `turn` never moves. Without this line
    // `transcriptCellPropsEqual` returns true and the demoted receipt keeps
    // its red pose until the card reloads ([L26]).
    a.arcStopSuperseded === b.arcStopSuperseded
  );
}

/**
 * `React.memo` props-equality for transcript cells: every prop except
 * `row` must be `Object.is`-identical (they all are for a mounted
 * cell — index, id, kind, stores, renderer callbacks are stable for
 * the card's lifetime, so any identity change is a real reason to
 * re-render), then {@link sameTranscriptRowData} decides. A skipped
 * re-render of a finalized row is the memo-hit the parse-economy
 * counters report.
 *
 * Lives here (React-free, props-generic) so the gate is pure-logic
 * testable; the cell components in `session-card-transcript.tsx` wrap
 * themselves with it.
 */
export function transcriptCellPropsEqual<
  P extends { row: SessionRowDescriptor },
>(prev: P, next: P): boolean {
  const prevKeys = Object.keys(prev) as Array<keyof P>;
  const nextKeys = Object.keys(next) as Array<keyof P>;
  if (prevKeys.length !== nextKeys.length) return false;
  for (const key of nextKeys) {
    if (key === "row") continue;
    if (!(key in prev)) return false;
    if (!Object.is(prev[key], next[key])) return false;
  }
  const equal = sameTranscriptRowData(prev.row, next.row);
  if (equal) recordRowMemoHit();
  return equal;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Construct a `SessionTranscriptDataSource` bound to `codeSessionStore` and
 * keep its identity stable across renders so React's `useSyncExternalStore`
 * machinery in the list view doesn't churn its subscription on every
 * parent rerender.
 *
 * The adapter itself holds no resources of its own — it proxies into the
 * store on every call — so disposal is a no-op today. The `useEffect`
 * cleanup is in place so the contract reads correctly: each store gets
 * exactly one adapter per consumer mount, and a swap to a new store
 * yields a fresh adapter.
 */
export function useSessionTranscriptDataSource(
  codeSessionStore: CodeSessionStore,
): SessionTranscriptDataSource {
  const adapter = useMemo(
    () => new SessionTranscriptDataSource(codeSessionStore),
    [codeSessionStore],
  );

  useEffect(() => {
    // No-op disposal today; the hook owns the lifecycle so a future
    // adapter that does hold resources (e.g. memoized derived state)
    // has the seam already in place.
    return () => {};
  }, [adapter]);

  return adapter;
}
