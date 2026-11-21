/**
 * `run-liveness` — what a running command's block says about how alive it
 * looks: how long it has run, how long ago it last printed, and the question
 * asked when it has gone quiet.
 *
 * The words are pure functions over times, so the offer's frame and the `$`
 * route's block say the same thing. The DOM half is one reading element that
 * carries its two times as attributes and is rewritten in place, once a
 * second, by whoever owns the container it sits in: a clock is appearance,
 * and it never goes through a store or a render.
 *
 * Laws: [L06] the reading is written to the DOM directly.
 *
 * @module lib/run-liveness
 */

/** A length of time as a running clock reads it: `8s`, `1m05s`, `1h02m`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** What a running command's reading says. */
export interface RunLivenessText {
  /** `1m05s`: how long the command has run. */
  elapsed: string;
  /** `last output 12s ago`, or `no output yet`. */
  lastOutput: string;
}

/**
 * The reading for a command started at `startedAtMs` that last printed at
 * `lastOutputAtMs` (`null` when it has printed nothing), as of `nowMs`.
 */
export function runLivenessText(
  startedAtMs: number,
  lastOutputAtMs: number | null,
  nowMs: number,
): RunLivenessText {
  return {
    elapsed: formatElapsed(nowMs - startedAtMs),
    lastOutput:
      lastOutputAtMs === null
        ? "no output yet"
        : `last output ${formatElapsed(nowMs - lastOutputAtMs)} ago`,
  };
}

/** A silence in words: `45 seconds`, `1 minute`, `6 minutes`. Under a minute
 *  it is said in seconds, and never as none; from a minute on, in the whole
 *  minutes it has lasted. The silence the feed reports runs from the last
 *  output, so after a Keep Waiting it holds the user's own pause as well and
 *  is seldom a whole number of minutes. */
function silencePhrase(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return seconds === 1 ? "1 second" : `${seconds} seconds`;
  const minutes = Math.floor(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** The question a quiet command's band asks, for a silence of `quietMs`. */
export function quietQuestion(quietMs: number): string {
  return `No output for ${silencePhrase(quietMs)}. This command might be stuck.`;
}

/** The label of the band's button that ends the command. */
export const QUIET_TERMINATE_LABEL = "Terminate";

/** The label of the band's button that leaves the command running. */
export const QUIET_KEEP_LABEL = "Keep Waiting";

/** The attribute a reading element carries: the time its command started. */
const STARTED_ATTR = "data-run-started-at";

/** The time the reading's command last printed; absent when it has not. */
const LAST_OUTPUT_ATTR = "data-run-last-output-at";

/** Every reading element under a root. */
const READING_SELECTOR = `[${STARTED_ATTR}]`;

/**
 * Point a reading element at a command and write what it says as of `nowMs`.
 * The element holds two spans, built on first use: the elapsed time and the
 * age of the last output.
 */
export function setLivenessReading(
  reading: HTMLElement,
  startedAtMs: number,
  lastOutputAtMs: number | null,
  nowMs: number,
): void {
  reading.setAttribute(STARTED_ATTR, String(startedAtMs));
  if (lastOutputAtMs === null) reading.removeAttribute(LAST_OUTPUT_ATTR);
  else reading.setAttribute(LAST_OUTPUT_ATTR, String(lastOutputAtMs));
  writeReading(reading, nowMs);
}

function writeReading(reading: HTMLElement, nowMs: number): void {
  const startedAtMs = Number(reading.getAttribute(STARTED_ATTR));
  const last = reading.getAttribute(LAST_OUTPUT_ATTR);
  const text = runLivenessText(startedAtMs, last === null ? null : Number(last), nowMs);
  let elapsed = reading.querySelector<HTMLElement>(":scope > [data-run-elapsed]");
  let lastOutput = reading.querySelector<HTMLElement>(":scope > [data-run-last-output]");
  if (elapsed === null || lastOutput === null) {
    reading.textContent = "";
    elapsed = document.createElement("span");
    elapsed.setAttribute("data-run-elapsed", "");
    lastOutput = document.createElement("span");
    lastOutput.setAttribute("data-run-last-output", "");
    reading.append(elapsed, lastOutput);
  }
  if (elapsed.textContent !== text.elapsed) elapsed.textContent = text.elapsed;
  if (lastOutput.textContent !== text.lastOutput) lastOutput.textContent = text.lastOutput;
}

/**
 * Rewrite every reading under `root` as of `nowMs`. Returns whether there
 * was one, which is whether a clock over `root` still has anything to do.
 */
export function writeLivenessReadings(root: ParentNode, nowMs: number): boolean {
  const readings = root.querySelectorAll<HTMLElement>(READING_SELECTOR);
  for (const reading of readings) writeReading(reading, nowMs);
  return readings.length > 0;
}

/** How often a running command's reading is rewritten. */
const CLOCK_MS = 1000;

/**
 * A clock over one root's readings. {@link LivenessClock.check} is called
 * after anything that may have added or removed a reading: it rewrites them
 * and keeps a one-second timer for exactly as long as one is there, so an
 * idle transcript holds no timer at all.
 */
export class LivenessClock {
  private _timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly _root: () => ParentNode | null) {}

  check = (): void => {
    const root = this._root();
    const live = root !== null && writeLivenessReadings(root, Date.now());
    if (live && this._timer === null) {
      this._timer = setInterval(this.check, CLOCK_MS);
    } else if (!live) {
      this.stop();
    }
  };

  stop(): void {
    if (this._timer === null) return;
    clearInterval(this._timer);
    this._timer = null;
  }
}
