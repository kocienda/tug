/**
 * at0592-workspace-parked-rows.test.ts — the Workspaces card's rows for a
 * workspace that is not on screen do what they say.
 *
 * Since [P09] the card lists every workspace, not just the one showing, which
 * means most of what a reader sees on it is rows for cards that are not
 * standing. Three of those rows' promises were being broken, all by the same
 * root cause in three disguises: the card was reading the DECK for structure
 * and the MOUNTED CARD for everything else, so anything the mounted card was
 * the only source of simply went missing when the card came down.
 *
 *   1. **The name.** A file card's title comes from the open registry the
 *      Text card and the viewer register with at mount. Drag one onto a
 *      workspace nobody has visited and it unmounts, the registry forgets it,
 *      and the row fell back to the registration's `defaultMeta.title` — so a
 *      file the user could see the name of a second ago was called `File`.
 *      The bag is where that card's path already is: `moveCardToSpace`
 *      captures every moving card before React takes its pane down ([L23]),
 *      so the row reads that when nothing is mounted to ask.
 *
 *   2. **The close box.** `close-tab` is a chain dispatch at the card, and an
 *      unmounted card registers no responder, so the × on such a row was a
 *      button that did nothing at all — a silent early return ([L31]) on the
 *      one gesture whose whole report is the row going away. It now stands
 *      the workspace up, exactly as the delete walk does and for exactly the
 *      same reason: a card that has never mounted has no close guard, so
 *      closing it without one would take unsaved work in silence.
 *
 *   3. **The group headers.** A `SESSIONS` or `FILES` header inside another
 *      workspace's block swallowed its click, because on the workspace that
 *      IS showing a click on a header means nothing — the fold cue is the
 *      only thing that folds. But a block belonging to a workspace that is
 *      not showing is a different question, and a reader clicking inside one
 *      is pointing at the workspace. So the header now means what its own
 *      workspace header means: go there.
 *
 * The negative in the third leg is what keeps the two readings apart: the
 * SHOWN workspace's group header still folds nothing and activates nothing,
 * which is the behaviour a reader scanning the list they are standing in
 * depends on.
 *
 * The first two legs run against a workspace the run has never stood up —
 * `mountedSpaceIds` does not hold it — because that is the only state in
 * which the registries and the responder chain are both empty. A workspace
 * [B06] has left mounted behind the one on screen answers both questions
 * live, and is the easy case.
 *
 * @covers tugdeck/src/components/cards/cards-data-source.ts
 * @covers tugdeck/src/components/cards/cards-card.tsx
 * @covers tugdeck/src/components/cards/cards-cell-context.tsx
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const HOME = "at0592-home";
const AWAY = "at0592-away";

/**
 * "On screen", said out loud. Every visited workspace stays mounted ([B06]),
 * so the document holds one Workspaces card per visited workspace — all but
 * one inside a wrapper with no `data-space-shown`.
 */
const SHOWN = "[data-space-layer][data-space-shown] ";

/** A row inside a named workspace's block, wherever that block is drawn. */
const rowIn = (spaceId: string): string =>
  `${SHOWN}.cards-list .cards-row[data-cards-space-run="${spaceId}"]`;
/** That block's Files band header. */
const filesHeaderIn = (spaceId: string): string =>
  `${SHOWN}.cards-list .cards-header[data-cards-group-run="${spaceId}:files"]`;

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

function textPane(id: string, cardId: string): Record<string, unknown> {
  return {
    id,
    position: { x: 60, y: 60 },
    size: { width: 700, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["standard"],
  };
}

/**
 * Two workspaces. `HOME` is active and holds the Workspaces card plus the
 * Text card the first two legs move; `AWAY` holds only its own Workspaces
 * card, so nothing about it is stood up until something stands it up.
 *
 * `AWAY` carries a Workspaces card of its own for the same reason every
 * workspace in these fixtures does: a workspace whose rail is empty has no
 * list to read once it becomes the one on screen.
 */
function blob(textCardId: string): Record<string, unknown> {
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
            { id: textCardId, componentId: "text", title: "T", closable: true },
          ],
          panes: [rail("pch", "CH"), textPane("pth", textCardId)],
          activePaneId: "pth",
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
          ],
          panes: [rail("pca", "CA")],
          activePaneId: "pca",
          imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
          hasFocus: true,
        },
      },
    ],
  };
}

/**
 * The bag a Text card bound to `file` would have written, seeded so the card
 * mounts already bound rather than having to be driven through an open.
 *
 * It is not what either of the first two legs is testing. The move captures
 * every moving card and REPLACES its bag ([L23]), so a capture that wrote
 * nothing would leave the row nameless whatever was seeded here — the seed is
 * the card's starting condition, not the answer.
 */
function textBag(file: string): string {
  return JSON.stringify({
    content: {
      path: file,
      draftId: null,
      untitled: false,
      untitledNumber: null,
      anchor: { line: 1, ch: 0 },
      scrollTop: 0,
    },
  });
}

/** The titles of every row in a workspace's block, in the order drawn. */
const titlesIn = (spaceId: string): string =>
  `(function () {
     return Array.prototype.map.call(
       document.querySelectorAll(${JSON.stringify(`${rowIn(spaceId)} .tug-list-row-title`)}),
       function (el) { return el.textContent; }
     );
   })()`;

interface SpacesDiag {
  activeSpaceId: string;
  spaces: { id: string; name: string; active: boolean; deck: { cards: { id: string }[] } }[];
}

describe.skipIf(!SHOULD_RUN)(
  "at0592 — rows for a workspace that is not on screen",
  () => {
    test(
      "a file card moved to an unvisited workspace keeps its name, and its × closes it",
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0592-"));
        const file = path.join(dir, "ledger-notes.txt");
        fs.writeFileSync(file, "one\ntwo\nthree\n");
        const CARD = "TH";

        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(blob(CARD)),
        );
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.cardstate",
          CARD,
          "json",
          textBag(file),
        );

        const app = await launchTugApp({
          testName: "at0592-parked-name-and-close",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          // ---- 0. The card is standing in HOME, named after its file. -----
          await app.waitForCondition<boolean>(
            `typeof window.tugdeck !== "undefined"
             && window.tugdeck.diag.getSpaces().spaces.length === 2`,
            { timeoutMs: 25_000 },
          );
          await app.waitForCondition<boolean>(
            `${titlesIn(HOME)}.indexOf("ledger-notes.txt") !== -1`,
            { timeoutMs: 25_000 },
          );
          await settle();

          // ---- 1. Move it to the workspace nobody has visited. ------------
          await app.evalJS<unknown>(
            `window.tugdeck.lab.moveCardToSpace(${JSON.stringify(CARD)}, ${JSON.stringify(AWAY)})`,
          );
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().spaces.filter(function (s) {
               return s.id === ${JSON.stringify(AWAY)};
             })[0].deck.cards.length === 2`,
            { timeoutMs: 10_000 },
          );
          await settle();

          // Nothing was stood up by the move: AWAY is still parked, which is
          // what makes the two readings below the hard case rather than the
          // easy one.
          const spaces = await app.evalJS<SpacesDiag>(
            `window.tugdeck.diag.getSpaces()`,
          );
          expect(
            spaces.activeSpaceId,
            "the move does not go where the card went",
          ).toBe(HOME);

          const away = await app.evalJS<string[]>(titlesIn(AWAY));
          note(`at0592 rows in the parked workspace: ${JSON.stringify(away)}`);
          expect(
            away,
            "the row still calls the card by its file, not by its registration",
          ).toContain("ledger-notes.txt");
          expect(
            away,
            "and `File` is what it used to say instead",
          ).not.toContain("File");

          // ---- 2. The × on that row closes the card. ---------------------
          // Nothing about this card is mounted, so the close has to stand its
          // workspace up to reach a close guard at all; the assertion is the
          // outcome, not the route.
          await app.evalJS<unknown>(
            `(function () {
               var box = document.querySelector(
                 ${JSON.stringify(`${rowIn(AWAY)} .cards-row-close`)}
               );
               if (box === null) throw new Error("no close box on the parked row");
               box.click();
               return null;
             })()`,
          );
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().spaces.filter(function (s) {
               return s.id === ${JSON.stringify(AWAY)};
             })[0].deck.cards.filter(function (c) {
               return c.id === ${JSON.stringify(CARD)};
             }).length === 0`,
            { timeoutMs: 30_000 },
          );
          const afterClose = await app.evalJS<SpacesDiag>(
            `window.tugdeck.diag.getSpaces()`,
          );
          note(
            `at0592 after the ×: active=${afterClose.activeSpaceId} away cards=${
              afterClose.spaces.filter((s) => s.id === AWAY)[0].deck.cards.length
            }`,
          );
          expect(
            afterClose.spaces.filter((s) => s.id === AWAY)[0].deck.cards.map((c) => c.id),
            "the card the × named is the one that went",
          ).toEqual(["CA"]);
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a click on a group header inside a workspace that is not showing goes there",
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0592-head-"));
        const file = path.join(dir, "away-notes.txt");
        fs.writeFileSync(file, "away\n");
        const CARD = "TA";

        // The same two workspaces, with the Text card seeded into AWAY from
        // the start: this leg needs a FILES band inside a block that is not
        // showing, and never moves anything.
        const layout = blob(CARD) as {
          spaces: { id: string; deck: Record<string, unknown> }[];
        };
        const home = layout.spaces[0];
        const awaySpace = layout.spaces[1];
        home.deck.cards = [
          { id: "CH", componentId: "cards", title: "Workspaces", closable: true },
          { id: "TH2", componentId: "text", title: "T", closable: true },
        ];
        home.deck.panes = [rail("pch", "CH"), textPane("pth", "TH2")];
        awaySpace.deck.cards = [
          { id: "CA", componentId: "cards", title: "Workspaces", closable: true },
          { id: CARD, componentId: "text", title: "T", closable: true },
        ];
        awaySpace.deck.panes = [rail("pca", "CA"), textPane("pta", CARD)];

        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(layout),
        );
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.cardstate",
          CARD,
          "json",
          textBag(file),
        );

        const app = await launchTugApp({
          testName: "at0592-group-header-goes-there",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `typeof window.tugdeck !== "undefined"
             && document.querySelector(${JSON.stringify(filesHeaderIn(AWAY))}) !== null
             && document.querySelector(${JSON.stringify(filesHeaderIn(HOME))}) !== null`,
            { timeoutMs: 25_000 },
          );
          await settle();

          // ---- 1. The SHOWN workspace's own band header still does nothing.
          const home0 = await app.evalJS<{ active: string; collapsed: string | null }>(
            `(function () {
               var h = document.querySelector(${JSON.stringify(filesHeaderIn(HOME))});
               h.click();
               return {
                 active: window.tugdeck.diag.getSpaces().activeSpaceId,
                 collapsed: h.getAttribute("data-group-collapsed"),
               };
             })()`,
          );
          await settle();
          note(`at0592 click on the shown workspace's FILES header: ${JSON.stringify(home0)}`);
          expect(
            home0.active,
            "a click inside the workspace already showing goes nowhere",
          ).toBe(HOME);
          expect(
            home0.collapsed,
            "and folds nothing — the cue is still the only thing that folds",
          ).toBe("false");

          // ---- 2. The other workspace's band header goes there. -----------
          await app.evalJS<unknown>(
            `(function () {
               var h = document.querySelector(${JSON.stringify(filesHeaderIn(AWAY))});
               if (h === null) throw new Error("no FILES header in the parked block");
               h.click();
               return null;
             })()`,
          );
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(AWAY)}`,
            { timeoutMs: 10_000 },
          );
          await settle();

          // The fold is untouched by the trip: going somewhere is not folding
          // the band that was clicked to get there.
          const arrived = await app.evalJS<{ active: string; collapsed: string | null }>(
            `(function () {
               var h = document.querySelector(${JSON.stringify(filesHeaderIn(AWAY))});
               return {
                 active: window.tugdeck.diag.getSpaces().activeSpaceId,
                 collapsed: h === null ? null : h.getAttribute("data-group-collapsed"),
               };
             })()`,
          );
          note(`at0592 after the click on the parked FILES header: ${JSON.stringify(arrived)}`);
          expect(arrived.active).toBe(AWAY);
          expect(
            arrived.collapsed,
            "the band the click travelled through is still open",
          ).toBe("false");
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
