/**
 * list-view-height-persist — the measured-height ledger as a card-state
 * payload, so a reopened or relaunched list windows from its first commit
 * instead of draining every row it has never measured.
 *
 * The payload rides the [A9] `bag.components` axis. It records each height
 * by a replay-stable row id (never the React key, which a replay re-mints)
 * together with the three samples the heights were measured under: the
 * scroller's width, the page zoom factor and the row gap. A list whose
 * live samples match seeds the heights fresh; one whose samples differ
 * seeds them stale, and they drain exactly as a width reflow's do.
 *
 * Pure helpers over index-addressed reads and writes, so the transcript's
 * `HeightIndex` and the Overview's keyed ledger share one implementation.
 */

/** The most heights one payload carries, taken nearest the tail. */
export const PERSISTED_HEIGHTS_MAX = 2000;

/** Width tolerance, in layout px, under which a recorded width matches. */
const WIDTH_TOLERANCE_PX = 0.5;

/** The samples a set of heights was measured under. */
export interface HeightSample {
  /** The scroller's `clientWidth`, in layout px. */
  width: number;
  /** `pageZoomStore.getFactor()`. */
  zoomFactor: number;
  /** The list's resolved row gap, in px. */
  rowGap: number;
}

/** The persisted payload. */
export interface PersistedHeightLedger extends HeightSample {
  v: 1;
  /** `[id, extent]`, at most {@link PERSISTED_HEIGHTS_MAX}, in row order. */
  entries: [id: string, extent: number][];
}

/** The ledger operations seeding needs, addressed by row index. */
export interface HeightSeedTarget {
  has(index: number): boolean;
  set(index: number, height: number): void;
  markStale(index: number): void;
}

/** Whether heights recorded under `recorded` hold under `live`. */
export function heightSamplesMatch(recorded: HeightSample, live: HeightSample): boolean {
  return (
    Math.abs(recorded.width - live.width) <= WIDTH_TOLERANCE_PX &&
    recorded.zoomFactor === live.zoomFactor &&
    recorded.rowGap === live.rowGap
  );
}

/**
 * Capture the heights of `[0, itemCount)` as a payload. `read` returns a
 * height only where it holds at the live samples (a stale height was
 * measured under other samples, so it is not recorded under these).
 * Walks from the tail, skips rows with no id, drops both rows of a
 * duplicated id, and stops at the cap.
 */
export function capturePersistedHeights(
  read: (index: number) => number | undefined,
  itemCount: number,
  idFor: (index: number) => string | null,
  sample: HeightSample,
): PersistedHeightLedger {
  const picked: [string, number][] = [];
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (let i = itemCount - 1; i >= 0 && picked.length < PERSISTED_HEIGHTS_MAX; i -= 1) {
    const id = idFor(i);
    if (id === null) continue;
    if (seen.has(id)) {
      duplicated.add(id);
      continue;
    }
    seen.add(id);
    const h = read(i);
    if (h === undefined || !Number.isFinite(h) || h < 0) continue;
    picked.push([id, h]);
  }
  const entries = picked.filter(([id]) => !duplicated.has(id)).reverse();
  return { v: 1, width: sample.width, zoomFactor: sample.zoomFactor, rowGap: sample.rowGap, entries };
}

/**
 * Carry `carried`'s entries into `captured` for every id the capture did not
 * record — rows the list has not seen since it mounted, or has not yet been
 * given — when both were measured under the same samples. A capture taken
 * before the rows arrive would otherwise overwrite every persisted height
 * with an empty ledger. The captured entries keep the tail, and the cap
 * drops the carried ones first.
 */
export function carryPersistedHeights(
  captured: PersistedHeightLedger,
  carried: PersistedHeightLedger | undefined,
): PersistedHeightLedger {
  if (carried === undefined || !heightSamplesMatch(carried, captured)) return captured;
  const have = new Set(captured.entries.map(([id]) => id));
  const kept = carried.entries.filter(([id]) => !have.has(id));
  const room = Math.max(0, PERSISTED_HEIGHTS_MAX - captured.entries.length);
  return { ...captured, entries: [...kept.slice(Math.max(0, kept.length - room)), ...captured.entries] };
}

/**
 * Seed `target` from `record` for every index whose id the record carries
 * and which has no height yet. The seeded heights are fresh when the
 * record's samples match `live`, and stale otherwise. Returns the seeded
 * indices, so a later sample check can mark exactly those stale.
 */
export function seedPersistedHeights(
  target: HeightSeedTarget,
  record: PersistedHeightLedger,
  itemCount: number,
  idFor: (index: number) => string | null,
  live: HeightSample,
): { seeded: number[]; stale: boolean } {
  const byId = new Map<string, number>(record.entries);
  const stale = !heightSamplesMatch(record, live);
  const seeded: number[] = [];
  if (byId.size === 0) return { seeded, stale };
  for (let i = 0; i < itemCount; i += 1) {
    if (target.has(i)) continue;
    const id = idFor(i);
    if (id === null) continue;
    const h = byId.get(id);
    if (h === undefined) continue;
    target.set(i, h);
    if (stale) target.markStale(i);
    seeded.push(i);
  }
  return { seeded, stale };
}

/**
 * Coerce a restored payload into a {@link PersistedHeightLedger}. An unknown
 * version or a malformed record is `undefined`, so the list starts with an
 * empty ledger rather than a crash; malformed entries are dropped one by one.
 */
export function coercePersistedHeights(raw: unknown): PersistedHeightLedger | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const obj = raw as Partial<PersistedHeightLedger>;
  if (obj.v !== 1) return undefined;
  const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  if (!finite(obj.width) || !finite(obj.zoomFactor) || !finite(obj.rowGap)) return undefined;
  if (!Array.isArray(obj.entries)) return undefined;
  const entries: [string, number][] = [];
  for (const e of obj.entries as unknown[]) {
    if (!Array.isArray(e) || e.length !== 2) continue;
    const [id, h] = e as [unknown, unknown];
    if (typeof id !== "string" || !finite(h) || h < 0) continue;
    entries.push([id, h]);
  }
  return {
    v: 1,
    width: obj.width,
    zoomFactor: obj.zoomFactor,
    rowGap: obj.rowGap,
    entries: entries.slice(-PERSISTED_HEIGHTS_MAX),
  };
}
