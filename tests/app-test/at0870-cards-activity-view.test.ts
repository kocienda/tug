/**
 * at0870-cards-activity-view.test.ts — the Workspaces card's Activity view.
 *
 * The card's toolbar carries a `View:` popup with two choices. Workspaces is
 * the card as it has always been: one block per workspace, its groups under
 * it. Activity drops the workspace blocks and lists two flat groups, Sessions
 * then Files, across every workspace at once, newest first, each row wearing a
 * chip that says which workspace it lives in.
 *
 * ## What this gates
 *
 *   - **The view is chosen by the popup and kept (A).** A real click on the
 *     popup and on its Activity item turns the list into Activity — no
 *     workspace headers, a chip on every row — and the choice is written to
 *     the cards domain, so a relaunch on the same tugbank opens the card in
 *     Activity. Fails if the item's `set-value` never reaches the picker's
 *     responder, if the store forgets to persist, or if hydration drops it.
 *
 *   - **Files order by their time on disk, across workspaces (B).** Three
 *     files in two workspaces, given disk times that interleave the
 *     workspaces, list newest first. An order that followed the workspaces
 *     would put both Home files together; this one cannot. The Sessions group
 *     stands above Files, and two sessions nobody has run keep the workspace
 *     order, since neither has a time. (The time order of sessions is
 *     asserted over recorded tables in the unit tests; a real turn's end is
 *     not something a launch can stage cheaply.)
 *
 *   - **The filter matches the workspace name (C).** Typing the parked
 *     workspace's name narrows both groups to its rows, which no row's own
 *     text would match.
 *
 *   - **A row press crosses workspaces (D).** Pressing a row whose card lives
 *     in the workspace not on screen switches to that workspace.
 *
 * @covers tugdeck/src/components/cards/cards-card.tsx
 * @covers tugdeck/src/components/cards/cards-data-source.ts
 * @covers tugdeck/src/components/cards/cards-session-cell.tsx
 * @covers tugdeck/src/components/cards/cards-store/cards-store.ts
 * @covers tugdeck/src/lib/file-modified-store.ts
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { launchTugApp, note, type BodyApp } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankRead,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { kindBody } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const HOME = "at0870-home";
const AWAY = "at0870-away";

const CARDS_DOMAIN = "dev.tugapp.cards";

const TRIGGER = '.cards-view-picker [data-slot="tug-popup-button"]';
/** The popup's items are its array index: `CARDS_VIEWS` is Workspaces, Activity. */
const ACTIVITY_ITEM = '[data-testid="cards-view-menu"] .tug-menu-item[data-item-id="1"]';
const FILTER_INPUT = '[data-testid="cards-filter"] input';
const SPACE_HEADERS = ".cards-list .cards-space-header";
const CHIPS = '.cards-list [data-testid="cards-activity-place"]';

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

function pane(id: string, cardId: string, x: number): Record<string, unknown> {
  return {
    id,
    position: { x, y: 60 },
    size: { width: 500, height: 360 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["standard"],
  };
}

const text = (id: string) => ({ id, componentId: "text", title: "T", closable: true });
const session = (id: string) => ({ id, componentId: "session", title: "S", closable: true });

/**
 * Two workspaces, Home on screen. Each holds a Session card nobody has
 * connected and its Text cards: Home the oldest and the middle file, Away the
 * newest. The Workspaces card is the window's, on the rail every workspace
 * shares ([D231]).
 */
function blob(): Record<string, unknown> {
  return {
    version: 5,
    activeSpaceId: HOME,
    rail: {
      cards: [{ id: "CH", componentId: "cards", title: "Workspaces", closable: true }],
      panes: [rail("pch", "CH")],
      imposition: { sidebars: { cards: { side: "right" } } },
    },
    spaces: [
      {
        id: HOME,
        name: "Home",
        deck: {
          cards: [session("SH"), text("TOLD"), text("TMID")],
          panes: [pane("psh", "SH", 40), pane("pold", "TOLD", 80), pane("pmid", "TMID", 120)],
          activePaneId: "pmid",
          imposition: { kind: "one-up", sidebars: {} },
          hasFocus: true,
        },
      },
      {
        id: AWAY,
        name: "Away",
        deck: {
          cards: [session("SA"), text("TNEW")],
          panes: [pane("psa", "SA", 40), pane("pnew", "TNEW", 80)],
          activePaneId: "pnew",
          imposition: { kind: "one-up", sidebars: {} },
          hasFocus: true,
        },
      },
    ],
  };
}

/** The bag a Text card bound to `file` would have written, so it mounts bound. */
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

/**
 * The list as drawn, top to bottom: a group header as `[group]`, a row as
 * `group:<its workspace's chip>:<its title>`.
 */
const LIST_SHAPE = `(function () {
  var nodes = document.querySelectorAll(
    ".cards-list .cards-header, .cards-list [data-cards-row-group]"
  );
  return Array.prototype.map.call(nodes, function (el) {
    if (el.classList.contains("cards-header")) {
      return "[" + el.getAttribute("data-cards-group") + "]";
    }
    var chip = el.querySelector('[data-testid="cards-activity-place"]');
    var title = el.querySelector(".cards-row-title");
    return el.getAttribute("data-cards-row-group") + ":" +
      (chip === null ? "-" : chip.getAttribute("data-cards-activity-space")) + ":" +
      (title === null ? "" : title.textContent.replace("•", "").trim());
  });
})()`;

const count = (selector: string): string =>
  `document.querySelectorAll(${JSON.stringify(selector)}).length`;

/** Type into the card's filter the way a keystroke does (React sees a change). */
function typeFilter(body: BodyApp, value: string): Promise<null> {
  return body.evalJS<null>(`(function () {
    var el = document.querySelector(${JSON.stringify(FILTER_INPUT)});
    if (!el) throw new Error("cards filter input not found");
    el.focus();
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return null;
  })()`);
}

function seed(tugbankPath: string, files: Record<string, string>): void {
  seedTugbankForLaunch(tugbankPath);
  tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(blob()));
  for (const [cardId, file] of Object.entries(files)) {
    tugbankWrite(tugbankPath, "dev.tugapp.deck.cardstate", cardId, "json", textBag(file));
  }
}

describe.skipIf(!SHOULD_RUN)("at0870 — the Workspaces card's Activity view", () => {
  test(
    "the popup switches to Activity, and a relaunch opens the card in it",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0870-view-"));
      const files: Record<string, string> = {};
      for (const id of ["TOLD", "TMID", "TNEW"]) {
        files[id] = path.join(dir, `${id.toLowerCase()}.md`);
        fs.writeFileSync(files[id], `${id}\n`);
      }
      const tugbankPath = mkTempTugbank();
      seed(tugbankPath, files);
      const launch = (testName: string) =>
        launchTugApp({
          testName,
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });

      let app = await launch("at0870-switch");
      try {
        const cards = kindBody(app, "cards");
        await cards.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TRIGGER)}) !== null
           && ${count(SPACE_HEADERS)} === 2`,
          { timeoutMs: 25_000 },
        );
        expect(
          await cards.evalJS<string | null>(
            `document.querySelector(${JSON.stringify(TRIGGER)}).getAttribute("data-cards-view")`,
          ),
          "a card with no stored view opens in Workspaces",
        ).toBe("workspaces");
        await settle();

        // ---- A. The popup, then its Activity item, by real clicks. --------
        await cards.nativeClickAtElement(TRIGGER);
        await cards.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ACTIVITY_ITEM)}) !== null`,
          { timeoutMs: 5_000 },
        );
        await cards.nativeClickAtElement(ACTIVITY_ITEM);
        await cards.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TRIGGER)}).getAttribute("data-cards-view") === "activity"
           && ${count(SPACE_HEADERS)} === 0
           && ${count(CHIPS)} > 0`,
          { timeoutMs: 10_000 },
        );
        await settle(600);
      } finally {
        await app.close().catch(() => undefined);
      }

      const stored = tugbankRead<string>(tugbankPath, CARDS_DOMAIN, "cardsView");
      note(`at0870 stored view: ${JSON.stringify(stored)}`);
      expect(stored?.value, "the choice is written to the cards domain").toBe("activity");

      app = await launch("at0870-relaunch");
      try {
        const cards = kindBody(app, "cards");
        await cards.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TRIGGER)}) !== null
           && ${count(CHIPS)} > 0`,
          { timeoutMs: 25_000 },
        );
        const after = {
          view: await cards.evalJS<string | null>(
            `document.querySelector(${JSON.stringify(TRIGGER)}).getAttribute("data-cards-view")`,
          ),
          spaceHeaders: await cards.evalJS<number>(count(SPACE_HEADERS)),
        };
        note(`at0870 after relaunch: ${JSON.stringify(after)}`);
        expect(after.view, "the card reopens in the view it was left in").toBe("activity");
        expect(after.spaceHeaders, "with no workspace blocks").toBe(0);
      } finally {
        await app.close().catch(() => undefined);
        rmTempTugbank(tugbankPath);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "files order by disk time across workspaces, the filter matches a workspace, and a press goes there",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0870-order-"));
      const now = Date.now() / 1000;
      // Disk times that cut across the workspaces: Away's file is the newest,
      // so an order that followed the workspaces would read differently.
      const ages: Record<string, number> = { TOLD: 3 * 86_400, TMID: 2 * 86_400, TNEW: 3_600 };
      const files: Record<string, string> = {};
      for (const [id, age] of Object.entries(ages)) {
        files[id] = path.join(dir, `${id.toLowerCase()}.md`);
        fs.writeFileSync(files[id], `${id}\n`);
        fs.utimesSync(files[id], now - age, now - age);
      }
      const tugbankPath = mkTempTugbank();
      seed(tugbankPath, files);
      tugbankWrite(tugbankPath, CARDS_DOMAIN, "cardsView", "json", JSON.stringify("activity"));

      const app = await launchTugApp({
        testName: "at0870-order",
        env: { TUGBANK_PATH: tugbankPath },
        skipAccessibilityPreflight: true,
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        const cards = kindBody(app, "cards");
        const expected = [
          "[sessions]",
          "sessions:Home:",
          "sessions:Away:",
          "[files]",
          "files:Away:tnew.md",
          "files:Home:tmid.md",
          "files:Home:told.md",
        ];
        // Times arrive after the rows do — the stat is asked once the paths
        // are known — so the order is waited on, then read once.
        const settled = await cards
          .waitForCondition<boolean>(
            `(function () {
               var shape = ${LIST_SHAPE}.map(function (s) {
                 return s.indexOf("sessions:") === 0 ? s.split(":").slice(0, 2).join(":") + ":" : s;
               });
               return JSON.stringify(shape) === ${JSON.stringify(JSON.stringify(expected))};
             })()`,
            { timeoutMs: 25_000 },
          )
          .then(() => true)
          .catch(() => false);
        const shape = await cards.evalJS<string[]>(LIST_SHAPE);
        note(`at0870 Activity list: ${JSON.stringify(shape)}`);
        expect(settled, `the list reads ${JSON.stringify(expected)}`).toBe(true);
        expect(
          await cards.evalJS<number>(count(SPACE_HEADERS)),
          "Activity draws no workspace blocks",
        ).toBe(0);

        // ---- C. The parked workspace's name narrows to its rows. ---------
        await typeFilter(cards, "away");
        const narrowed = await cards
          .waitForCondition<boolean>(
            `(function () {
               var rows = ${LIST_SHAPE}.filter(function (s) { return s.charAt(0) !== "["; });
               return rows.length === 2 && rows.every(function (s) { return s.indexOf(":Away:") !== -1; });
             })()`,
            { timeoutMs: 5_000 },
          )
          .then(() => true)
          .catch(() => false);
        note(`at0870 filtered to "away": ${JSON.stringify(await cards.evalJS<string[]>(LIST_SHAPE))}`);
        expect(narrowed, "only Away's session and file are left").toBe(true);
        await typeFilter(cards, "");
        await cards.waitForCondition<boolean>(`${count(CHIPS)} === 5`, { timeoutMs: 5_000 });
        await settle();

        // ---- D. A press on Away's file goes to Away. ----------------------
        expect(
          await app.evalJS<string>(`window.tugdeck.diag.getSpaces().activeSpaceId`),
        ).toBe(HOME);
        await cards.nativeClickAtElement(
          `.cards-list .cards-row[data-cards-row-group="files"][data-cards-space-run="${AWAY}"] .cards-row-title`,
        );
        const went = await app
          .waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(AWAY)}`,
            { timeoutMs: 10_000 },
          )
          .then(() => true)
          .catch(() => false);
        note(
          `at0870 after the press: active=${await app.evalJS<string>(
            `window.tugdeck.diag.getSpaces().activeSpaceId`,
          )}`,
        );
        expect(went, "pressing a row in a parked workspace switches to it").toBe(true);
      } finally {
        await app.close().catch(() => undefined);
        rmTempTugbank(tugbankPath);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
