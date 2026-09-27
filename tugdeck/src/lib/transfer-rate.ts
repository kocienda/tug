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

/**
 * How many characters of one detail line the UpdateTug download row can show
 * before it wraps — and a wrap is what this budget exists to prevent, because a
 * row saying its line in two lines while its neighbours say theirs in one is the
 * geometry complaint this whole surface was fixed for ([B01]).
 *
 * The number is measured rather than reasoned. `at0632` reads the row's own box
 * in the running app and records it: the download row gives its detail line
 * **338px** while *Stop for Now* stands beside it — the narrowest any row of the
 * wizard gets — and the line renders at close to **5.76px per character** at
 * 13px, so 58 is the last count that fits (58 × 5.76 = 334px). The other rows
 * are wider (360–474px), which is why the budget belongs to the tightest of
 * them.
 *
 * Because it was measured on one row, it governs only the line that row asks
 * for: a call that passes a `trailer` is the download row mid-transfer with
 * *Stop for Now* beside it, and it is the only shape that can outgrow 352px.
 * ConfigureTug paints its own download line through this function and is a
 * different row of a different panel — a budget taken from the wizard's
 * narrowest column is not a fact about it, so it is not applied there.
 *
 * It is a character count rather than a width because the alternative is reading
 * the element's width from the painter once a second, which is a layout read in
 * the one place ([L06]) exists to keep free of them. Crossing it sheds the ETA,
 * and the ETA is the one clause here that can be shed.
 */
const DETAIL_LINE_BUDGET = 58;

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
 *
 * `trailer` is a consequence rather than a measurement — what stopping would
 * cost, said while the transfer is still running ([B05]) — and it joins after an
 * em dash rather than as another `·` term, because it is not one more fact about
 * the transfer. It is also the one clause that cannot be shed: a line too long
 * with it drops the **ETA** first and keeps the warning, since the ETA is a
 * number the bar and the byte count between them already imply and the warning
 * is the only place the panel says the download starts over.
 */
export function transferDetailLine(
  received: number,
  expected: number,
  bytesPerSecond: number | null,
  trailer?: string,
): string {
  const tail = trailer === undefined || trailer === "" ? "" : ` — ${trailer}`;
  if (expected <= 0) return `Starting…${tail}`;
  const parts = [`${formatBytes(received)} of ${formatBytes(expected)}`];
  let remaining = "";
  if (bytesPerSecond !== null && bytesPerSecond > 0) {
    parts.push(formatRate(bytesPerSecond));
    remaining = formatRemaining((expected - received) / bytesPerSecond);
  }
  if (remaining === "") return `${parts.join(" · ")}${tail}`;
  const withEta = `${[...parts, remaining].join(" · ")}${tail}`;
  if (tail === "" || withEta.length <= DETAIL_LINE_BUDGET) return withEta;
  return `${parts.join(" · ")}${tail}`;
}
