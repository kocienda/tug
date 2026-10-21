/**
 * beep-report.ts — the test-mode beep tripwire's result, on the harness side.
 *
 * The app process counts the no-responder beeps AppKit raises during a run
 * (`tugapp/Sources/TestHarness/BeepTripwire.swift`) and hands them over the
 * `beepReport` RPC. The harness reads that report at every teardown
 * (`App.close`, `App.quitGracefully`) and accumulates it here, because one
 * test file may launch several app processes and the verdict is over the file,
 * not any one launch. The preload's `afterAll` then throws
 * {@link formatBeepFailure} when the file beeped at all, so the run summary's
 * `Failures:` section names the file and what provoked each beep — a beep is a
 * red (brief [B03]).
 *
 * Bun re-evaluates modules per test file, so this accumulator is per file:
 * `App.close` and the preload share one instance within a file's run, and the
 * next file starts clean.
 */

/** One beep the app-side tripwire caught, as the `beepReport` RPC reports it. */
export interface CaughtBeep {
  /** The AppKit origin, e.g. `noResponderFor(keyDown:)`. */
  readonly origin: string;
  /** The last harness verb dispatched before the beep, when one is known. */
  readonly verb?: string;
  /** The top of the call stack at the beep, trimmed. */
  readonly stack?: readonly string[];
  /**
   * The launch the beep happened in — the `testName` the test gave
   * `launchTugApp`, else the instance id. Stamped by the harness, not the app:
   * a file that launches several apps needs it to say which test beeped.
   */
  readonly launch?: string;
}

/** The `beepReport` RPC payload. */
export interface BeepReport {
  readonly count: number;
  readonly beeps: readonly CaughtBeep[];
}

const caught: CaughtBeep[] = [];

/**
 * Fold one launch's `beepReport` into the file's running total. A malformed or
 * absent report (an app built before the verb) folds in nothing rather than
 * throwing — a missing tripwire is not a beep.
 */
export function recordBeeps(report: BeepReport | null | undefined, launch?: string): void {
  if (report === null || report === undefined) return;
  if (!Array.isArray(report.beeps)) return;
  for (const beep of report.beeps) {
    if (beep !== null && typeof beep === "object" && typeof beep.origin === "string") {
      caught.push(launch === undefined ? beep : { ...beep, launch });
    }
  }
}

/** The beeps caught in this file's run so far. */
export function caughtBeeps(): readonly CaughtBeep[] {
  return caught;
}

/** Drop the accumulated beeps — for tests of this module only. */
export function resetCaughtBeeps(): void {
  caught.length = 0;
}

/** How many frames of a beep's stack the failure message shows. */
const STACK_FRAMES_SHOWN = 6;

/**
 * The frames of a beep's stack worth reading: the ones past the tripwire and
 * the `noResponder` chokepoint that recorded it, which every beep shares and
 * which say nothing about what provoked it. A frame of `callStackSymbols` is
 * `N  image  address  symbol + offset`; the symbol is what a reader wants.
 */
function provokingFrames(stack: readonly string[] | undefined): string[] {
  if (stack === undefined) return [];
  const out: string[] = [];
  for (const frame of stack) {
    if (/BeepTripwire|noResponder/.test(frame)) continue;
    const m = /^\s*\d+\s+(\S+)\s+0x[0-9a-fA-F]+\s+(.*)$/.exec(frame);
    out.push(m === null ? frame.trim() : `${m[1]}: ${m[2]}`);
    if (out.length === STACK_FRAMES_SHOWN) break;
  }
  return out;
}

/**
 * The failure message for a file whose run beeped. Pure over its input so the
 * shape is unit-tested without an app. One summary line, then one line per
 * distinct launch, origin and verb with how many times it fired, most frequent
 * first, each followed by the frames of its first beep's stack past the
 * tripwire — the detail a reader needs to find the launch and the verb that
 * provoked the beep and the AppKit path it took, without reprinting an
 * identical line per beep.
 */
export function formatBeepFailure(beeps: readonly CaughtBeep[]): string {
  const n = beeps.length;
  const plural = n === 1 ? "beep" : "beeps";
  const header = `${n} ${plural} during this run — the harness contract is silence (brief [B03]).`;

  // Group by launch + origin + verb, preserving first-seen order for the tie-break.
  const counts = new Map<string, { launch?: string; origin: string; verb?: string; count: number; frames: string[] }>();
  for (const beep of beeps) {
    const key = `${beep.launch ?? ""}\u0000${beep.origin}\u0000${beep.verb ?? ""}`;
    const prior = counts.get(key);
    if (prior === undefined) {
      counts.set(key, { launch: beep.launch, origin: beep.origin, verb: beep.verb, count: 1, frames: provokingFrames(beep.stack) });
    } else {
      prior.count += 1;
    }
  }

  const lines = [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .flatMap((g) => {
      const times = g.count === 1 ? "" : ` ×${g.count}`;
      const after = g.verb ? ` after verb \`${g.verb}\`` : " with no verb recorded";
      const where = g.launch ? ` in launch \`${g.launch}\`` : "";
      return [`  • ${g.origin}${after}${where}${times}`, ...g.frames.map((f) => `      ${f}`)];
    });

  return [header, ...lines].join("\n");
}
