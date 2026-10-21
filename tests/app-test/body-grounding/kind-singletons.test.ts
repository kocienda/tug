/**
 * kind-singletons.test.ts — the devtools card, the three app-menu singletons
 * (Settings, Keyboard Shortcuts, About) and the Hello card are bodies, and
 * everything each is for works in its body.
 *
 * One body Session card, then each kind opened the user's way — the app
 * menu's item performed, the devtools chord, the Maker menu's `show-card` —
 * and read in its body before the next opens:
 *
 * - **Settings** — opens on General over its stored values, reached the
 *   production way (a seeded tugbank); a section click switches the panel in
 *   the body; a control pressed there writes tugbank, which the shell reads;
 *   a second open raises the one card and makes no second body; and a
 *   reveal dispatched in the shell lands the body on the named section.
 * - **Keyboard Shortcuts** — lists the keymap in its body; its filter field
 *   takes typing and narrows the rows.
 * - **About** — shows the host's build identity, which only the shell
 *   hears, relayed in the body's context; the shell's tab wears the title
 *   the body published.
 * - **Hello** — mounts and shows its line.
 * - **Devtools** — follows the Session card focused before it: its Telemetry
 *   tab shows that session's id and phase, relayed from the Session body,
 *   which publishes only while followed; its Log tab shows an entry the
 *   shell logged. Closing the card stops the relay.
 * - **Each** body paints the content pane's surface, read off the composite,
 *   and asked the deck for nothing only the shell answers.
 *
 * @foreground activation
 * @covers tugdeck/src/components/devtools/devtools-card.tsx
 * @covers tugdeck/src/components/devtools/telemetry-inspector.tsx
 * @covers tugdeck/src/components/tugways/cards/settings-card.tsx
 * @covers tugdeck/src/components/tugways/cards/keyboard-card.tsx
 * @covers tugdeck/src/components/tugways/cards/about-card.tsx
 * @covers tugdeck/src/components/tugways/cards/hello-world-card.tsx
 * @covers tugdeck/src/lib/telemetry-inspection-store.ts
 * @covers tugdeck/src/body/body-inspection.ts
 * @covers tugdeck/src/lib/settings-reveal.ts
 * @covers tugdeck/src/lib/app-info-store.ts
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/body/body-main.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App, type BodyApp } from "../_harness";
import { bodyOfKind } from "../_harness/card-reach";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankRead, tugbankWrite } from "../_harness/tugbank-helpers";
import { STUB_TRANSCRIPT_DIR_ENV, streamingTranscript, stubDirectory } from "../streaming-stub-fixture";
import { focusBody, pollFor, sessionPane, waitForBody } from "./_bodies";
import { expectContentSurface } from "./_kind-bodies";
import { cardKind } from "./_kinds";

const TEST_NAME = "body-grounding-kind-singletons";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;
const READ_MS = 15_000;

const A = "ks-a";
const SID = "a7c0d1ea-0000-4000-8000-0000000007b2";

const EDITOR_DOMAIN = "dev.tugapp.editor";
const EDITOR_KEY = "settings";
const APP_DOMAIN = "dev.tugapp.app";
const PROJECT_DIR_KEY = "default-project-path";

const SETTINGS_SECTION = '[data-testid="settings-card"] [data-testid^="settings-section-"]';
const SECTION_TAB = (id: string): string => `[data-testid="tug-tab-view-tab-${id}"]`;
const PROJECT_DIR_INPUT = '[data-testid="settings-default-project-dir-field"] input';
const SOFT_TABS = '[data-testid="prompt-editor-option-soft-tabs"]';
const KEYMAP_ROW_TITLE = ".settings-keymap-row-title";
const KEYMAP_FILTER_INPUT = '[data-testid="settings-keymap-filter"] input';
const ABOUT_VERSION = '[data-testid="about-card-version"]';
const HELLO_TITLE = '[data-testid="hello-world-card-title"]';
const DEVTOOLS_TAB = (id: string): string => `[data-testid="tug-tab-${id}"]`;
const FIELD_ROWS = ".tug-devpanel-field-row";
const LOG_MESSAGES = ".tug-devlog-row-message";
const LOG_SOURCES = ".tug-devlog-row-source";

const present = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}) !== null`;
const count = (selector: string): string => `document.querySelectorAll(${JSON.stringify(selector)}).length`;
const textOf = (selector: string): string =>
  `(function () { var el = document.querySelector(${JSON.stringify(selector)}); return el === null ? "" : el.textContent || ""; })()`;
const textsOf = (selector: string): string =>
  `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(function (el) { return el.textContent || ""; })`;
const valueOf = (selector: string): string =>
  `(function () { var el = document.querySelector(${JSON.stringify(selector)}); return el === null ? null : el.value; })()`;
/** The section id the Settings card shows: only the selected panel exists. */
const showingSection = `(function () {
  var el = document.querySelector(${JSON.stringify(SETTINGS_SECTION)});
  return el === null ? null : el.getAttribute("data-testid").replace("settings-section-", "");
})()`;
/** The inspector's rows as label → value. */
const inspectorRows = `(function () {
  var rows = {};
  document.querySelectorAll(${JSON.stringify(FIELD_ROWS)}).forEach(function (row) {
    var label = row.querySelector(".tug-devpanel-field-label-text");
    var value = row.querySelector(".tug-devpanel-field-value-text, .tug-devpanel-field-value-pre");
    if (label !== null && value !== null) rows[label.textContent || ""] = value.textContent || "";
  });
  return rows;
})()`;
const cardsOfKind = (kind: string): string =>
  `window.tugdeck.diag.getDeckState().cards.filter(function (c) { return c.componentId === ${JSON.stringify(kind)}; }).map(function (c) { return c.id; })`;
const paneHolding = (cardId: string): string =>
  `(function () { var p = window.tugdeck.diag.getDeckState().panes.find(function (p) { return p.cardIds.indexOf(${JSON.stringify(cardId)}) !== -1; }); return p ? p.id : null; })()`;

/** Close `cardId`'s pane the shell's way, and wait until no body holds the card. */
async function closeCard(app: App, cardId: string): Promise<void> {
  const paneId = await app.evalJS<string | null>(paneHolding(cardId));
  expect(paneId, `${cardId} stands in a pane`).not.toBeNull();
  await app.evalJS<null>(`(window.__tug.closePane(${JSON.stringify(paneId)}), null)`);
  const gone = await pollFor(() => app.bodies(), (bs) => bs.every((b) => b.cardId !== cardId), READ_MS);
  expect(gone.some((b) => b.cardId === cardId), `${cardId}'s body is gone with its card`).toBe(false);
}

/**
 * Stand up the one card of `kind` the shell just opened: its body ready and
 * mounted, and the card brought into view — a flow slot past the window's
 * edge holds a body no click can reach — and placed visible.
 */
async function openedKind(app: App, kind: string): Promise<{ body: BodyApp; cardId: string }> {
  const body = await bodyOfKind(app, kind);
  const root = JSON.stringify(cardKind(kind).root);
  const up = await pollFor(() => body.evalJS<boolean>(`document.querySelector(${root}) !== null`), (v) => v, READ_MS);
  expect(up, `${kind}: its root is mounted in its body`).toBe(true);
  // card-dom: shell
  expect(await app.evalJS<boolean>(`document.querySelector(${root}) !== null`), `${kind}: the shell's document holds none of it`).toBe(false);
  const ids = await app.evalJS<string[]>(cardsOfKind(kind));
  expect(ids.length, `${kind}: one card on the deck`).toBe(1);
  const cardId = ids[0];
  await app.dispatchControlAction("focus-session-card", { cardId });
  const width = await app.evalJS<number>("innerWidth");
  const inView = await pollFor(
    () => app.bodies(),
    (bs) => {
      const b = bs.find((x) => x.cardId === cardId);
      return b !== undefined && b.visible && b.frame.x >= 0 && b.frame.x + b.frame.width <= width + 1;
    },
    READ_MS,
  );
  const placed = inView.find((x) => x.cardId === cardId);
  note(`${kind} ${cardId}: body ${JSON.stringify(placed?.frame)} visible=${placed?.visible} in a ${width}-wide window`);
  expect(placed?.visible, `${kind}: its body stands visible in the window`).toBe(true);
  await Bun.sleep(400);
  return { body, cardId };
}

describe.skipIf(!SHOULD_RUN)("body-grounding kind checks: devtools, Settings, Keyboard Shortcuts, About and Hello", () => {
  test(
    "each opens the user's way as a body over its real data, and its own gestures and relays work there",
    async () => {
      const stubDir = stubDirectory();
      writeFileSync(join(stubDir, `${SID}.json`), JSON.stringify(streamingTranscript(2, 1)));
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-kind-singletons-")));
      tugbankWrite(tugbankPath, APP_DOMAIN, PROJECT_DIR_KEY, "string", projectDir);
      tugbankWrite(tugbankPath, EDITOR_DOMAIN, EDITOR_KEY, "json", JSON.stringify({ softTabs: true }));
      const app = await launchTugApp({
        testName: TEST_NAME,
        foreground: true,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir, TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.seedDeckState({
          state: {
            cards: [{ id: A, componentId: "session", title: "A", closable: true }],
            panes: [sessionPane(A, 0)],
            activePaneId: `${A}-pane`,
            hasFocus: true,
          },
          focusCardId: A,
        });
        await app.spawnSessionNew(A, { tugSessionId: SID, projectDir });
        await waitForBody(app, A);
        const a = app.body(A);

        // ── Settings: its stored values, a section click, a write the shell reads ──
        await app.performMenuItem("app.settings");
        const settings = await openedKind(app, "settings");
        const section = await pollFor(() => settings.body.evalJS<string | null>(showingSection), (s) => s === "general", READ_MS);
        expect(section, "Settings opens on General in its body").toBe("general");
        const stored = await pollFor(() => settings.body.evalJS<string | null>(valueOf(PROJECT_DIR_INPUT)), (v) => v === projectDir, READ_MS);
        expect(stored, "the General panel shows the stored default project directory, read from tugbank").toBe(projectDir);
        await settings.body.nativeClickAtElement(SECTION_TAB("sessionCard"));
        const sessions = await pollFor(() => settings.body.evalJS<string | null>(showingSection), (s) => s === "sessionCard", READ_MS);
        expect(sessions, "a sidebar click in the body switches the panel").toBe("sessionCard");
        await pollFor(() => settings.body.evalJS<boolean>(present(SOFT_TABS)), (v) => v, READ_MS);
        await settings.body.nativeClickAtElement(SOFT_TABS);
        const written = await pollFor(
          () => Promise.resolve(tugbankRead<{ softTabs?: boolean }>(tugbankPath, EDITOR_DOMAIN, EDITOR_KEY)?.value?.softTabs ?? null),
          (v) => v === false,
          READ_MS,
        );
        expect(written, "the Soft Tabs press in the Settings body wrote tugbank").toBe(false);
        const shellSees = await pollFor(
          // card-dom: shell
          () => app.evalJS<{ softTabs?: boolean } | null>(`(function () { var v = window.__tug.getTugbankValue(${JSON.stringify(EDITOR_DOMAIN)}, ${JSON.stringify(EDITOR_KEY)}); return v === null ? null : v.value; })()`),
          (v) => v?.softTabs === false,
          READ_MS,
        );
        note(`editor settings after the press: tugbank ${JSON.stringify(written)}, shell ${JSON.stringify(shellSees)}`);
        expect(shellSees?.softTabs, "and the shell reads the write").toBe(false);
        // A second open raises the one card: no second card, no second body.
        await app.performMenuItem("app.settings");
        await Bun.sleep(1_000);
        // card-dom: shell
        expect((await app.evalJS<string[]>(cardsOfKind("settings"))).length, "Settings opened twice is one card").toBe(1);
        expect((await app.bodies()).filter((b) => b.componentId === "settings").length, "and one body").toBe(1);
        // A reveal dispatched in the shell lands the body on the section it names.
        await app.dispatchControlAction("reveal-settings", { section: "viewerCard" });
        const revealed = await pollFor(() => settings.body.evalJS<string | null>(showingSection), (s) => s === "viewerCard", READ_MS);
        expect(revealed, "reveal-settings shows the named section in the Settings body").toBe("viewerCard");
        await expectContentSurface(app, settings.cardId, 0.15);
        await closeCard(app, settings.cardId);

        // ── Keyboard Shortcuts: the keymap, and its filter ───────────────
        await app.performMenuItem("app.keyboardShortcuts");
        const keyboard = await openedKind(app, "keyboard");
        const rows = await pollFor(() => keyboard.body.evalJS<number>(count(KEYMAP_ROW_TITLE)), (n) => n > 0, READ_MS);
        expect(rows, "the Keyboard Shortcuts body lists the keymap").toBeGreaterThan(0);
        await keyboard.body.nativeClickAtElement(KEYMAP_FILTER_INPUT);
        await app.nativeType("zoom");
        const narrowed = await pollFor(() => keyboard.body.evalJS<string[]>(textsOf(KEYMAP_ROW_TITLE)), (titles) => titles.length > 0 && titles.length < rows, READ_MS);
        note(`keymap rows: ${rows} before the filter, ${narrowed.length} after: ${JSON.stringify(narrowed)}`);
        expect(narrowed.length, "typing in the filter narrows the rows").toBeLessThan(rows);
        expect(narrowed, "to the ones it names").toContain("Zoom In");
        expect(narrowed, "to the ones it names").toContain("Zoom Out");
        await expectContentSurface(app, keyboard.cardId, 0.15);
        await closeCard(app, keyboard.cardId);

        // ── About: the host's identity, relayed through the shell ─────────
        await app.performMenuItem("app.about");
        const about = await openedKind(app, "about");
        const version = await pollFor(() => about.body.evalJS<string>(textOf(ABOUT_VERSION)), (t) => /Version \d/.test(t), READ_MS);
        note(`About body: ${version.trim()}`);
        expect(version, "the About body shows the host's version and build").toMatch(/^Version \d[^(]*\(\d+\)$/);
        const paneTitle = await pollFor(
          () => about.body.evalJS<string>(textOf('[data-testid="tug-pane-title"]')),
          (t) => t.includes("About"),
          READ_MS,
        );
        expect(paneTitle, "the card's own title bar wears the title the About body published").toContain("About");
        await expectContentSurface(app, about.cardId, 0.3);
        await closeCard(app, about.cardId);

        // ── Hello ────────────────────────────────────────────────────────
        await app.dispatchControlAction("show-card", { component: "hello" });
        const hello = await openedKind(app, "hello");
        expect((await hello.body.evalJS<string>(textOf(HELLO_TITLE))).trim(), "the Hello body shows its line").toBe("Hello, World!");
        await expectContentSurface(app, hello.cardId, 0.5);
        await closeCard(app, hello.cardId);

        // ── Devtools: follows the Session body; the inspection and the log relays ──
        await focusBody(app, A, { composer: false });
        await app.nativeKey("/", ["alt", "cmd"]);
        const devtools = await openedKind(app, "devtools");
        await devtools.body.nativeClickAtElement(DEVTOOLS_TAB("telemetry"));
        const inspector = await pollFor(() => devtools.body.evalJS<Record<string, string>>(inspectorRows), (r) => r["Tug session id"] === SID, READ_MS);
        note(`devtools telemetry: ${JSON.stringify(inspector)}`);
        expect(inspector["Tug session id"], "the Telemetry tab shows the followed Session body's session id").toBe(SID);
        expect(inspector["Phase"], "and its phase").toBeTruthy();
        expect(await a.evalJS<boolean>("window.tugdeck.diag.inspecting()"), "the Session body publishes its inspection while followed").toBe(true);
        // card-dom: shell
        await app.evalJS<null>(`(window.tugDevLog.info("kind-check", "hello from the shell"), null)`);
        await devtools.body.nativeClickAtElement(DEVTOOLS_TAB("log"));
        const logged = await pollFor(
          () => devtools.body.evalJS<string[]>(textsOf(LOG_MESSAGES)),
          (messages) => messages.some((m) => m.includes("hello from the shell")),
          READ_MS,
        );
        expect(logged.some((m) => m.includes("hello from the shell")), "the Log tab shows an entry the shell logged").toBe(true);
        const sources = await devtools.body.evalJS<string[]>(textsOf(LOG_SOURCES));
        expect(sources.some((s) => s.includes("shell/kind-check")), "under the shell's name").toBe(true);
        await expectContentSurface(app, devtools.cardId, 0.15);
        await closeCard(app, devtools.cardId);
        const stopped = await pollFor(() => a.evalJS<boolean>("window.tugdeck.diag.inspecting()"), (v) => !v, READ_MS);
        expect(stopped, "closing the devtools card stops the Session body's publishing").toBe(false);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
        rmSync(projectDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
