/**
 * kind-documents.test.ts — the Text, file-view, Diff and Commit cards are
 * bodies, and everything each is for works in its body.
 *
 * One deck holds one card of each kind in a four-up flow, over real data
 * reached the production way — a text file and a picture on disk, and this
 * checkout's own pinned one-file commit read through git — beside a Cards rail, which
 * reads every card's identity from the shell:
 *
 * - **Text** — the file's text is in its body; typing there makes the buffer
 *   unsaved, which the Cards rail's row says with its dot (a fact only the
 *   Text card's own page knows, relayed through the shell); ⌘S writes the
 *   file and the dot goes. Its pane's Reveal button stands enabled in the
 *   shell's title bar, answered by the body's chain.
 * - **File view** — the picture decodes at its natural size in its body;
 *   the gear in the shell's title bar opens the image settings sheet in the
 *   body, and Escape closes it.
 * - **Diff** — the commit's files are its body's sections; a click on a
 *   section's trigger folds it.
 * - **Commit** — the shell's pane wears the commit's own subject in its
 *   masthead; a click on a path in the body's roster opens that file in a
 *   new card on the shell's deck, and a second click goes back to that card.
 * - **Each** body paints the content pane's surface, read off the composite,
 *   and asked the deck for nothing only the shell answers.
 *
 * @foreground
 * @covers tugdeck/src/components/tugways/cards/text-card-registration.tsx
 * @covers tugdeck/src/components/tugways/cards/file-view-card-registration.tsx
 * @covers tugdeck/src/components/tugways/cards/diff-card.tsx
 * @covers tugdeck/src/components/tugways/cards/commit-card.tsx
 * @covers tugdeck/src/body/body-publisher.ts
 * @covers tugdeck/src/lib/card-identity.ts
 * @covers tugdeck/src/lib/pane-title-bar-items-store.ts
 * @covers tugdeck/src/lib/open-file-in-card.ts
 */

import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import { paneOf, pollFor } from "./_bodies";
import { expectContentSurface, expectNoShellReads, standUpKind } from "./_kind-bodies";
import { cardKind, kindPane, kindSidebars } from "./_kinds";

const TEST_NAME = "body-grounding-kind-documents";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const READ_MS = 15_000;

/** The checkout the run reads its commit from. */
const REPO = resolve(import.meta.dir, "..", "..", "..");
const PICTURE = join(REPO, "resources", "AppIcon-1024b.png");

const T = "kd-text";
const F = "kd-file";
const D = "kd-diff";
const C = "kd-commit";
const R = "kd-cards";

const TEXT_EDITOR = '[data-slot="tug-text-card-editor"] .cm-content';
const IMAGE = '[data-slot="file-view-card"] img.tugx-image-img';
const IMAGE_SHEET = '[data-testid="image-card-settings"]';
const DIFF_FILE = '[data-testid="diff-file"]';
const DIFF_LABEL = ".tug-diff-document-header-label";
const ROSTER_PATH = '[data-slot="tug-changes-list-file-ref"]';
const ROW_TITLE = ".cards-list .cards-row-headline .tug-list-row-title";
const UNSAVED = '[data-testid="cards-card-unsaved"]';
const titleBarItem = (cardId: string, command: string): string =>
  `${paneOf(cardId)} [data-testid="tug-pane-title-bar-item-${command}"]`;

const present = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}) !== null`;
const count = (selector: string): string => `document.querySelectorAll(${JSON.stringify(selector)}).length`;
const textOf = (selector: string): string =>
  `(function () { var el = document.querySelector(${JSON.stringify(selector)}); return el === null ? "" : el.textContent || ""; })()`;

function git(...args: string[]): string {
  return Bun.spawnSync(["git", "-C", REPO, ...args]).stdout.toString().trim();
}

/**
 * The commit the Diff and Commit cards show: a fixed one-file commit, not
 * HEAD. The Diff row's surface share is read over what the card shows, and
 * HEAD's diff grows with whatever was last committed — a nine-file HEAD fills
 * the body with sunken hunk panels and the share falls under its bar.
 */
const PINNED_COMMIT = "b7a4dcaed";

/**
 * Focus `cardId` the deck's way, which brings a card the flow band holds
 * past the window's edge into view, and wait for its body to stand wholly
 * in the window, clear of the rail, before a gesture aims at it.
 */
async function bringIntoView(app: App, cardId: string): Promise<void> {
  await app.dispatchControlAction("focus-session-card", { cardId });
  const inView = await pollFor(
    async () => {
      const frame = (await app.bodies()).find((b) => b.cardId === cardId)?.frame;
      const rail = await app.evalJS<number>(`(function () { var p = document.querySelector(${JSON.stringify(paneOf(R))}); return p === null ? innerWidth : p.getBoundingClientRect().left; })()`);
      return frame !== undefined && frame.x >= 0 && frame.x + frame.width <= rail + 1;
    },
    (v) => v,
    READ_MS,
  );
  expect(inView, `${cardId} stands in view, clear of the rail`).toBe(true);
  await Bun.sleep(400);
}

/**
 * Wait until `selector`'s own centre is the shell's to hit and its box has
 * stopped moving — a title-bar cluster reflows as a body's items arrive, and
 * its neighbours stand where it is about to be — then click it.
 */
async function clickSettled(app: App, selector: string): Promise<void> {
  const read = `(function () {
    var b = document.querySelector(${JSON.stringify(selector)}); if (b === null) return null;
    var r = b.getBoundingClientRect(); var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { key: [r.left, r.top, r.width, r.height].join(","), on: hit !== null && b.contains(hit) };
  })()`;
  let last = "";
  const settled = await pollFor(
    async () => {
      const now = await app.evalJS<{ key: string; on: boolean } | null>(read);
      const steady = now !== null && now.on && now.key === last;
      last = now?.key ?? "";
      await Bun.sleep(100);
      return steady;
    },
    (v) => v,
    READ_MS,
  );
  expect(settled, `${selector} stands still and on top`).toBe(true);
  await app.nativeClickAtElement(selector);
}

function deck(): Record<string, unknown> {
  return {
    cards: [
      { id: T, componentId: "text", title: "Text", closable: true },
      { id: F, componentId: "file-view", title: "File", closable: true },
      { id: D, componentId: "diff", title: "Diff", closable: true },
      { id: C, componentId: "commit", title: "Commit", closable: true },
      { id: R, componentId: "cards", title: "Cards", closable: true },
    ],
    panes: [
      kindPane("text", T, 0),
      kindPane("file-view", F, 1),
      kindPane("diff", D, 2),
      kindPane("commit", C, 3),
      kindPane("cards", R, 0),
    ],
    activePaneId: `${T}-pane`,
    imposition: { kind: "four-up", layout: "flow", sidebars: kindSidebars(["cards"]) },
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)("body-grounding kind checks: Text, file-view, Diff and Commit", () => {
  test(
    "each mounts as a body over its real data, and its own gestures — typing and saving, its title-bar verbs, its sections, its roster — work there",
    async () => {
      const sha = git("rev-parse", PINNED_COMMIT);
      const subject = git("show", "-s", "--format=%s", PINNED_COMMIT);
      const scratch = mkdtempSync(join(tmpdir(), "tug-kind-documents-"));
      const textFile = join(scratch, "notes.md");
      writeFileSync(textFile, "alpha\nbeta\n");
      const picture = join(scratch, "picture.png");
      copyFileSync(PICTURE, picture);
      const app = await launchTugApp({ testName: TEST_NAME, foreground: true, bodies: true });
      try {
        await app.seedDeckState({
          state: deck(),
          cardStates: {
            [T]: { content: { path: textFile, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
            [F]: { content: { path: picture } },
            [D]: { content: { descriptor: { kind: "commit", root: REPO, sha } } },
            [C]: { content: { target: { root: REPO, sha: sha.slice(0, 8) } } },
          },
          focusCardId: T,
        });
        const text = await standUpKind(app, cardKind("text"), T);
        const file = await standUpKind(app, cardKind("file-view"), F);
        const diff = await standUpKind(app, cardKind("diff"), D);
        const commit = await standUpKind(app, cardKind("commit"), C);
        const cards = await standUpKind(app, cardKind("cards"), R);

        // ── Text: its file, an edit the Cards rail sees, ⌘S to disk ─────
        const loaded = await pollFor(() => text.evalJS<string>(textOf(TEXT_EDITOR)), (t) => t.includes("alpha"), READ_MS);
        expect(loaded, "the Text body shows the file's text").toContain("beta");
        const listed = await pollFor(
          () => cards.evalJS<string[]>(`Array.from(document.querySelectorAll(${JSON.stringify(ROW_TITLE)})).map(function (el) { return el.textContent || ""; })`),
          (rows) => rows.some((r) => r.includes("notes.md")),
          READ_MS,
        );
        note(`cards rail rows: ${JSON.stringify(listed)}`);
        expect(listed.some((r) => r.includes("notes.md")), "the Cards rail names the Text card by its file").toBe(true);
        const reveal = await pollFor(
          () => app.evalJS<boolean | null>(`(function () { var b = document.querySelector(${JSON.stringify(titleBarItem(T, "reveal-card-file"))}); return b === null ? null : !b.disabled; })()`),
          (v) => v === true,
          READ_MS,
        );
        expect(reveal, "the Text card's Reveal button stands enabled in the shell's title bar").toBe(true);
        await text.nativeClickAtElement(TEXT_EDITOR);
        await app.nativeType("EDIT ");
        const edited = await pollFor(() => text.evalJS<string>(textOf(TEXT_EDITOR)), (t) => t.includes("EDIT"), READ_MS);
        expect(edited, "typing lands in the Text body").toContain("EDIT");
        const dirty = await pollFor(() => cards.evalJS<number>(count(UNSAVED)), (n) => n === 1, READ_MS);
        expect(dirty, "the Cards rail marks the Text card unsaved").toBe(1);
        expect(readFileSync(textFile, "utf8"), "the edit is in the buffer only").toBe("alpha\nbeta\n");
        await app.nativeKey("s", ["cmd"]);
        const saved = await pollFor(() => Promise.resolve(readFileSync(textFile, "utf8")), (t) => t.includes("EDIT"), READ_MS);
        expect(saved, "⌘S wrote the buffer to the file").toContain("EDIT");
        const clean = await pollFor(() => cards.evalJS<number>(count(UNSAVED)), (n) => n === 0, READ_MS);
        expect(clean, "and the Cards rail's dot is gone").toBe(0);

        // ── File view: the picture, and the gear's sheet in the body ─────
        await bringIntoView(app, F);
        const natural = await pollFor(
          () => file.evalJS<number>(`(function () { var i = document.querySelector(${JSON.stringify(IMAGE)}); return i === null ? 0 : i.naturalWidth; })()`),
          (w) => w > 0,
          READ_MS,
        );
        expect(natural, "the file-view body decodes the picture at its natural size").toBe(1024);
        const gear = titleBarItem(F, "show-card-settings");
        const gearUp = await pollFor(
          () => app.evalJS<boolean>(`(function () { var b = document.querySelector(${JSON.stringify(gear)}); return b !== null && !b.disabled; })()`),
          (v) => v,
          READ_MS,
        );
        expect(gearUp, "the gear stands enabled in the shell's title bar, answered by the body's chain").toBe(true);
        // The gear rests inside the pane's rollup, revealed on a title-bar
        // hover and unhittable until then. Pin the row open first (at0416).
        await app.revealPaneControls(paneOf(F));
        await clickSettled(app, gear);
        const sheet = await pollFor(() => file.evalJS<boolean>(present(IMAGE_SHEET)), (v) => v, READ_MS);
        expect(sheet, "the gear in the shell's title bar opens the image settings sheet in the body").toBe(true);
        await app.nativeKey("Escape");
        const gone = await pollFor(() => file.evalJS<boolean>(present(IMAGE_SHEET)), (v) => !v, READ_MS);
        expect(gone, "Escape closes it").toBe(false);

        // ── Diff: the commit's files, and a section folds ────────────────
        await bringIntoView(app, D);
        const files = await pollFor(() => diff.evalJS<number>(count(DIFF_FILE)), (n) => n > 0, READ_MS);
        expect(files, "the Diff body lists the commit's files").toBeGreaterThan(0);
        expect(await diff.evalJS<string>(textOf(DIFF_LABEL)), "under the commit's label").toContain(sha.slice(0, 9));
        const state = `(document.querySelector(${JSON.stringify(DIFF_FILE)}) || { getAttribute: function () { return null; } }).getAttribute("data-state")`;
        const before = await diff.evalJS<string | null>(state);
        await diff.nativeClickAtElement(`${DIFF_FILE} .tug-accordion-trigger`);
        const after = await pollFor(() => diff.evalJS<string | null>(state), (s) => s !== before, READ_MS);
        note(`diff: first section ${before} → ${after}`);
        expect(after, "a click on a section's trigger toggles it").not.toBe(before);

        // ── Commit: the shell's masthead, and the roster opens a file ────
        await bringIntoView(app, C);
        const masthead = await pollFor(
          () => app.evalJS<string>(textOf(`${paneOf(C)} [data-testid="commit-masthead-subject"]`)),
          (t) => t.trim().length > 0,
          READ_MS,
        );
        expect(masthead.trim(), "the shell's pane wears the commit's subject").toBe(subject);
        await pollFor(() => commit.evalJS<boolean>(present(ROSTER_PATH)), (v) => v, READ_MS);
        const textCards = "window.tugdeck.diag.getDeckState().cards.filter(function (c) { return c.componentId === \"text\"; }).length";
        await commit.nativeClickAtElement(ROSTER_PATH);
        const opened = await pollFor(() => app.evalJS<number>(textCards), (n) => n === 2, READ_MS);
        expect(opened, "a roster path opens its file in a new card on the shell's deck").toBe(2);
        // The card it opened is a body; the same path again goes to it, found
        // by the path its page published, rather than to a second card.
        const opener = (await app.evalJS<string[]>("window.tugdeck.diag.getDeckState().cards.filter(function (c) { return c.componentId === \"text\"; }).map(function (c) { return c.id; })")).find((id) => id !== T)!;
        await standUpKind(app, cardKind("text"), opener);
        await Bun.sleep(1_000);
        await commit.nativeClickAtElement(ROSTER_PATH);
        await Bun.sleep(1_500);
        expect(await app.evalJS<number>(textCards), "opening the same file again reuses its body card").toBe(2);

        // ── Surfaces and shell reads ─────────────────────────────────────
        // The Text card paints its editing well, in the shell as in its body.
        const WELL = "--tug7-surface-card-primary-normal-well-rest";
        for (const [id, share, token] of [[T, 0.5, WELL], [F, 0.2, undefined], [D, 0.3, undefined], [C, 0.3, undefined]] as const) {
          await bringIntoView(app, id);
          await expectContentSurface(app, id, share, token);
        }
        for (const id of [T, F, D, C]) await expectNoShellReads(app, id);
      } finally {
        await app.close();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
