/**
 * docket-citation-store.ts — does this machine hold the docket a `docket:`
 * reference names, and which checkout owns it?
 *
 * A docket's record lives in its checkout's state directory, which the deck
 * cannot read, so the server answers over the `resolve_dockets` CONTROL verb
 * and this store is the cache in front of it. It is `sketch-citation-store`'s
 * shape, kept rather than reinvented:
 *
 * 1. **Ask once per id, in batches.** Asks queue on a microtask and go out as
 *    one request per asking project. An id already asked or answered is never
 *    re-asked.
 * 2. **Cache both answers.** A found docket records its owning project, its
 *    name, whether it is retired and how many threads it has; a miss records
 *    the miss.
 * 3. **Forget on reconnect.** A wire bounce may have crossed a rename or a
 *    store written elsewhere, so every cached answer is dropped.
 *
 * Answers are keyed by id alone: a docket id is unique on the machine, and the
 * server looks under every checkout whichever project asked. Subscribers are
 * told the ids that moved.
 *
 * **Laws:** [L22] — nothing renders from this through React; the chip
 * decorator reads it synchronously and re-bakes on its notifications. [L27] —
 * the reconnect observer's unregister is held and released by `dispose()`.
 *
 * @module lib/docket-citation-store
 */

import { getConnection } from "@/lib/connection-singleton";
import { getConnectionLifecycle } from "@/lib/connection-lifecycle";
import { encodeResolveDockets, type DocketVerbOk } from "@/protocol";

/** The decoded `resolve_dockets_ok`. */
export type ResolveDocketsOk = Extract<DocketVerbOk, { verb: "resolve_dockets" }>;

/** What the machine said about one asked docket id. */
export type CitedDocketAnswer =
  /** Asked, no answer yet — or nobody has asked. */
  | { status: "pending" }
  /** A checkout holds it; `projectDir` is that checkout. */
  | {
      status: "found";
      projectDir: string;
      name: string;
      retired: boolean;
      threads: number;
    }
  /** No checkout on this machine holds it. */
  | { status: "missing" };

const PENDING: CitedDocketAnswer = Object.freeze({ status: "pending" });
const MISSING: CitedDocketAnswer = Object.freeze({ status: "missing" });

/**
 * The store's state machine with no transport attached. Exported for the
 * store's own tests, which exercise it over plain objects.
 */
export class DocketCitationStore {
  private answers = new Map<string, CitedDocketAnswer>();
  /** Ids queued for the next batch, per asking project. */
  private queued = new Map<string, Set<string>>();
  private flushScheduled = false;
  private readonly listeners = new Set<(ids: readonly string[]) => void>();
  private disposers: (() => void)[] = [];
  private reconnectHooked = false;

  /**
   * @param send — how a batch goes out; the default writes a CONTROL frame on
   * the live connection and reports `false` when there is none.
   */
  constructor(
    private readonly send: (
      projectDir: string,
      ids: readonly string[],
    ) => boolean = sendOverConnection,
  ) {}

  /** Attach the reconnect observer on the first ask, as the sketch store does. */
  private ensureReconnectHook(): void {
    if (this.reconnectHooked) return;
    const lifecycle = getConnectionLifecycle();
    if (lifecycle === null) return;
    this.reconnectHooked = true;
    this.disposers.push(
      lifecycle.observeConnectionDidReconnect(() => this.forgetAll()),
    );
  }

  subscribe = (listener: (ids: readonly string[]) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The cached answer for `id`, without asking. */
  getAnswer(id: string): CitedDocketAnswer {
    return this.answers.get(id) ?? PENDING;
  }

  /**
   * Ask the server about `id` unless it is asked or answered. `projectDir` is
   * the asking project, which rides the request.
   */
  request(projectDir: string, id: string): void {
    this.ensureReconnectHook();
    if (projectDir === "" || id === "") return;
    if (this.answers.has(id)) return;
    this.answers.set(id, PENDING);
    let ids = this.queued.get(projectDir);
    if (ids === undefined) {
      ids = new Set();
      this.queued.set(projectDir, ids);
    }
    ids.add(id);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  /**
   * Apply a `resolve_dockets_ok` frame: settle every id it speaks for. The
   * Docket card's own resolves are heard too, which only fills the cache.
   */
  applyResolved(response: ResolveDocketsOk): void {
    const changed: string[] = [];
    for (const docket of response.found) {
      this.answers.set(docket.id, {
        status: "found",
        projectDir: docket.projectDir,
        name: docket.name,
        retired: docket.retired,
        threads: docket.threads.length,
      });
      changed.push(docket.id);
    }
    for (const id of response.missing) {
      this.answers.set(id, MISSING);
      changed.push(id);
    }
    if (changed.length > 0) this.notify(changed);
  }

  /**
   * Give up on every ask still in flight, so the next pass asks again. A
   * refusal says nothing about any docket, so nothing is cached as missing,
   * and nothing is notified, which would send the same refused ask back.
   */
  applyFailed(): void {
    for (const [id, answer] of this.answers) {
      if (answer.status === "pending") this.answers.delete(id);
    }
  }

  /** Drop every cached answer. Called on reconnect. */
  forgetAll(): void {
    if (this.answers.size === 0) return;
    const forgotten = [...this.answers.keys()];
    this.answers.clear();
    this.queued.clear();
    this.notify(forgotten);
  }

  /** Release the lifecycle registration ([L27]). Test/teardown only. */
  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers = [];
    this.reconnectHooked = false;
    this.listeners.clear();
  }

  private flush(): void {
    this.flushScheduled = false;
    const batches = [...this.queued];
    this.queued.clear();
    for (const [projectDir, ids] of batches) {
      if (ids.size === 0) continue;
      const asked = [...ids];
      if (!this.send(projectDir, asked)) {
        // No transport: nothing is known and nothing is claimed.
        for (const id of asked) this.answers.delete(id);
      }
    }
  }

  private notify(ids: readonly string[]): void {
    for (const listener of this.listeners) listener(ids);
  }
}

function sendOverConnection(projectDir: string, ids: readonly string[]): boolean {
  const connection = getConnection();
  if (connection === null) return false;
  const frame = encodeResolveDockets({
    projectDir,
    ids,
    requestId: `docket-cite-${crypto.randomUUID()}`,
  });
  connection.send(frame.feedId, frame.payload);
  return true;
}

/** Module-scope singleton — the page's one cache of docket answers. */
export const docketCitationStore = new DocketCitationStore();
