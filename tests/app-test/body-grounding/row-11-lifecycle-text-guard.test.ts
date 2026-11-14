/**
 * row-11-lifecycle-text-guard.test.ts — a dirty Text body asks before its
 * pane closes and before a Cards body deletes its workspace, and Cancel
 * keeps both.
 *
 * A piece of row 11's lifecycle ([B02] row 11; the row is `_row-11.ts`'s),
 * a test to a file so each launch fits its own budget: a Text card holding
 * unsaved edits is a body whose close guard the shell cannot read in its own
 * document, so the gestures that destroy it ask in the body.
 *
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/body/body-main.ts
 * @family row-11-lifecycle
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type BodyApp } from "../_harness";
import { pollFor, settleFor } from "./_bodies";
import { standUpKind } from "./_kind-bodies";
import { cardKind, kindPane, kindSidebars } from "./_kinds";
import {
  CARD_IDS,
  CONFIRM_OK,
  ORIGINAL,
  SETTLE_MS,
  SHEET_CANCEL,
  SHOULD_RUN,
  TEST_NAME,
  TEST_TIMEOUT_MS,
  TEXT_EDITOR,
  X,
  present,
} from "./_row-11";

describe.skipIf(!SHOULD_RUN)("body-grounding row 11: close, close all, reload and quit", () => {
  test(
    "a dirty Text body asks before its pane closes and before a Cards body deletes its workspace, and Cancel keeps both",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tug-row11-guard-"));
      const file = join(dir, "notes.md");
      writeFileSync(file, ORIGINAL);
      const app = await launchTugApp({ testName: `${TEST_NAME}-text-guard` });
      try {
        await app.seedDeckState({
          state: {
            cards: [
              { id: X, componentId: "text", title: "Text", closable: true },
              { id: "row11-cards", componentId: "cards", title: "Workspaces", closable: true },
            ],
            panes: [kindPane("text", X, 0), kindPane("cards", "row11-cards", 0)],
            activePaneId: `${X}-pane`,
            imposition: { kind: "one-up", layout: "flow", sidebars: kindSidebars(["cards"]) },
            hasFocus: true,
          },
          cardStates: { [X]: { content: { path: file, anchor: { line: 1, ch: 0 }, scrollTop: 0 } } },
          focusCardId: X,
        });
        const text = await standUpKind(app, cardKind("text"), X);
        await standUpKind(app, cardKind("cards"), "row11-cards");
        await pollFor(() => text.evalJS<string>(`(document.querySelector(${JSON.stringify(TEXT_EDITOR)}) || { innerText: "" }).innerText`), (t) => t.includes("alpha"), SETTLE_MS);
        await text.nativeClickAtElement(TEXT_EDITOR);
        await app.nativeType("EDIT ");
        const typed = await settleFor(() => text.evalJS<string>(`document.querySelector(${JSON.stringify(TEXT_EDITOR)}).innerText`), (t) => t.includes("EDIT"), SETTLE_MS);
        expect(typed, "the Text body holds an unsaved edit").toContain("EDIT");

        // ---- The pane's close: the Save sheet in the body, Cancel keeps the card ----
        // The pane's chrome is drawn in the card's own page, and its close button is pressed there.
        await text.nativeClickAtElement(`[data-testid="tug-pane-close-button"]`);
        const asked = await settleFor(() => text.evalJS<boolean>(present(SHEET_CANCEL)), (v) => v, SETTLE_MS);
        expect(asked, "the pane's close puts the Save sheet up in the Text body").toBe(true);
        await text.nativeClickAtElement(SHEET_CANCEL);
        await pollFor(() => text.evalJS<boolean>(present(SHEET_CANCEL)), (v) => !v, SETTLE_MS);
        await Bun.sleep(300);
        expect(await app.evalJS<string[]>(CARD_IDS), "Cancel keeps the card").toContain(X);
        expect(readFileSync(file, "utf8"), "and writes nothing").toBe(ORIGINAL);

        // ---- A workspace delete from a Cards body: fronted, asked, Cancel keeps it ----
        const home = await app.evalJS<string>("window.tugdeck.diag.getSpaces().activeSpaceId");
        await app.evalJS<string>(`window.tugdeck.lab.createSpace("Away")`);
        await pollFor(() => app.evalJS<string>("window.tugdeck.diag.getSpaces().activeSpaceId"), (id) => id !== home, SETTLE_MS);
        const shown = await settleFor(
          () => app.bodies(),
          (bodies) => bodies.some((b) => b.componentId === "cards" && b.state === "ready" && b.visible),
          SETTLE_MS,
        );
        const awayCards: BodyApp = app.body(shown.find((b) => b.componentId === "cards" && b.state === "ready" && b.visible)!.cardId!);
        await app.dispatchControlAction("delete-space", { spaceId: home });
        await pollFor(() => awayCards.evalJS<boolean>(present(CONFIRM_OK)), (v) => v, SETTLE_MS);
        await awayCards.nativeClickAtElement(CONFIRM_OK);
        const askedAgain = await settleFor(() => text.evalJS<boolean>(present(SHEET_CANCEL)), (v) => v, 15_000);
        expect(askedAgain, "the confirmed delete asks in the Text body").toBe(true);
        expect(await app.evalJS<string>("window.tugdeck.diag.getSpaces().activeSpaceId"), "with its workspace fronted").toBe(home);
        await text.nativeClickAtElement(SHEET_CANCEL);
        await Bun.sleep(500);
        const after = await app.evalJS<{ activeSpaceId: string; spaces: { id: string }[] }>("window.tugdeck.diag.getSpaces()");
        note(`after the cancelled delete: ${JSON.stringify(after)}`);
        expect(after.spaces.map((s) => s.id), "Cancel keeps the workspace").toContain(home);
        expect(await app.evalJS<string[]>(CARD_IDS), "and the card").toContain(X);
        expect(readFileSync(file, "utf8"), "and writes nothing").toBe(ORIGINAL);
      } finally {
        await app.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
