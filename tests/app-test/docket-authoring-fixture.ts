/**
 * docket-authoring-fixture.ts — what the Docket card's authoring app-tests
 * share: a scratch repository and data root, a launch with a Session card
 * that registers the repository and a Docket card seeded on it, a docket
 * made from the chooser, an idea typed into the field, a gesture pressed on
 * a thread's strip, and the Session card a gesture opens.
 *
 * Everything runs through this checkout's built `tugtool` against the
 * scratch data root, so nothing touches the user's own dockets, ideas or
 * sketches.
 */

import { expect } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  makeArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  type ArcScratchRepo,
} from "./arc-fixture";
import { CHECKOUT } from "./arcs-card-fixture";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 180_000;

export const CHOOSER = '.docket-chooser [data-slot="tug-popup-button"]';
export const CHOOSER_ITEM = (i: number): string =>
  `[data-testid="docket-chooser"] .tug-menu-item[data-item-id="${i}"]`;
export const DIALOG_FIELD = '[data-slot="tug-modal-input-dialog-field"]';
export const EMPTY = '[data-slot="docket-empty"]';
export const FIELD = '[data-testid="docket-filing-field"]';
export const FIELD_CONTENT = `${FIELD} .cm-content`;
export const ROW = '[data-slot="docket-thread-row"]';
export const IDEA_CELL = '[data-slot="docket-idea-cell"]';
export const INBOX_LABEL = '[data-slot="docket-inbox-label"]';
export const EDITOR = '[data-slot="docket-sketch-editor"]';
export const EDITOR_TEXT = '[data-testid="docket-sketch-text"]';
export const EDITOR_SAVE = '[data-testid="docket-sketch-save"]';
export const USER_BODY = '[data-testid="session-card-transcript-user-body"]';

/** A scratch repository, its data root, and the session that registers it. */
export interface AuthoringScratch {
  scratch: ArcScratchRepo;
  sessionDir: string;
  sid: string;
}

/** Make the scratch repository and a transcript for its registering session. */
export function makeAuthoringScratch(prefix: string, sid: string): AuthoringScratch {
  const scratch = makeArcScratchRepo({ prefix, checkout: CHECKOUT });
  // A resume needs a transcript to replay, or the card stays on its picker.
  const sessionDir = seedScratchSession(scratch.repo, sid);
  return { scratch, sessionDir, sid };
}

export function rmAuthoringScratch(s: AuthoringScratch | null): void {
  if (s === null) return;
  rmScratchSession(s.sessionDir);
  rmSync(s.scratch.repo, { recursive: true, force: true });
  rmSync(s.scratch.dataRoot, { recursive: true, force: true });
}

/** This checkout's tugtool, in the scratch repo, against the scratch data. */
export function cli(s: AuthoringScratch, args: string[]): string {
  return tugtool(args, {
    cwd: s.scratch.repo,
    binaryRoot: s.scratch.cli.binaryRoot,
    env: s.scratch.cli.env,
  });
}

/** Session card A beside Docket card D, both wide enough for a gesture strip. */
function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
      { id: "D", componentId: "docket", title: "Docket", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 20, y: 20 },
        size: { width: 620, height: 900 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: "p2",
        position: { x: 660, y: 20 },
        size: { width: 820, height: 600 },
        cardIds: ["D"],
        activeCardId: "D",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p2",
    hasFocus: true,
  };
}

/**
 * Launch the app on the scratch data with A resumed on the scratch repo —
 * which registers it — and D seeded on it, and wait for D to say there are no
 * dockets yet. Returns the app and a closer.
 */
export async function launchAuthoring(
  s: AuthoringScratch,
  testName: string,
): Promise<{ app: App; close: () => Promise<void> }> {
  const tugbankPath = mkTempTugbank();
  seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
  const app = await launchTugApp({
    testName,
    env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: s.scratch.dataRoot },
  });
  const close = async (): Promise<void> => {
    await app.close();
    rmTempTugbank(tugbankPath);
  };
  try {
    await app.seedDeckState({
      state: deckShape(),
      cardStates: { D: { content: { projectDir: s.scratch.repo } } },
      focusCardId: "D",
    });
    await app.waitForCondition<boolean>(
      `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
      { timeoutMs: 30_000 },
    );
    await app.spawnSessionResume("A", { tugSessionId: s.sid, projectDir: s.scratch.repo });
    await app.awaitEngineReady("A", { timeoutMs: 15_000 });
    await app.body("D").waitForCondition<boolean>(
      `document.querySelector(${JSON.stringify(EMPTY)}) !== null
       && (document.querySelector(${JSON.stringify(EMPTY)}).textContent || "").trim() === "No dockets"`,
      { timeoutMs: 20_000 },
    );
  } catch (error) {
    await close();
    throw error;
  }
  return { app, close };
}

/** Bring D's pane forward, so the presses below land on a raised card. */
export async function focusDocket(app: App): Promise<void> {
  await app.dispatchControlAction("focus-pane", { paneId: "p2" });
}

/** Wait until `cardId`'s view is the window's first responder. */
export async function awaitResponder(app: App, cardId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await app.bodies()).some((b) => b.cardId === cardId && b.firstResponder === true)) {
    if (Date.now() > deadline) throw new Error(`${cardId}'s view never became the first responder`);
    await Bun.sleep(50);
  }
}

/**
 * Open the chooser by a real press and wait for its items. A press into a
 * card that is not yet key may only raise it, so a second press follows when
 * the first opened nothing, as a hand would.
 */
async function openChooser(app: App): Promise<void> {
  const open = `document.querySelector(${JSON.stringify(CHOOSER_ITEM(0))}) !== null`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await app.body("D").nativeClickAtElement(CHOOSER);
    try {
      await app.body("D").waitForCondition<boolean>(open, { timeoutMs: 1_500 });
      return;
    } catch {
      // Raised, not opened; press again.
    }
  }
  throw new Error("the docket chooser never opened");
}

/** New Docket… in the chooser, `name` typed into the dialog, Return. */
export async function newDocket(app: App, name: string): Promise<void> {
  await focusDocket(app);
  await openChooser(app);
  const labels = await app.body("D").evalJS<string[]>(
    `Array.from(document.querySelectorAll('[data-testid="docket-chooser"] .tug-menu-item')).map(function (el) { return (el.textContent || "").trim(); })`,
  );
  const index = labels.indexOf("New Docket…");
  expect(index, `the chooser offers New Docket… (it offered ${labels.join(" | ")})`).toBeGreaterThan(-1);
  await app.body("D").nativeClickAtElement(CHOOSER_ITEM(index));
  await app.body("D").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(DIALOG_FIELD)}) !== null`,
    { timeoutMs: 5_000 },
  );
  await app.nativeType(name);
  await app.body("D").waitForCondition<boolean>(
    `(document.querySelector('[data-slot="tug-modal-input-dialog-list"]') || { textContent: "" }).textContent.indexOf(${JSON.stringify(name)}) !== -1`,
    { timeoutMs: 5_000 },
  );
  await app.nativeKey("Return");
  await app.body("D").waitForCondition<boolean>(
    `(document.querySelector(${JSON.stringify(CHOOSER)}).textContent || "").indexOf(${JSON.stringify(name)}) !== -1`,
    { timeoutMs: 10_000 },
  );
}

/** A JS expression for the row whose idea cell reads `text`, or null. */
export function rowFor(text: string): string {
  return `(Array.from(document.querySelectorAll(${JSON.stringify(ROW)})).find(function (r) {
    var c = r.querySelector(${JSON.stringify(IDEA_CELL)});
    return c !== null && (c.textContent || "").trim() === ${JSON.stringify(text)};
  }) || null)`;
}

/** Type `text` into D's field and press Return; wait for its row. */
export async function captureIdea(app: App, text: string): Promise<void> {
  await focusDocket(app);
  await app.body("D").nativeClickAtElement(FIELD);
  await awaitResponder(app, "D");
  await app.nativeType(text);
  await app.nativeKey("Return");
  try {
    await app.body("D").waitForCondition<boolean>(`${rowFor(text)} !== null`, { timeoutMs: 15_000 });
  } catch (error) {
    const seen = await app.body("D").evalJS<string>(
      `JSON.stringify({
        line: (document.querySelector('[data-slot="docket-filing-line"]') || {}).textContent || null,
        field: (document.querySelector(${JSON.stringify(FIELD_CONTENT)}) || {}).textContent || null,
        chooser: (document.querySelector(${JSON.stringify(CHOOSER)}) || {}).textContent || null,
        empty: (document.querySelector(${JSON.stringify(EMPTY)}) || {}).textContent || null,
        rows: Array.from(document.querySelectorAll(${JSON.stringify(ROW)})).map(function (r) { return r.outerHTML.slice(0, 400); }),
      })`,
    );
    note("docket idea capture", seen);
    throw error;
  }
}

/** The id `tugtool idea list` gives the idea whose line is `text`. */
export function ideaId(s: AuthoringScratch, text: string): string {
  const out = JSON.parse(cli(s, ["idea", "list", "--json"])) as {
    data: Array<{ id: string; text: string }>;
  };
  const found = out.data.find((i) => i.text === text);
  if (found === undefined) throw new Error(`no idea reads ${text}: ${JSON.stringify(out.data)}`);
  return found.id;
}

/** The gestures the row whose idea reads `text` offers, in strip order. */
export async function gesturesOn(app: App, text: string): Promise<string[]> {
  return app.body("D").evalJS<string[]>(
    `(function(){ var r = ${rowFor(text)}; return r === null ? [] : Array.from(r.querySelectorAll("[data-gesture]")).map(function (b) { return b.getAttribute("data-gesture"); }); })()`,
  );
}

/** Wait until the row whose idea reads `text` offers `gesture`, then press it. */
export async function pressGesture(app: App, text: string, gesture: string): Promise<void> {
  await focusDocket(app);
  const offered = `(function(){ var r = ${rowFor(text)}; return r !== null && r.querySelector('[data-gesture="${gesture}"]') !== null; })()`;
  try {
    await app.body("D").waitForCondition<boolean>(offered, { timeoutMs: 15_000 });
  } catch (error) {
    note("docket gesture not offered", `${gesture} on ${text}: ${JSON.stringify(await gesturesOn(app, text))}`);
    throw error;
  }
  const mark = `data-authoring-press`;
  await app.body("D").evalJS<null>(
    `(function(){
      document.querySelectorAll("[${mark}]").forEach(function (el) { el.removeAttribute("${mark}"); });
      ${rowFor(text)}.querySelector('[data-gesture="${gesture}"]').setAttribute("${mark}", "1");
      return null;
    })()`,
  );
  await app.body("D").nativeClickAtElement(`[${mark}="1"]`);
}

/** The ids of the deck's Session cards. */
export async function sessionCards(app: App): Promise<string[]> {
  return (await app.bodies())
    .filter((b) => b.componentId === "session" && b.cardId !== null)
    .map((b) => b.cardId as string);
}

/**
 * Wait for a Session card that is not in `known`, and for its first user turn
 * to carry every string in `expected`. Returns the card's id and that turn's
 * text.
 */
export async function awaitOpenedSession(
  app: App,
  known: readonly string[],
  expected: readonly string[],
): Promise<{ cardId: string; turn: string }> {
  const deadline = Date.now() + 5_000;
  let cardId: string | undefined;
  while (cardId === undefined) {
    cardId = (await sessionCards(app)).find((id) => !known.includes(id));
    if (cardId !== undefined) break;
    if (Date.now() > deadline) {
      note("opened session", `no new card; known ${JSON.stringify(known)}, bodies ${JSON.stringify(await app.bodies())}`);
      throw new Error("no new Session card opened");
    }
    await Bun.sleep(50);
  }
  const page = await waitForBodyReady(app, cardId);
  // The transcript sets a typed `--` as an en dash; read it back as typed.
  const first = `(function(){ var r = document.querySelector(${JSON.stringify(USER_BODY)}); return r === null ? "" : (r.textContent || "").replace(/\u2013/g, "--"); })()`;
  const all = expected.map((e) => `t.indexOf(${JSON.stringify(e)}) !== -1`).join(" && ");
  try {
    await page.waitForCondition<boolean>(`(function(){ var t = ${first}; return ${all || "t.length > 0"}; })()`, {
      timeoutMs: 7_000,
    });
  } catch (error) {
    const trace = (await page.getDeckTrace({}))
      .filter((e) => e.kind === "session-lifecycle")
      .map((e) => e.event);
    const text = await page.evalJS<string>(`(document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 600)`);
    note("opened session's first turn", `${cardId}: turn=${JSON.stringify(await page.evalJS<string>(first))} lifecycle=${JSON.stringify(trace)} page=${JSON.stringify(text)}`);
    throw error;
  }
  return { cardId, turn: await page.evalJS<string>(first) };
}

/**
 * Keep `want` as a new version of idea `id`'s sketch, through the CLI, as the
 * keep-sketch skill would; returns the sketch's id.
 */
export function keepSketch(s: AuthoringScratch, id: string, want: string, turns: string): string {
  const dir = join(s.scratch.dataRoot, "fixture-sketches");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}-${turns}.md`);
  writeFileSync(path, `# Sketch\n\n${want}\n\nSource: session ${s.sid}, turns ${turns}\n`);
  const out = JSON.parse(cli(s, ["sketch", "keep", "--idea", id, "--file", path, "--json"])) as {
    data: { id?: string; sketch?: string };
  };
  const sketch = out.data.id ?? out.data.sketch;
  if (typeof sketch !== "string") throw new Error(`sketch keep named no sketch: ${JSON.stringify(out)}`);
  return sketch;
}

/**
 * Write a brief under `briefs/` and record it as written from
 * sketch version `from`, as the brief skill would. Returns its path.
 */
export function recordBrief(s: AuthoringScratch, sketch: string, slug: string, from: number): string {
  const rel = `briefs/${slug}-brief.md`;
  mkdirSync(join(s.scratch.repo, "briefs"), { recursive: true });
  writeFileSync(join(s.scratch.repo, rel), `# ${slug}\n\nWhat was decided.\n`);
  cli(s, ["sketch", "record-brief", sketch, "--path", rel, "--from-version", String(from)]);
  return rel;
}
