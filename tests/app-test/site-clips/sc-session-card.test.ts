/**
 * sc-session-card.test.ts — the site's session-card still: one tall Session
 * card, top to bottom, holding a REAL session from this checkout's history,
 * scrolled to the start of its second turn so the still reads prompt, then
 * work.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that the still was written. Run by path, once per
 * mode (`_site-clips.ts` has the invocation); skips unless the runner and
 * both site variables are set.
 *
 * The scene, the way `sc-deck.test.ts` builds its three: a scratch git
 * repository named `tug`, so the masthead prints a plain project name; the
 * transcript copied from this checkout's Claude project directory into the
 * scratch repository's, with each row's `cwd` moved to the scratch path; and
 * the card spawned with `spawnSessionResume` on that repository. The window
 * is sized tall and narrow so the one-up fits the card to it, and the still
 * is cut to the card.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { App } from "../_harness";
import { ClaudeHome, claudeProjectDir } from "../_harness/claude-home";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { pollFor } from "../body-grounding/_frames";
import { MODE, RUNS, contentSize, cropAround, launchForMode, outDirFor, standIns, stillTo } from "./_site-clips";

const TEST_TIMEOUT_MS = 300_000;
/** This checkout — whose history the session comes from, and never the tree the scene is staged in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", "..", ".."));
const CARD = "sc-session-card";
/** `workspace-xp`: a workspace-switch bug diagnosed and fixed in two turns, with a cache refresher added in the second. */
const SESSION_ID = "df121055-c014-4f54-bb50-117d0f6fcd69";
/** The second turn's prompt, which the still's transcript starts on. */
const SECOND_PROMPT = "Of course I do!";
const PROJECT_NAME = "tug";
/** The session's identity as this checkout's ledger holds it: the name the user gave it, its callsign, and the Observer's synopsis. */
const IDENTITY = { name: "workspace-xp", name_user_set: true, tag: "docile-knoll", synopsis: "Repair session labels changing when workspaces switch" };

/** A tall, narrow window: the one-up fits the card to it. */
const CONTENT_SIZE = { width: 760, height: 1720 };
const READY_MS = 120_000;
const SETTLE_MS = 2_000;

const SCROLLER = '[data-tug-scroll-key="session-card-transcript"]';
const EDITOR = '[data-slot="tug-text-editor"] .cm-content';

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: CARD, componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: `${CARD}-pane`,
        position: { x: 20, y: 20 },
        size: { width: 720, height: 1680 },
        cardIds: [CARD],
        activeCardId: CARD,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: `${CARD}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** The scratch checkout the session is resumed on: a git repository whose basename is the project's. */
function makeRepo(parent: string): string {
  const repo = join(parent, PROJECT_NAME);
  mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# tug\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=ken@example.com", "-c", "user.name=Ken Kocienda", "commit", "-q", "-m", "init"]);
  return repo;
}

/**
 * Copy the transcript from this checkout's Claude project directory into the
 * scratch repository's, each row's `cwd` moved with it, so `claude --resume`
 * finds it there. The source is the user's own Claude home, resolved with no
 * config dir (see `sc-deck.test.ts`).
 */
function transplant(sessionId: string, repo: string): void {
  const from = join(ClaudeHome.resolve(undefined, homedir()).projectDir(CHECKOUT), `${sessionId}.jsonl`);
  const dir = claudeProjectDir(repo);
  mkdirSync(dir, { recursive: true });
  const text = readFileSync(from, "utf8");
  const rows = text.split("\n").map((line) => {
    if (line === "") return line;
    try {
      const row = JSON.parse(line) as { cwd?: string };
      if (typeof row.cwd === "string" && row.cwd.startsWith(CHECKOUT)) row.cwd = repo + row.cwd.slice(CHECKOUT.length);
      return JSON.stringify(row);
    } catch {
      return line;
    }
  });
  writeFileSync(join(dir, `${sessionId}.jsonl`), rows.join("\n"));
  onTestRunEnd(() => rmSync(dir, { recursive: true, force: true }));
}

async function resume(app: App, repo: string): Promise<void> {
  await app.spawnSessionResume(CARD, { tugSessionId: SESSION_ID, projectDir: repo });
  await app.awaitEngineReady(CARD, { timeoutMs: READY_MS });
  await pollFor(
    () =>
      app
        .body(CARD)
        .evalJS<boolean>(
          `document.querySelector('[data-testid="session-card-transcript"]') !== null && document.querySelectorAll(".tug-transcript-entry").length > 0`,
        )
        .catch(() => false),
    (ready) => ready,
    READY_MS,
  );
}

/**
 * Scroll the transcript so the entry holding `text` sits at the top of its
 * viewport. The transcript windows its rows, so the entry is looked for a
 * viewport at a time from the top until it is in the document.
 */
async function scrollTo(app: App, text: string): Promise<boolean> {
  const body = app.body(CARD);
  const find = `(function(){
    var s = document.querySelector(${JSON.stringify(SCROLLER)});
    if (!s) return "no-scroller";
    var entries = Array.prototype.slice.call(document.querySelectorAll(".tug-transcript-entry"));
    var el = entries.find(function (e) { return (e.textContent || "").indexOf(${JSON.stringify(text)}) !== -1; });
    if (!el) return null;
    var r = el.getBoundingClientRect(), sr = s.getBoundingClientRect();
    s.scrollTop = s.scrollTop + (r.top - sr.top);
    return { top: s.scrollTop, height: s.scrollHeight, client: s.clientHeight };
  })()`;
  const step = `(function(){ var s = document.querySelector(${JSON.stringify(SCROLLER)}); if (!s) return false; s.scrollTop = ${"__TOP__"}; return s.scrollTop; })()`;
  const metrics = await body.evalJS<{ height: number; client: number } | null>(
    `(function(){ var s = document.querySelector(${JSON.stringify(SCROLLER)}); return s ? { height: s.scrollHeight, client: s.clientHeight } : null; })()`,
  );
  if (metrics === null) return false;
  for (let top = 0; top <= metrics.height; top += Math.max(100, metrics.client - 100)) {
    await body.evalJS<unknown>(step.replace("__TOP__", String(top)));
    await Bun.sleep(250);
    const found = await body.evalJS<unknown>(find);
    if (found !== null && found !== "no-scroller") return true;
  }
  return false;
}

describe.skipIf(!RUNS)("site still: the session card", () => {
  test(
    "records one real session in a tall card, scrolled to its second turn",
    async () => {
      const parent = realpathSync(mkdtempSync(join(tmpdir(), "sc-session-card-")));
      onTestRunEnd(() => rmSync(parent, { recursive: true, force: true }));
      const repo = makeRepo(parent);
      transplant(SESSION_ID, repo);

      const app = await launchForMode("sc-session-card", deck(), undefined, { contentSize: CONTENT_SIZE });
      try {
        await resume(app, repo);
        // The identity the real ledger holds for it, delivered the way the
        // wire does (at0570), since the scratch ledger has no row for it.
        await app.body(CARD).evalJS<boolean>(
          `window.__tug.publishSessionUpdated(${JSON.stringify(JSON.stringify({ session_id: SESSION_ID, fields: IDENTITY }))})`,
        );
        await Bun.sleep(SETTLE_MS);
        // Focus in the composer, where a resting card keeps it.
        await app.body(CARD).nativeClickAtElement(EDITOR);
        await Bun.sleep(600);

        const rest = await standIns(app);
        expect(rest[CARD], "the card stands in its slot").toBeDefined();
        const crop = cropAround([rest[CARD]!], 0, await contentSize(app));

        // Two stills: the transcript at its end, as the card rests, and
        // scrolled to the second turn's prompt.
        const { scale } = await stillTo(app, crop, join(outDirFor("session-card"), "still-end.png"));
        const scrolled = await scrollTo(app, SECOND_PROMPT);
        await Bun.sleep(SETTLE_MS);
        await stillTo(app, crop, join(outDirFor("session-card"), "still-turn.png"));
        writeFileSync(
          join(outDirFor("session-card"), "reading.json"),
          JSON.stringify({ clip: "session-card", mode: MODE, scale, crop, contentSize: CONTENT_SIZE, scrolled }, null, 2),
        );
        expect(scale, "a still was written at the window's scale").toBeGreaterThan(0);
        expect(scrolled, "the transcript stands on the second turn's prompt").toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
