/**
 * AT0445 — the shade summons itself when an arc is ready to join.
 *
 * ## Why this exists
 *
 * The arc's whole shape is *the machine works first, the user decides once*.
 * The machine half is at0441's. This is the deciding half, and its decision
 * surface is the **Changes shade** — a standing room the card reveals rather
 * than a dialog it mounts.
 *
 * That replaced an inline prompt, and the reason is a live incident. A reflex
 * Escape answered "Not yet"; the dismissal was durable, keyed on the arc
 * head, and suppressed every re-ask; recovery took a hand-run `git config
 * --unset-all`. A transient surface has no reopen gesture by construction. A
 * standing one does: closing the shade discards nothing, because the arc row
 * is still in there. So the whole dismissal apparatus — the mark, its re-ask
 * policy, the answer frame — is gone, and this file's negatives changed shape
 * with it: the claim is no longer "a dismissal holds" but "closing costs
 * nothing and new work summons again".
 *
 * Six claims:
 *
 * - A reconciled arc **bound to this card's session** reveals the shade, with
 *   no gesture and **no mark anywhere** ([D147]). Both fixture arcs are
 *   plan-less, so a committed round on a clean worktree is the whole of what
 *   arms them. This is the negative that matters most: the arc used to sit
 *   dark behind a declaration a skill had to remember to make, and a `mark
 *   built` reintroduced here would hide that regression the moment it returned.
 * - **The card goes to the Changes route, not to a glance at it.** Work ready
 *   to join arrives presented: the Z4A toggle reads Changes, join mode is up,
 *   and the Z5 is the Join button — the state the user would otherwise have to
 *   build by hand before the ⬆ meant anything. The shade without the mode was
 *   the half-switched card this file used to pin, and the field complaint that
 *   retired it: the room open, the composer still a prompt, and the join
 *   behind a door the reveal declined to open.
 * - **The fold says what would land, and whose words those are.** With no
 *   draft written, the join would quietly land the branch description; the
 *   provenance note is where "quietly" stops. Write a draft while the shade
 *   stands and it repaints in place — the lands-as is a live view of the
 *   ledger, not a snapshot of the moment the offer was raised. It used to be a
 *   snapshot, and the field consequence was a surface announcing "no draft was
 *   written" over a join that landed with one.
 * - **The Changes segment wears the offer while the room is closed**, and rests
 *   while it is open. The held signal for the case a reveal must yield to — a
 *   running turn, a folded card — so an offer is never silent, only
 *   quiet.
 * - **Closing costs nothing, and does not re-reveal.** The shade goes down and
 *   stays down for the same work across a full re-run of the arc — a base
 *   move replays the arc's rounds onto the new base, rewriting its head, and
 *   re-reconciles in silence, because the card remembers the server's work id
 *   rather than the head. The memory is the card's, for this mount only:
 *   nothing durable records that a room was closed, which is precisely the
 *   machinery whose absence this file pins.
 * - **New work summons it again.** A round the user has never seen mints a new
 *   offer id, and the shade comes back up.
 *
 * And one about reach: an **unbound** arc, with facts identical to the bound
 * one's in the same repository at the same moment, is ready too — readiness is
 * derived from the arc's facts, and nothing has to work an arc to make it so —
 * but it is the bound card's offer alone that summons that card's shade, and
 * the bound card's room never offers to land the arc nobody is working.
 *
 * The join **press** is not this file's subject — at0436 drives it, at the
 * composer's ⬆ where it lives. The offer's disappearance after a landing is
 * structural rather than pinned here: the dot and the fold both derive from a
 * feed entry that `broadcast_arc_gone` removes.
 *
 * ## The fixture
 *
 * One scratch repository, two arcs, neither conflicting with the base and
 * neither ever marked. A plan-less arc with no wheel is ready on its first
 * round, which is what makes the reveal the *only* thing this file drives; the
 * unbound one is the control. Nothing is built anywhere, so the arc runs at
 * git speed.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-lane.tsx
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/lib/shade-view-controller.ts
 * @covers tugdeck/src/lib/changeset-types.ts
 * @covers tugdeck/src/lib/arc-join-register.ts
 * @covers tugdeck/src/lib/join-offer-reveal.ts
 * @covers tugdeck/src/components/arcs/arcs-card.tsx
 * @covers tugrust/crates/tugarc-core/src/log.rs
 * @covers tugrust/crates/tugarc-core/src/ops/join.rs
 * @covers tugrust/crates/tugarc-core/src/ops/show.rs
 * @covers tugrust/crates/tugarc-core/src/replay.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_board.rs
 * @covers tugrust/crates/tugcast-core/src/types.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { sessionCardShape } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  commitRound,
  createArc,
  disarmAutoreplay,
  gitRetry as git,
  makeArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 420_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000445";

/** The bound arc — the one this card would join. */
const ARC = "at0445-bound";
/** The other one, in the same repo, at the same stage, bound to nobody. */
const QUIET_ARC = "at0445-quiet";

const CARD = '[data-card-id="A"]';
/** The Changes shade — the arc's decision surface, and what a ready arc
 *  summons. Its presence IS the reveal. */
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-arc-lane"]`;
/** The bound arc's row and the fold that opens with it. */
const ROW = `${LANE} [data-slot="session-changes-arc-row"][data-arc="${ARC}"]`;
/** What this join would land, composed exactly as the landing composes it. */
const LANDS_AS = `${ROW} [data-slot="session-changes-arc-lands-as"]`;
/** Where those words came from, when it is not somebody's draft. */
const LANDS_AS_NOTE = `${ROW} [data-slot="session-changes-arc-lands-as-note"]`;
/** The Z4A route group — invariant in shape and words, so the offer rides an
 *  attribute rather than a label or a third segment. */
const ROUTE_GROUP = `${CARD} .tug-prompt-entry-route-group`;
/** The composer's Z5 in its prompt form — present only when no landing is up,
 *  which is how its *absence* reads as "the card went to the Changes route". */
const SUBMIT = `${CARD} [data-slot="tug-prompt-entry"] [data-mode]`;
/** The Z5 the join wears: the control that actually lands, per at0436. */
const JOIN_BUTTON = `${CARD} .tug-prompt-entry-commit-button[aria-label="Join"]`;

const ARCS_CARD = '.arcs-section';
const arcRow = (arc: string): string =>
  `${ARCS_CARD} [data-slot="arcs-row"][data-arc="${arc}"]`;

/** The checkout whose built binaries the fixture drives. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch = "";
let boundWorktree = "";
let dataRoot = "";
let fixtureDir = "";
let cli: { binaryRoot?: string; env?: Record<string, string> } = {};

beforeAll(() => {
  if (!SHOULD_RUN) return;
  const base = makeArcScratchRepo({ prefix: "at0445", checkout: CHECKOUT });
  scratch = base.repo;
  dataRoot = base.dataRoot;
  cli = base.cli;

  // Two arcs, each touching a file of its own, so neither conflicts with the
  // base or with the other. The arc they walk is the quiet one — reconcile,
  // ready — which is exactly the state the offer stands on.
  const bound = createArc(scratch, ARC, "at0445 bound-arc fixture", cli);
  boundWorktree = bound.worktree;
  writeFileSync(join(bound.worktree, "bound.txt"), "at0445 the bound arc's file\n");
  commitRound(scratch, ARC, "at0445(round): the bound arc's work", cli);

  const quiet = createArc(scratch, QUIET_ARC, "at0445 unbound-arc fixture", cli);
  writeFileSync(join(quiet.worktree, "quiet.txt"), "at0445 the unbound arc's file\n");
  commitRound(scratch, QUIET_ARC, "at0445(round): the unbound arc's work", cli);

  // No `arc mark built` anywhere, deliberately ([D147]). Both arcs are
  // plan-less, so a committed round on a clean worktree is the whole of what
  // arms them — which is the guarantee this file exists to hold: the arc must
  // not depend on a skill remembering to declare anything.

  fixtureDir = seedScratchSession(scratch, SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
  if (dataRoot !== "") rmSync(dataRoot, { recursive: true, force: true });
  rmScratchSession(fixtureDir);
});

const settle = (ms = 200): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

/** Whether the shade is up right now. */
function shadeUp(app: App): Promise<boolean> {
  return app.body("A").evalJS<boolean>(
    `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
  );
}

/**
 * Wait for an arc's Arcs-card register to reach a word — the arc, without a
 * gesture. Read off the ROW rather than off the register band: a ready arc
 * says so in the lifecycle line's own words and draws no band at all.
 */
async function registerReaches(
  app: App,
  arc: string,
  word: string,
  timeoutMs: number,
): Promise<void> {
  await kindBody(app, "dashes").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(arcRow(arc))})?.getAttribute("data-join-word") === ${JSON.stringify(word)}`,
    { timeoutMs },
  );
}

/**
 * In-page recorders over the whole run, installed once the Arcs card lists
 * the arcs. MutationObservers rather than a poll from outside, so a value
 * that appears and is superseded between two reads still counts. The shade
 * is in the Session card's body and the rows are in the Arcs card's, so each
 * page records its own half:
 *
 *  - `quiet` (Arcs card): every register word the unbound arc's row ever
 *    wore, so "it reached ready" is a claim about the whole run rather than
 *    about a window sampled at its end;
 *  - `bound` (Arcs card): every word the bound arc's row wore since the last
 *    reset, noted across the base move;
 *  - `sheetSeen` (Session card): whether the shade mounted at any moment
 *    while `armSheet` was set.
 */
const SHEET_RECORDER_INSTALL = `(function () {
  var r = (window.__at0445 = { armSheet: false, sheetSeen: false });
  r.tick = function () {
    if (r.armSheet && document.querySelector(${JSON.stringify(SHEET)}) !== null) r.sheetSeen = true;
  };
  r.obs = new MutationObserver(r.tick);
  r.obs.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-join-word"],
  });
  r.tick();
  return null;
})()`;
const ROW_RECORDER_INSTALL = `(function () {
  var r = (window.__at0445 = { bound: [], quiet: [] });
  function word(sel) {
    var el = document.querySelector(sel);
    return el === null ? null : el.getAttribute("data-join-word");
  }
  r.tick = function () {
    var b = word(${JSON.stringify(arcRow(ARC))});
    if (b !== null && r.bound[r.bound.length - 1] !== b) r.bound.push(b);
    var q = word(${JSON.stringify(arcRow(QUIET_ARC))});
    if (q !== null && r.quiet[r.quiet.length - 1] !== q) r.quiet.push(q);
  };
  r.obs = new MutationObserver(r.tick);
  r.obs.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-join-word"],
  });
  r.tick();
  return null;
})()`;

interface Recording {
  sheetSeen: boolean;
  bound: string[];
  quiet: string[];
}

const readRecording = async (app: App): Promise<Recording> => {
  const sheet = await app.body("A").evalJS<{ sheetSeen: boolean }>(
    `(function () { var r = window.__at0445; return { sheetSeen: r.sheetSeen }; })()`,
  );
  const rows = await kindBody(app, "dashes").evalJS<{ bound: string[]; quiet: string[] }>(
    `(function () { var r = window.__at0445; return { bound: r.bound.slice(), quiet: r.quiet.slice() }; })()`,
  );
  return { sheetSeen: sheet.sheetSeen, bound: rows.bound, quiet: rows.quiet };
};

/** Whether the Changes segment is wearing the standing-join dot. */
function offerDot(app: App): Promise<boolean> {
  return app.body("A").evalJS<boolean>(
    `document.querySelector(${JSON.stringify(ROUTE_GROUP)})?.hasAttribute("data-join-offer") ?? false`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0445: a ready arc summons the shade", () => {
  test(
    "a bound reconciled arc puts the card on the Changes route with no mark and no gesture, the fold names what would land and repaints it live, the segment wears the offer while the room is closed, closing costs nothing across a base move, a new round summons it again, and an unbound arc is ready without summoning anybody's room",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0445-join-reveal",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: dataRoot },
      });
      try {
        const t0 = Date.now();
        const at = (): string => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 15000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: scratch });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // The Arcs card stays up for the whole run: it is where the arc is read
        // from without touching either arc. The shade is a view swap inside
        // the card, so the two do not contend.
        await app.dispatchControlAction("toggle-arcs");
        await kindBody(app, "dashes").waitForCondition<boolean>(
          `document.querySelector('${ARCS_CARD} [data-slot="arcs-row"][data-arc="${ARC}"]') !== null`,
          { timeoutMs: 40000 },
        );
        await app.body("A").evalJS<null>(SHEET_RECORDER_INSTALL);
        await kindBody(app, "dashes").evalJS<null>(ROW_RECORDER_INSTALL);

        // Nothing has been revealed yet, and nothing is worn: the precondition
        // that makes every assertion below about the offer rather than about
        // the card's resting state.
        expect(await shadeUp(app), "the card rests on the transcript").toBe(false);
        expect(await offerDot(app), "and the segment wears nothing").toBe(false);

        // ── The bind, and the reveal it earns ─────────────────────────────
        // Bound first, so the offer has a card to arrive on. Both arcs reach
        // the same state; only this one is this card's.
        //
        // The real `arc bind` verb, not a `bind_arc_ok` broadcast: the pilot
        // works only for arcs bound in the **ledger**, and a client-side
        // broadcast moves the deck's store without writing a row. Faking it
        // here would leave the server thinking nobody holds this arc, and
        // nothing downstream would ever run.
        tugtool(["arc", "bind", ARC], {
          cwd: scratch,
          binaryRoot: cli.binaryRoot,
          env: { ...cli.env, TUG_SESSION_ID: SID },
        });
        // Read from the Arcs card rather than from the verb's own exit: the row
        // grows the bound worker's atom, which is the deck seeing the ledger
        // row the pilot will read. The atom is the positive signal — an absent
        // Bind would also be true of a row that never rendered.
        await kindBody(app, "dashes").waitForCondition<boolean>(
          `document.querySelector('${arcRow(ARC)} [data-slot="tug-arc-lifecycle-worker"]') !== null`,
          { timeoutMs: 30000 },
        );
        note(`at0445 ${at()} bound: the ledger row landed and the arc row saw it`);
        await registerReaches(app, ARC, "ready", 240000);

        // The reveal. No gesture, no mark, no declaration — a reconciled arc
        // on a bound card, and the room it is waiting in opens itself.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 60000 },
        );
        note(`at0445 ${at()} revealed: the shade came up on its own`);

        // ── The route, not a glance at it ─────────────────────────────────
        // The card is *on* Changes: join mode is up, so the Z4A toggle reads
        // Changes and the Z5 is the Join button. Every one of those follows
        // from the one act of entering the mode — the toggle derives from
        // whether a landing is active, and the shade came up through the same
        // coupling ⌃⌘C rides. A shade raised without the mode is the
        // half-switched card, and it is what this pins the absence of.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('${ROUTE_GROUP} button[data-choice-value="changes"]')?.getAttribute("data-state") === "active"`,
          { timeoutMs: 20000 },
        );
        expect(
          await app.body("A").evalJS<boolean>(
            `document.querySelector(${JSON.stringify(JOIN_BUTTON)}) !== null`,
          ),
          "the composer is the join's, so its ⬆ is the control that lands",
        ).toBe(true);
        expect(
          await app.body("A").evalJS<boolean>(
            `document.querySelector(${JSON.stringify(SUBMIT)}) === null`,
          ),
          "and the prompt's Submit is not what is sitting under the cursor",
        ).toBe(true);

        // ── What it would land, and whose words those are ─────────────────
        // Nobody wrote a draft on this arc, so the join would quietly land
        // the branch description. The whole point of the provenance note is
        // that "quietly" stops here, at the one moment somebody is about to
        // agree to it.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LANDS_AS)}) !== null`,
          { timeoutMs: 30000 },
        );
        const landsAs = await app.body("A").evalJS<string>(
          `(document.querySelector(${JSON.stringify(LANDS_AS)})?.textContent || "")`,
        );
        note(`at0445 lands-as: ${JSON.stringify(landsAs)}`);
        expect(
          landsAs,
          "the fold quotes the message the join would land, scope and all",
        ).toContain(`tugarc(${ARC}): at0445 bound-arc fixture`);
        expect(
          landsAs,
          "and says the words are the branch description, not an authored draft",
        ).toContain("no draft was written");

        // ── The lands-as is live, not a snapshot ─────────────────────────
        // A draft written WHILE the shade stands repaints it in place. This is
        // the defect that produced "no draft was written" over a join that
        // landed with one: the read side missed the gateway-keyed row, and a
        // draft write bumped no feed, so the standing surface served the words
        // it was raised with forever.
        //
        // `--instance` is not optional here, and the omission is not benign:
        // `draft set` writes through a running tugcast's `POST /api/draft`,
        // and its discovery finds whichever instance is registered — which,
        // on a developer's machine, is their **live** Tug. Without this the
        // draft lands in the real machine-global `changes.db` under a scratch
        // arc's owner key, and this instance never sees it.
        tugtool(
          [
            "draft",
            "set",
            "--instance",
            app.instanceId,
            "--owner",
            `arc:${ARC}`,
            "--message",
            "at0445 the words the author chose",
          ],
          { cwd: scratch, binaryRoot: cli.binaryRoot, env: cli.env },
        );
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LANDS_AS_NOTE)}) === null`,
          { timeoutMs: 30000 },
        );
        const repainted = await app.body("A").evalJS<string>(
          `(document.querySelector(${JSON.stringify(LANDS_AS)})?.textContent || "")`,
        );
        note(`at0445 lands-as (repainted): ${JSON.stringify(repainted)}`);
        expect(
          repainted,
          "the standing fold now quotes the words the author just wrote",
        ).toContain("the words the author chose");
        expect(
          repainted,
          "and drops the apology, because these words ARE somebody's",
        ).not.toContain("no draft was written");

        // ── The segment wears the offer only while the room is closed ────
        // Open, there is nothing to point at: the reader is already looking at
        // it. This is the whole of [S02]'s second clause.
        expect(
          await offerDot(app),
          "an open room needs no unread dot",
        ).toBe(false);

        // ── Closing costs nothing ────────────────────────────────────────
        // ⌃⌘C with the room open leaves the landing mode, and the mode↔sheet
        // coupling drops the shade with it — the card returns to the Prompt
        // route in one press. Nothing durable is written, which is the
        // machinery this file exists to pin the absence of.
        //
        // ⌃⌘C is the Session card's, so it reaches the card only while the
        // card holds the keyboard — and showing the Arcs rail above made the
        // Arcs card active. A reader closing the room is looking at it, so the
        // card is put back in front first, as their click on it would.
        await app.dispatchControlAction("focus-session-card", { cardId: "A" });
        expect(
          await app.evalJS<string | null>(`window.__tug.getActiveCardId()`),
          "the card holds the keyboard the close is pressed on",
        ).toBe("A");
        await app.dispatchControlAction("toggle-changes-view");
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) === null`,
          { timeoutMs: 15000 },
        );
        expect(
          await app.body("A").evalJS<string | null>(
            `document.querySelector('${ROUTE_GROUP} button[data-choice-value="prompt"]')?.getAttribute("data-state") ?? null`,
          ),
          "and the card is back on the Prompt route, mode and shade together",
        ).toBe("active");
        expect(
          await offerDot(app),
          "and the segment picks the offer back up the moment the room closes",
        ).toBe(true);
        // Read with a bare spawn rather than the throwing helper: the assertion
        // is that no such key exists, and `git config --get` answers that with
        // a non-zero exit. The retired mark was `…tugjoinprompted`.
        expect(
          Bun.spawnSync(
            ["git", "-C", scratch, "config", "--get-regexp", "tugjoinprompted"],
            {},
          ).exitCode,
          "closing the room records nothing durable anywhere",
        ).not.toBe(0);
        note(`at0445 ${at()} closed: the shade went down and nothing was written`);

        // ── The base moves, and the shade stays down ─────────────────────
        // A full re-run of the arc — not merely a quiet minute. The base sha
        // moves, base motion replays the arc's rounds onto it (a new arc
        // head), the arc's facts are read again, and a
        // new offer id is minted. The card has already shown this work, and a
        // re-reveal on every base push would be the nagging the old dialog was
        // accused of — and, with every ready arc replayed at once, a
        // neighbour's join would reopen this room.
        //
        // The watch is the recorder's, armed from the moment the room closed,
        // and it ends once the replay is SEEN — the arc head moving — and the
        // row reads `ready` again, plus a tail for the reveal effect, which
        // runs on the commit that carries the new offer.
        await app.body("A").evalJS<null>(
          `(window.__at0445.armSheet = true, window.__at0445.sheetSeen = false, window.__at0445.tick(), null)`,
        );
        await kindBody(app, "dashes").evalJS<null>(
          `(window.__at0445.bound = [], window.__at0445.tick(), null)`,
        );
        const headBefore = git(scratch, "rev-parse", `tugarc/${ARC}`).trim();
        // The fixture disarms auto-replay on every arc it cuts, so no other
        // instance moves a test's branches. This step is about the replay, so
        // the bound arc is armed for the base move alone and disarmed again
        // the moment its head is seen to move.
        git(scratch, "config", `branch.tugarc/${ARC}.tugautoreplay`, "true");
        writeFileSync(join(scratch, "base-move.txt"), "at0445 the base moved\n");
        git(scratch, "add", "-A");
        git(scratch, "commit", "-m", "at0445: the base moves under a closed shade");
        const replayDeadline = Date.now() + 8000;
        while (
          git(scratch, "rev-parse", `tugarc/${ARC}`).trim() === headBefore &&
          Date.now() < replayDeadline
        ) {
          await settle(100);
        }
        disarmAutoreplay(scratch, ARC);
        await registerReaches(app, ARC, "ready", 240000);
        await settle(3000);
        const quietWatch = await readRecording(app);
        note(`at0445 base move: bound words ${JSON.stringify(quietWatch.bound)}`);
        // The replay is the case that matters: a base move that left the head
        // where it was would prove only that nothing changed.
        expect(
          git(scratch, "rev-parse", `tugarc/${ARC}`).trim(),
          "base motion replayed the arc onto the moved base",
        ).not.toBe(headBefore);
        expect(
          quietWatch.sheetSeen || (await shadeUp(app)),
          "a replay onto a moved base is not new work, so it re-offers in silence",
        ).toBe(false);
        await app.body("A").evalJS<null>(`(window.__at0445.armSheet = false, null)`);
        expect(
          await offerDot(app),
          "and the offer is still worn, because it is still standing",
        ).toBe(true);
        note(`at0445 ${at()} quiet: the base moved, the arc re-ran, and nothing revealed`);

        // ── A new round, and the shade comes back ────────────────────────
        // A round lands. That is work the user has never seen, which is
        // the case a standing surface must still announce — the failure the
        // old durable dismissal produced was a run that walked four milestones
        // and spoke at the first.
        //
        // The draft written above survives — it is the arc's, not the
        // surface's — so the new offer opens on the author's words.
        writeFileSync(
          join(boundWorktree, "bound.txt"),
          "at0445 the bound arc keeps working\n",
        );
        commitRound(scratch, ARC, "at0445(round): work the user has not been asked about", cli);
        await registerReaches(app, ARC, "ready", 300000);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 90000 },
        );
        note(`at0445 ${at()} re-revealed: new work summoned the room again`);
        const drafted = await app.body("A").evalJS<string>(
          `(document.querySelector(${JSON.stringify(LANDS_AS)})?.textContent || "")`,
        );
        note(`at0445 lands-as (drafted): ${JSON.stringify(drafted)}`);
        expect(
          drafted,
          "an authored draft is what this join would now land",
        ).toContain("the words the author chose");
        expect(
          drafted,
          "and it needs no apology — these words ARE somebody's",
        ).not.toContain("no draft was written");

        // ── And the unbound arc is ready, and summons nobody ────────────
        // Readiness is derived from the arc's own facts, so the quiet arc —
        // whose facts are the bound one's — reads `ready` with nothing working
        // it. What it must not do is reach the bound card's room: the offer
        // that reveals a shade is that card's own arc's.
        //
        // Read off the recorder, which has watched the quiet row since the
        // Arcs card first listed it, rather than off a window sampled at the
        // end.
        const whole = await readRecording(app);
        note(`at0445 the unbound arc's words across the run: ${JSON.stringify(whole.quiet)}`);
        expect(
          whole.quiet.includes("ready"),
          "an unbound arc's readiness needs nothing to work it",
        ).toBe(true);
        expect(
          await app.body("A").evalJS<boolean>(
            `document.querySelector(${JSON.stringify(`${LANE} [data-slot="session-changes-arc-row"][data-arc="${QUIET_ARC}"] [data-slot="session-changes-arc-lands-as"]`)}) === null`,
          ),
          "and no row in the revealed shade offers to land the arc nobody is working",
        ).toBe(true);
        note(`at0445 ${at()} unbound: ready, and absent from the bound card's room`);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
