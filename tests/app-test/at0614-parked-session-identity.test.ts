/**
 * at0614-parked-session-identity.test.ts — a Session card in a workspace
 * nobody has activated says what it is seated on, from the first frame.
 *
 * The reported defect, in the user's words: the Workspaces card was "far too
 * eager in dropping the session information for cards not in the current
 * workspace", and clicking into the workspace restored it. Nothing was ever
 * dropped ([F01]) — nothing ever picked it up. `resolveCard` had exactly one
 * door into session identity, the LIVE `cardSessionBindingStore` entry a card
 * receives when it mounts, and a workspace nobody has activated mounts no
 * cards. So `tugSessionId` and `projectDir` came back null, the list built a
 * generic cell rather than `CardsSessionRow`, and what the reader saw was a
 * row titled `session` with no description, no slot picker, and a close ×
 * where its identity should be. The × and the missing picker were never
 * separate cosmetic defects; they are the tell that the row fell through.
 *
 * The durable record was in hand the whole time ([F02]): the boot
 * `list_card_bindings_ok` frame lists EVERY card id the ledger knows rather
 * than only the active deck's, and the Cards card read all of it for a single
 * `N live` boolean. The fix is the two ids ([B04]) — the Session card's
 * registration now declares a parked resolver over that cache, and the name,
 * tag and synopsis the row shows were already seeded from the same frame by
 * the same handler.
 *
 * What this drives is that whole path through the real app: the frame arrives
 * on the action the server's own reply lands on, the handler seeds the
 * identity stores, the cache fills, and the row for a card in a workspace
 * this run has never stood up is asserted to be a session row.
 *
 * Three assertions, one per face of the defect:
 *
 *   1. **`data-session-id`.** Only `CardsSessionRow` carries it, so its
 *      presence IS the proof that the generic branch was not taken.
 *   2. **The description line, non-empty.** The row says what the session is
 *      about, which is the information the user said was being dropped.
 *   3. **No close ×.** The generic row draws one and the session row does
 *      not, so its absence is the same proof from the other side.
 *
 * The frame is stated rather than earned, on at0579's precedent and for its
 * reason: the ledger this harness answers from carries no card-binding rows
 * of its own, so a test about a workspace nobody has activated has to state
 * the server's reply. It is stated through `dispatchControlAction`, which
 * enters at the registered action the real frame enters at — everything
 * downstream of the payload is the production path, seeding included.
 *
 * @covers tugdeck/src/lib/card-identity.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-registration.tsx
 * @covers tugdeck/src/components/cards/cards-data-source.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const HOME = "at0614-home";
/** Never activated in this run — which is the whole point. */
const AWAY = "at0614-away";

/** The Session card sitting in the workspace nobody visits. */
const PARKED_CARD = "at0614-parked-card";
const PARKED_SESSION = "at0614-parked-session";
const PARKED_LINE = "at0614-parked-line";
const PROJECT_DIR = "/tmp/at0614-project";
const SESSION_NAME = "ledger walk";
const SESSION_SYNOPSIS = "Reading the bindings ledger back at boot.";

/**
 * "On screen", said out loud. Every visited workspace stays mounted ([B06]),
 * so the document holds one Workspaces card per visited workspace — all but
 * one inside a wrapper with no `data-space-shown`.
 */
const SHOWN = "[data-space-layer][data-space-shown] ";

/** Any row inside a named workspace's block. */
const rowIn = (spaceId: string): string =>
  `${SHOWN}.cards-list .cards-row[data-cards-space-run="${spaceId}"]`;

/** The parked card's row, IF it drew as a session row. */
const SESSION_ROW = `${SHOWN}.cards-list [data-session-id="${PARKED_SESSION}"]`;

const settle = (ms = 400): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function rail(id: string, cardId: string): Record<string, unknown> {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 460, height: 900 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: [] as string[],
  };
}

function sessionPane(id: string, cardId: string): Record<string, unknown> {
  return {
    id,
    position: { x: 60, y: 60 },
    size: { width: 700, height: 600 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["standard"],
  };
}

/**
 * Two workspaces. `HOME` is active and holds the Workspaces card that draws
 * both blocks; `AWAY` holds the Session card under test, plus a Workspaces
 * card of its own for the reason every fixture here gives one — a workspace
 * whose rail is empty has no list to read once it becomes the one showing.
 *
 * Nothing in `AWAY` is ever stood up: no card of it mounts, no binding is
 * written for `PARKED_CARD`, and the only thing that can speak for it is the
 * ledger's own record.
 */
function blob(): Record<string, unknown> {
  return {
    version: 5,
    activeSpaceId: HOME,
    spaces: [
      {
        id: HOME,
        name: "Home",
        deck: {
          cards: [
            { id: "CH", componentId: "cards", title: "Workspaces", closable: true },
          ],
          panes: [rail("pch", "CH")],
          activePaneId: "pch",
          imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
          hasFocus: true,
        },
      },
      {
        id: AWAY,
        name: "Away",
        deck: {
          cards: [
            { id: "CA", componentId: "cards", title: "Workspaces", closable: true },
            { id: PARKED_CARD, componentId: "session", title: "", closable: true },
          ],
          panes: [rail("pca", "CA"), sessionPane("psa", PARKED_CARD)],
          activePaneId: "psa",
          imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
          hasFocus: true,
        },
      },
    ],
  };
}

/** The titles of every row in a workspace's block, in the order drawn. */
const titlesIn = (spaceId: string): string =>
  `(function () {
     return Array.prototype.map.call(
       document.querySelectorAll(${JSON.stringify(`${rowIn(spaceId)} .tug-list-row-title`)}),
       function (el) { return el.textContent; }
     );
   })()`;

/**
 * The server's own reply, stated. One row per card the ledger knows — here
 * just the parked one, carrying everything the real frame carries.
 */
const publishLedger = `(function () {
  window.__tug.dispatchControlAction("list_card_bindings_ok", {
    bindings: [{
      card_id: ${JSON.stringify(PARKED_CARD)},
      session_id: ${JSON.stringify(PARKED_SESSION)},
      line_id: ${JSON.stringify(PARKED_LINE)},
      project_dir: ${JSON.stringify(PROJECT_DIR)},
      state: "live",
      turn_count: 4,
      is_alive: true,
      has_jsonl: true,
      name: ${JSON.stringify(SESSION_NAME)},
      name_user_set: true,
      tag: null,
      synopsis: ${JSON.stringify(SESSION_SYNOPSIS)}
    }]
  });
  return null;
})()`;

describe.skipIf(!SHOULD_RUN)(
  "at0614 — a parked Session card's identity",
  () => {
    test(
      "a Session card in a workspace nobody has activated draws as a session row",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(blob()),
        );

        const app = await launchTugApp({
          testName: "at0614-parked-session-identity",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `typeof window.tugdeck !== "undefined"
             && window.tugdeck.diag.getSpaces().spaces.length === 2`,
            { timeoutMs: 25_000 },
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(rowIn(AWAY))}) !== null`,
            { timeoutMs: 25_000 },
          );
          await settle();

          // ---- 0. HOME is where the run is, and AWAY was never stood up. --
          const spaces = await app.evalJS<{ activeSpaceId: string }>(
            `window.tugdeck.diag.getSpaces()`,
          );
          expect(
            spaces.activeSpaceId,
            "the run never leaves the workspace it booted into",
          ).toBe(HOME);
          expect(
            await app.evalJS<boolean>(
              `(function () {
                 try { window.__tug.cardLineFacts(${JSON.stringify(PARKED_CARD)}); return true; }
                 catch (e) { return false; }
               })()`,
            ),
            "and the parked card holds no binding, so only the ledger can answer",
          ).toBe(false);

          // ---- 1. The ledger's answer arrives, as the boot frame's does. --
          await app.evalJS<unknown>(publishLedger);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SESSION_ROW)}) !== null`,
            { timeoutMs: 15_000 },
          );
          await settle();

          const titles = await app.evalJS<string[]>(titlesIn(AWAY));
          note(`at0614 rows in the parked workspace: ${JSON.stringify(titles)}`);
          expect(
            titles,
            "the row calls the session by the name the user gave it",
          ).toContain(SESSION_NAME);

          // ---- 2. The three faces of the defect, one assertion each. ------
          const row = await app.evalJS<{
            sessionId: string | null;
            description: string | null;
            descriptionEmpty: string | null;
            closeBoxes: number;
            genericRows: number;
          }>(
            `(function () {
               var el = document.querySelector(${JSON.stringify(SESSION_ROW)});
               if (el === null) throw new Error("the parked card drew no session row");
               var desc = el.querySelector(".tug-session-row-description");
               return {
                 sessionId: el.getAttribute("data-session-id"),
                 description: desc === null ? null : desc.textContent.trim(),
                 descriptionEmpty: desc === null ? null : desc.getAttribute("data-empty"),
                 closeBoxes: el.querySelectorAll(".cards-row-close").length,
                 genericRows: document.querySelectorAll(
                   ${JSON.stringify(`${rowIn(AWAY)} .cards-row-close`)}
                 ).length
               };
             })()`,
          );
          note(`at0614 the parked session's row: ${JSON.stringify(row)}`);

          expect(
            row.sessionId,
            "only CardsSessionRow carries this, so it IS the proof the generic branch was not taken",
          ).toBe(PARKED_SESSION);
          expect(
            row.description,
            "the row says what the session is about — the information the report said was dropped",
          ).toBe(SESSION_SYNOPSIS);
          expect(
            row.descriptionEmpty,
            "and says it for real, rather than drawing the empty stand-in",
          ).toBeNull();
          expect(
            row.closeBoxes,
            "no close × — the generic row draws one and the session row does not",
          ).toBe(0);
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
