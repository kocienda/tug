/**
 * `RunOfferStore` — the runs of a card's runnable offers.
 *
 * A runnable offer is a command the model wrote in a `tugrun` fence. Pressing
 * its Play runs the command in the card's shell session, and what comes back
 * is read under the command, in the offer's own frame — not as a turn at the
 * foot of the transcript. This store is where that result lives: one run per
 * offer, the latest, keyed by the offer.
 *
 * It holds no DOM and sends nothing. `ShellSessionStore` owns it and writes
 * to it from the one door every command goes through and from the shell feed;
 * the transcript reads it to draw each offer's frame. A frame is rebuilt
 * whenever its markdown block is, so a result that lived only in the DOM
 * would be lost on the next streaming delta or window prune.
 *
 * @module lib/run-offer-store
 */

import { Subscribable } from "./subscribable";

/** What stopped a run that did not exit on its own. */
export type RunOfferStop = "kill" | "timeout";

/** One run of one offer. A new object for every change, so identity is the
 *  change signal a reader compares. */
export interface RunOfferRun {
  /** The offer this run belongs to. */
  readonly key: string;
  /** The shell exchange carrying it; a refusal has one of its own. */
  readonly exchangeId: string;
  readonly command: string;
  readonly status: "running" | "settled";
  /** The combined output; empty while running. */
  readonly output: string;
  /** `null` while running, and for a run that was stopped. */
  readonly exitCode: number | null;
  /** The directory the command ran in. */
  readonly cwd: string;
  readonly startedAtMs: number;
  readonly settledAtMs: number | null;
  /** Set when the run ended because it was stopped. */
  readonly stoppedBy: RunOfferStop | null;
  /** True when the command was answered with a notice and never run. */
  readonly refused: boolean;
}

/** The facts an exchange settles with. */
export interface RunOfferSettle {
  output: string;
  exitCode: number | null;
  cwd?: string;
  startedAtMs?: number;
  settledAtMs: number;
  stoppedBy?: RunOfferStop | null;
}

/**
 * The key of an offer: where it was written and what it says. The scope
 * names the message the fence is in, the index is the fence's position among
 * that message's offers, and the hash is of the command, so an edited command
 * at the same position is a different offer.
 *
 * The key is written into the shell ledger beside the exchange, so every part
 * of it has to read the same after a reload. That is why the scope is the
 * message's wire-derived key and never the turn's, which is minted afresh by
 * each page that loads the transcript.
 */
export function runOfferKey(scope: string, index: number, command: string): string {
  return `${scope}#${index}#${hashCommand(command)}`;
}

/** A key taken apart again, or `null` for a string that is not one. */
export function parseRunOfferKey(
  key: string,
): { scope: string; index: number; hash: string } | null {
  const hashAt = key.lastIndexOf("#");
  const indexAt = hashAt <= 0 ? -1 : key.lastIndexOf("#", hashAt - 1);
  if (indexAt < 0) return null;
  const index = Number(key.slice(indexAt + 1, hashAt));
  if (!Number.isInteger(index) || index < 0) return null;
  return { scope: key.slice(0, indexAt), index, hash: key.slice(hashAt + 1) };
}

/** FNV-1a over the command's UTF-16 units, as eight hex digits. */
export function hashCommand(command: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < command.length; i += 1) {
    hash ^= command.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** How long a run took, in the transcript's own short form. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

/** What a settled or running run reads as, and whether it went wrong. */
export interface RunOfferStatusView {
  /** `running`, `exit 0`, `stopped`, `timed out`, `not run`. */
  label: string;
  tone: "running" | "ok" | "fail";
  /** `1.2s`; `null` while running and for a command that never ran. */
  duration: string | null;
}

export function runOfferStatus(run: RunOfferRun): RunOfferStatusView {
  if (run.status === "running") return { label: "running", tone: "running", duration: null };
  if (run.refused) return { label: "not run", tone: "fail", duration: null };
  const duration = formatDuration(
    Math.max(0, (run.settledAtMs ?? run.startedAtMs) - run.startedAtMs),
  );
  if (run.stoppedBy === "timeout") return { label: "timed out", tone: "fail", duration };
  if (run.exitCode === null) return { label: "stopped", tone: "fail", duration };
  return {
    label: `exit ${run.exitCode}`,
    tone: run.exitCode === 0 ? "ok" : "fail",
    duration,
  };
}

export class RunOfferStore extends Subscribable {
  private readonly _runs = new Map<string, RunOfferRun>();
  private readonly _keyByExchange = new Map<string, string>();

  /** The latest run of an offer, or `undefined` when it has never been run. */
  get(key: string): RunOfferRun | undefined {
    return this._runs.get(key);
  }

  /**
   * The run that belongs to the offer `key` names, among the offers now on
   * screen (`present`, the keys of every offer drawn beside it).
   *
   * The run keyed exactly so is the answer when there is one. Otherwise the
   * offer may have moved: a message that was edited or streamed again can
   * gain or lose an offer above this one, which shifts the index and leaves
   * the message and the command as they were. So a run in the same message,
   * of the same command, at an index no offer on screen now holds, is this
   * offer's run under its old position. The latest such run wins.
   */
  match(key: string, present: ReadonlySet<string>): RunOfferRun | undefined {
    const exact = this._runs.get(key);
    if (exact !== undefined) return exact;
    const want = parseRunOfferKey(key);
    if (want === null) return undefined;
    let found: RunOfferRun | undefined;
    for (const run of this._runs.values()) {
      if (present.has(run.key)) continue;
      const have = parseRunOfferKey(run.key);
      if (have === null || have.scope !== want.scope || have.hash !== want.hash) continue;
      if (found === undefined || run.startedAtMs > found.startedAtMs) found = run;
    }
    return found;
  }

  /** Drop an offer's run. Used when the offer is run again from a new
   *  position, so the run under its old key does not outlive the one that
   *  replaced it. */
  forget(key: string): void {
    const run = this._runs.get(key);
    if (run === undefined) return;
    this._keyByExchange.delete(run.exchangeId);
    this._runs.delete(key);
    this.notify();
  }

  /**
   * Take ledgered runs back in after a reload, oldest first. One offer keeps
   * one result, the latest, so a later row for the same offer replaces an
   * earlier one. A run this page saw live is never overwritten by the
   * ledger's copy of the same exchange or of an older one: the live run is
   * at least as new, and it knows what stopped it, which the ledger does not.
   */
  restore(
    rows: ReadonlyArray<{
      key: string;
      exchangeId: string;
      command: string;
      output: string;
      exitCode: number | null;
      cwd: string;
      startedAtMs: number;
      settledAtMs: number;
    }>,
  ): void {
    let changed = false;
    for (const row of rows) {
      const prior = this._runs.get(row.key);
      if (prior !== undefined) {
        if (prior.exchangeId === row.exchangeId) continue;
        if (prior.status === "running") continue;
        if ((prior.settledAtMs ?? prior.startedAtMs) >= row.settledAtMs) continue;
        this._keyByExchange.delete(prior.exchangeId);
      }
      this._runs.set(row.key, {
        ...row,
        status: "settled",
        stoppedBy: null,
        refused: false,
      });
      changed = true;
    }
    if (changed) this.notify();
  }

  /** The offer an exchange belongs to, or `undefined` for any other exchange. */
  keyForExchange(exchangeId: string): string | undefined {
    return this._keyByExchange.get(exchangeId);
  }

  /** Begin a run. It replaces the offer's earlier run: one offer shows one
   *  result, the latest. */
  start(run: {
    key: string;
    exchangeId: string;
    command: string;
    cwd: string;
    startedAtMs: number;
  }): void {
    const prior = this._runs.get(run.key);
    if (prior !== undefined) this._keyByExchange.delete(prior.exchangeId);
    this._keyByExchange.set(run.exchangeId, run.key);
    this._runs.set(run.key, {
      ...run,
      status: "running",
      output: "",
      exitCode: null,
      settledAtMs: null,
      stoppedBy: null,
      refused: false,
    });
    this.notify();
  }

  /** The shell echoed the exchange's start: take its directory and clock. */
  started(exchangeId: string, facts: { cwd: string; startedAtMs: number }): void {
    const run = this._running(exchangeId);
    if (run === undefined) return;
    this._runs.set(run.key, { ...run, cwd: facts.cwd, startedAtMs: facts.startedAtMs });
    this.notify();
  }

  /** A piece of a running exchange's output arrived: the run's output grows
   *  by it. A piece for any other exchange, or for a run that has already
   *  settled, is dropped, since the settle carried the whole. */
  append(exchangeId: string, chunk: string): void {
    const run = this._running(exchangeId);
    if (run === undefined || chunk.length === 0) return;
    this._runs.set(run.key, { ...run, output: run.output + chunk });
    this.notify();
  }

  /** Settle a run. Returns whether the exchange was an offer's. */
  settle(exchangeId: string, facts: RunOfferSettle): boolean {
    const key = this._keyByExchange.get(exchangeId);
    if (key === undefined) return false;
    const run = this._runs.get(key);
    if (run === undefined || run.exchangeId !== exchangeId) return true;
    this._runs.set(key, {
      ...run,
      status: "settled",
      // A run the timeout stopped settles with no output of its own, because
      // the reader that held it was abandoned with the command. What had
      // streamed in by then is all there is, and it stays.
      output:
        facts.output.length === 0 && facts.stoppedBy === "timeout" ? run.output : facts.output,
      exitCode: facts.exitCode,
      cwd: facts.cwd ?? run.cwd,
      startedAtMs: facts.startedAtMs ?? run.startedAtMs,
      settledAtMs: facts.settledAtMs,
      stoppedBy: facts.stoppedBy ?? null,
    });
    this.notify();
    return true;
  }

  /** Answer an offer with a notice in place of running it. */
  refuse(run: {
    key: string;
    exchangeId: string;
    command: string;
    cwd: string;
    notice: string;
    atMs: number;
  }): void {
    const prior = this._runs.get(run.key);
    if (prior !== undefined) this._keyByExchange.delete(prior.exchangeId);
    this._runs.set(run.key, {
      key: run.key,
      exchangeId: run.exchangeId,
      command: run.command,
      status: "settled",
      output: run.notice,
      exitCode: 1,
      cwd: run.cwd,
      startedAtMs: run.atMs,
      settledAtMs: run.atMs,
      stoppedBy: null,
      refused: true,
    });
    this.notify();
  }

  private _running(exchangeId: string): RunOfferRun | undefined {
    const key = this._keyByExchange.get(exchangeId);
    const run = key === undefined ? undefined : this._runs.get(key);
    return run !== undefined && run.exchangeId === exchangeId && run.status === "running"
      ? run
      : undefined;
  }
}
