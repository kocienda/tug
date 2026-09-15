/**
 * at0576-trip-session-card.test.ts — a running trip opens its own Session
 * card, and takes nothing the user was holding.
 *
 * ## What this gates
 *
 * A trip is an ordinary Tug session with hands, and the deck is where sessions
 * are seen. The engine seats the session and writes its id onto the trip row
 * the moment it has one; what was missing was somebody deck-side to open the
 * card. The trip-card controller is that somebody, and the whole of its
 * promise is that it opens a card **without taking the key view** ([B03],
 * [P08]) — a trip arriving while the user is mid-thought must not move the
 * work out from under them.
 *
 * Three things are pinned, in the real app:
 *
 *   1. A roster row that is `running` with an `open_session` no card holds
 *      seats a Session card **bound to that session** — proved by the card
 *      opening onto the session's own transcript, replayed from the JSONL on
 *      disk, rather than by a card merely appearing.
 *   2. The card that had the key view **still has it** — at the instant the
 *      new card lands, and again after the whole replay. This is the claim
 *      the option's three suppressions exist for.
 *   3. The Tripwires row's own `Open session` then **raises that card** rather
 *      than opening a second one — the deck never puts a rival card on a
 *      session it already holds.
 *
 * ## Why the roster arrives on a published frame
 *
 * There is no CLI door that records a trip against an arbitrary session id.
 * `tugtool tripwire trip` fires for real, which would put a real arc worktree
 * and a real `claude` behind every run of this file, and opening the ledger
 * with a foreign sqlite is a corruption vector the house rules out. So the
 * roster body is published through `__tug.publishTripwiresFrame`, which hands
 * it to the store's own frame handler — the same path a server frame takes,
 * with the card and the controller both reading it from there. Everything
 * downstream of the frame is the real app: the real registry handler, the real
 * `addCard`, the real binding store, the real replay.
 *
 * ## Why `deck-manager.ts` is not named below
 *
 * `addCard`'s `activate: false` path is three suppressions inside that one
 * method, and naming the file would push it past the selection budget — an
 * edit there would turn `app-test-changed` into a sweep. The three branches
 * are pinned instead by `tugdeck/src/__tests__/add-card-activate.test.ts`,
 * which fails the moment one is dropped or one `_revealAfterArrival` escapes
 * the flag, and which runs on every `bun test`. That guard cannot see whether
 * the key view actually moved, which is this file's half; between them the
 * claim is covered from both sides, and neither is a fiction about where the
 * code lives.
 *
 * @covers tugdeck/src/components/tripwires/trip-card-controller.tsx
 * @covers tugdeck/src/components/tripwires/tripwires-card-registration.tsx
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugdeck/src/lib/tripwires-store.ts
 * @covers tugrust/crates/tugtool-core/src/tripwire_roster.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** The trip's own session: seated by the engine, held by no card. */
const SESSION_ID = "c7d8e9f0-1a2b-4c3d-8e4f-5a6b7c8d9e76";
/** What `background_card_id("at0576")` mints. */
const BACKGROUND_CARD_ID = "tripwire:at0576";
/** The one turn the trip's session left on disk, so the seated card has a
 *  transcript to open onto rather than an empty one. */
const FIXTURE_PROMPT = "at0576 the trip session asked this";

let projectDir = "";
let fixtureDir = "";

/** Mirrors tugcode's `encodeProjectDir` (see at0192 for the rationale). */
const encodeProjectDir = (absDir: string): string =>
  absDir.replace(/[^A-Za-z0-9-]/g, "-");

function fixtureJsonl(cwd: string, sessionId: string): string {
  const base = {
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId,
    version: "2.1.105",
    gitBranch: "main",
  };
  const uuid = "00000000-0000-4000-8000-000000000576";
  const lines = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid,
      timestamp: new Date(Date.now() - 600_000).toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: FIXTURE_PROMPT }],
      },
    },
    {
      ...base,
      parentUuid: uuid,
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000010576",
      timestamp: new Date(Date.now() - 599_000).toISOString(),
      message: {
        id: "msg-at0576",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "and this is what it found." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 50 },
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/** One roster row, in the shape the `TRIPWIRES` feed publishes. */
function rosterFrame(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tripwires: [
      {
        name: "at0576",
        trigger: '{"fact":{"kind":"edit_failed"}}',
        scope: null,
        probe: null,
        brief: "say whether anything broke",
        description: "Says whether the last landing broke anything",
        model: null,
        permission_mode: "acceptEdits",
        paused: false,
        max_seconds: 120,
        max_tool_calls: 30,
        running: true,
        open_session: SESSION_ID,
        open_session_dir: projectDir,
        last_trip: {
          at_ms: Date.now(),
          status: "running",
          headline: null,
          session_id: SESSION_ID,
          report: null,
          rounds: null,
        },
        trip_count: 1,
        trip_log_revision: 1,
        ...over,
      },
    ],
    error: null,
  });
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0576-")));
  writeFileSync(join(projectDir, "README.md"), "at0576\n");
  fixtureDir = join(
    homedir(),
    ".claude",
    "projects",
    encodeProjectDir(projectDir),
  );
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(
    join(fixtureDir, `${SESSION_ID}.jsonl`),
    fixtureJsonl(projectDir, SESSION_ID),
  );
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
  if (fixtureDir !== "" && existsSync(fixtureDir)) {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

const CARD = ".tripwires-card";
const CARD_HOSTS = `document.querySelectorAll('.tug-pane [data-card-host]').length`;
const USER_BODIES =
  '.tug-pane [data-card-host] [data-testid="session-card-transcript-user-body"]';
const DOT = `[data-tripwire-open-session="${SESSION_ID}"]`;

describe.skipIf(!SHOULD_RUN)(
  "at0576 — a running trip opens its own card without taking the view",
  () => {
    test(
      "the card arrives bound, the key view is untouched, and the row then raises it",
      async () => {
        const app = await launchTugApp({ testName: "at0576-trip-session-card" });
        try {
          await app.waitForCondition<boolean>(
            `typeof window.__tug !== "undefined"`,
            { timeoutMs: 15_000 },
          );

          // Seeded after launch, deliberately: tugcast demotes every `live`
          // row to `closed` once at startup, and a session that is alive right
          // now is the whole of this fixture.
          app.seedLedger({
            sessions: [
              {
                session_id: SESSION_ID,
                workspace_key: projectDir,
                project_dir: projectDir,
                card_id: BACKGROUND_CARD_ID,
                name: "at0576 trip session",
              },
            ],
          });

          // The Tripwires surface is where the controller lives, so it has to
          // be open for a trip to be carded at all.
          await app.dispatchControlAction("toggle-tripwires");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CARD)}) !== null`,
            { timeoutMs: 15_000 },
          );

          // What the user is holding when the trip arrives. Read after the
          // rail has settled, so the comparison below is against the state the
          // reader would actually be looking at.
          const heldBefore = await app.evalJS<string | null>(
            `window.__tug.getActiveCardId()`,
          );
          const cardsBefore = await app.evalJS<number>(CARD_HOSTS);
          note(
            "at0576 before",
            JSON.stringify({ heldBefore, cardsBefore }),
          );

          // ---- 1. The trip is running, and a card arrives bound to it. -----
          expect(
            await app.evalJS<boolean>(
              `window.__tug.publishTripwiresFrame(${JSON.stringify(rosterFrame())})`,
            ),
          ).toBe(true);
          await app.waitForCondition<boolean>(
            `${CARD_HOSTS} > ${cardsBefore}`,
            { timeoutMs: 25_000 },
          );
          const seated = await app.evalJS<number>(CARD_HOSTS);
          note("at0576 cards", `${cardsBefore} → ${seated}`);
          // The key view at the instant the card lands, before the replay: a
          // promotion that happened at arrival and was corrected afterwards
          // would still have been a promotion the user saw.
          expect(
            await app.evalJS<string | null>(`window.__tug.getActiveCardId()`),
          ).toBe(heldBefore);

          // Bound, not merely present: the binding fires `request_replay`,
          // tugcode replays the JSONL the trip's session left on disk, and the
          // turn it carries paints.
          await app.waitForCondition<boolean>(
            `(function(){
               var bodies = document.querySelectorAll(${JSON.stringify(USER_BODIES)});
               return Array.prototype.some.call(bodies, function (b) {
                 return (b.textContent || "").indexOf(${JSON.stringify(FIXTURE_PROMPT)}) !== -1;
               });
             })()`,
            { timeoutMs: 30_000 },
          );

          // ---- 2. And it took nothing. -------------------------------------
          //
          // The key view, after the binding and the whole replay: the card the
          // user was in is still the card the keyboard is in.
          //
          // `getActiveCardId` and not `getFocusedCardId`. The two are
          // different questions and only the first is the promise: the key
          // view is the composite first responder, read off `activePaneId`,
          // while the "focused card" is *derived from z-order* — the last pane
          // in the array — so a card that arrives at all is the answer to it
          // whatever it took or did not take. Asserting that one would be
          // asserting that no card arrived.
          expect(
            await app.evalJS<string | null>(`window.__tug.getActiveCardId()`),
          ).toBe(heldBefore);

          // ---- 3. The row's own gesture raises it, never a second card. ----
          //
          // The controller and the dot answer through the same registry
          // handler, and with a card already holding the session that handler
          // takes the raise branch. A second card here would be the deck
          // putting a rival on a session it already holds.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DOT)}) !== null`,
            { timeoutMs: 10_000 },
          );
          await app.nativeClickAtElement(DOT);
          // Give a card that was going to open the time to open: an assertion
          // that ran before the deck could act would pass over the failure.
          await app.waitForCondition<boolean>(
            `window.__tug.getActiveCardId() !== ${JSON.stringify(heldBefore)}`,
            { timeoutMs: 15_000 },
          );
          expect(await app.evalJS<number>(CARD_HOSTS)).toBe(seated);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
