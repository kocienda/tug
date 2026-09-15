/**
 * at0568-background-session-resume.test.ts — a **background** session's row
 * stops refusing the gesture that would seat it on a card.
 *
 * ## What this gates
 *
 * A session spawned by something that is not a deck — a tripwire's work tier —
 * carries `tripwire:<owner>` in the `card_id` field a Session card would put
 * its own id in. Nothing read that string, so the deck could not tell a live
 * session held by another card from one held by nobody a user could be sent
 * to, and `session-identity-menu.tsx`'s `heldElsewhere = state === "live"`
 * guard refused the resume gesture it already implemented. The row now says
 * `background`, and the guard reads it.
 *
 * Driven through the menu on a **Overview atom** — a citation in foreign
 * context, which is the surface the go-to item exists for and the one at0387
 * already drives both halves of. Three things are pinned, all over the real
 * ledger:
 *
 *   1. A **live** session held by a background owner offers `Resume Session`,
 *      enabled. Before this phase the same row offered `Show Session` against
 *      a card that does not exist, because `heldElsewhere` was true for every
 *      live session and there was no field to tell the two apart.
 *   2. Activating it **seats a card** on that session — a new card, since none
 *      held it a moment ago — and that card opens onto the session's own
 *      transcript, replayed from the JSONL the background session left on
 *      disk. That is the Exit's "a settled trip opens onto its full
 *      transcript": the gesture is the resume that already ships ([B01]), so
 *      what is proved here is that the resume finds a background session's
 *      history exactly as it finds a card's.
 *   3. With that card holding it, the same row now reads `Show Session`: the
 *      binding store answers a card, the gesture takes the raise branch, and
 *      the deck never opens a rival card on a session it already holds
 *      ([B05], proved without the wire ever carrying a refusal).
 *
 * ## What is deliberately not here
 *
 * The Tripwires row's live dot is not the vehicle, and that is a split rather
 * than an omission: the dot, and the card a *running* trip opens on its own,
 * are `at0576-trip-session-card.test.ts`. What this file drives is the menu on
 * a citation in foreign context — the surface the go-to item exists for — and
 * the dot reaches the same registry handler this menu item does.
 *
 * The engine's half — that a trip's session survives being carded, because
 * `close_headless_session` refuses to close one a deck card holds — is Rust,
 * and is proved as Rust in
 * `tugrust/crates/tugcast/src/feeds/tripwire_session.rs`.
 *
 * @covers tugdeck/src/components/tugways/session-identity-menu.tsx
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugdeck/src/lib/card-session-binding-store.ts
 * @covers tugdeck/src/lib/session-citation-store.ts
 * @covers tugdeck/src/lib/session-restore.ts
 * @covers tugdeck/src/protocol.ts
 * @covers tugrust/crates/tugcast/src/session_ledger.rs
 * @covers tugrust/crates/tugcast/src/background_session.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** The tripwire's own session: spawned by the work tier, held by no card. */
const SESSION_ID = "c7d8e9f0-1a2b-4c3d-8e4f-5a6b7c8d9e68";
/** What `background_card_id("at0568")` mints — the string under test. */
const BACKGROUND_CARD_ID = "tripwire:at0568";

/** The one turn the background session left on disk, so the seated card has a
 *  transcript to open onto rather than an empty one. */
const FIXTURE_PROMPT = "at0568 the tripwire session asked this";

/** The project the background session ran in — a scratch tree of its own, so
 *  the fixture JSONL below is the only transcript under it. */
let projectDir = "";
let fixtureDir = "";

/** Mirrors tugcode's `encodeProjectDir` (see at0192 for the rationale). */
const encodeProjectDir = (absDir: string): string => absDir.replace(/[^A-Za-z0-9-]/g, "-");

/** One committed turn, in claude's own JSONL, where tugcode's replay looks for
 *  it. The seeded row below points at the same project and the same id, so the
 *  resume that seats the card replays this and nothing else. */
function fixtureJsonl(cwd: string, sessionId: string): string {
  const base = {
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId,
    version: "2.1.105",
    gitBranch: "main",
  };
  const uuid = "00000000-0000-4000-8000-000000000568";
  const lines = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid,
      timestamp: new Date(Date.now() - 600_000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: FIXTURE_PROMPT }] },
    },
    {
      ...base,
      parentUuid: uuid,
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000010568",
      timestamp: new Date(Date.now() - 599_000).toISOString(),
      message: {
        id: "msg-at0568",
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

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0568-")));
  writeFileSync(join(projectDir, "README.md"), "at0568\n");
  fixtureDir = join(homedir(), ".claude", "projects", encodeProjectDir(projectDir));
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, `${SESSION_ID}.jsonl`), fixtureJsonl(projectDir, SESSION_ID));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
  if (fixtureDir !== "" && existsSync(fixtureDir)) {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

const MENU = '[data-slot="tug-editor-context-menu"]';
const OVERVIEW = '[data-testid="overview-card"]';
/** The session atom inside a Overview post — a citation with no row under it
 *  and no card around it, so the menu is the only way from the name to the
 *  session. */
const OVERVIEW_CHIP = `${OVERVIEW} .overview-post [data-slot="tug-session-identity"]`;
const CARD_HOSTS = `document.querySelectorAll('.tug-pane [data-card-host]').length`;
/** Every transcript's user rows, across whichever card the gesture seated. */
const USER_BODIES =
  '.tug-pane [data-card-host] [data-testid="session-card-transcript-user-body"]';

/** A right press on the atom. Dispatched rather than driven from the mouse:
 *  at0387 gates the trusted press on this very chip, and what this test is
 *  about is what the menu SAYS. */
function rightClickChip(): string {
  return `(function(){
     var chip = document.querySelector(${JSON.stringify(OVERVIEW_CHIP)});
     var r = chip.getBoundingClientRect();
     chip.dispatchEvent(new MouseEvent("contextmenu", {
       bubbles: true,
       clientX: Math.round(r.left + r.width / 2),
       clientY: Math.round(r.top + r.height / 2),
     }));
     return null;
   })()`;
}

function menuRows(): string {
  return `Array.prototype.map.call(
     document.querySelectorAll(${JSON.stringify(MENU)} + ' [role="menuitem"]'),
     function (item) {
       return {
         action: item.getAttribute("data-item-action") || "",
         label: (item.querySelector(".tug-menu-item-label") || item).textContent || "",
         disabled: item.getAttribute("aria-disabled") === "true",
       };
     })`;
}

/** Open the atom's menu and wait for its leading item to settle. */
async function openChipMenu(
  app: Awaited<ReturnType<typeof launchTugApp>>,
): Promise<ReadonlyArray<{ action: string; label: string; disabled: boolean }>> {
  // The Overview is a rail of its own, and a menu fires into the key view — so
  // it takes the key view back before every press.
  await app.click(OVERVIEW);
  await app.evalJS<null>(rightClickChip());
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(MENU)}) !== null`,
    { timeoutMs: 10_000 },
  );
  // The leading item is disabled until the ledger's answer arrives over
  // `resolve_sessions`, so the wait is for the LIVE item rather than merely
  // for an item with that name.
  await app.waitForCondition<boolean>(
    `(function(){
       var item = document.querySelector(${JSON.stringify(MENU)} + ' [role="menuitem"]');
       return item !== null && item.getAttribute("aria-disabled") !== "true";
     })()`,
    { timeoutMs: 15_000 },
  );
  return app.evalJS<ReadonlyArray<{ action: string; label: string; disabled: boolean }>>(
    menuRows(),
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0568 — a background session seats onto a card instead of refusing",
  () => {
    test(
      "the row offers Resume, the gesture seats a card, and the row then offers Show",
      async () => {
        const app = await launchTugApp({
          testName: "at0568-background-session-resume",
        });
        try {
          await app.waitForCondition<boolean>(`typeof window.__tug !== "undefined"`, {
            timeoutMs: 15_000,
          });

          // Seeded after launch, deliberately: tugcast demotes every `live`
          // row to `closed` once at startup, and a session that is alive right
          // now is the whole of this fixture.
          app.seedLedger({
            sessions: [
              {
                session_id: SESSION_ID,
                workspace_key: projectDir,
                project_dir: projectDir,
                // The string this phase turns on, written the way
                // `spawn_headless_session` writes it — through the real ledger,
                // so the projection computes `background` from it rather than
                // being told.
                card_id: BACKGROUND_CARD_ID,
                name: "at0568 tripwire session",
              },
            ],
          });

          // The Overview, and one post citing the session. The ref resolves
          // through the real `resolve_sessions` round trip against the row
          // seeded above, which is the lookup the gesture itself uses.
          await app.nativeKey("o", ["cmd", "ctrl"]);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OVERVIEW)}) !== null`,
            { timeoutMs: 15_000 },
          );
          expect(
            await app.evalJS<boolean>(
              `window.__tug.publishOverviewPost(${JSON.stringify(
                JSON.stringify({
                  id: 1,
                  at_ms: 1_754_600_000_000,
                  author: "tripwire",
                  body: "The tripwire's session is still open, if you want it.",
                  refs: [{ kind: "session", target: SESSION_ID }],
                }),
              )})`,
            ),
          ).toBe(true);
          await app.waitForCondition<boolean>(
            `(function(){
               var chip = document.querySelector(${JSON.stringify(OVERVIEW_CHIP)});
               return chip !== null && chip.getAttribute("data-missing") !== "true";
             })()`,
            { timeoutMs: 15_000 },
          );

          // ---- 1. A live session nobody can be sent to offers Resume. -------
          const held = await openChipMenu(app);
          note("at0568 menu (background session)", JSON.stringify(held));
          expect(held[0].action).toBe("resume-session");
          expect(held[0].label).toBe("Resume Session");
          expect(held[0].disabled).toBe(false);

          // ---- 2. It seats a card. ------------------------------------------
          const before = await app.evalJS<number>(CARD_HOSTS);
          await app.nativeClickAtElement(`${MENU} [data-item-action="resume-session"]`);
          await app.waitForCondition<boolean>(`${CARD_HOSTS} > ${before}`, {
            timeoutMs: 25_000,
          });
          const seated = await app.evalJS<number>(CARD_HOSTS);
          note("at0568 cards", `${before} → ${seated}`);

          // And it opens onto the session's own transcript, not an empty
          // card: the binding fires `request_replay`, tugcode replays the
          // JSONL the background session left on disk, and the turn it
          // carries paints. This is the Exit's "a settled trip opens onto its
          // full transcript" — the half of the gesture that a seated card
          // alone does not prove.
          await app.waitForCondition<boolean>(
            `(function(){
               var bodies = document.querySelectorAll(${JSON.stringify(USER_BODIES)});
               return Array.prototype.some.call(bodies, function (b) {
                 return (b.textContent || "").indexOf(${JSON.stringify(FIXTURE_PROMPT)}) !== -1;
               });
             })()`,
            { timeoutMs: 30_000 },
          );

          // ---- 3. And the row then points at the card holding it. -----------
          //
          // Not a second card: the deck opening a rival on a session it already
          // holds is the failure [B05] rules out, and the item changing its
          // word is how the surface says so before anybody clicks.
          const raised = await openChipMenu(app);
          note("at0568 menu (card holding it)", JSON.stringify(raised));
          expect(raised[0].action).toBe("show-session");
          expect(raised[0].label).toBe("Show Session");
          expect(await app.evalJS<number>(CARD_HOSTS)).toBe(seated);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
