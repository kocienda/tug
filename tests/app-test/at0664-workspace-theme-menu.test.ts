/**
 * at0664-workspace-theme-menu.test.ts — the Theme menu acts on the current
 * workspace, and Apply To All Workspaces does what it says.
 *
 * A theme is a property of the workspace, so the menu's verbs have a scope
 * to keep: choosing a theme, or stepping to the next one, changes the
 * workspace on screen and no other. The one verb that crosses that line is
 * the last item in View ▸ Theme, and it is enabled only while crossing it
 * would change something.
 *
 *   1. Two workspaces are seeded in different themes. The native Apply To
 *      All Workspaces item validates ENABLED, and the Theme submenu's
 *      checkmark sits on the current workspace's theme.
 *   2. `set-theme` — the wire the Theme submenu sends — changes the current
 *      workspace's record and the screen, and leaves the parked workspace's
 *      record alone. The checkmark follows.
 *   3. `apply-theme-to-all-workspaces` — the wire the new item sends — puts
 *      the current theme on every workspace's record, changes nothing on
 *      screen, and the item validates DISABLED: every workspace already
 *      wears the theme.
 *   4. Switching to the other workspace shows the applied theme.
 *   5. `next-theme` there moves that workspace alone, and the item is
 *      enabled again.
 *
 * The menu item is read through `menuItemState`, the validated state AppKit
 * computes at open time, so the enablement asserted is the one a user sees.
 *
 * @covers tugdeck/src/spaces.ts
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugdeck/src/contexts/theme-provider.tsx
 * @covers tugdeck/src/lib/host-menu-state.ts
 * @covers tugapp/Sources/AppDelegate.swift
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SPACE_ONE = "11111111-1111-4111-8111-111111111111";
const SPACE_TWO = "22222222-2222-4222-8222-222222222222";
const THEME_ONE = "caravel";
const THEME_TWO = "sloop";
/** The theme chosen from the menu in workspace one. */
const THEME_PICKED = "ketch";
/** What `next-theme` steps to from {@link THEME_PICKED}. */
const THEME_AFTER_PICKED = "skiff";

const APPLY_ITEM = "view.applyThemeToAllWorkspaces";

type App = Awaited<ReturnType<typeof launchTugApp>>;

function canvasColorOf(theme: string): string {
  const css = readFileSync(
    resolve(import.meta.dir, "..", "..", "tugdeck", "styles", "themes", `${theme}.css`),
    "utf8",
  );
  const match = css.match(/--tugx-host-canvas-color:\s*(#[0-9a-fA-F]{6})/);
  if (match === null) throw new Error(`no canvas color in ${theme}.css`);
  return match[1].toLowerCase();
}

function deckWith(cardId: string) {
  return {
    cards: [{ id: cardId, componentId: "text", title: "File", closable: true }],
    panes: [
      {
        id: `p-${cardId}`,
        position: { x: 40, y: 40 },
        size: { width: 720, height: 520 },
        cardIds: [cardId],
        activeCardId: cardId,
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: `p-${cardId}`,
    imposition: { kind: "one-up", sidebars: {} },
  };
}

const BLOB = {
  version: 5,
  activeSpaceId: SPACE_ONE,
  spaces: [
    { id: SPACE_ONE, name: "One", theme: THEME_ONE, deck: deckWith("A") },
    { id: SPACE_TWO, name: "Two", theme: THEME_TWO, deck: deckWith("B") },
  ],
};

const SCREEN_CANVAS = `getComputedStyle(document.body).getPropertyValue("--tugx-host-canvas-color").trim().toLowerCase()`;

/** Each workspace's recorded theme, in the list's order. */
async function recordedThemes(app: App): Promise<(string | undefined)[]> {
  return app.evalJS<(string | undefined)[]>(
    `window.tugdeck.diag.getSpaces().spaces.map(function (s) { return s.theme; })`,
  );
}

async function waitScreenTheme(app: App, theme: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `${SCREEN_CANVAS} === ${JSON.stringify(canvasColorOf(theme))}`,
    { timeoutMs: 10_000 },
  );
}

/** Poll the validated menu-item state until `enabled` matches. */
async function waitMenuEnabled(
  app: App,
  identifier: string,
  wantEnabled: boolean,
  timeoutMs = 8000,
): Promise<{ found: boolean; enabled?: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let last: { found: boolean; enabled?: boolean } = { found: false };
  while (Date.now() < deadline) {
    last = await app.menuItemState(identifier);
    if (last.found && last.enabled === wantEnabled) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

/** Poll until the Theme submenu's checkmark sits on `theme`. */
async function waitThemeChecked(
  app: App,
  theme: string,
  timeoutMs = 8000,
): Promise<{ found: boolean; state?: number }> {
  const deadline = Date.now() + timeoutMs;
  let last: { found: boolean; state?: number } = { found: false };
  while (Date.now() < deadline) {
    last = await app.menuItemState(`view.theme.${theme}`);
    if (last.found && last.state === 1) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

function dispatch(action: string, payload: Record<string, unknown> = {}): string {
  return `(window.tugdeck.lab.dispatch(${JSON.stringify(action)}, ${JSON.stringify(payload)}), null)`;
}

describe.skipIf(!SHOULD_RUN)("at0664 — the Theme menu acts on the current workspace", () => {
  test(
    "a pick moves one workspace, Apply To All Workspaces moves the rest, and the item is enabled only when it would change something",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(BLOB),
        );
        const app = await launchTugApp({
          testName: "at0664-workspace-theme-menu",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `typeof window.tugdeck !== "undefined" && typeof window.tugdeck.diag.getSpaces === "function" && window.tugdeck.diag.getSpaces().spaces.length === 2`,
            { timeoutMs: 10_000 },
          );

          // (1) Two themes stand, so there is something to apply.
          await waitScreenTheme(app, THEME_ONE);
          expect(await recordedThemes(app)).toEqual([THEME_ONE, THEME_TWO]);
          expect(await waitMenuEnabled(app, APPLY_ITEM, true)).toMatchObject({
            found: true,
            enabled: true,
          });
          expect(await waitThemeChecked(app, THEME_ONE)).toMatchObject({
            found: true,
            state: 1,
          });

          // (2) A pick is the current workspace's alone.
          await app.evalJS<null>(dispatch("set-theme", { theme: THEME_PICKED }));
          await waitScreenTheme(app, THEME_PICKED);
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().spaces[0].theme === ${JSON.stringify(THEME_PICKED)}`,
            { timeoutMs: 8_000 },
          );
          expect(await recordedThemes(app)).toEqual([THEME_PICKED, THEME_TWO]);
          expect(await waitThemeChecked(app, THEME_PICKED)).toMatchObject({
            found: true,
            state: 1,
          });
          expect(await app.menuItemState(`view.theme.${THEME_ONE}`)).toMatchObject({
            found: true,
            state: 0,
          });

          // (3) Apply To All Workspaces: every record, nothing on screen, and
          // then nothing left for it to do.
          await app.evalJS<null>(dispatch("apply-theme-to-all-workspaces"));
          expect(await recordedThemes(app)).toEqual([THEME_PICKED, THEME_PICKED]);
          expect(await app.evalJS<string>(SCREEN_CANVAS)).toBe(
            canvasColorOf(THEME_PICKED),
          );
          expect(await waitMenuEnabled(app, APPLY_ITEM, false)).toMatchObject({
            found: true,
            enabled: false,
          });

          // (4) The other workspace is shown in the applied theme.
          await app.evalJS<null>(dispatch("activate-space", { spaceId: SPACE_TWO }));
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().activeSpaceId === ${JSON.stringify(SPACE_TWO)}`,
            { timeoutMs: 8_000 },
          );
          expect(await app.evalJS<string>(SCREEN_CANVAS)).toBe(
            canvasColorOf(THEME_PICKED),
          );

          // (5) Next Theme here moves this workspace alone, and there is
          // something to apply again.
          await app.evalJS<null>(dispatch("next-theme"));
          await waitScreenTheme(app, THEME_AFTER_PICKED);
          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().spaces[1].theme === ${JSON.stringify(THEME_AFTER_PICKED)}`,
            { timeoutMs: 8_000 },
          );
          expect(await recordedThemes(app)).toEqual([
            THEME_PICKED,
            THEME_AFTER_PICKED,
          ]);
          expect(await waitMenuEnabled(app, APPLY_ITEM, true)).toMatchObject({
            found: true,
            enabled: true,
          });
          expect(await waitThemeChecked(app, THEME_AFTER_PICKED)).toMatchObject({
            found: true,
            state: 1,
          });

          await app.quitGracefully();
        } catch (e) {
          await app.close().catch(() => undefined);
          throw e;
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
