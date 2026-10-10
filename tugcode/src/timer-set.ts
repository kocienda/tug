// The session manager's process-bound timers, held in one place so a
// teardown clears them in one call.
//
// A timer belongs here when it is armed on behalf of one claude process and
// means nothing once that process is gone: the activity-flush heartbeat, the
// cancel-escalation ladder, the result watchdog, and the resume handshake's
// health gate. `killAndCleanup` calls `clearAll()`, so a respawn starts with
// none of the previous process's timers armed.
//
// A timer that settles a promise its caller awaits does not belong here —
// clearing it from outside would strand the await. Those stay local to the
// operation that arms them and are cleared by its own `finally`.

type Handle = ReturnType<typeof setTimeout>;

interface Entry {
  handle: Handle;
  kind: "timeout" | "interval";
}

export interface TimerOptions {
  /** Let a quiescent process exit while this timer is armed. */
  unref?: boolean;
}

export class TimerSet {
  private readonly timers = new Map<string, Entry>();

  /**
   * Arm a one-shot timer under `key`, replacing any timer already armed
   * under it. The entry is dropped before `fn` runs, so `has(key)` reads
   * `false` from inside the callback.
   */
  setTimeout(key: string, fn: () => void, ms: number, opts: TimerOptions = {}): void {
    this.clear(key);
    const handle = setTimeout(() => {
      if (this.timers.get(key)?.handle === handle) this.timers.delete(key);
      fn();
    }, ms);
    if (opts.unref === true) handle.unref?.();
    this.timers.set(key, { handle, kind: "timeout" });
  }

  /** Arm a repeating timer under `key`, replacing any timer already armed under it. */
  setInterval(key: string, fn: () => void, ms: number, opts: TimerOptions = {}): void {
    this.clear(key);
    const handle = setInterval(fn, ms);
    if (opts.unref === true) handle.unref?.();
    this.timers.set(key, { handle, kind: "interval" });
  }

  /** Whether a timer is armed under `key`. */
  has(key: string): boolean {
    return this.timers.has(key);
  }

  /** Clear the timer armed under `key`, if any. */
  clear(key: string): void {
    const entry = this.timers.get(key);
    if (entry === undefined) return;
    if (entry.kind === "interval") clearInterval(entry.handle);
    else clearTimeout(entry.handle);
    this.timers.delete(key);
  }

  /** Clear every armed timer. */
  clearAll(): void {
    for (const key of [...this.timers.keys()]) this.clear(key);
  }

  /** The keys of every armed timer. */
  keys(): string[] {
    return [...this.timers.keys()];
  }
}
