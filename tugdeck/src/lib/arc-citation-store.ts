/**
 * arc-citation-store.ts — does this project's arc log hold the arc an `arc:`
 * reference names, and what became of it?
 *
 * An arc's existence is recorded in one place, the project's arc log, which
 * the deck cannot read. `ChangesetAllStore` knows the live arcs and nothing
 * else, so a reference to an arc that was joined last week would be refused by
 * every cache the deck holds. The server answers instead, over the
 * `resolve_arcs` CONTROL verb, and this store is the cache in front of it. It
 * is `session-citation-store`'s shape, kept rather than reinvented:
 *
 * 1. **Ask once per name, in batches.** Asks queue on a microtask and go out
 *    as one request per project. A name already asked or answered is never
 *    re-asked.
 * 2. **Cache both answers.** A found arc records its fate and, for a joined
 *    one, the squash commit; a miss records the miss, so an unresolvable
 *    reference is a cached fact rather than a re-ask on every repaint.
 * 3. **Forget on reconnect.** A wire bounce may have crossed a join or a
 *    discard, and a cached answer outliving the change it missed is the one
 *    wrong answer this store could hold for a long time.
 *
 * Answers are keyed by project and name, because an arc's name is unique only
 * within its project's log. Subscribers are told the {@link arcVerdictKey}s
 * that moved, which is what lets the annotator re-mark only the ink that
 * consulted them.
 *
 * **Laws:** [L22] — nothing renders from this through React; the annotator
 * reads it synchronously inside a pass and re-marks on its notifications.
 * [L27] — the reconnect observer's unregister is held and released by
 * `dispose()`.
 *
 * @module lib/arc-citation-store
 */

import { getConnection } from "@/lib/connection-singleton";
import { getConnectionLifecycle } from "@/lib/connection-lifecycle";
import { arcVerdictKey, type VerdictKey } from "@/lib/annotator/verdict-keys";
import { encodeResolveArcs, type ResolveArcsOk } from "@/protocol";

/** What the arc log said about one asked name. */
export type CitedArcAnswer =
  /** Asked, no answer yet — or nobody has asked. */
  | { status: "pending" }
  /**
   * The arc can be read back. `joinSha` is set exactly when the arc was
   * joined; a `discarded` arc is one whose archive or kept documents remain.
   * `created` is its newest generation's start, when the server knows it.
   * `projectKey` is the asked checkout's canonical form, from the server's
   * path gateway, which is what `here` versus `elsewhere` compares ([L29]).
   */
  | {
      status: "found";
      fate: "live" | "joined" | "discarded";
      joinSha?: string;
      created?: string;
      projectKey?: string;
    }
  /** Nothing on this machine can read it back. */
  | { status: "missing" };

const PENDING: CitedArcAnswer = Object.freeze({ status: "pending" });
const MISSING: CitedArcAnswer = Object.freeze({ status: "missing" });

/**
 * One map key per (project, name). The verdict key's own compound form, so a
 * project path containing any byte cannot collide two pairs into one key.
 */
const keyFor = (root: string, name: string): string => arcVerdictKey(root, name);

/**
 * The store's state machine with no transport attached: the asks it would
 * send, the answers it holds, and the keys each change moved. Exported for
 * the store's own tests, which exercise it over plain objects.
 */
export class ArcCitationStore {
  private answers = new Map<string, CitedArcAnswer>();
  /** Names queued for the next batch, per project. */
  private queued = new Map<string, Set<string>>();
  private flushScheduled = false;
  private readonly listeners = new Set<(keys: readonly VerdictKey[]) => void>();
  private disposers: (() => void)[] = [];
  private reconnectHooked = false;

  /**
   * @param send — how a batch goes out; the default writes a CONTROL frame on
   * the live connection and reports `false` when there is none.
   */
  constructor(
    private readonly send: (
      projectDir: string,
      names: readonly string[],
    ) => boolean = sendOverConnection,
  ) {}

  /**
   * Attach the reconnect observer on the first ask rather than at
   * construction: this singleton is built during static-import evaluation,
   * before the app registers its connection lifecycle.
   */
  private ensureReconnectHook(): void {
    if (this.reconnectHooked) return;
    const lifecycle = getConnectionLifecycle();
    if (lifecycle === null) return;
    this.reconnectHooked = true;
    this.disposers.push(
      lifecycle.observeConnectionDidReconnect(() => this.forgetAll()),
    );
  }

  subscribe = (
    listener: (keys: readonly VerdictKey[]) => void,
  ): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The cached answer for `name` in `root`, without asking. */
  getAnswer(root: string, name: string): CitedArcAnswer {
    return this.answers.get(keyFor(root, name)) ?? PENDING;
  }

  /** Ask the server about `name` in `root` unless it is asked or answered. */
  request(root: string, name: string): void {
    this.ensureReconnectHook();
    if (root === "" || name === "") return;
    const key = keyFor(root, name);
    if (this.answers.has(key)) return;
    this.answers.set(key, PENDING);
    let names = this.queued.get(root);
    if (names === undefined) {
      names = new Set();
      this.queued.set(root, names);
    }
    names.add(name);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // One request per project per frame's worth of references.
    queueMicrotask(() => this.flush());
  }

  /** Apply a `resolve_arcs_ok` frame: settle every name it speaks for. */
  applyResolved(response: ResolveArcsOk): void {
    const root = response.projectDir;
    const changed: VerdictKey[] = [];
    for (const arc of response.found) {
      const key = keyFor(root, arc.name);
      const created = {
        ...(arc.created !== undefined ? { created: arc.created } : {}),
        ...(response.projectKey !== undefined ? { projectKey: response.projectKey } : {}),
      };
      this.answers.set(
        key,
        arc.fate === "joined" && arc.joinSha !== undefined
          ? { status: "found", fate: "joined", joinSha: arc.joinSha, ...created }
          : {
              status: "found",
              fate: arc.fate === "discarded" ? "discarded" : "live",
              ...created,
            },
      );
      changed.push(key);
    }
    for (const name of response.missing) {
      const key = keyFor(root, name);
      this.answers.set(key, MISSING);
      changed.push(key);
    }
    if (changed.length > 0) this.notify(changed);
  }

  /**
   * Give up on every ask still in flight, so the next pass asks again. A
   * refusal says nothing about any arc, so nothing is cached as missing; and
   * nothing is notified, because a notification would re-run the pass at once
   * and send the same refused ask straight back.
   */
  applyFailed(): void {
    for (const [key, answer] of this.answers) {
      if (answer.status === "pending") this.answers.delete(key);
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
    for (const [root, names] of batches) {
      if (names.size === 0) continue;
      const asked = [...names];
      if (!this.send(root, asked)) {
        // No transport: nothing is known and nothing is claimed. Drop the
        // asks so a later pass with a live wire tries again.
        for (const name of asked) this.answers.delete(keyFor(root, name));
      }
    }
  }

  private notify(keys: readonly VerdictKey[]): void {
    for (const listener of this.listeners) listener(keys);
  }
}

function sendOverConnection(
  projectDir: string,
  names: readonly string[],
): boolean {
  const connection = getConnection();
  if (connection === null) return false;
  const frame = encodeResolveArcs(projectDir, names);
  connection.send(frame.feedId, frame.payload);
  return true;
}

/** Module-scope singleton — the page's one cache of arc answers. */
export const arcCitationStore = new ArcCitationStore();
