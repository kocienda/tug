/**
 * at0599-menu-open-beside-host.test.ts — a menu row opens its card beside the
 * card the menu was raised in, not beside whichever card holds first responder.
 *
 * A right-click does not move first responder. So a menu raised over a file
 * reference in one card, while another card is focused, used to open the file
 * beside the FOCUSED card: the opener read only the first responder, and the
 * menu's own host was never asked. Every opening gesture now names the card it
 * was made in (`originCardId`), and the deck ranks the new card's slot from it.
 *
 * The fixture makes the two answers disagree. A five-up deck:
 *
 *   slot 0  the Session card whose Read header names the file   (the host)
 *   slot 1  empty
 *   slot 2  a hello card
 *   slot 3  a hello card, focused                               (first responder)
 *   slot 4  empty
 *
 * Ranked from the host the file takes slot 1, the empty slot beside it. Ranked
 * from the first responder it would take slot 4 — the empty slot beside THAT
 * card, which wins over the stack at slot 2 at the same distance. So the slot
 * the new card stands in says which card the open was placed from.
 *
 * The gestures are native: a trusted right-click raises the menu and a trusted
 * click picks Open in Editor, because a synthetic event does not run the
 * menu's real activation path. The first responder is read between the two, so
 * the test proves the premise — the focused card never moved — rather than
 * assuming it.
 *
 * @covers tugdeck/src/components/tugways/use-annotation-menu.tsx
 * @covers tugdeck/src/lib/opening-placement.ts
 * @covers tugdeck/src/lib/open-file-in-card.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-at0599";
const FILE_BODY = ["alpha", "bravo", "charlie"].join("\n");

let projectDir = "";
let filePath = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0599-"));
  filePath = join(projectDir, "cited.md");
  writeFileSync(filePath, FILE_BODY, "utf8");
});
afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function deckShape() {
  const pane = (id: string, cardId: string, slot: number) => ({
    id,
    position: { x: 40, y: 40 },
    size: { width: 600, height: 600 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  });
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
      { id: "X", componentId: "hello", title: "Card X", closable: true },
      { id: "H", componentId: "hello", title: "Card H", closable: true },
    ],
    panes: [pane("pA", "A", 0), pane("pX", "X", 2), pane("pH", "H", 3)],
    activePaneId: "pH",
    // Fit, so every slot is on screen: the deck's default is flow, which would
    // leave the host card at slot 0 scrolled off the band and out of reach of
    // a native right-click.
    imposition: { kind: "five-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

const textCardIds = (app: App): Promise<string[]> =>
  app.evalJS<string[]>(
    `window.tugdeck.diag.getDeckState().cards
      .filter(function (c) { return c.componentId === "text"; })
      .map(function (c) { return c.id; })`,
  );

/** The stored slot of the pane holding `cardId`; null when it holds none. */
const slotOf = (app: App, cardId: string): Promise<number | null> =>
  app.evalJS<number | null>(
    `(function () {
      var pane = window.tugdeck.diag.getDeckState().panes.find(function (p) {
        return p.cardIds.indexOf(${JSON.stringify(cardId)}) !== -1;
      });
      return pane === undefined || pane.slot === undefined ? null : pane.slot;
    })()`,
  );

/** Trusted native-click the open menu's item with `data-item-action === action`. */
async function activateMenuItem(app: App, action: string): Promise<void> {
  const point = await app.evalJS<{ x: number; y: number } | null>(
    `(() => {
      const item = document.querySelector('[data-item-action="' + ${JSON.stringify(action)} + '"]');
      if (item === null) return null;
      const r = item.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`,
  );
  if (point === null) throw new Error(`menu item ${action} not found`);
  await app.nativeClick(point);
}

describe.skipIf(!SHOULD_RUN)(
  "at0599 — a menu row opens beside the card it was raised in",
  () => {
    test(
      "Open in Editor from an unfocused card lands beside that card",
      async () => {
        const app = await launchTugApp({ testName: "at0599-menu-open-beside-host" });
        const ingest = (decoded: unknown) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded,
          });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "H" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { tugSessionId: SID, sessionMode: "resume" });

          // A replayed Read, whose header is a confirmed file reference.
          await ingest({ type: "replay_started", tug_session_id: SID });
          await ingest({
            type: "add_user_message",
            tug_session_id: SID,
            content: [{ type: "text", text: "read it" }],
          });
          await ingest({
            type: "tool_use",
            tug_session_id: SID,
            msg_id: "m1",
            tool_use_id: "tc-1",
            tool_name: "Read",
            input: { file_path: filePath },
            seq: 1,
          });
          await ingest({
            type: "tool_result",
            tug_session_id: SID,
            tool_use_id: "tc-1",
            output: FILE_BODY,
          });
          await ingest({
            type: "turn_complete",
            tug_session_id: SID,
            msg_id: "m1",
            result: "success",
          });
          await ingest({
            type: "replay_complete",
            tug_session_id: SID,
            count: 1,
            firstLoadedTurnIndex: 0,
            totalTurns: 1,
            hasOlder: false,
          });

          const HEADER_REF = '[data-card-id="A"] [data-slot="read-tool-block-path"]';
          await app.waitForCondition<boolean>(
            `document.querySelector('${HEADER_REF}') !== null`,
            { timeoutMs: 8000 },
          );

          // The premise: the focused card is H, in slot 3, and the card the
          // menu is about to be raised in is not it.
          expect(await app.getActiveCardId()).toBe("H");

          const before = await textCardIds(app);
          await app.nativeRightClickAtElement(HEADER_REF);
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-item-action="open-file"]') !== null`,
            { timeoutMs: 3000 },
          );
          // …and the right-click left it there. Were first responder to move
          // to A, the two rankings would agree and the test would prove nothing.
          expect(
            await app.getActiveCardId(),
            "a right-click does not move first responder",
          ).toBe("H");

          await activateMenuItem(app, "open-file");
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getDeckState().cards.filter(function (c) {
              return c.componentId === "text";
            }).length === ${before.length + 1}`,
            { timeoutMs: 12_000 },
          );
          const fresh = (await textCardIds(app)).filter((id) => !before.includes(id));
          expect(fresh, "exactly one card answered the open").toHaveLength(1);

          const slot = await slotOf(app, fresh[0]);
          note("arrival", `the file opened in slot ${slot}`);
          expect(
            slot,
            "the file opens in the empty slot beside the menu's card, not beside the focused one (slot 4)",
          ).toBe(1);

          // Nobody else moved.
          expect(await slotOf(app, "A")).toBe(0);
          expect(await slotOf(app, "X")).toBe(2);
          expect(await slotOf(app, "H")).toBe(3);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
