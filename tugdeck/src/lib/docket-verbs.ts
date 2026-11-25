/**
 * docket-verbs.ts — the deck's sender for the docket CONTROL verbs.
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
  decodeDocketVerbErr,
  decodeDocketVerbOk,
  encodeDocketCreate,
  encodeDocketFile,
  encodeDocketRemove,
  encodeDocketRename,
  encodeDocketRetire,
  encodeResolveDockets,
  encodeSearchDockets,
  type DocketFileItem,
  type DocketVerb,
  type DocketVerbOk,
  type Frame,
} from "../protocol";
import type { TugConnection } from "../connection";

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
    const ok = decodeDocketVerbOk(body);
    const err = ok === null ? decodeDocketVerbErr(body) : null;
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
