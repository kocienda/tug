/**
 * transfer-rate — bytes, rate and time remaining, as plain functions.
 *
 * A transfer's detail line says three things — how far, how fast, how much
 * longer — and only the first is a fact the host sends. The other two are
 * *measurements* over successive (bytes, time) pairs, and they live here
 * rather than in the painter that draws them for the usual reason: a
 * measurement with a smoothing constant in it is a thing a test should be
 * able to state, and a test that has to mount a modal to state it is a test
 * nobody writes twice.
 *
 * Nothing here touches the DOM or React. The painter owns the element; this
 * owns the arithmetic.
 *
 * @module lib/transfer-rate
 */

/**
 * Smoothing for the rate's exponentially weighted average.
 *
 * A download's instantaneous rate over one ~1% sample is noise — a stalled
 * TCP window, a burst off a CDN edge — and a readout that followed it would
 * flicker between numbers the user cannot act on. 0.25 keeps roughly the last
 * handful of samples in view, which settles within a second or two of a real
 * rate change and ignores a single bad sample.
 */
const RATE_SMOOTHING = 0.25;

/**
 * Samples closer together than this are not a measurement.
 *
 * Two events in the same millisecond divide by something near zero and report
 * a rate in gigabytes. The floor is small enough that every real sample is
 * kept — the host publishes on whole-percent changes, which on any download
 * worth a bar are tens of milliseconds apart at minimum.
 */
const MIN_SAMPLE_MS = 20;

/** A running rate estimate, folded one sample at a time. */
export interface RateEstimator {
  /** Bytes per second, or `null` before two usable samples have arrived. */
  readonly bytesPerSecond: number | null;
  /**
   * Fold in one reading. Returns the estimator to use next — a new object, so
   * a caller that keeps the old one keeps the old answer rather than being
   * mutated under itself.
   */
  sample(received: number, atMs: number): RateEstimator;
}

/** An estimator that has seen nothing. */
export function newRateEstimator(): RateEstimator {
  return makeEstimator(null, null, null);
}

function makeEstimator(
  bytesPerSecond: number | null,
  lastBytes: number | null,
  lastMs: number | null,
): RateEstimator {
  return {
    bytesPerSecond,
    sample(received: number, atMs: number): RateEstimator {
      if (lastBytes === null || lastMs === null) {
        return makeEstimator(bytesPerSecond, received, atMs);
      }
      const elapsed = atMs - lastMs;
      // A reading that went backwards is a new transfer wearing the old
      // one's estimator — a restart, or a resume that began again from zero.
      // Re-anchor rather than report a negative rate.
      if (received < lastBytes) return makeEstimator(null, received, atMs);
      if (elapsed < MIN_SAMPLE_MS) return makeEstimator(bytesPerSecond, lastBytes, lastMs);
      const instant = ((received - lastBytes) * 1000) / elapsed;
      const next =
        bytesPerSecond === null
          ? instant
          : bytesPerSecond + RATE_SMOOTHING * (instant - bytesPerSecond);
      return makeEstimator(next, received, atMs);
    },
  };
}

/**
 * A byte count in the units a person reads.
 *
 * Decimal (MB = 10^6), matching what a download's own source advertises and
 * what every other progress readout on the machine says. One decimal place
 * below 100 and none above, so the number's width barely moves as it grows.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** A rate, in the same units as {@link formatBytes}. */
export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * Time remaining, rounded to something a person would say out loud.
 *
 * Deliberately coarse and deliberately hedged with "about": an ETA computed
 * from a smoothed rate is an estimate, and a readout that said `1 m 43 s`
 * would be claiming a precision the measurement does not have. Anything over
 * an hour says so without counting, because at that range the exact number is
 * not what the user is deciding on.
 */
export function formatRemaining(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 10) return "a few seconds left";
  if (seconds < 60) return `about ${Math.round(seconds / 5) * 5} s left`;
  if (seconds < 3600) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    return `about ${minutes} min left`;
  }
  const hours = Math.round(seconds / 360) / 10;
  return `over ${hours < 1 ? 1 : Math.floor(hours)} h left`;
}

/**
 * The whole detail line for a transfer in flight ([B06]).
 *
 * `Starting…` until a total is known, and never a false 0: a bar that sat at
 * 0% because nobody has said how long the file is would be saying something
 * the host did not say. Rate and ETA join the line only once they are
 * measured, so the line grows from left to right as the transfer settles
 * rather than appearing all at once with a made-up number in it.
 */
export function transferDetailLine(
  received: number,
  expected: number,
  bytesPerSecond: number | null,
): string {
  if (expected <= 0) return "Starting…";
  const parts = [`${formatBytes(received)} of ${formatBytes(expected)}`];
  if (bytesPerSecond !== null && bytesPerSecond > 0) {
    parts.push(formatRate(bytesPerSecond));
    const remaining = formatRemaining((expected - received) / bytesPerSecond);
    if (remaining !== "") parts.push(remaining);
  }
  return parts.join(" · ");
}
