/**
 * arc-entry-points-fixture.ts — the scratch repository, the constants and the
 * helpers the at0469-arc-entry-points-* files share: a surface that shows an
 * arc lets you act on one.
 *
 * Two gestures, both of which were missing while every fact about an arc was
 * already on screen.
 *
 * **Activating an arc row opens the arc's room.** It fronts the card
 * working the arc and reveals that card's Changes shade — the one surface
 * where a decision about an arc is made ([D152]). The dispatch is the part
 * worth pinning rather than inspecting: `sendToTarget` walks the responder
 * chain *upward* from its target, so a `reveal-changes` aimed at the bare card
 * id would be swallowed in silence by `card-host`, with no error to observe.
 * The first draft of this work made exactly that mistake. A row with no open
 * worker card is the other half: it does nothing, and — because a dead click
 * on something that looked live is the failure the affordance rule exists for
 * — it does not present as activatable either.
 *
 * **A diverged arc can be replayed by hand, and the answer is always
 * audible.** The base-motion engine replays an arc when the base moves, but
 * its gate skips a repository with autoreplay off, which is what every fixture
 * arc here is. So Replay is offered whenever the arc is diverged — bound
 * or not, since boundness has no part in that gate. No outcome shows itself on
 * the row — the lifecycle line carries the arc's standing, not the checkout's
 * git bookkeeping — so every one of the five has to report somewhere else, and
 * **where depends on where the press was made.** A press on the Arcs card is
 * answered by the card's pane bulletin; a press in the Changes shade is answered
 * inside the shade, in its own notice band, because the corner lane sits in the
 * transcript region the shade's scrim dims and an answer that arrives greyed out
 * above the gesture is the dead button all over again ([B01]).
 *
 * Both halves are asserted, and they are now the two *seats* as well as the
 * two outcomes: the rail press that moves the rounds speaks in the bulletin
 * (`-replay-from-menu`), and the shade press that moves nothing speaks in the
 * band (`-replay-in-shade`) — with the corner lane asserted empty of it, which
 * is what makes the split a tested fact rather than a convention. One store
 * slot carries both, divided by the `entryKey` the press was stamped with.
 * `-row-opens-room` carries the first gesture.
 *
 * Everything is real: a scratch repository each file owns, real arcs, a real
 * base commit moving underneath them, and the real `changeset_replay`
 * round trip. No arc is ever cut in the developer's checkout.
 *
 * Split out of `at0469-arc-entry-points.test.ts` when that file was cut one
 * test to a file so each launch fits its own budget. The original built ONE
 * scratch repository in a `beforeAll` all three tests shared; each file now
 * builds its own from the same seed (`seedArcEntryPointsScratch`).
 *
 * @module tests/app-test/arc-entry-points-fixture
 */

import { realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { type App, type BodyApp } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import {
  commitRound,
  createArc,
  gitRetry,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type ArcScratchRepo,
} from "./arc-fixture";
import { kindBody } from "./_harness/card-reach";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 240_000;

export const SID = "a7c0d1ea-0000-4000-8000-000000000469";
export const CARD = '[data-card-id="A"]';
export const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
export const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;

/** The arc the session holds — the row that has a room to open. */
export const HELD = "at0469-held";
/** An arc nobody in this instance is working — the inert row. */
export const IDLE = "at0469-idle";
/** An arc whose base moved under it — the row with a replay to offer. */
export const BEHIND = "at0469-behind";
/** An arc whose round collides with that base move — the replay that refuses. */
export const CLASH = "at0469-clash";

export const SECTION = '.arcs-section';
export const arcRow = (arc: string): string =>
  `${SECTION} [data-slot="arcs-row"][data-arc="${arc}"]`;

export const BULLETIN = ".tug-pane-bulletin";
export const BULLETIN_TITLE = `${BULLETIN} [data-title]`;
/** The Changes shade's own notice band — where a shade press is answered. */
export const SHADE_NOTICE = `${CARD} [data-slot="session-changes-notice"]`;
/** Every corner bulletin on screen, as text — nothing a shade press made may be here. */
export const CORNER_TEXTS = `Array.from(document.querySelectorAll('[data-sonner-toast]')).map(function(e){ return e.textContent || ""; })`;

/** This checkout — the build under test, and never the tree an arc is cut in. */
export const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
/** The scratch repository the running file owns, and the only tree it touches.
 *  A live binding: `seedArcEntryPointsScratch` assigns it. */
export let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
export const projectDir = (): string => scratch?.repo ?? "";

/** The file the base and the diverged arc both move. */
export const SHARED_FILE = "at0469-shared.txt";
export const SHARED_BASE = "at0469 the line both sides start from\n";

/** The original file's `beforeAll`: the scratch repository, its four arcs, the
 *  base moving past two of them, and the scratch session. */
export function seedArcEntryPointsScratch(): void {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({
    prefix: "at0469",
    checkout: CHECKOUT,
    files: { [SHARED_FILE]: SHARED_BASE },
  });

  createArc(projectDir(), HELD, "at0469 the held arc", scratch.cli);
  createArc(projectDir(), IDLE, "at0469 the idle arc", scratch.cli);

  // The diverged one: a round of its own, then the base moves past it. Two
  // different files, so the replay is clean rather than conflicted — this is
  // the outcome that MOVES something, and the row's own facts are the receipt.
  const behind = createArc(projectDir(), BEHIND, "at0469 the behind arc", scratch.cli);
  writeFileSync(join(behind.worktree, "at0469-arc-only.txt"), "the arc's own line\n");
  commitRound(
    projectDir(),
    BEHIND,
    "at0469(round): the arc adds a file of its own",
    scratch.cli,
  );
  // And one whose round rewrites the very line the base is about to rewrite,
  // so its replay stops conflicted — the outcome that runs, reports, and moves
  // nothing a row could show.
  const clash = createArc(projectDir(), CLASH, "at0469 the clashing arc", scratch.cli);
  writeFileSync(join(clash.worktree, SHARED_FILE), "at0469 the arc's version\n");
  commitRound(
    projectDir(),
    CLASH,
    "at0469(round): the arc rewrites the shared line",
    scratch.cli,
  );

  writeFileSync(join(projectDir(), SHARED_FILE), `${SHARED_BASE}the base moved on\n`);
  gitRetry(projectDir(), "add", "-A");
  gitRetry(projectDir(), "commit", "-m", "at0469: the base moves ahead");

  fixtureDir = seedScratchSession(projectDir(), SID);
}

/** The original file's `afterAll`. */
export function rmArcEntryPointsScratch(): void {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
}

export const settle = (ms = 200): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

/** Bring the card up, spawn its session, and open the Arcs rail. */
export async function openArcsRail(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  // A *spawned* session, not a bound one: spawning registers the scratch repo
  // as a workspace, so its arcs reach the aggregate.
  await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
  await app.awaitEngineReady("A", { timeoutMs: 15000 });
  await app.dispatchControlAction("toggle-arcs");
  await kindBody(app, "dashes").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SECTION)}) !== null`,
    { timeoutMs: 20000 },
  );
}

/** Scroll a row into view and click it, the way the section's other tests do. */
export async function clickRow(page: BodyApp, row: string): Promise<void> {
  await page.evalJS<null>(
    `(() => {
       const el = document.querySelector(${JSON.stringify(row)});
       if (el !== null) el.scrollIntoView({ block: "center" });
       return null;
     })()`,
  );
  await settle(250);
  await page.nativeClickAtElement(row);
}
