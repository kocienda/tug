/**
 * idea-citation-store.ts — does this machine hold the idea an `idea:`
 * reference names, and which checkout owns it?
 *
 * An idea's record lives in its checkout's state directory, which the deck
 * cannot read, so the server answers over the `resolve_ideas` CONTROL verb and
 * this store is the cache in front of it. It is `docket-citation-store`'s
 * shape, kept rather than reinvented:
 *
 * 1. **Ask once per id, in batches.** Asks queue on a microtask and go out as
 *    one request per asking project. An id already asked or answered is never
 *    re-asked.
 * 2. **Cache both answers.** A found idea records its owning project, its
 *    line, the docket it is on and the sketch kept from it; a miss records the
 *    miss.
 * 3. **Bound every ask.** A batch nobody answers within
 *    {@link IDEA_ASK_DEADLINE_MS} is given up, so the next pass asks again,
 *    rather than leaving its ids pending for the life of the page.
 * 4. **Forget on reconnect.** A wire bounce may have crossed an edit written
 *    elsewhere, so every cached answer is dropped.
 *
 * Answers are keyed by id alone: an idea id is unique on the machine, and the
 * server looks under every checkout whichever project asked. Subscribers are
 * told the ids that moved.
 *
 * **Laws:** [L22] — nothing renders from this through React; the chip
 * decorator reads it synchronously and re-bakes on its notifications. [L27] —
 * the reconnect observer's unregister and every pending deadline are released
 * by `dispose()`. [L31] — an ask with no answer says so by going back to
 * unasked.
 *
 * @module lib/idea-citation-store
 */

import { getConnection } from "@/lib/connection-singleton";
import { getConnectionLifecycle } from "@/lib/connection-lifecycle";
import { encodeResolveIdeas, type IdeaVerbOk } from "@/protocol";

/** The decoded `resolve_ideas_ok`. */
export type ResolveIdeasOk = Extract<IdeaVerbOk, { verb: "resolve_ideas" }>;

/** How long a batch may go unanswered before it is given up. */
export const IDEA_ASK_DEADLINE_MS = 10_000;

/** What the machine said about one asked idea id. */
export type CitedIdeaAnswer =
  /** Asked, no answer yet — or nobody has asked. */
  | { status: "pending" }
  /** A checkout holds it; `projectDir` is that checkout. */
  | {
      status: "found";
      projectDir: string;
      text: string;
      /** The name of the docket it is filed on; null when none. */
      docket: string | null;
      /** The id of the sketch kept from it; null when none. */
      sketch: string | null;
    }
  /** No checkout on this machine holds it. */
  | { status: "missing" };

const PENDING: CitedIdeaAnswer = Object.freeze({ status: "pending" });
const MISSING: CitedIdeaAnswer = Object.freeze({ status: "missing" });

/** How the store waits out a deadline; a test hands in its own. */
export interface DeadlineTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMER: DeadlineTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The store's state machine with no transport attached. Exported for the
 * store's own tests, which exercise it over plain objects.
 */
export class IdeaCitationStore {
  private answers = new Map<string, CitedIdeaAnswer>();
  /** Ids queued for the next batch, per asking project. */
  private queued = new Map<string, Set<string>>();
  private flushScheduled = false;
  private readonly listeners = new Set<(ids: readonly string[]) => void>();
  private disposers: (() => void)[] = [];
  private reconnectHooked = false;
  private readonly deadlines = new Set<unknown>();

  /**
   * @param send — how a batch goes out; the default writes a CONTROL frame on
   * the live connection and reports `false` when there is none.
   * @param timer — how a deadline is waited out.
   */
  constructor(
    private readonly send: (
      projectDir: string,
      ids: readonly string[],
    ) => boolean = sendOverConnection,
    private readonly timer: DeadlineTimer = REAL_TIMER,
  ) {}

  /** Attach the reconnect observer on the first ask, as the docket store does. */
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
  getAnswer(id: string): CitedIdeaAnswer {
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

  /** Apply a `resolve_ideas_ok` frame: settle every id it speaks for. */
  applyResolved(response: ResolveIdeasOk): void {
    const changed: string[] = [];
    for (const idea of response.ideas) {
      this.answers.set(
        idea.id,
        idea.found
          ? {
              status: "found",
              projectDir: idea.projectDir,
              text: idea.text,
              docket: idea.docket?.name ?? null,
              sketch: idea.sketch?.id ?? null,
            }
          : MISSING,
      );
      changed.push(idea.id);
    }
    if (changed.length > 0) this.notify(changed);
  }

  /**
   * Give up on every ask still in flight, so the next pass asks again. A
   * refusal says nothing about any idea, so nothing is cached as missing,
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

  /** Release the lifecycle registration and every deadline ([L27]). */
  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers = [];
    this.reconnectHooked = false;
    this.listeners.clear();
    for (const handle of this.deadlines) this.timer.clear(handle);
    this.deadlines.clear();
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
        continue;
      }
      const handle = this.timer.set(() => {
        this.deadlines.delete(handle);
        for (const id of asked) {
          if (this.answers.get(id)?.status === "pending") this.answers.delete(id);
        }
      }, IDEA_ASK_DEADLINE_MS);
      this.deadlines.add(handle);
    }
  }

  private notify(ids: readonly string[]): void {
    for (const listener of this.listeners) listener(ids);
  }
}

function sendOverConnection(projectDir: string, ids: readonly string[]): boolean {
  const connection = getConnection();
  if (connection === null) return false;
  const frame = encodeResolveIdeas({
    projectDir,
    ids,
    requestId: `idea-cite-${crypto.randomUUID()}`,
  });
  connection.send(frame.feedId, frame.payload);
  return true;
}

/** Module-scope singleton — the page's one cache of idea answers. */
export const ideaCitationStore = new IdeaCitationStore();
