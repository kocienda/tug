/**
 * The geometry-chain probe — "which read, after which write, forced a style
 * resolution?"
 *
 * A `/usr/bin/sample` profile over a workspace switch says that several full
 * `Document::resolveStyle` walks happen inside the click task and that the
 * JIT frames above the getters are unsymbolicated, so the profile names the
 * ENGINE function and not the line of ours that asked for it. This probe is the
 * other half: it wraps the four getters the profile implicates and the two
 * writes that dirty style, logs each call with a stack, and reports the
 * read→write→read chains — the shape that forces a resolve rather than reusing
 * the one already computed.
 *
 * It is a BENCH PROBE behind the loopback eval door. `arm` replaces platform
 * property descriptors, so it MUTATES — the same standing as `pause` and
 * `demote`, whose only caller on a release build is `POST /api/eval`,
 * loopback-only and gated on dev mode or the per-instance `diag/eval` opt-in.
 * Nothing arms it on load, and `disarm` puts every descriptor back.
 *
 * The classification is pure and lives apart from the wrapping
 * ({@link classifyGeometryChains} over {@link ChainLogEntry}), so the
 * interesting half is testable as data without a browser.
 *
 * ## `taskId` is approximate, and that is the design
 *
 * A chain only forces a resolve when the read, the writes and the second read
 * are in ONE task: a write in a later task is flushed by the frame between
 * them, and the second read pays nothing. There is no platform event for "a
 * task ended", so the probe schedules a microtask on the first entry of a task
 * and increments the id when it runs. A microtask checkpoint is the end of the
 * synchronous run of the task that queued it, which is the boundary this needs
 * — but code that awaits inside one task will be split across two ids, and two
 * synchronous runs in the same task separated by nothing will not be. Both
 * errors are conservative in the direction that matters: a chain the probe
 * reports is a chain, and a chain it splits is one somebody has to find another
 * way. It is a diagnostic, not an assertion.
 *
 * @module lib/motion-guard/geometry-chain-probe
 */

/**
 * How many entries the log keeps before it stops recording.
 *
 * A switch on the user's deck touches these getters a few hundred times, but one
 * gesture over real transcripts filled the old 4,000 by itself — a session card
 * reacting to its height change reads and writes in a loop — so the cap is four
 * times that. The log STOPS rather than rolling,
 * because a ring would drop the earliest chain — the one under the arriving
 * layer's first effect, which is the whole subject — and report the tail as if
 * it were the whole reading. Truncation is reported instead.
 */
export const CHAIN_LOG_CAP = 16000;

/** How many frames of `new Error().stack` each entry keeps above the wrapper. */
export const CHAIN_STACK_FRAMES = 6;

/** How many writing sites are named beneath each ranked reading site. */
export const CHAIN_WRITE_SITES_PER_READ = 4;

export interface ChainLogEntry {
  readonly seq: number;
  /** `performance.now()` at the call. */
  readonly t: number;
  /**
   * The wrapped call's own time, in ms — `original.call(this)` alone. The stack
   * capture is outside it, so an armed probe does not read its own price.
   */
  readonly ms: number;
  readonly kind: "read" | "write";
  /** The property or method — `clientWidth`, `setProperty`, … */
  readonly name: string;
  /** The task the call was in, per the approximation above. */
  readonly taskId: number;
  /**
   * The first {@link CHAIN_STACK_FRAMES} frames above the wrapper, or
   * `"<no stack>"` when the probe was armed without stacks.
   */
  readonly stack: string;
}

/** One chain: a read, the writes after it, and the read that pays for them. */
export interface GeometryChain {
  readonly taskId: number;
  /** The site of the read that pays — the one worth fixing. */
  readonly readSite: string;
  readonly readName: string;
  /** The paying read's own time — the forced layout this chain cost. */
  readonly ms: number;
  /** The paying read's `performance.now()`, to place the chain against a commit's span. */
  readonly t: number;
  /** The writes between the two reads, in order. */
  readonly writes: readonly { readonly name: string; readonly site: string }[];
}

/** Reading sites ranked by how many chains they pay for. */
export interface RankedReadSite {
  readonly site: string;
  readonly chains: number;
  /** The summed {@link GeometryChain.ms} of this site's chains. */
  readonly ms: number;
  /** The distinct writing sites that dirtied style before this read. */
  readonly writeSites: readonly string[];
  /** Which getters this site read. */
  readonly names: readonly string[];
}

export interface GeometryChainReading {
  readonly entries: number;
  readonly tasks: number;
  readonly chains: number;
  /** The costliest single chain's ms; 0 with no chains. */
  readonly longestChainMs: number;
  /** Every chain's ms, summed. */
  readonly totalChainMs: number;
  /**
   * Each chain's paying read, in log order — so a reader can set aside the
   * chains a commit's span already counts, and say which task each one paid in.
   */
  readonly chainTimes: readonly {
    readonly t: number;
    readonly ms: number;
    readonly taskId: number;
    readonly name: string;
    readonly site: string;
    /** The writes that dirtied style before the paying read, in order. */
    readonly writes: readonly { readonly name: string; readonly site: string }[];
  }[];
  /** Ranked by `chains`, descending. */
  readonly ranked: readonly RankedReadSite[];
  /** The log hit {@link CHAIN_LOG_CAP}; the reading is a lower bound. */
  readonly truncated: boolean;
}

/**
 * The reading the geometry getters in `[F03]`'s profile are wrapped for.
 *
 * `clientWidth` and `clientHeight` are on `Element`; `offsetWidth` is on
 * `HTMLElement`; `scrollTop` is on `Element` and is both a read and a write,
 * wrapped as a read because that is the half that forces the resolve.
 */
const READ_TARGETS: readonly {
  readonly proto: () => object;
  readonly name: string;
}[] = [
  { proto: () => Element.prototype, name: "clientWidth" },
  { proto: () => Element.prototype, name: "clientHeight" },
  { proto: () => HTMLElement.prototype, name: "offsetWidth" },
  { proto: () => Element.prototype, name: "scrollTop" },
];

/**
 * The writes that dirty style.
 *
 * `setProperty` is how every inline custom property and every imposer transform
 * is written, and `setAttribute` covers the attribute-keyed rules the deck
 * switches appearance with ([L06]). Both are methods rather than accessors, so
 * they are wrapped by value rather than by descriptor — the restore path
 * handles the two shapes separately for that reason.
 */
const WRITE_TARGETS: readonly {
  readonly proto: () => object;
  readonly name: string;
}[] = [
  { proto: () => CSSStyleDeclaration.prototype, name: "setProperty" },
  { proto: () => Element.prototype, name: "setAttribute" },
];

interface Restore {
  readonly proto: object;
  readonly name: string;
  readonly descriptor: PropertyDescriptor;
}

let log: ChainLogEntry[] = [];
let seq = 0;
let taskId = 0;
let taskPending = false;
let truncated = false;
let captureStacks = true;
let restores: Restore[] = [];

function siteOf(stack: string | undefined): string {
  if (stack === undefined) return "<no stack>";
  const lines = stack.split("\n");
  // Frame 0 is `Error`, frame 1 is the wrapper itself. The first frame above
  // those is the caller, which is the site worth naming.
  const frames = lines.slice(1).filter((line) => line.trim() !== "");
  const above = frames.slice(1, 1 + CHAIN_STACK_FRAMES);
  return above.join("\n").trim();
}

/**
 * The caller's site, or `"<no stack>"` when armed without stacks.
 *
 * Called directly from the wrapper, so the stack it captures has the same
 * shape {@link siteOf} expects: `Error`, this frame, the wrapper, the caller.
 */
function stackHere(): string {
  return captureStacks ? siteOf(new Error().stack) : "<no stack>";
}

function full(): boolean {
  if (log.length < CHAIN_LOG_CAP) return false;
  truncated = true;
  return true;
}

function push(
  kind: "read" | "write",
  name: string,
  t: number,
  ms: number,
  stack: string,
): void {
  if (!taskPending) {
    taskPending = true;
    // The delimiter. A microtask queued on the first entry of a task runs at the
    // end of that task's synchronous run, so incrementing there makes every
    // entry after it a later `taskId`.
    queueMicrotask(() => {
      taskPending = false;
      taskId += 1;
    });
  }
  seq += 1;
  log.push({ seq, t, ms, kind, name, taskId, stack });
}

function restoreAll(): void {
  for (const entry of [...restores].reverse()) {
    Object.defineProperty(entry.proto, entry.name, entry.descriptor);
  }
  restores = [];
}

function wrap(): void {
  for (const target of READ_TARGETS) {
    const proto = target.proto();
    const descriptor = Object.getOwnPropertyDescriptor(proto, target.name);
    if (descriptor?.get === undefined) continue;
    const original = descriptor.get;
    restores.push({ proto, name: target.name, descriptor });
    Object.defineProperty(proto, target.name, {
      ...descriptor,
      get(this: unknown) {
        if (full()) return original.call(this);
        const stack = stackHere();
        const t = performance.now();
        const value = original.call(this);
        push("read", target.name, t, performance.now() - t, stack);
        return value;
      },
    });
  }
  for (const target of WRITE_TARGETS) {
    const proto = target.proto();
    const descriptor = Object.getOwnPropertyDescriptor(proto, target.name);
    if (typeof descriptor?.value !== "function") continue;
    const original = descriptor.value as (...args: unknown[]) => unknown;
    restores.push({ proto, name: target.name, descriptor });
    Object.defineProperty(proto, target.name, {
      ...descriptor,
      value: function (this: unknown, ...args: unknown[]): unknown {
        if (full()) return original.apply(this, args);
        const stack = stackHere();
        const t = performance.now();
        const result = original.apply(this, args);
        push("write", target.name, t, performance.now() - t, stack);
        return result;
      },
    });
  }
}

export interface ChainArmReading {
  readonly armed: boolean;
  readonly cap: number;
  /** Whether each entry carries its call site; `false` writes `"<no stack>"`. */
  readonly stacks: boolean;
}

/**
 * Install the wrappers and clear the log.
 *
 * Idempotent in the only sense that matters: a second `arm` restores the first
 * one's descriptors before installing its own, so the wrappers never nest. A
 * nested wrapper would log every call twice and, worse, would survive one
 * `disarm` — the deck would keep paying for a probe nobody could see.
 *
 * `stacks: false` skips the per-entry `new Error().stack`, which is the probe's
 * main cost: a reading whose milliseconds are summed with a commit's own must
 * not carry the probe's price. Chains still count; their site reads
 * `"<no stack>"`.
 */
export function armGeometryChains(
  opts: { readonly stacks?: boolean } = {},
): ChainArmReading {
  restoreAll();
  log = [];
  seq = 0;
  taskId = 0;
  taskPending = false;
  truncated = false;
  captureStacks = opts.stacks ?? true;
  wrap();
  return {
    armed: restores.length > 0,
    cap: CHAIN_LOG_CAP,
    stacks: captureStacks,
  };
}

/** Restore every descriptor and clear the log. */
export function disarmGeometryChains(): ChainArmReading {
  restoreAll();
  log = [];
  seq = 0;
  truncated = false;
  captureStacks = true;
  return { armed: false, cap: CHAIN_LOG_CAP, stacks: captureStacks };
}

/** The current log, for the reading and for tests. */
export function geometryChainLog(): readonly ChainLogEntry[] {
  return log;
}

export function geometryChainsTruncated(): boolean {
  return truncated;
}

/**
 * Find the read→write→read chains in a log.
 *
 * Walked one task at a time, because a chain that spans a task boundary is not
 * a chain. Inside a task the walk is a small state machine: a read arms it, a
 * write after a read marks style dirty, and the next read closes a chain and
 * re-arms — so a task reading and writing in a loop reports one chain per
 * iteration rather than one for the whole task, which is what makes the count
 * proportional to the cost.
 *
 * Grouped by the site of the read that PAYS. That is the fixable end: the write
 * is usually a thing the code must do, and the read is the thing that can move
 * above it or be batched with its peers.
 */
export function classifyGeometryChains(
  entries: readonly ChainLogEntry[],
  wasTruncated = false,
): GeometryChainReading {
  const byTask = new Map<number, ChainLogEntry[]>();
  for (const entry of entries) {
    const bucket = byTask.get(entry.taskId);
    if (bucket === undefined) byTask.set(entry.taskId, [entry]);
    else bucket.push(entry);
  }

  const chains: GeometryChain[] = [];
  for (const [id, bucket] of byTask) {
    let sawRead = false;
    let pendingWrites: { name: string; site: string }[] = [];
    for (const entry of bucket) {
      if (entry.kind === "write") {
        if (sawRead) {
          pendingWrites.push({ name: entry.name, site: entry.stack });
        }
        continue;
      }
      if (sawRead && pendingWrites.length > 0) {
        chains.push({
          taskId: id,
          readSite: entry.stack,
          readName: entry.name,
          ms: entry.ms,
          t: entry.t,
          writes: pendingWrites,
        });
      }
      sawRead = true;
      pendingWrites = [];
    }
  }

  const grouped = new Map<
    string,
    { chains: number; ms: number; writeSites: Set<string>; names: Set<string> }
  >();
  for (const chain of chains) {
    let group = grouped.get(chain.readSite);
    if (group === undefined) {
      group = { chains: 0, ms: 0, writeSites: new Set(), names: new Set() };
      grouped.set(chain.readSite, group);
    }
    group.chains += 1;
    group.ms += chain.ms;
    group.names.add(chain.readName);
    for (const write of chain.writes) group.writeSites.add(write.site);
  }

  const ranked: RankedReadSite[] = [...grouped.entries()]
    .map(([site, group]) => ({
      site,
      chains: group.chains,
      ms: group.ms,
      writeSites: [...group.writeSites].slice(0, CHAIN_WRITE_SITES_PER_READ),
      names: [...group.names],
    }))
    .sort((a, b) => b.chains - a.chains);

  return {
    entries: entries.length,
    tasks: byTask.size,
    chains: chains.length,
    longestChainMs: chains.reduce((max, chain) => Math.max(max, chain.ms), 0),
    totalChainMs: chains.reduce((sum, chain) => sum + chain.ms, 0),
    chainTimes: chains.map((chain) => ({
      t: chain.t,
      ms: chain.ms,
      taskId: chain.taskId,
      name: chain.readName,
      site: chain.readSite,
      writes: chain.writes,
    })),
    ranked,
    truncated: wasTruncated,
  };
}

/** The `read` mode: classify what the armed probe has logged so far. */
export function readGeometryChains(): GeometryChainReading {
  return classifyGeometryChains(log, truncated);
}
