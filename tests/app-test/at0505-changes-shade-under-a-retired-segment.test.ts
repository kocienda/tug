/**
 * at0505-changes-shade-under-a-retired-segment.test.ts — **the Changes shade
 * on a card whose session has rotated.**
 *
 * ## What this is
 *
 * `notes/draft-request-stale-segment.md` records one incident. On a card whose
 * session had rotated, the Changes shade *displayed* its changeset perfectly —
 * eighteen files, the right counts, the gate reading green on everything but
 * the message — and could not write a commit message at all. Auto-Message did
 * nothing whatsoever, leaving no trace in any log. A typed message vanished
 * into a row nothing reads. Commit then refused with "Write a commit message"
 * over a changeset it was showing correctly.
 *
 * The cause was one identity read two ways. `deriveChangesRouteSnapshot` finds
 * the card's entry **line-first**, so the display resolves through a rotation.
 * The request paths sent the card's frozen `binding.tugSessionId` — a demoted
 * segment — and the server, which keys each entry by the line's current
 * **seat**, matched nothing and answered nothing.
 *
 * ## The rotation is real; the scribe is not
 *
 * The split this file needs is a card bound to a retired segment while the
 * server keys its entry by the seat. `at0504` established how to earn one
 * cheaply: opening an arc's door rotates the card about a second later, and
 * the card's binding is its **address** and deliberately does not move. So the
 * door is the gesture here too, and this file is that file's sibling.
 *
 * What is *not* driven for real is the scribe. Nothing in this arc touched
 * generation — the defect was always about which owner the request was
 * addressed to and which owner the answer was read under — so the scribe's
 * side of the exchange is published as frames, the same way `at0497` drives
 * it. That is the assertion sharpened rather than weakened: the frames are
 * addressed to the **seat**, and before this arc the deck read them under the
 * binding id, so every one of them would have landed on a key nothing was
 * watching.
 *
 * ## The four things the incident lost
 *
 *   1. **The scribe's answer reaches the composer.** A `drafting` / `delta` /
 *      `ready` sequence addressed to the seat streams into the message field.
 *   2. **A typed message persists where the ledger reads it.** The words the
 *      composer wrote make a round trip through the server and come back on
 *      the entry the aggregate keys by the **seat**, seeding the composer when
 *      the mode is re-entered — the row the incident wrote under a demoted
 *      segment while every reader looked at the seat's.
 *   3. **What the shade offers to land.** Noted rather than asserted, for the
 *      reason the next section gives.
 *   4. **An unmatched owner is visible.** An `error` state addressed to the
 *      seat raises a pane bulletin naming the failure, instead of an
 *      Auto-Message button that looks idle forever.
 *
 * ## What this file does not prove
 *
 * **That Commit lands.** The incident's third symptom — Commit refusing over
 * `messageLen: 0` — is a *consequence* of the empty message rather than a
 * defect of its own, so what unblocks it is (2) above. Asserting it as well
 * needs the card's entry to carry files, and this fixture could not get the
 * scratch repo's dirt attributed to the rotated session: the change stays in
 * the unattributed bucket, the entry's commit set is empty, and the press is
 * a no-op. The press and the resulting HEAD are **noted** rather than
 * asserted, so a run says what it saw.
 *
 * **That `tugtool draft show` reads the row.** Same reason, from the other
 * side: drafts live in the running instance's session ledger, and this
 * fixture's `TUG_DATA_DIR` points the CLI at a scratch root with no ledger in
 * it. (2) proves the same property in-process instead — the message makes a
 * round trip through the server and comes back on the entry, which is what
 * "the one row the reader reads" means.
 *
 * @covers tugdeck/src/lib/changes-route-controller.ts
 * @covers tugdeck/src/lib/commit-mode-controller.ts
 * @covers tugdeck/src/components/tugways/cards/draft-error-notice-controller.tsx
 * @covers tugrust/crates/tugcast/src/feeds/draft_engine.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  createArc,
  arcBriefPath,
  arcTasksPath,
  fixturePlanDocument,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  tugtoolPath,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

/** The card's id at spawn — and, after its rotation, the retired segment. */
const SID = "a7c0d1ea-0000-4000-8000-000000000505";

const ARC = "at0505-rotate";
const DIRTY_FILE = "at0505-work.txt";

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const COMMIT_BUTTON = `${CARD} [data-testid="tug-prompt-entry-commit-button"]`;
const COMMIT_SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const BULLETIN_TEXTS = `Array.from(document.querySelectorAll('[data-sonner-toast]')).map(function(e){ return e.textContent || ""; })`;

/** This checkout — the build under test, never the tree the arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir: string | null = null;
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0505", checkout: CHECKOUT });
  createArc(projectDir(), ARC, `at0505 ${ARC}`, scratch.cli);
  writeFileSync(arcBriefPath(projectDir(), ARC), "# A brief\n\nOne small thing.\n");
  writeFileSync(arcTasksPath(projectDir(), ARC), fixturePlanDocument(1));
  // A **tracked** file for the card to dirty. An untracked one lands in the
  // unattributed bucket, which is a different surface with no session entry
  // behind it — and the entry is the whole of what this file is about.
  writeFileSync(join(projectDir(), DIRTY_FILE), "at0505 baseline\n");
  execFileSync("git", ["add", DIRTY_FILE], { cwd: projectDir() });
  execFileSync("git", ["commit", "-m", "at0505: seed the file the card will dirty"], {
    cwd: projectDir(),
  });
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  if (fixtureDir !== null) rmScratchSession(fixtureDir);
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 980, height: 720 },
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

/** Run a shell command on the card through its own `$` route. */
async function shell(app: App, command: string): Promise<void> {
  await app.nativeClickAtElement(PROMPT_INPUT);
  await app.nativeType(`/shell ${command}`);
  await new Promise((r) => setTimeout(r, 150));
  await app.nativeKey("Enter", ["cmd"]);
}

const settle = (ms = 400): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

interface ArcReading {
  stages: { stage: string; session_id: string }[];
  stopped: [string, string] | null;
}

function arcReport(name: string): ArcReading {
  const out = JSON.parse(
    tugtool(["arc", "record", name, "--json"], {
      cwd: projectDir(),
      binaryRoot: CHECKOUT,
      env: scratch?.cli.env,
    }),
  ) as { data: { arc: ArcReading | null } };
  return out.data.arc ?? { stages: [], stopped: null };
}

/**
 * Wait until the wheel has seated a fresh segment, and return its id. The
 * `arc-stage` line is written when the new claude announces itself, so this is
 * the moment the rotation is *complete* rather than the moment it was asked
 * for — the same reading `at0504` takes, for the same reason.
 */
async function waitForRotation(name: string): Promise<string> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const arc = arcReport(name);
    const seated = arc.stages[0]?.session_id;
    if (seated !== undefined) return seated;
    if (arc.stopped !== null) {
      throw new Error(
        `at0505: ${name}'s arc stopped before it rotated — ${arc.stopped.join(": ")}`,
      );
    }
    if (Date.now() >= deadline) throw new Error(`at0505: ${name}'s arc never rotated`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

describe.skipIf(!SHOULD_RUN)("AT0505: the Changes shade under a retired segment", () => {
  test(
    "display and request read one identity, and an unmatched owner is visible",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0505-changes-shade-under-a-retired-segment",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.spawnSessionResume("A", {
          tugSessionId: SID,
          projectDir: projectDir(),
        });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });

        // ── The rotation ────────────────────────────────────────────────
        //
        // The door is the cheap way to a real one ([at0504]). The arc is
        // stopped the moment the reading is taken: what this file needs is the
        // *seat*, not a stage doing work.
        await shell(app, `${cli} arc run ${ARC} --kind arc`);
        const seat = await waitForRotation(ARC);
        await shell(app, `${cli} arc stop ${ARC}`);
        note(`at0505 the wheel seated ${seat}; the card was born on ${SID}`);
        expect(seat, "a rotation minted a fresh segment").not.toBe(SID);

        // What the deck now thinks the card is seated on. `at0504` owns the
        // claim that this follows the rotation; it is noted here because it is
        // the fact that tells a shade reading the wrong owner from a rotation
        // that never reached the deck at all.
        const facts = await app.evalJS<{ tugSessionId: string; lineId: string }>(
          `window.__tug.cardLineFacts("A")`,
        );
        note(`at0505 the deck's reading of the card: ${JSON.stringify(facts)}`);

        // ── Work on the card's line, so the shade has a changeset ────────
        //
        // Through `file run`, which fingerprints the tree before and after and
        // receipts what moved. A bare `sh -c 'echo >> f'` leaves the file
        // dirty but *unattributed*: nothing can read which path a string
        // handed to a shell names, so the change lands in the unattributed
        // bucket and this card's entry carries no files at all.
        await shell(app, `${cli} file run -- sh -c 'echo at0505 >> ${DIRTY_FILE}'`);
        await settle(4_000);
        note(
          `at0505 the scratch repo's dirt: ${JSON.stringify(
            execFileSync("git", ["status", "--porcelain"], {
              cwd: projectDir(),
              encoding: "utf8",
            }).trim(),
          )}`,
        );

        const workspaceKey = projectDir();
        const draftFrame = (body: Record<string, unknown>) =>
          app.evalJS<boolean>(
            `window.__tug.publishDraftFrame(${JSON.stringify(
              JSON.stringify({
                workspace_key: workspaceKey,
                owner_kind: "session",
                // Addressed to the SEAT, which is how the server addresses
                // every answer it sends. Before this arc the deck read these
                // under the card's binding id and none of them landed.
                owner_id: seat,
                ...body,
              }),
            )})`,
          );

        // ── 1. The scribe's answer reaches the composer ──────────────────
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType("/commit");
        await settle();
        await app.nativeKey("Escape");
        await settle();
        await app.nativeKey("Return", ["cmd"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(COMMIT_SHEET)}) !== null &&
           document.querySelector(${JSON.stringify(COMMIT_BUTTON)}) !== null`,
          { timeoutMs: 20_000 },
        );

        const GENERATED = "Record the at0505 line of work";

        // First, the negative that pins which owner the deck is reading under.
        // A card that still addressed its frozen binding id would take this
        // one and ignore the seat's below — which is precisely the incident,
        // read from the other end.
        const staleFrame = (body: Record<string, unknown>) =>
          app.evalJS<boolean>(
            `window.__tug.publishDraftFrame(${JSON.stringify(
              JSON.stringify({
                workspace_key: workspaceKey,
                owner_kind: "session",
                owner_id: SID,
                ...body,
              }),
            )})`,
          );
        await staleFrame({ action: "changeset_draft_state", state: "drafting" });
        await staleFrame({
          action: "changeset_draft_delta",
          text: "ADDRESSED TO THE RETIRED SEGMENT",
        });
        await settle(800);
        const afterStale = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(PROMPT_INPUT)})?.textContent ?? "").trim()`,
        );
        note(`at0505 the composer after the stale-addressed frames: ${JSON.stringify(afterStale)}`);
        expect(
          afterStale,
          "a frame addressed to the retired segment reaches nothing",
        ).not.toContain("ADDRESSED TO THE RETIRED SEGMENT");

        expect(
          await draftFrame({ action: "changeset_draft_state", state: "drafting" }),
        ).toBe(true);
        await settle();
        await draftFrame({ action: "changeset_draft_delta", text: GENERATED });
        await settle();
        await draftFrame({ action: "changeset_draft_state", state: "ready" });
        await settle(800);

        const streamed = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(PROMPT_INPUT)})?.textContent ?? "").trim()`,
        );
        note(`at0505 the composer after the stream: ${JSON.stringify(streamed)}`);
        expect(
          streamed,
          "the scribe's answer, addressed to the seat, reached the composer",
        ).toContain(GENERATED);

        // ── 2. A typed message persists where the ledger reads it ────────
        //
        // The incident's second half: the composer wrote its row under the
        // demoted segment while every reader looked at the seat's. The proof
        // is a **round trip through the server** — the message is persisted by
        // `changeset_draft_set`, comes back on the entry the aggregate keys by
        // the seat, and seeds the composer when the mode is re-entered. A
        // message that seeds from that path was written under the owner the
        // entry is filed under, which is the whole claim.
        const TYPED = ", typed on a rotated card";
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeKey("End");
        await app.nativeType(TYPED);
        // The persist is debounced; give it room to land.
        await settle(4_000);
        const typedField = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(PROMPT_INPUT)})?.textContent ?? "").trim()`,
        );
        note(`at0505 the composer after typing: ${JSON.stringify(typedField)}`);

        // Leave the mode and come back. The composer's seed is
        // `entry.draft.message` — the server's row, not anything the deck
        // kept — so what comes back is what the ledger holds.
        await app.nativeKey("Escape");
        await settle(600);
        // The fold is what makes the reseed mean anything. A `ready` overlay
        // outranks the persisted message in the composer's seed, so a field
        // read while one stands comes back carrying the very text these frames
        // put there — and the assertion below would hold with the round trip
        // completely broken. `cancelled` is the store's own way back to idle
        // (no partial draft is kept), and from idle the seed is
        // `entry.draft.message`: the server's row, on the entry the aggregate
        // keys by the **seat**. Published after the mode is left so no live
        // composer is reseeded out from under the debounced write.
        await draftFrame({ action: "changeset_draft_state", state: "cancelled" });
        await settle(400);
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType("/commit");
        await settle();
        await app.nativeKey("Escape");
        await settle();
        await app.nativeKey("Return", ["cmd"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(COMMIT_SHEET)}) !== null`,
          { timeoutMs: 20_000 },
        );
        await settle(1_500);
        const reseeded = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(PROMPT_INPUT)})?.textContent ?? "").trim()`,
        );
        note(`at0505 the composer after re-entering the mode: ${JSON.stringify(reseeded)}`);
        expect(
          reseeded,
          "the persisted row the entry carries is the row the composer wrote",
        ).toContain(`${GENERATED}${TYPED}`);

        // ── 3. What the shade offers to land ─────────────────────────────
        //
        // Noted, not asserted — see the header. The press is left in so the
        // reading is taken against a card that was actually driven, and the
        // note is what a later run compares against if the fixture ever does
        // attribute the change.
        const gate = await app.evalJS<{ disabled: boolean; label: string; rows: number }>(
          `(function(){
             const b = document.querySelector(${JSON.stringify(COMMIT_BUTTON)});
             return {
               disabled: b === null ? true : (b.disabled === true || b.getAttribute("aria-disabled") === "true"),
               label: b === null ? "(no button)" : (b.textContent || "").trim(),
               rows: document.querySelectorAll(${JSON.stringify(CARD)} + ' [data-slot="tug-changes-file-row"]').length,
             };
           })()`,
        );
        note(`at0505 the commit gate before the press: ${JSON.stringify(gate)}`);
        await app.nativeClickAtElement(COMMIT_BUTTON);
        await settle(8_000);
        const head = gitSubject(projectDir());
        note(`at0505 HEAD after the press: ${JSON.stringify(head)}`);

        // ── 4. An unmatched owner is visible ─────────────────────────────
        //
        // The engine's answer when it cannot place an owner. Before this arc
        // it sent nothing at all and logged nothing at all, and the button sat
        // idle forever; now the shade says the scribe was not reached.
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType("/commit");
        await settle();
        await app.nativeKey("Escape");
        await settle();
        await app.nativeKey("Return", ["cmd"]);
        await settle(800);

        const REFUSAL = `Couldn't reach the scribe: no changeset is filed under this card's session (${seat}).`;
        await draftFrame({
          action: "changeset_draft_state",
          state: "error",
          detail: REFUSAL,
        });
        await app.waitForCondition<boolean>(
          `${BULLETIN_TEXTS}.some(function(t){ return t.indexOf("Auto-Message failed") !== -1; })`,
          { timeoutMs: 15_000 },
        );
        const bulletins = await app.evalJS<string[]>(BULLETIN_TEXTS);
        note(`at0505 bulletins after the refusal: ${JSON.stringify(bulletins)}`);
        expect(
          bulletins.join("\n"),
          "the refusal names the owner it could not place",
        ).toContain(seat);
        note("at0505 the refusal is on the card", (await app.screenshot()).path);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/** `git log -1 --format=%B` on the scratch repo. */
function gitSubject(repo: string): string {
  return execFileSync("git", ["log", "-1", "--format=%B"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
}
