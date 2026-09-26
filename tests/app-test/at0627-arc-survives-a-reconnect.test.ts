/**
 * at0627-arc-survives-a-reconnect.test.ts — a rotated card loses its
 * WebSocket, gets it back, and still knows which arc it is on.
 *
 * ## Why this exists
 *
 * Four times across two days a live arc's card came back from a reconnect
 * reading unbound: the masthead's `^<arc>` sigil gone, the Z2 cell reading
 * TASKS instead of ARC, the step list empty — over an arc the server had never
 * stopped knowing about. The mechanism is one sentence long. The card's bridge
 * is keyed by the id the card first spawned under; a rotation mints a fresh
 * segment *inside* that bridge and moves the binding onto it; a reconnect
 * re-spawns, the one-card-one-bridge attach re-points the spawn at the bridge's
 * key, and the ack then read the arc pair off the retired segment's row — which
 * says unbound, because the rotation took the binding off it.
 *
 * Every piece of that was unit-tested on both sides and none of it was driven
 * end to end. `TugConnection._forceCloseForTest` exists precisely to drive the
 * restore from a test, and `at0503` pins what a *restart* does to a rotated
 * seat — but nothing rotated a card, dropped the wire, and read the card
 * afterwards. That gap is why four reconnects went by before anybody had a
 * reproduction.
 *
 * ## What is driven here
 *
 * A real arc in a scratch repository with a plan three steps deep, the ledger
 * state a rotation leaves behind seeded through the bundle's own
 * `--seed-ledger`, and a real `spawn_session` under **the address the bridge is
 * keyed by** — the retired segment, which is exactly the id a restore asks for
 * after the attach has re-pointed it. Then `app.connectionClose()`, which drops
 * the actual socket without the `intentionalClose` latch, so the whole chain
 * runs: close → `connectionDidClose` → backoff → reconnect →
 * `cardSessionBindingStore.clearAll()` → `restoreSessions` → a fresh
 * `spawn_session` → `spawn_session_ok`.
 *
 * All three arc surfaces are read before the close and again after it, and the
 * "before" half is not ceremony: it is what makes the "after" half a claim
 * about the reconnect rather than about a card that never showed an arc at all.
 *
 * ## Why `connectionClose` and not `driveSession(transportClose)`
 *
 * The same reason `at0335` gives. The store-level op dispatches into one card's
 * reducer and never reaches `ConnectionLifecycle`, `clearAll()`, or
 * `restoreSessions` — it can show green while the recovery path is entirely
 * broken, and the recovery path is the whole subject here.
 *
 * ## What this does NOT prove, and the finding behind it
 *
 * **It does not fail against the machine that had the defect.** Run under
 * `tugtool file probe` with the whole of [B01]/[B02] reverted — the ack's
 * `seated_session_id`, the deck's handler, and the index's line key — this
 * test is still green, and that is a fact about the fixture rather than about
 * the fix.
 *
 * The reason is one the incident's own evidence predicts. A **seeded**
 * rotation does not survive the reconnect: `restoreSessions` re-spawns, and
 * `seat_line_binding` on that spawn walks the arc binding onto whichever
 * segment the card came up under, so the aggregate's `bound_session` ends up
 * naming the address and the deck's direct lookup hits without needing any of
 * the three doors. That is the server repairing itself, which is [F08], and it
 * is why the ledger was right throughout the live incident ([F01]) while the
 * card read blank: what was lost was the **ack**, not the row.
 *
 * Reproducing the loss therefore needs a real rotation on a live bridge — the
 * wheel minting a segment inside a bridge it does not re-key — which is
 * `at0504`'s territory, behind that file's `TUG_REAL_CLAUDE` gate. The
 * discriminating assertion belongs there and this file cannot host it.
 *
 * What this file does pin is still worth its runtime: the whole close →
 * backoff → reconnect → `clearAll` → restore → re-spawn → `spawn_session_ok`
 * chain runs against a real arc, and all three arc surfaces are read out of
 * the real DOM on the far side of it. Nothing drove that before ([F10]).
 *
 * @covers tugdeck/src/lib/session-restore.ts
 * @covers tugdeck/src/lib/card-session-binding-store.ts
 * @covers tugdeck/src/lib/arc-session-index.ts
 * @covers tugdeck/src/lib/session-line-store.ts
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugdeck/src/connection.ts
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  appendArcLogLine,
  createArc,
  arcLogPath,
  arcPlanPath,
  fixturePlanDocument,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

/** The line of work both segments below belong to. */
const LINE = "c0dedbad-0000-4000-8000-000000000627";
/**
 * The **address**: the id the card first spawned under, which the bridge is
 * keyed by ever after. A rotation retires the segment; the bridge keeps the id.
 */
const ADDRESS = "c0dedbad-0000-4000-8000-000000000628";
/** The **seat**: the segment the rotation minted, which holds the binding. */
const SEAT = "c0dedbad-0000-4000-8000-000000000629";

const ARC_NAME = "at0627-reconnect";
const TAG = "wary-otter";

// The one card in the deck, so the masthead is addressed the way `at0503`
// addresses it — the marker is not nested under the `data-card-id` element.
const MASTHEAD_ARC =
  '[data-slot="session-masthead"] [data-slot="session-identity-arc"]';
/** The Z2 work cell — TASKS or ARC, one `data-priority` either way. */
const CELL =
  '[data-card-id="A"] [data-slot="tug-status-cell"][data-priority="tasks"]';
const ARC_PLACARD = '[data-slot="session-arc-popover-body"]';
const SUBMIT = '[data-card-id="A"] .tug-prompt-entry-submit-button';

/** This checkout — the build under test, never the tree the fixture cuts in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let arcId = "";
const fixtureDirs: string[] = [];
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0627", checkout: CHECKOUT });
  const created = createArc(projectDir(), ARC_NAME, "at0627 reconnect", scratch.cli);
  arcId = created.id;
  // Three steps with the first under way: a step list worth reading back, and
  // a fraction in the Z2 cell that a blank surface could not fake.
  writeFileSync(
    arcPlanPath(projectDir(), ARC_NAME),
    fixturePlanDocument(3, ["in progress"]),
  );
  for (const id of [ADDRESS, SEAT]) {
    fixtureDirs.push(seedScratchSession(projectDir(), id));
  }
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  for (const dir of fixtureDirs) rmScratchSession(dir);
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

/**
 * The two segments of one line, as a rotation leaves the ledger: both live,
 * the tip carrying the stage label and the arc binding, the segment it forked
 * from carrying neither.
 *
 * Seeded after launch, because the startup demote flips every live row and a
 * row seeded before one would arrive closed — and **in one call, before the
 * spawn**, which is a deliberate retreat from a more faithful shape. Seeding
 * the rotation *after* the spawn is the real order and was tried: it made the
 * aggregate's first reading a race, because `seedLedger` writes through a
 * separate `tugcast --seed-ledger` process that the running tugcast gets no
 * notification from, and the wait for the ARC label below then timed out in
 * two runs of five. Since the post-spawn ordering bought no discrimination
 * either (see the section above), a real flake was the whole of its price.
 */
function seedTheLine(app: App): void {
  const repo = projectDir();
  app.seedLedger({
    sessions: [
      {
        session_id: ADDRESS,
        workspace_key: repo,
        project_dir: repo,
        card_id: "A",
        line_id: LINE,
        tag: TAG,
      },
      {
        session_id: SEAT,
        workspace_key: repo,
        project_dir: repo,
        card_id: "A",
        line_id: LINE,
        forked_from_session_id: ADDRESS,
        stage_label: "implement",
        stage_model: "opus",
        arc_id: arcId,
        arc_name: ARC_NAME,
      },
    ],
  });
}

/**
 * The arc generation a seated implement stage leaves in the arc log, written
 * straight into the real log rather than through a verb — the verb that writes
 * these lines is the runner, and the runner is what this fixture is standing
 * in for.
 */
function seedTheArc(): void {
  const log = arcLogPath(scratch?.dataRoot ?? "");
  appendArcLogLine(log, ARC_NAME, "arc-start", `.tug/arcs/${ARC_NAME}/plan.md`);
  appendArcLogLine(log, ARC_NAME, "arc-kind", "planned");
  appendArcLogLine(log, ARC_NAME, "arc-stage", `implement ${SEAT} opus`);
}

interface ArcSurfaces {
  readonly sigil: string;
  readonly cellLabel: string;
  readonly cellText: string;
  readonly steps: readonly string[];
  /** The segment the binding says the card is seated on, and its line. */
  readonly seat: string;
  readonly line: string;
}

/**
 * All three surfaces at once, so "before" and "after" are the same reading
 * rather than two readings that happen to agree.
 *
 * The placard is opened by clicking the cell and closed by clicking it again,
 * which leaves the card in the state this was called in — the second call must
 * not inherit a placard the first left up.
 */
async function readArcSurfaces(app: App): Promise<ArcSurfaces> {
  const cell = await app.evalJS<{ label: string; text: string }>(
    `(() => {
       const el = document.querySelector(${JSON.stringify(CELL)});
       return {
         label: (el?.querySelector(".session-telemetry-endcap-label")?.textContent ?? "").trim(),
         text: (el?.querySelector('[data-slot="session-telemetry-arc-value"]')?.textContent ?? "").trim(),
       };
     })()`,
  );
  const sigil = await app.evalJS<string>(
    `(document.querySelector(${JSON.stringify(MASTHEAD_ARC)})?.textContent ?? "").trim()`,
  );
  // Which segment the card believes it is on. Noted on both readings because
  // the whole defect is an id: a card answering for the address rather than
  // the seat is the shape every blank surface above came from.
  const facts = await app.evalJS<{ tugSessionId: string; lineId: string }>(
    `window.__tug.cardLineFacts("A")`,
  );
  await app.click(CELL);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(ARC_PLACARD)}) !== null`,
    { timeoutMs: 10_000 },
  );
  const steps = await app.evalJS<string[]>(
    `(() => {
       const body = document.querySelector(${JSON.stringify(ARC_PLACARD)});
       return Array.from(body?.querySelectorAll('[data-slot="arc-step"]') ?? []).map(
         (row) => (row.querySelector(".tug-popup-list-item-primary")?.textContent ?? "").trim(),
       );
     })()`,
  );
  await app.click(CELL);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(ARC_PLACARD)}) === null`,
    { timeoutMs: 10_000 },
  );
  return {
    sigil,
    cellLabel: cell.label,
    cellText: cell.text,
    steps,
    seat: facts.tugSessionId,
    line: facts.lineId,
  };
}

/**
 * Wait until every arc surface has answered for this card — the Z2 cell's
 * label AND its reading, and the masthead's marker. Waited for rather than
 * read, because the aggregate and the binding are two beats and a read
 * between them would be a flake wearing an assertion's clothes.
 *
 * **The cell's reading is a third beat, and leaving it out was that flake.**
 * The label flips as soon as a fact exists for the card, which is the binding;
 * the reading beside it is the run's position, which comes off the aggregate's
 * git entry and the ledger glance and can land later. So the cell can read
 * `ARC` with an empty value between the two, and a sample taken there reports
 * a blank surface over an arc that is bound and answering — green run alone,
 * red in a batch, which is contention rather than a defect.
 */
async function awaitArcSurfaces(app: App, timeoutMs = 60_000): Promise<void> {
  await app.waitForCondition<boolean>(
    `(document.querySelector(${JSON.stringify(CELL)})?.querySelector(".session-telemetry-endcap-label")?.textContent ?? "").trim() === "ARC"`,
    { timeoutMs },
  );
  await app.waitForCondition<boolean>(
    `(document.querySelector(${JSON.stringify(CELL)})?.querySelector('[data-slot="session-telemetry-arc-value"]')?.textContent ?? "").trim().length > 0`,
    { timeoutMs },
  );
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(MASTHEAD_ARC)}) !== null`,
    { timeoutMs },
  );
}

function submitMode(app: App): Promise<string | null> {
  return app.evalJS<string | null>(
    `document.querySelector(${JSON.stringify(SUBMIT)})?.getAttribute("data-mode") ?? null`,
  );
}

function awaitSubmitMode(app: App, mode: string, timeoutMs: number): Promise<boolean> {
  return app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SUBMIT)})?.getAttribute("data-mode") === ${JSON.stringify(mode)}`,
    { timeoutMs },
  );
}

/**
 * Wait until the card is out of the inert reconnecting mode — the wire is back
 * and the restore has run. This is the ordering the surfaces below depend on:
 * the DOM holds the *pre-close* marker until the reconnect's `clearAll` lands,
 * so reading the surfaces before this returns reads the state the close was
 * supposed to destroy and calls it a survival.
 */
function awaitWireBack(app: App, timeoutMs: number): Promise<boolean> {
  return app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SUBMIT)})?.getAttribute("data-mode") !== "reconnecting"`,
    { timeoutMs },
  );
}

describe.skipIf(!SHOULD_RUN)(
  "AT0627: a reconnect keeps a rotated card's arc",
  () => {
    test(
      "the sigil, the Z2 cell and the step list all survive a dropped wire",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
        const app = await launchTugApp({
          testName: "at0627-arc-survives-a-reconnect",
          instanceId: `${process.env.TUG_APPTEST_ID_PREFIX ?? "apptest"}-arc-reconnect-${randomUUID()}`,
          env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
        });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          seedTheLine(app);
          seedTheArc();

          // The card spawns under the address, which is what keys its bridge.
          await app.spawnSessionResume("A", {
            tugSessionId: ADDRESS,
            projectDir: projectDir(),
          });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });

          // The card reads its arc across all three surfaces. Not ceremony:
          // without this the assertions after the close could pass over a card
          // that never had an arc to lose.
          await awaitArcSurfaces(app);
          const before = await readArcSurfaces(app);
          note(`at0627 arc surfaces before the close: ${JSON.stringify(before)}`);
          expect(before.sigil, "the masthead sigil names the arc").toContain(ARC_NAME);
          expect(before.cellLabel).toBe("ARC");
          expect(before.cellText).toBe("1/3");
          expect(before.steps).toEqual([
            "1.The only step",
            "2.The second step",
            "3.The third step",
          ]);
          note("at0627 card before the close", (await app.screenshot()).path);

          // ── The real close ───────────────────────────────────────────────
          expect(
            await app.connectionClose(),
            "the app had a connection to close",
          ).toBe(true);
          // The deck notices: submit clamps to the inert reconnecting mode.
          // Proving the wire actually dropped is what keeps the assertions
          // below from passing over a close that never happened.
          await awaitSubmitMode(app, "reconnecting", 30_000);

          // ── And the restore ──────────────────────────────────────────────
          // The connection retries on its own backoff; `restoreSessions`
          // re-spawns every card the server still holds a binding for.
          //
          // Waited for on the **arc surfaces**, not on the submit mode. The
          // submit walks `reconnecting → submit → restoring → submit` as the
          // restore's own replay runs, so any single mode is a state the card
          // passes through rather than one it settles in — and a test that
          // gated on one would be pinning the race and not the recovery. The
          // `reconnecting` wait above is what proves the wire actually
          // dropped; this is what proves it came back knowing the arc.
          await awaitWireBack(app, 120_000);
          expect(
            await submitMode(app),
            "the card is not left announcing a reconnect",
          ).not.toBe("reconnecting");
          await awaitArcSurfaces(app, 120_000);
          const after = await readArcSurfaces(app);
          note(`at0627 arc surfaces after the restore: ${JSON.stringify(after)}`);
          note("at0627 card after the restore", (await app.screenshot()).path);

          // The three readings the incident lost, each named on its own so a
          // failure says which surface went blank rather than only that one
          // did.
          expect(after.sigil, "the masthead sigil survived the reconnect").toContain(
            ARC_NAME,
          );
          expect(after.cellLabel, "the Z2 cell still reads ARC").toBe("ARC");
          expect(after.cellText, "and still counts the run").toBe("1/3");
          expect(after.steps, "the step list survived too").toEqual([
            ...before.steps,
          ]);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
