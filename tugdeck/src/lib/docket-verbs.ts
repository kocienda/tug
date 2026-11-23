/**
 * docket-verbs.ts — the deck's sender for the docket CONTROL verbs, the
 * idea and sketch verbs the Docket card authors with, and the docket-loop
 * verbs an arc answers a newer brief with.
 *
 * Each call writes one CONTROL frame carrying a fresh `request_id` and
 * settles on the reply that echoes it: `ok` with the decoded `_ok`, or
 * `refused` with the `_err`'s sentence. CONTROL replies are broadcast to
 * every page, so the id is what makes an answer this caller's.
 *
 * Every ask is bounded ([L33]), on the model of the changeset verbs'
 * `PRESS_ACKNOWLEDGEMENT_MS`: one nothing answered by the deadline settles
 * as `unanswered`, which the card words rather than waiting on forever. An
 * answer that arrives after that is still delivered, to the call's `onLate`,
 * so a filing that did land is not reported as lost.
 *
 * The sender holds no state the UI reads; the DOCKETS feed carries what the
 * store now holds, and the reply carries only how the gesture went.
 *
 * @module lib/docket-verbs
 */

import {
  FeedId,
  decodeDocketLoopVerbErr,
  decodeDocketLoopVerbOk,
  decodeIdeaVerbErr,
  decodeIdeaVerbOk,
  decodeDocketVerbErr,
  decodeDocketVerbOk,
  encodeArcKeepGoing,
  encodeArcPark,
  encodeFollowUpAccept,
  encodeFollowUpDismiss,
  encodeArcRevert,
  encodeDocketCreate,
  encodeDocketFile,
  encodeDocketRemove,
  encodeDocketRename,
  encodeDocketRetire,
  encodeIdeaAddSession,
  encodeIdeaCreate,
  encodeResolveDockets,
  encodeSearchDockets,
  encodeSketchEdit,
  encodeSketchRead,
  type DocketFileItem,
  type DocketLoopVerb,
  type DocketLoopVerbOk,
  type DocketVerb as DocketOnlyVerb,
  type DocketVerbOk as DocketOnlyVerbOk,
  type Frame,
  type IdeaVerb,
  type IdeaVerbOk,
} from "../protocol";
import type { TugConnection } from "../connection";

/** Every verb this sender asks: the docket verbs, the idea verbs and the docket-loop verbs. */
export type DocketVerb = DocketOnlyVerb | IdeaVerb | DocketLoopVerb;

/** Every decoded `_ok` this sender settles with. */
export type DocketVerbOk = DocketOnlyVerbOk | IdeaVerbOk | DocketLoopVerbOk;

/** How long an ask waits for its answer before it is `unanswered`. */
export const DOCKET_ACKNOWLEDGEMENT_MS = 60_000;

/** How one ask came out. */
export type DocketVerbResult<V extends DocketVerb = DocketVerb> =
  | { kind: "ok"; reply: Extract<DocketVerbOk, { verb: V }> }
  | { kind: "refused"; message: string }
  | { kind: "unanswered" };

/** What an ask may be told besides its own settlement. */
export interface DocketAskOptions<V extends DocketVerb> {
  /** The answer, when it arrives after the ask settled `unanswered`. */
  onLate?: (result: DocketVerbResult<V>) => void;
}

/** The timer the deadline runs on; a test hands in its own. */
export interface DocketVerbClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const SYSTEM_CLOCK: DocketVerbClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The part of a connection the sender uses. */
export type DocketVerbConnection = Pick<TugConnection, "send" | "onFrame">;

export interface DocketVerbs {
  create(
    opts: { projectDir: string; name: string },
    ask?: DocketAskOptions<"docket_create">,
  ): Promise<DocketVerbResult<"docket_create">>;
  rename(
    opts: { projectDir: string; id: string; name: string },
    ask?: DocketAskOptions<"docket_rename">,
  ): Promise<DocketVerbResult<"docket_rename">>;
  retire(
    opts: { projectDir: string; id: string; retired: boolean },
    ask?: DocketAskOptions<"docket_retire">,
  ): Promise<DocketVerbResult<"docket_retire">>;
  file(
    opts: { projectDir: string; id: string; items: readonly DocketFileItem[] },
    ask?: DocketAskOptions<"docket_file">,
  ): Promise<DocketVerbResult<"docket_file">>;
  remove(
    opts: { projectDir: string; id: string; keys: readonly string[] },
    ask?: DocketAskOptions<"docket_remove">,
  ): Promise<DocketVerbResult<"docket_remove">>;
  resolve(
    opts: { projectDir: string; ids: readonly string[] },
    ask?: DocketAskOptions<"resolve_dockets">,
  ): Promise<DocketVerbResult<"resolve_dockets">>;
  search(
    opts: { projectDir: string; query: string },
    ask?: DocketAskOptions<"search_dockets">,
  ): Promise<DocketVerbResult<"search_dockets">>;
  /** Make an idea from its one line and file it onto `docketId`. */
  ideaCreate(
    opts: { projectDir: string; docketId: string; text: string; body?: string },
    ask?: DocketAskOptions<"idea_create">,
  ): Promise<DocketVerbResult<"idea_create">>;
  /** Record a session (by uuid) as one the idea was sketched in. */
  ideaAddSession(
    opts: { projectDir: string; id: string; uuid: string },
    ask?: DocketAskOptions<"idea_add_session">,
  ): Promise<DocketVerbResult<"idea_add_session">>;
  /** Read a sketch version (the latest when absent), or a brief version's bytes. */
  sketchRead(
    opts: { projectDir: string; id: string; version?: number; brief?: number },
    ask?: DocketAskOptions<"sketch_read">,
  ): Promise<DocketVerbResult<"sketch_read">>;
  /** Keep `text` as the user's version, refused when `baseVersion` is not the latest. */
  sketchEdit(
    opts: { projectDir: string; id: string; text: string; baseVersion: number },
    ask?: DocketAskOptions<"sketch_edit">,
  ): Promise<DocketVerbResult<"sketch_edit">>;
  /** Keep going past brief version `version`, filing its added decisions on `docketId`. */
  keepGoing(
    opts: { projectDir: string; arc: string; version: number; docketId: string },
    ask?: DocketAskOptions<"arc_keep_going">,
  ): Promise<DocketVerbResult<"arc_keep_going">>;
  /** Park `arc` at `boundary` (`tip`, `fork`, `step:<K>`) for `successor`. */
  park(
    opts: { projectDir: string; arc: string; successor: string; boundary: string },
    ask?: DocketAskOptions<"arc_park">,
  ): Promise<DocketVerbResult<"arc_park">>;
  /** Accept follow-up `k` of the `arc` generation started at `created` as an idea on `docketId`. */
  followUpAccept(
    opts: { projectDir: string; arc: string; created: string; k: number; docketId: string },
    ask?: DocketAskOptions<"follow_up_accept">,
  ): Promise<DocketVerbResult<"follow_up_accept">>;
  /** Dismiss follow-up `k` of the `arc` generation started at `created`. */
  followUpDismiss(
    opts: { projectDir: string; arc: string; created: string; k: number },
    ask?: DocketAskOptions<"follow_up_dismiss">,
  ): Promise<DocketVerbResult<"follow_up_dismiss">>;
  /** Revert the join of the `arc` generation started at `created`; a dry run commits nothing. */
  revert(
    opts: { projectDir: string; arc: string; created: string; dryRun: boolean },
    ask?: DocketAskOptions<"arc_revert">,
  ): Promise<DocketVerbResult<"arc_revert">>;
  /** Stop listening; every ask still open settles `unanswered`. */
  dispose(): void;
}

interface Pending {
  verb: DocketVerb;
  /** True once the ask settled `unanswered`; its answer then goes to `onLate`. */
  timedOut: boolean;
  timer: unknown;
  settle: (result: DocketVerbResult) => void;
  onLate?: (result: DocketVerbResult) => void;
}

function mintRequestId(): string {
  return `docket-${crypto.randomUUID()}`;
}

/**
 * The docket verb sender over `connection`. `clock` and `deadlineMs` are
 * seams for tests; the app passes neither.
 */
export function docketVerbs(
  connection: DocketVerbConnection,
  clock: DocketVerbClock = SYSTEM_CLOCK,
  deadlineMs: number = DOCKET_ACKNOWLEDGEMENT_MS,
): DocketVerbs {
  const pending = new Map<string, Pending>();
  const decoder = new TextDecoder();

  const unsubscribe = connection.onFrame(FeedId.CONTROL, (payload: Uint8Array) => {
    let body: unknown;
    try {
      body = JSON.parse(decoder.decode(payload));
    } catch {
      return;
    }
    const ok: DocketVerbOk | null =
      decodeDocketVerbOk(body) ?? decodeIdeaVerbOk(body) ?? decodeDocketLoopVerbOk(body);
    const err =
      ok === null
        ? (decodeDocketVerbErr(body) ?? decodeIdeaVerbErr(body) ?? decodeDocketLoopVerbErr(body))
        : null;
    const requestId = ok?.requestId ?? err?.requestId ?? null;
    if (requestId === null) return;
    const entry = pending.get(requestId);
    if (entry === undefined) return;
    const verb = ok?.verb ?? err?.verb;
    if (verb !== entry.verb) return;
    const result: DocketVerbResult =
      ok !== null
        ? ({ kind: "ok", reply: ok } as DocketVerbResult)
        : { kind: "refused", message: err?.message ?? "" };
    pending.delete(requestId);
    if (entry.timedOut) {
      clock.clearTimeout(entry.timer);
      entry.onLate?.(result);
      return;
    }
    clock.clearTimeout(entry.timer);
    entry.settle(result);
  });

  function ask<V extends DocketVerb>(
    verb: V,
    build: (requestId: string) => Frame,
    options: DocketAskOptions<V> | undefined,
  ): Promise<DocketVerbResult<V>> {
    return new Promise((resolve) => {
      const requestId = mintRequestId();
      const entry: Pending = {
        verb,
        timedOut: false,
        timer: null,
        settle: resolve as (result: DocketVerbResult) => void,
        onLate: options?.onLate as ((result: DocketVerbResult) => void) | undefined,
      };
      entry.timer = clock.setTimeout(() => {
        entry.timedOut = true;
        resolve({ kind: "unanswered" });
        // A late answer is still delivered, for one more deadline; after
        // that the ask is forgotten, so a reply that never comes holds
        // nothing for the life of the page.
        entry.timer = clock.setTimeout(() => pending.delete(requestId), deadlineMs);
      }, deadlineMs);
      pending.set(requestId, entry);
      const frame = build(requestId);
      connection.send(frame.feedId, frame.payload);
    });
  }

  return {
    create: (o, a) =>
      ask("docket_create", (requestId) => encodeDocketCreate({ ...o, requestId }), a),
    rename: (o, a) =>
      ask("docket_rename", (requestId) => encodeDocketRename({ ...o, requestId }), a),
    retire: (o, a) =>
      ask("docket_retire", (requestId) => encodeDocketRetire({ ...o, requestId }), a),
    file: (o, a) => ask("docket_file", (requestId) => encodeDocketFile({ ...o, requestId }), a),
    remove: (o, a) =>
      ask("docket_remove", (requestId) => encodeDocketRemove({ ...o, requestId }), a),
    resolve: (o, a) =>
      ask("resolve_dockets", (requestId) => encodeResolveDockets({ ...o, requestId }), a),
    search: (o, a) =>
      ask("search_dockets", (requestId) => encodeSearchDockets({ ...o, requestId }), a),
    ideaCreate: (o, a) =>
      ask("idea_create", (requestId) => encodeIdeaCreate({ ...o, requestId }), a),
    ideaAddSession: (o, a) =>
      ask("idea_add_session", (requestId) => encodeIdeaAddSession({ ...o, requestId }), a),
    sketchRead: (o, a) =>
      ask("sketch_read", (requestId) => encodeSketchRead({ ...o, requestId }), a),
    sketchEdit: (o, a) =>
      ask("sketch_edit", (requestId) => encodeSketchEdit({ ...o, requestId }), a),
    keepGoing: (o, a) =>
      ask("arc_keep_going", (requestId) => encodeArcKeepGoing({ ...o, requestId }), a),
    park: (o, a) => ask("arc_park", (requestId) => encodeArcPark({ ...o, requestId }), a),
    followUpAccept: (o, a) =>
      ask("follow_up_accept", (requestId) => encodeFollowUpAccept({ ...o, requestId }), a),
    followUpDismiss: (o, a) =>
      ask("follow_up_dismiss", (requestId) => encodeFollowUpDismiss({ ...o, requestId }), a),
    revert: (o, a) => ask("arc_revert", (requestId) => encodeArcRevert({ ...o, requestId }), a),
    dispose() {
      unsubscribe();
      for (const entry of pending.values()) {
        clock.clearTimeout(entry.timer);
        if (!entry.timedOut) entry.settle({ kind: "unanswered" });
      }
      pending.clear();
    },
  };
}
