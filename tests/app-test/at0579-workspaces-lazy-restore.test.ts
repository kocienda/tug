/**
 * at0579-workspaces-lazy-restore.test.ts — the restore pass a workspace switch
 * runs, and what it decides.
 *
 * [B04] says a workspace's sessions are restored when it is opened rather than
 * when the app launches: ten workspaces must not spawn ten sets of tugcode at
 * boot. The boot pass therefore covers the ACTIVE workspace's session cards
 * only, and `restoreSpaceSessions` runs over a workspace's cards at the moment
 * it is activated, deciding each from `spaceBindingsLedgerStore` synchronously
 * so no card mounts unbound-and-unexpected and falls through to its picker.
 *
 * What this file drives is that pass, through the real switch, against a real
 * bound session:
 *
 *   1. Two workspaces, a real fixture session resumed into card `A` in one of
 *      them. The boot pass sent `list_card_bindings` for it, so the cache is
 *      filled from the ledger rather than from anything this test staged.
 *   2. Switch to the workspace with no session cards. A pass runs over nothing
 *      and spawns nothing — the shape that makes ten empty workspaces free.
 *   3. Switch back. A pass runs over card `A` and **leaves it alone**, because
 *      it is already bound. Re-firing there would re-spawn a session that is
 *      already running, which is the switch's version of a double resume.
 *   4. A THIRD workspace, never activated, holds a Session card the cache
 *      knows is alive. Deleting it sends `close_session` for that card ([P07])
 *      — which is the leg that would have caught the hole, because the card
 *      holds no binding and the destruction event alone sends nothing for it.
 *
 * Step 4 is the one place the two halves of [P07] are checked against each
 * other: `spaceHoldsLiveSessions` is what a confirm dialog would have counted,
 * and the number of `close.frame_send` records is what the close loop actually
 * did. A version of this feature that counted three and closed none would look
 * entirely correct to the user and leave three orphaned tugcode processes.
 *
 * ## What this file does not drive, and why
 *
 * [B04]'s other half — a relaunch binding the active workspace's cards and not
 * the parked one's — needs the server's ledger to carry a card binding across a
 * quit, and the app-test harness does not reproduce that: a plain
 * quit-and-relaunch of a real fixture session rebinds nothing, with the restore
 * pass finding no row for the card. That is a property of the harness rather
 * than of this change, and it is why `at0247` drives its own relaunch rebind
 * with a synthetic `bindSession` and says so. The routing that half turns on —
 * which cached row resumes, which fresh-spawns, which is left alone, which
 * takes a round trip — is pinned where it lives, over `restoreSpaceSessions`
 * itself, in `tugdeck/src/__tests__/session-restore-space.test.ts`.
 *
 * The same limit is why the pass's `cached_rows` is reported in the diagnostic
 * below but not asserted on: the ledger this harness answers from carries no
 * card bindings at all, so the cache is empty for steps 1-3 however the code
 * behaves. Step 4 therefore STATES the ledger's answer itself, through
 * `window.__tug.publishCardBindings` — the same publish `action-dispatch`
 * performs on the server's frame, onto the same bus. What it stages is the
 * server's reply, not the behaviour under test; everything downstream of the
 * frame is the real path.
 *
 * `@covers` names the two files whose rules this drives. `deck-manager.ts` is
 * deliberately not among them, on at0506's precedent: it is already the second
 * widest fan-out in the corpus and the ratchet lets recorded debt be paid down
 * rather than refinanced. `deleteSpace`'s own switch-and-delete behaviour is
 * covered by at0578.
 *
 * `tugdeck/src/lib/__tests__/space-bindings-ledger-store.test.ts` is where the
 * cache's own rules are pinned.
 *
 * @covers tugdeck/src/lib/session-restore.ts
 * @covers tugdeck/src/lib/space-bindings-ledger-store.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { seedFixtureSession } from "./fixtures/resolve";
import { openFixtureSession, waitForTranscriptSettled } from "./fixtures/runner";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const PLAIN_SPACE = "space-plain";
const SESSION_SPACE = "space-session";
/** Never activated in this run — which is the whole point of step 4. */
const PARKED_SPACE = "space-parked";

/** The session the cache says card `P` is holding, and the one to be closed. */
const PARKED_SESSION_ID = "at0579-parked-session";

/**
 * Three workspaces, the SESSION one active so the fixture runner — which seeds
 * the active workspace's deck — stands its session card up there. The plain one
 * holds a Text card, so a switch to it renders something and its restore pass
 * has no session card to consider. The parked one holds a Session card and is
 * never activated, which is what makes it able to stand for a workspace whose
 * cards hold no bindings.
 */
const THREE_SPACE_BLOB = {
  version: 5,
  activeSpaceId: SESSION_SPACE,
  spaces: [
    {
      id: PLAIN_SPACE,
      name: "Plain",
      deck: {
        cards: [{ id: "T", componentId: "text", title: "File", closable: true }],
        panes: [
          {
            id: "p-t",
            position: { x: 60, y: 60 },
            size: { width: 700, height: 500 },
            cardIds: ["T"],
            activeCardId: "T",
            title: "",
            acceptsFamilies: ["standard"],
          },
        ],
        activePaneId: "p-t",
        imposition: { kind: "one-up", sidebars: {} },
      },
    },
    {
      id: SESSION_SPACE,
      name: "Session",
      deck: { cards: [], panes: [], imposition: { sidebars: {} } },
    },
    {
      id: PARKED_SPACE,
      name: "Parked",
      deck: {
        cards: [
          { id: "P", componentId: "session", title: "Parked", closable: true },
        ],
        panes: [
          {
            id: "p-p",
            position: { x: 80, y: 80 },
            size: { width: 700, height: 500 },
            cardIds: ["P"],
            activeCardId: "P",
            title: "",
            acceptsFamilies: ["standard"],
          },
        ],
        activePaneId: "p-p",
        imposition: { kind: "one-up", sidebars: {} },
      },
    },
  ],
};

/** `cardLineFacts` throws on an unbound card, so ask it behind a catch. */
const BOUND_SESSION_ID = `(function(){
  try { return window.__tug.cardLineFacts("A").tugSessionId; }
  catch (e) { return null; }
})()`;

interface SpacePass {
  space_card_count: number;
  restore_count: number;
  fresh_spawn_count: number;
  unanswered_count: number;
  cached_rows: number;
}

interface CloseFrame {
  card_id: string;
  tug_session_id: string;
}

/** The `restore.space_pass` records written since `mark`, newest last. */
function passesSince(mark: number): string {
  return `window.__deckTrace.since(${mark})
    .filter(function (e) { return e.kind === "session-lifecycle" && e.event === "restore.space_pass"; })
    .map(function (e) { return e.fields; })`;
}

/**
 * The `close.frame_send` records written since `mark`.
 *
 * That line is emitted by `sendCloseSession` itself, one per wire frame, so
 * counting them counts closes — which is what the confirm's number has to
 * agree with.
 */
function closesSince(mark: number): string {
  return `window.__deckTrace.since(${mark})
    .filter(function (e) { return e.kind === "session-lifecycle" && e.event === "close.frame_send"; })
    .map(function (e) { return e.fields; })`;
}

describe.skipIf(!SHOULD_RUN)("at0579 — the switch's restore pass", () => {
  test(
    "a switch runs a pass over the incoming workspace and leaves a live session alone",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const seeded = await seedFixtureSession(
        "session-transcript-basic",
        "at0579",
      );
      tugbankWrite(
        tugbankPath,
        "dev.tugapp.dev",
        "recent-projects",
        "json",
        JSON.stringify({ paths: [seeded.projectDir] }),
      );
      tugbankWrite(
        tugbankPath,
        "dev.tugapp.deck.layout",
        "layout",
        "json",
        JSON.stringify(THREE_SPACE_BLOB),
      );

      const app = await launchTugApp({
        testName: "at0579-workspaces-lazy-restore",
        env: { TUGBANK_PATH: tugbankPath },
        skipAccessibilityPreflight: true,
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        await app.waitForCondition<boolean>(
          `typeof window.tugdeck !== "undefined" && window.tugdeck.diag.getSpaces().spaces.length === 3`,
          { timeoutMs: 10_000 },
        );

        // ---- 1. A real session, bound through the real picker.
        await openFixtureSession(app, seeded);
        await waitForTranscriptSettled(app);
        const boundSessionId = await app.evalJS<string | null>(BOUND_SESSION_ID);
        expect(boundSessionId).not.toBeNull();

        const mark = await app.evalJS<number>(`window.__deckTrace.mark()`);

        // ---- 2. Away, to a workspace with no session cards.
        await app.evalJS<null>(
          `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(PLAIN_SPACE)} }), null)`,
        );
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.listCardIds().indexOf("T") !== -1`,
          { timeoutMs: 8_000 },
        );

        // ---- 3. And back.
        await app.evalJS<null>(
          `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(SESSION_SPACE)} }), null)`,
        );
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.listCardIds().indexOf("A") !== -1`,
          { timeoutMs: 8_000 },
        );

        const passes = await app.evalJS<SpacePass[]>(passesSince(mark));
        note("at0579 space passes", passes);
        expect(passes.length).toBe(2);

        // The empty workspace: a pass ran, saw no session card, spawned
        // nothing. This is the shape that makes a workspace free to keep.
        expect(passes[0].space_card_count).toBe(0);
        expect(passes[0].restore_count).toBe(0);
        expect(passes[0].fresh_spawn_count).toBe(0);

        // The returning workspace: the pass saw its one session card and left
        // it alone, because the binding stands. Re-firing here would re-spawn
        // a session that is already running.
        expect(passes[1].space_card_count).toBe(1);
        expect(passes[1].restore_count).toBe(0);
        expect(passes[1].fresh_spawn_count).toBe(0);
        expect(passes[1].unanswered_count).toBe(0);

        // The session itself is untouched by either switch.
        expect(await app.evalJS<string | null>(BOUND_SESSION_ID)).toBe(
          boundSessionId,
        );

        // ---- 4. Delete a workspace nobody ever opened ([P07]).
        //
        // Card `P` has no binding — lazy restore never ran for its workspace,
        // which is by [B04]'s design. The only thing that knows its session is
        // alive is the cache, so the cache is what the count and the close must
        // both read.
        await app.evalJS<null>(
          `(window.__tug.publishCardBindings([{
            card_id: "P",
            session_id: ${JSON.stringify(PARKED_SESSION_ID)},
            project_dir: ${JSON.stringify(seeded.projectDir)},
            state: "live",
            turn_count: 3,
            is_alive: true,
            has_jsonl: true
          }]), null)`,
        );
        await app.waitForCondition<boolean>(
          `window.tugdeck.lab.spaceHoldsLiveSessions(${JSON.stringify(PARKED_SPACE)}) === 1`,
          { timeoutMs: 5_000 },
        );
        // And card `P` really is unbound, so nothing but the cache could have
        // answered — which is exactly the case the naive delete sends nothing
        // for.
        expect(
          await app.evalJS<boolean>(
            `(function () {
              try { window.__tug.cardLineFacts("P"); return true; }
              catch (e) { return false; }
            })()`,
          ),
        ).toBe(false);

        const counted = await app.evalJS<number>(
          `window.tugdeck.lab.spaceHoldsLiveSessions(${JSON.stringify(PARKED_SPACE)})`,
        );
        const closeMark = await app.evalJS<number>(`window.__deckTrace.mark()`);
        expect(
          await app.evalJS<boolean>(
            `window.tugdeck.lab.deleteSpace(${JSON.stringify(PARKED_SPACE)})`,
          ),
        ).toBe(true);

        await app.waitForCondition<boolean>(
          `${closesSince(closeMark)}.length >= 1`,
          { timeoutMs: 8_000 },
        );
        const closes = await app.evalJS<CloseFrame[]>(closesSince(closeMark));
        note("at0579 closes on delete", closes);
        // The confirm's number and the wire's agree, and the frame names the
        // cached session rather than some id invented at the close.
        expect(closes.length).toBe(counted);
        expect(closes[0].card_id).toBe("P");
        expect(closes[0].tug_session_id).toBe(PARKED_SESSION_ID);

        const left = await app.evalJS<string[]>(
          `window.tugdeck.diag.getSpaces().spaces.map(function (s) { return s.id; })`,
        );
        expect([...left].sort()).toEqual([PLAIN_SPACE, SESSION_SPACE].sort());
      } finally {
        await app.close().catch(() => undefined);
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
