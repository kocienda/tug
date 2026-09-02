/**
 * AT0445 — the shade summons itself when a dash is ready to join.
 *
 * ## Why this exists
 *
 * The arc's whole shape is *the machine works first, the user decides once*.
 * The machine half is at0441's. This is the deciding half, and its decision
 * surface is the **Changes shade** — a standing room the card reveals rather
 * than a dialog it mounts.
 *
 * That replaced an inline prompt, and the reason is a live incident. A reflex
 * Escape answered "Not yet"; the dismissal was durable, keyed on the dash
 * head, and suppressed every re-ask; recovery took a hand-run `git config
 * --unset-all`. A transient surface has no reopen gesture by construction. A
 * standing one does: closing the shade discards nothing, because the dash row
 * is still in there. So the whole dismissal apparatus — the mark, its re-ask
 * policy, the answer frame — is gone, and this file's negatives changed shape
 * with it: the claim is no longer "a dismissal holds" but "closing costs
 * nothing and new work summons again".
 *
 * Six claims:
 *
 * - A reconciled dash **bound to this card's session** reveals the shade, with
 *   no gesture and **no mark anywhere** ([D147]). Both fixture dashes are
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
 *   running turn, a half-typed composer — so an offer is never silent, only
 *   quiet.
 * - **Closing costs nothing, and does not re-reveal.** The shade goes down and
 *   stays down for the same offer across a full re-run of the arc — a base
 *   move re-reconciles in silence. The memory is the card's, for this mount
 *   only: nothing durable records that a room was closed, which is precisely
 *   the machinery whose absence this file pins.
 * - **New work summons it again.** A round the user has never seen mints a new
 *   offer id, and the shade comes back up.
 *
 * And one about reach: an **unbound** dash, with facts identical to the bound
 * one's in the same repository at the same moment, is left alone entirely. Not
 * merely unrevealed — unworked: the pilot reconciles only dashes bound to a
 * live session, so the quiet dash's register never even reaches `ready`. With
 * readiness derived rather than declared, an unbounded pilot would turn a
 * single commit on the base into one reconcile per dash, every one spent on
 * nobody.
 *
 * The join **press** is not this file's subject — at0436 drives it, at the
 * composer's ⬆ where it lives. The offer's disappearance after a landing is
 * structural rather than pinned here: the dot and the fold both derive from a
 * feed entry that `broadcast_dash_gone` removes.
 *
 * ## The fixture
 *
 * One scratch repository, two dashes, neither conflicting with the base and
 * neither ever marked. The bound one the pilot reconciles without being asked,
 * which is what makes the reveal the *only* thing this file drives; the
 * unbound one is the control. Nothing is built anywhere: the join gates on
 * reconcile-clean alone, so the arc runs at git speed.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-lane.tsx
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/lib/shade-view-controller.ts
 * @covers tugdeck/src/lib/changeset-types.ts
 * @covers tugdeck/src/lib/arc-join-register.ts
 * @covers tugrust/crates/tugarc-core/src/log.rs
 * @covers tugrust/crates/tugarc-core/src/ops.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_board.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_pilot.rs
 * @covers tugrust/crates/tugcast-core/src/types.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  commitRound,
  createDash,
  gitRetry as git,
  makeDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 420_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000445";

/** The bound dash — the one this card would join. */
const DASH = "at0445-bound";
/** The other one, in the same repo, at the same stage, bound to nobody. */
const QUIET_DASH = "at0445-quiet";

const CARD = '[data-card-id="A"]';
/** The Changes shade — the arc's decision surface, and what a ready dash
 *  summons. Its presence IS the reveal. */
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;
/** The bound dash's row and the fold that opens with it. */
const ROW = `${LANE} [data-slot="session-changes-dash-row"][data-dash="${DASH}"]`;
/** What this join would land, composed exactly as the landing composes it. */
const LANDS_AS = `${ROW} [data-slot="session-changes-dash-lands-as"]`;
/** Where those words came from, when it is not somebody's draft. */
const LANDS_AS_NOTE = `${ROW} [data-slot="session-changes-dash-lands-as-note"]`;
/** The Z4A route group — invariant in shape and words, so the offer rides an
 *  attribute rather than a label or a third segment. */
const ROUTE_GROUP = `${CARD} .tug-prompt-entry-route-group`;
/** The composer's Z5 in its prompt form — present only when no landing is up,
 *  which is how its *absence* reads as "the card went to the Changes route". */
const SUBMIT = `${CARD} [data-slot="tug-prompt-entry"] [data-mode]`;
/** The Z5 the join wears: the control that actually lands, per at0436. */
const JOIN_BUTTON = `${CARD} .tug-prompt-entry-commit-button[aria-label="Join"]`;

const DASHES_CARD = '.dashes-section';
const dashRow = (dash: string): string =>
  `${DASHES_CARD} [data-slot="dashes-row"][data-dash="${dash}"]`;
const dashRegister = (dash: string): string =>
  `${dashRow(dash)} [data-slot="arc-join-register"]`;

/** The checkout whose built binaries the fixture drives. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch = "";
let boundWorktree = "";
let dataRoot = "";
let fixtureDir = "";
let cli: { binaryRoot?: string; env?: Record<string, string> } = {};

beforeAll(() => {
  if (!SHOULD_RUN) return;
  const base = makeDashScratchRepo({ prefix: "at0445", checkout: CHECKOUT });
  scratch = base.repo;
  dataRoot = base.dataRoot;
  cli = base.cli;

  // Two dashes, each touching a file of its own, so neither conflicts with the
  // base or with the other. The arc they walk is the quiet one — reconcile,
  // ready — which is exactly the state the offer stands on.
  const bound = createDash(scratch, DASH, "at0445 bound-dash fixture", cli);
  boundWorktree = bound.worktree;
  writeFileSync(join(bound.worktree, "bound.txt"), "at0445 the bound dash's file\n");
  commitRound(scratch, DASH, "at0445(round): the bound dash's work", cli);

  const quiet = createDash(scratch, QUIET_DASH, "at0445 unbound-dash fixture", cli);
  writeFileSync(join(quiet.worktree, "quiet.txt"), "at0445 the unbound dash's file\n");
  commitRound(scratch, QUIET_DASH, "at0445(round): the unbound dash's work", cli);

  // No `dash mark built` anywhere, deliberately ([D147]). Both dashes are
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

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 680 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

const settle = (ms = 200): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

/** Whether the shade is up right now. */
function shadeUp(app: App): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
  );
}

/**
 * Watch for the shade across a window, and answer whether it ever appeared.
 *
 * Sampled rather than checked once at the end: the failure this guards is a
 * reveal that fires and is superseded, which a single late read would report
 * as silence.
 */
async function shadeAppearsWithin(app: App, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await shadeUp(app)) return true;
    await settle(500);
  }
  return false;
}

/** A dash's register word on the Arcs card right now, or null if it has none. */
function registerWord(app: App, dash: string): Promise<string | null> {
  return app.evalJS<string | null>(
    `document.querySelector(${JSON.stringify(dashRegister(dash))})?.getAttribute("data-word") ?? null`,
  );
}

/**
 * Sample a dash's register across a window and answer whether it ever reached
 * a word. Sampled rather than read once, so a value that appears and is
 * superseded still counts as having appeared.
 */
async function registerEverReaches(
  app: App,
  dash: string,
  word: string,
  ms: number,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await registerWord(app, dash)) === word) return true;
    await settle(500);
  }
  return false;
}

/** Wait for a dash's Dashes-card register to reach a word — the arc, without a gesture. */
async function registerReaches(
  app: App,
  dash: string,
  word: string,
  timeoutMs: number,
): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(dashRegister(dash))})?.getAttribute("data-word") === ${JSON.stringify(word)}`,
    { timeoutMs },
  );
}

/** Whether the Changes segment is wearing the standing-join dot. */
function offerDot(app: App): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.querySelector(${JSON.stringify(ROUTE_GROUP)})?.hasAttribute("data-join-offer") ?? false`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0445: a ready dash summons the shade", () => {
  test(
    "a bound reconciled dash puts the card on the Changes route with no mark and no gesture, the fold names what would land and repaints it live, the segment wears the offer while the room is closed, closing costs nothing across a base move, a new round summons it again, and an unbound dash is never piloted at all",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0445-join-reveal",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: dataRoot },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 15000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: scratch });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // The Arcs card stays up for the whole run: it is where the arc is read
        // from without touching either dash. The shade is a view swap inside
        // the card, so the two do not contend.
        await app.dispatchControlAction("toggle-arcs");
        await app.waitForCondition<boolean>(
          `document.querySelector('${DASHES_CARD} [data-slot="dashes-row"][data-dash="${DASH}"]') !== null`,
          { timeoutMs: 40000 },
        );

        // Nothing has been revealed yet, and nothing is worn: the precondition
        // that makes every assertion below about the offer rather than about
        // the card's resting state.
        expect(await shadeUp(app), "the card rests on the transcript").toBe(false);
        expect(await offerDot(app), "and the segment wears nothing").toBe(false);

        // ── The bind, and the reveal it earns ─────────────────────────────
        // Bound first, so the offer has a card to arrive on. Both dashes reach
        // the same state; only this one is this card's.
        //
        // The real `dash bind` verb, not a `bind_dash_ok` broadcast: the pilot
        // works only for dashes bound in the **ledger**, and a client-side
        // broadcast moves the deck's store without writing a row. Faking it
        // here would leave the server thinking nobody holds this dash, and
        // nothing downstream would ever run.
        tugtool(["arc", "bind", DASH], {
          cwd: scratch,
          binaryRoot: cli.binaryRoot,
          env: { ...(cli.env ?? {}), TUG_SESSION_ID: SID },
        });
        // Read from the Arcs card rather than from the verb's own exit: the row
        // grows the bound worker's atom, which is the deck seeing the ledger
        // row the pilot will read. The atom is the positive signal — an absent
        // Bind would also be true of a row that never rendered.
        await app.waitForCondition<boolean>(
          `document.querySelector('${dashRow(DASH)} [data-slot="tug-dash-lifecycle-worker"]') !== null`,
          { timeoutMs: 30000 },
        );
        note("at0445 bound: the ledger row landed and the dash row saw it");
        await registerReaches(app, DASH, "ready", 240000);

        // The reveal. No gesture, no mark, no declaration — a reconciled dash
        // on a bound card, and the room it is waiting in opens itself.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 60000 },
        );
        note("at0445 revealed: the shade came up on its own");

        // ── The route, not a glance at it ─────────────────────────────────
        // The card is *on* Changes: join mode is up, so the Z4A toggle reads
        // Changes and the Z5 is the Join button. Every one of those follows
        // from the one act of entering the mode — the toggle derives from
        // whether a landing is active, and the shade came up through the same
        // coupling ⌃⌘C rides. A shade raised without the mode is the
        // half-switched card, and it is what this pins the absence of.
        await app.waitForCondition<boolean>(
          `document.querySelector('${ROUTE_GROUP} button[data-choice-value="changes"]')?.getAttribute("data-state") === "active"`,
          { timeoutMs: 20000 },
        );
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(JOIN_BUTTON)}) !== null`,
          ),
          "the composer is the join's, so its ⬆ is the control that lands",
        ).toBe(true);
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(SUBMIT)}) === null`,
          ),
          "and the prompt's Submit is not what is sitting under the cursor",
        ).toBe(true);

        // ── What it would land, and whose words those are ─────────────────
        // Nobody wrote a draft on this dash, so the join would quietly land
        // the branch description. The whole point of the provenance note is
        // that "quietly" stops here, at the one moment somebody is about to
        // agree to it.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LANDS_AS)}) !== null`,
          { timeoutMs: 30000 },
        );
        const landsAs = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(LANDS_AS)})?.textContent || "")`,
        );
        note(`at0445 lands-as: ${JSON.stringify(landsAs)}`);
        expect(
          landsAs,
          "the fold quotes the message the join would land, scope and all",
        ).toContain(`tugdash(${DASH}): at0445 bound-dash fixture`);
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
        // dash's owner key, and this instance never sees it.
        tugtool(
          [
            "draft",
            "set",
            "--instance",
            app.instanceId,
            "--owner",
            `dash:${DASH}`,
            "--message",
            "at0445 the words the author chose",
          ],
          { cwd: scratch, binaryRoot: cli.binaryRoot, env: cli.env },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LANDS_AS_NOTE)}) === null`,
          { timeoutMs: 30000 },
        );
        const repainted = await app.evalJS<string>(
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
        await app.dispatchControlAction("toggle-changes-view");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) === null`,
          { timeoutMs: 15000 },
        );
        expect(
          await app.evalJS<string | null>(
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
        note("at0445 closed: the shade went down and nothing was written");

        // ── The base moves, and the shade stays down ─────────────────────
        // A full re-run of the arc — not merely a quiet minute. The base sha
        // moves, the dash is reconciled again, the candidate is rebuilt, and a
        // new offer id is minted. The card has already shown this dash head's
        // room, and a re-reveal on every base push would be the nagging the
        // old dialog was accused of.
        writeFileSync(join(scratch, "base-move.txt"), "at0445 the base moved\n");
        git(scratch, "add", "-A");
        git(scratch, "commit", "-m", "at0445: the base moves under a closed shade");
        await registerReaches(app, DASH, "ready", 240000);
        expect(
          await shadeAppearsWithin(app, 15000),
          "a base move under an unchanged dash head re-reconciles in silence",
        ).toBe(false);
        expect(
          await offerDot(app),
          "and the offer is still worn, because it is still standing",
        ).toBe(true);
        note("at0445 quiet: the base moved, the arc re-ran, and nothing revealed");

        // ── A new round, and the shade comes back ────────────────────────
        // The dash head moves. That is work the user has never seen, which is
        // the case a standing surface must still announce — the failure the
        // old durable dismissal produced was a run that walked four milestones
        // and spoke at the first.
        //
        // The draft written above survives — it is the dash's, not the
        // surface's — so the new offer opens on the author's words.
        writeFileSync(
          join(boundWorktree, "bound.txt"),
          "at0445 the bound dash keeps working\n",
        );
        commitRound(scratch, DASH, "at0445(round): work the user has not been asked about", cli);
        await registerReaches(app, DASH, "ready", 300000);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 90000 },
        );
        note("at0445 re-revealed: new work summoned the room again");
        const drafted = await app.evalJS<string>(
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

        // ── And the unbound dash was left alone entirely ─────────────────
        // Not merely unrevealed: unworked. The pilot only reconciles dashes
        // bound to a live session, because a reconcile on a dash nobody is
        // working is spent on nobody — and one commit on the base would
        // otherwise re-qualify every dash in the repository at once. So its
        // register never reaches `ready`, even though its facts are identical
        // to the bound dash's and the base has moved underneath it.
        expect(
          await registerEverReaches(app, QUIET_DASH, "ready", 20000),
          "an unbound dash is never piloted, so its arc never runs at all",
        ).toBe(false);
        expect(
          await registerWord(app, QUIET_DASH),
          "and its row promises no check it will never run",
        ).toBeNull();
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(`${LANE} [data-slot="session-changes-dash-row"][data-dash="${QUIET_DASH}"] [data-slot="session-changes-dash-lands-as"]`)}) === null`,
          ),
          "and no row in the revealed shade offers to land the dash nobody is working",
        ).toBe(true);
        note("at0445 unbound: never piloted, and its row says nothing at all");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
