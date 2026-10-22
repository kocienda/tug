/**
 * _land.ts — the land, read on both sides of a carried card: the card page's
 * own `body-land` row and the shell's `settle-land` row, and the bar that
 * says the land owed nothing.
 *
 * The bar is the product's (`emptyLandClause` in `settle-bar.ts`), the one
 * the settle verb prints, so the test and the verb cannot disagree about
 * what an empty land is: one frame by the settle's own land bar, and no
 * commit, forced layout, delivery, episode end or scroll write in it.
 *
 * Both rows are bench records behind the record switch, so a leg that reads
 * them arms the switch first, in the shell and in each carried card's page
 * ({@link armLandRecords}). A leg that carries a crossing its arc has not yet
 * solved notes the rows and asserts nothing; the leg the arc solves asserts
 * {@link expectEmptyLand}.
 *
 * A gesture that carries no crossing — the flow slide — sends its cards no
 * `bodyCrossing`, so no page writes a `body-land` row; its card side is the
 * page's commit census over the gesture's window ({@link readBodyCommits}).
 */

import { expect } from "bun:test";

import { note, type App } from "../_harness";
import type { DeckTraceEventShape } from "../_harness/matchers";
import { emptyLandClause, LAND_FRAMES_BAR, landIsOneFrame } from "../../../tugdeck/src/lib/motion-guard/settle-bar";
import { bodyOf } from "./_bodies";

/** A card page's `body-land` row. */
export type BodyLandRow = Extract<DeckTraceEventShape, { kind: "body-land" }>;
/** The shell's `settle-land` row. */
export type SettleLandRow = Extract<DeckTraceEventShape, { kind: "settle-land" }>;

/** How many 50 ms waits a reader gives a land's two-tick tail. */
const LAND_TAIL_WAIT_TRIES = 10;

/** Both sides of one land. */
export interface LandReading {
  readonly body: BodyLandRow | null;
  readonly shell: SettleLandRow | null;
}

/** One commit a card page's census recorded that performed work. */
export interface BodyCommit {
  readonly t: number;
  readonly performed: number;
  readonly top?: readonly (readonly [string, number])[];
}

/** The card page's own clock, the one {@link readBodyCommits} reads its window on. */
export async function bodyClock(app: App, cardId: string): Promise<number> {
  return app.body(cardId).evalJS<number>("performance.now()");
}

/**
 * The commits that performed work in `cardId`'s page since `sinceMs`, on the
 * page's own clock ({@link bodyClock}); `null` when the page has no census.
 */
export async function readBodyCommits(app: App, cardId: string, sinceMs: number): Promise<readonly BodyCommit[] | null> {
  return app.body(cardId).evalJS<readonly BodyCommit[] | null>(`(function () {
    var census = window.__tugCommits;
    if (census === undefined) return null;
    return census.since(${sinceMs}).filter(function (c) { return c.performed > 0; }).map(function (c) {
      return { t: c.t, performed: c.performed, top: c.top };
    });
  })()`);
}

/** Throw the record switch in the shell and in each of `cardIds`' pages. */
export async function armLandRecords(app: App, cardIds: readonly string[]): Promise<void> {
  // card-dom: shell — the shell's own switch.
  await app.evalJS("window.__tugMotion.record(true)");
  for (const cardId of cardIds) await app.body(cardId).evalJS("window.__tugMotion.record(true)");
}

/** The card page's last `body-land` row since `mark` in its trace, or null. */
export async function readBodyLand(app: App, cardId: string, mark?: number): Promise<BodyLandRow | null> {
  // The harness reads the trace untyped; the kind is authoritative.
  const rows = (await app.body(cardId).getDeckTrace(mark === undefined ? {} : { since: mark })).filter(
    (e) => e.kind === "body-land",
  ) as unknown as readonly BodyLandRow[];
  return rows[rows.length - 1] ?? null;
}

/** The shell's last `settle-land` row since `mark`, or null. */
export async function readSettleLand(app: App, mark?: number): Promise<SettleLandRow | null> {
  const rows = (await app.getDeckTrace(mark === undefined ? {} : { since: mark })).filter(
    (e) => e.kind === "settle-land",
  ) as unknown as readonly SettleLandRow[];
  return rows[rows.length - 1] ?? null;
}

/**
 * Read both sides of `cardId`'s land and note them, with the host's account
 * of the card's last crossing — whether it solved, how long the solve took,
 * and its cover's snapshot — asserting nothing.
 */
export async function noteLand(app: App, cardId: string, label: string, marks?: { body?: number; shell?: number }): Promise<LandReading> {
  // The page writes its row two ticks after the host's `land`, which can be
  // just after the host reports `landed`: give the tail its frames.
  let body = await readBodyLand(app, cardId, marks?.body);
  for (let i = 0; body === null && i < LAND_TAIL_WAIT_TRIES; i++) {
    await Bun.sleep(50);
    body = await readBodyLand(app, cardId, marks?.body);
  }
  const reading = { body, shell: await readSettleLand(app, marks?.shell) };
  note(`${label}: body-land ${reading.body === null ? "none" : JSON.stringify(reading.body)}`);
  note(`${label}: settle-land ${reading.shell === null ? "none" : JSON.stringify(reading.shell)}`);
  note(`${label}: body ${emptyLandClause(reading.body).detail}`);
  const crossing = ((await bodyOf(app, cardId)) as { crossing?: unknown } | null)?.crossing ?? null;
  note(`${label}: host crossing ${JSON.stringify(crossing)}`);
  return reading;
}

/**
 * The fully-solved bar on both sides: the card page's land owed nothing, and
 * the shell's land was one frame. A page with no commit census reads unread
 * rather than green, which fails here: a bar nobody could count is not met.
 *
 * `crossing: false` is a gesture that carries none, whose page writes no
 * `body-land` row: the reading's body side must be empty, and the caller
 * reads the page's commits itself ({@link readBodyCommits}).
 */
export function expectEmptyLand(reading: LandReading, label: string, options: { crossing?: boolean } = {}): void {
  if (options.crossing === false) {
    expect(reading.body, `${label}: a gesture with no crossing wrote no body-land row`).toBeNull();
  } else {
    const body = emptyLandClause(reading.body);
    expect(body.pass, `${label}: the card page's land owed nothing — ${body.detail}`).toBe(true);
  }
  const shell = reading.shell;
  expect(shell, `${label}: the shell recorded its land`).not.toBeNull();
  if (shell === null) return;
  expect(
    landIsOneFrame(shell.frameMs, shell.framePeriodMs),
    `${label}: the shell's land was one frame — ${shell.frameMs.toFixed(1)} ms against ${(shell.framePeriodMs * LAND_FRAMES_BAR).toFixed(1)}`,
  ).toBe(true);
}
