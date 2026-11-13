/**
 * vd-short-atoms.test.ts — a YouTube Short on session and commit atoms: a
 * session's name in its masthead, a commit's pill on its receipt and down the
 * History shade, the Commit card a click on the pill opens, and both placed
 * in a question to the Operator in the Overview sidebar, whose answer names
 * them back as the same pills.
 *
 * A video tool, not a test of the app: it stages a scene and records it, and
 * its assertions are that frames were written and the staged commit landed.
 * It lives beside the other video drivers and shares the site clips' helpers
 * and gate: run by path with `TUG_SITE_CLIPS_OUT` and `TUG_SITE_CLIPS_MODE`
 * set; with either unset it skips. The `vids` repo's `tools/shot.py
 * short-atoms` is the usual caller, and its `tools/short.py` composes the
 * portrait frame.
 *
 * The scene: a scratch clone of this checkout under a directory named `tug`,
 * and a Session card with the Overview standing in the right rail. The work
 * shown is real: a commit of this repository's own history (`SOURCE_SHA`,
 * the rename field's invisible selection) and the turn of the session that
 * made it, with the prompt as the user typed it, the two files as that commit
 * changed them, the reply's own opening, and the commit's own message. The
 * clone is wound back to that commit's parent, the card (`WORKER`) replays
 * the turn as a stub before the first frame, and the work is committed again
 * through the card's own Changes route, so the receipt, its pill and the
 * commit's session trailer are the app's. The feed's posts and the
 * Operator's answer retell that session's own record
 * (`tugtool session show e8ee13b9`, turns 20 and 21, and its six commits).
 * The callsign is seeded in the ledger (`CALLSIGN`) rather
 * than left to the mint, so the name on screen is the same every take. The
 * question is typed in the Overview's composer; under the app-test gate the
 * Operator has no model, so the answer is the video's own post.
 *
 * The frame is portrait and the window is not: the composer (`tools/short.py`,
 * a `camera` recipe) looks at the capture through a 9:16 window that moves
 * between the views this driver writes to `shot.json` (`camera`: a view per
 * beat, in window points, with the seconds its move runs over), and draws a
 * hand-drawn ring round each thing a beat is about (`rings`: a rect in
 * window points and the seconds it shows for).
 *
 * The two atoms reach the prompt by paste. Each is copied before the first
 * frame, by the app's own copy, and its pasteboard is kept; on camera the
 * pasteboard is put back and pasted. The `@` picker for sessions and commits
 * is not in the app yet, so nothing here types `@`.
 *
 * The times are seconds of a draft read of the narration; they are re-timed
 * to the recording's word timestamps once there is one.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { TUGCODE_TRANSCRIPT_SCHEMA_VERSION, note, type App } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { pollFor } from "../body-grounding/_frames";
import { standUpKind } from "../body-grounding/_kind-bodies";
import { cardKind, kindPane } from "../body-grounding/_kinds";
import { stubDirectory } from "../streaming-stub-fixture";
import { MODE, RUNS, contentSize, expectRecorded, launchForMode, outDirFor, scene, standIns } from "../site-clips/_site-clips";

const TEST_TIMEOUT_MS = 500_000;
const IPC_VERSION = 2;
const SHOT = "short-atoms";
/** This checkout, cloned for the scene. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", "..", ".."));
/** Where the scratch clone lives: a readable path, since the app names the directory. Removed when the run ends. */
const SCRATCH_ROOT = process.env.TUG_VIDS_SCRATCH ?? resolve(CHECKOUT, "..", "scratch");

const WORKER = "vd-atoms-worker";
const OVERVIEW = "vd-atoms-overview";
/** The worker's callsign, seeded so the mint does not choose it. */
const CALLSIGN = "tawny-mill";

/** View › Zoom: with the 2× backing store, one CSS pixel is two and a half captured pixels. */
const PAGE_ZOOM = 1.25;
/** A Session card close to the frame's own 9:16, an empty slot beside it for the Commit card to open in, and the Overview's rail. */
const CONTENT_SIZE = { width: 2330, height: 1575 };

const PACE_MS = 60;
const DELTA_MS = 45;
/** A character every this long in the prompt. */
const CHAR_MS = 55;

const ENTRY = '[data-slot="tug-prompt-entry"]';
const FIELD = `${ENTRY} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = '.session-view-pane[data-view="changes"] [data-slot="tug-sheet"]';
const ANY_ROWS = `${SHEET} [data-testid="tug-changes-list-file-block"]`;
const COMMIT_BUTTON = '[data-testid="tug-prompt-entry-commit-button"]';
const RECEIPT = '[data-slot="tug-commit-changes-list"]';
const RECEIPT_ROWS = `${RECEIPT} [data-testid="tug-changes-list-file-block"]`;
const COMMIT_PILL = '[data-slot="tug-commit-atom"]';
const SESSION_PILL = '[data-slot="tug-session-identity"]';
const HISTORY_ROW = '[data-slot="session-history-view"] [data-testid="session-history-commit"]';
const OVERVIEW_TRANSCRIPT = '[data-testid="overview-card"] [data-testid="overview-transcript"]';
const OVERVIEW_FIELD = '[data-testid="overview-composer-field"] .cm-content';
const PROMPT_PHASE = `(function(){ var e = document.querySelector('[data-slot="tug-prompt-entry"]'); return e === null ? null : e.getAttribute("data-phase"); })()`;

/** The commit the scene re-makes: "tugdeck(session-rename-selection): Paint selected name in rename field", by the session `burly-brook`. */
const SOURCE_SHA = "b328ce73e7944db36fb7103f7512d9569f762f39";
/** That session's turn, in its own words: the user's prompt, and the opening of the reply. */
const WORK = {
  prompt: "Text must be *visibly selected*. Did you just invent a new editing component here?",
  closing:
    "No new component: the field is the app's standard `TugInput`, and the name was selected, but the selection was painted transparent.\n" +
    "\n" +
    "The title bar has a rule that blanks the selection highlight for everything inside it, so a selection dragged through a card's content doesn't paint across the chrome. The rename field sits in the title bar, so that rule reached into it.",
} as const;
/** The commit's own message, without the trailers the app writes again. */
const MESSAGE = execFileSync("git", ["-C", CHECKOUT, "log", "-1", "--format=%B", SOURCE_SHA], { encoding: "utf8" })
  .split("\n")
  .filter((line) => !line.startsWith("Tug-Session"))
  .join("\n")
  .trim();
/** The files that commit changed. */
const FILES = execFileSync("git", ["-C", CHECKOUT, "diff", "--name-only", `${SOURCE_SHA}~1`, SOURCE_SHA], { encoding: "utf8" }).trim().split("\n");

/** The question to the Operator, in the pieces typed around the two pasted atoms. */
const ASK = ["Why did ", " make ", "?"] as const;

/** The beats, in seconds of the draft read. */
const T = {
  /** "In AI coding, two things are everywhere: sessions and commits": out from the receipt to the whole card, a ring on each as it is named. */
  open: [0.0, 2.2],
  sessionsRing: [2.3, 4.9],
  commitsRing: [3.3, 4.9],
  /** "Every session gets a short name right away": in on the worker's masthead. */
  name: [5.2, 6.3],
  nameRing: [6.5, 8.1],
  /** "Sessions and commits are shown as atoms…": out to the receipt and its pills. */
  receipt: [8.3, 9.1],
  receiptRings: [9.2, 10.6],
  /** "…that look the same everywhere in the app": the History shade drops, and lifts. */
  historyOn: 10.7,
  history: [10.6, 11.4],
  historyRings: [11.9, 13.0],
  historyOff: 13.2,
  back: [13.2, 13.9],
  /** "Click a commit, and it opens." */
  clickRing: [13.95, 14.6],
  click: 14.4,
  commit: [14.6, 15.5],
  /** "Type at, and I can put a session or a commit right in my prompt." */
  toAsk: [16.5, 17.5],
  leave: 16.6,
  type: 17.7,
  /** "Claude knows exactly which session and which commit I mean." */
  send: 21.0,
  answer: 22.0,
  answerSessionRing: [22.7, 23.75],
  answerCommitRing: [23.8, 24.9],
  /** "Simpler, unified, refined. That's what AI coding in Tug is all about." */
  wide: [25.0, 26.4],
  end: 29.5,
} as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

interface Edit {
  path: string;
  old: string;
  new: string;
}

/** One file's edit as the commit made it: the first hunk of its diff, with a line of context, as an Edit call's two strings. */
function editOf(path: string): Edit {
  const diff = execFileSync("git", ["-C", CHECKOUT, "diff", "-U1", `${SOURCE_SHA}~1`, SOURCE_SHA, "--", path], { encoding: "utf8" }).split("\n");
  const from = diff.findIndex((l) => l.startsWith("@@"));
  if (from < 0) throw new Error(`no hunk in ${path}`);
  const next = diff.findIndex((l, i) => i > from && l.startsWith("@@"));
  const hunk = diff.slice(from + 1, next < 0 ? undefined : next).filter((l) => l !== "" && !l.startsWith("\\"));
  const side = (drop: string) => hunk.filter((l) => !l.startsWith(drop)).map((l) => l.slice(1)).join("\n");
  return { path, old: side("+"), new: side("-") };
}

/** The scratch clone, under a directory named `tug`: this checkout wound back to the commit's parent, with the commit's files as it left them, uncommitted. */
function makeRepo(root: string): string {
  const repo = join(root, "tug");
  execFileSync("git", ["clone", "-q", "--local", "--no-hardlinks", CHECKOUT, repo]);
  git(repo, "config", "user.email", "kocienda@mac.com");
  git(repo, "config", "user.name", "Ken Kocienda");
  git(repo, "reset", "-q", "--hard", `${SOURCE_SHA}~1`);
  git(repo, "checkout", SOURCE_SHA, "--", ...FILES);
  git(repo, "reset", "-q");
  return repo;
}

const toolUseId = (i: number): string => `toolu_${WORKER}_${i + 1}`;

/** The worker's turn: the edits, each an Edit call that opens and returns, and a closing line. */
function workerTranscript(repo: string, edits: readonly Edit[]): unknown {
  const outputs: unknown[] = [];
  edits.forEach((e, i) => {
    const id = toolUseId(i);
    outputs.push({ type: "tool_use", msg_id: "w-m1", seq: i, tool_name: "Edit", tool_use_id: id, input: { file_path: join(repo, e.path), old_string: e.old, new_string: e.new }, ipc_version: IPC_VERSION });
    outputs.push({ type: "tool_progress", tool_use_id: id, tool_name: "Edit", elapsed_time_seconds: 0, parent_tool_use_id: null, ipc_version: IPC_VERSION });
    outputs.push({ type: "tool_result", tool_use_id: id, output: `The file ${join(repo, e.path)} has been updated successfully.`, is_error: false, ipc_version: IPC_VERSION });
  });
  outputs.push({ type: "content_block_start", msg_id: "w-m2", block_index: 0, kind: "text", ipc_version: IPC_VERSION });
  outputs.push({ type: "assistant_text", msg_id: "w-m2", block_index: 0, seq: edits.length, rev: 0, text: WORK.closing, is_partial: false, status: "complete", ipc_version: IPC_VERSION });
  outputs.push({ type: "turn_complete", msg_id: "w-m2", seq: edits.length + 1, result: "success", ipc_version: IPC_VERSION });
  return { schemaVersion: TUGCODE_TRANSCRIPT_SCHEMA_VERSION, tugcodeVersion: "stub", paceMs: PACE_MS, turns: [{ index: 0, description: "the worker's edits", outputs }] };
}

function deck(): Record<string, unknown> {
  return {
    cards: [
      { id: WORKER, componentId: "session", title: "Session", closable: true },
      { id: OVERVIEW, componentId: "overview", title: "Overview", closable: true },
    ],
    panes: [kindPane("session", WORKER, 0), kindPane("overview", OVERVIEW, 0)],
    activePaneId: `${WORKER}-pane`,
    imposition: { kind: "two-up", layout: "fit", contentWidth: "slim", sidebars: { overview: { side: "right" } }, rails: { left: { order: [] }, right: { order: ["overview"] } } },
    hasFocus: true,
  };
}

/** The scribe's stream: the message so far, two words at a time. */
function deltas(message: string): string[] {
  const words = message.match(/\S+\s*/g) ?? [message];
  const out: string[] = [];
  let sofar = "";
  words.forEach((w, i) => {
    sofar += w;
    if (i % 2 === 1 || i === words.length - 1) out.push(sofar);
  });
  return out;
}

const JXA_KEEP = `ObjC.import("AppKit");
function run(argv) {
  var pb = $.NSPasteboard.generalPasteboard;
  var items = pb.pasteboardItems;
  var out = {};
  if (items.count > 0) {
    var item = items.objectAtIndex(0);
    var types = item.types;
    for (var i = 0; i < types.count; i++) {
      var t = types.objectAtIndex(i);
      var d = item.dataForType(t);
      if (!d.isNil()) out[ObjC.unwrap(t)] = ObjC.unwrap(d.base64EncodedStringWithOptions(0));
    }
  }
  $(JSON.stringify(out)).writeToFileAtomicallyEncodingError(argv[0], true, $.NSUTF8StringEncoding, null);
  return Object.keys(out).join(" ");
}`;

const JXA_PUT = `ObjC.import("AppKit");
function run(argv) {
  var kept = JSON.parse(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null)));
  var pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  var item = $.NSPasteboardItem.alloc.init;
  Object.keys(kept).forEach(function (t) {
    item.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions(kept[t], 0), t);
  });
  pb.writeObjects($.NSArray.arrayWithObject(item));
  return Object.keys(kept).length;
}`;

/** Keep the pasteboard's first item, every flavor of it, in `file`; answers the flavors kept. */
function keepPasteboard(file: string): string {
  return execFileSync("osascript", ["-l", "JavaScript", "-e", JXA_KEEP, file], { encoding: "utf8" }).trim();
}

/** Put a kept item back on the pasteboard. */
function putPasteboard(file: string): void {
  execFileSync("osascript", ["-l", "JavaScript", "-e", JXA_PUT, file]);
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Paste whatever the pasteboard holds at the caret of `card`'s field. */
function paste(app: App, card: string, field: string): Promise<null> {
  return app.body(card).evalJS<null>(`(function(){
    var cm = document.querySelector(${JSON.stringify(field)});
    cm.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() }));
    return null;
  })()`);
}

describe.skipIf(!RUNS)("video shot: the session-and-commit-atoms Short", () => {
  test(
    "records a session's name, a commit's pill and card, and both cited in a question to the Operator",
    async () => {
      mkdirSync(SCRATCH_ROOT, { recursive: true });
      const scratch = realpathSync(mkdtempSync(join(SCRATCH_ROOT, "run-")));
      onTestRunEnd(() => rmSync(scratch, { recursive: true, force: true }));
      note("cloning the checkout");
      const repo = makeRepo(scratch);
      const edits = FILES.map(editOf);
      const stubDir = stubDirectory();
      const workerSid = randomUUID();
      writeFileSync(join(stubDir, `${workerSid}.json`), JSON.stringify(workerTranscript(repo, edits)));

      const app = await launchForMode("vd-short-atoms", deck(), stubDir, { contentSize: CONTENT_SIZE });
      try {
        const granted = await app.setWindowContentSize(CONTENT_SIZE);
        expect(granted, "the display grants the window").toEqual(CONTENT_SIZE);
        await app.setPageZoom(PAGE_ZOOM);
        await Bun.sleep(800);
        const focus = (card: string) => app.dispatchControlAction("focus-pane", { paneId: `${card}-pane` });
        const phase = (card: string) => () => app.body(card).evalJS<string | null>(PROMPT_PHASE).catch(() => null);
        const bind = async (card: string, sid: string) => {
          note(`binding ${card}`);
          await focus(card);
          await app.waitForCondition<boolean>(`(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(card)})`, { timeoutMs: 30_000 });
          await app.spawnSessionNew(card, { tugSessionId: sid, projectDir: repo });
          await pollFor(
            () =>
              app
                .body(card)
                .evalJS<boolean>(`document.querySelector('[data-testid="session-card-transcript"]') !== null && document.querySelector('.session-card-picker-form') === null`)
                .catch(() => false),
            (bound) => bound,
            30_000,
          );
          await app.ingestSessionMetadata(card, { type: "system_metadata", cwd: repo, model: "claude-fable-5-2", version: "2.1.299", permissionMode: "auto", ipc_version: IPC_VERSION });
          await Bun.sleep(400);
        };
        const notes: Record<string, unknown> = {};

        await standUpKind(app, cardKind("overview"), OVERVIEW);
        // The callsign, in the ledger before the session spawns, so the commit's trailer carries it too.
        app.seedLedger({ sessions: [{ session_id: workerSid, workspace_key: repo, project_dir: repo, tag: CALLSIGN }] });

        // ---- The worker: its turn, then its commit, through the card's own Changes route. ----
        await bind(WORKER, workerSid);
        const worker = app.body(WORKER);
        await worker.driveSession({ op: "send", text: WORK.prompt });
        await pollFor(phase(WORKER), (p) => p === "streaming", 20_000);
        await pollFor(phase(WORKER), (p) => p !== null && p !== "streaming", 30_000);
        app.seedLedger({
          file_events: edits.map((e, j) => ({
            tug_session_id: workerSid,
            tool_use_id: toolUseId(j),
            file_path: join(repo, e.path),
            tool_name: "Edit",
            op: "write",
            origin: "exact",
            ambiguous: false,
            project_dir: repo,
            at: Date.now(),
          })),
        });
        const first = join(repo, edits[0]!.path);
        writeFileSync(first, readFileSync(first));
        await Bun.sleep(1_500);
        await focus(WORKER);
        await Bun.sleep(300);
        await app.nativeKey("c", ["ctrl", "cmd"]);
        await worker.waitForCondition<boolean>(`document.querySelectorAll(${JSON.stringify(ANY_ROWS)}).length >= ${edits.length}`, { timeoutMs: 15_000 });
        const draftFrame = (frame: Record<string, unknown>) =>
          worker.evalJS<boolean>(`window.__tug.publishDraftFrame(${JSON.stringify(JSON.stringify({ workspace_key: repo, owner_kind: "session", owner_id: workerSid, ...frame }))})`);
        await draftFrame({ action: "changeset_draft_state", state: "drafting" });
        for (const text of deltas(MESSAGE)) {
          await draftFrame({ action: "changeset_draft_delta", text });
          await Bun.sleep(DELTA_MS);
        }
        await draftFrame({ action: "changeset_draft_state", state: "ready" });
        await Bun.sleep(400);
        await worker.nativeClickAtElement(COMMIT_BUTTON);
        await pollFor(() => worker.evalJS<boolean>(`document.querySelector(${JSON.stringify(RECEIPT_ROWS)}) !== null`).catch(() => false), (landed) => landed, 60_000);
        const sha = git(repo, "rev-parse", "HEAD");
        notes.commit = git(repo, "log", "-1", "--format=%H%n%B");
        expect(git(repo, "log", "-1", "--format=%s"), "the press produced the commit it asked for").toBe(MESSAGE.split("\n")[0]!);
        await worker.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(COMMIT_PILL)}) !== null`, { timeoutMs: 20_000 });
        const callsign = await worker.evalJS<string>(`(document.querySelector(${JSON.stringify(SESSION_PILL)}) || { innerText: "" }).innerText.replace(/\\s+/g, " ").trim()`);
        notes.workerPill = callsign;
        const reference = callsign.includes("/") ? callsign : `tug/${callsign}`;

        // ---- The two atoms, each copied by the app and its pasteboard kept. ----
        const keptSession = join(scratch, "session.pasteboard.json");
        const keptCommit = join(scratch, "commit.pasteboard.json");
        expect(await app.evalJS<boolean>(`window.__tug.copySessionAtom(${JSON.stringify(workerSid)})`), "the session atom was copied").toBe(true);
        await Bun.sleep(600);
        notes.sessionFlavors = keepPasteboard(keptSession);
        // The pill's own menu, Copy as Atom: a selection dragged across the pill copies its characters, not the object.
        await worker.nativeRightClickAtElement(COMMIT_PILL);
        await worker.waitForCondition<boolean>(`document.querySelector('[data-item-action="copy-annotation-atom"]') !== null`, { timeoutMs: 5_000 });
        const item = await worker.evalJS<{ x: number; y: number }>(`(function(){
          var r = document.querySelector('[data-item-action="copy-annotation-atom"]').getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`);
        await worker.nativeClick(item);
        await Bun.sleep(700);
        notes.commitFlavors = keepPasteboard(keptCommit);

        // ---- The Overview: two posts of the Observer's about the session, so the feed is not empty when the question is asked. ----
        const overview = app.body(OVERVIEW);
        await overview.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(OVERVIEW_TRANSCRIPT)}) !== null`, { timeoutMs: 15_000 });
        // Under the app-test gate the Operator has no model, so a question sent from the composer is answered at once with a transient
        // "couldn't answer that"; the video's own answer is published instead, and the transient's row is kept off the screen.
        await overview.evalJS<boolean>(`(function(){
          function hide(){
            document.querySelectorAll('[data-testid="overview-card"] .overview-cell').forEach(function(el){
              if (el.getAttribute("data-author") === "operator" && (el.textContent || "").indexOf("t answer that") !== -1) el.style.display = "none";
              // The question's echo resolves its sha against the app's own tree, which here is this checkout and not the scratch clone the
              // commit is in, so its commit stays plain text. The video publishes the same words against the clone, where the sha
              // resolves as it does in a user's own project, and the echo that cannot resolve is kept off the screen.
              if (el.getAttribute("data-author") === "user") el.style.display = el.querySelector(${JSON.stringify(COMMIT_PILL)}) === null ? "none" : "";
            });
          }
          new MutationObserver(hide).observe(document.body, { childList: true, subtree: true, characterData: true });
          return true;
        })()`);
        const publish = (post: Record<string, unknown>) => overview.evalJS<boolean>(`window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(post))})`);
        const now = Date.now();
        // Enough of them that the feed runs down to the composer, as it does on a working day.
        // The session's own afternoon, a post per commit it made, in order.
        const feed: readonly [number, string, boolean, boolean][] = [
          [64, "The masthead rename landed: a session is renamed inline from its masthead.", true, false],
          [53, "The rename pencil now matches the title bar's other controls.", true, false],
          [47, "A Rename label stands beside the pencil, and the field no longer hops when editing starts.", true, false],
          [30, "The Rename label moved inside a ghost button.", true, false],
          [12, "Reversed on request: the label is gone, and the pencil is a plain icon, leftmost in the row the ⋯ reveals.", true, false],
          [4, "The rename field's name was selected but painted transparent: a title-bar rule blanks the selection highlight for everything inside it. One CSS rule fixes it, and the test now checks the highlight is painted.", true, false],
          [1, "The selection fix is committed: two files, eighteen lines.", true, true],
        ];
        for (const [i, [minutesAgo, body, session, commit]] of feed.entries()) {
          await publish({ id: 9001 + i, at_ms: now - minutesAgo * 60_000, author: "observer", body, refs: commit ? [{ kind: "commit", target: sha }] : [], ...(session ? { session_id: workerSid } : {}), wake_reason: "sitrep", project_dir: repo });
        }
        const answer =
          `${reference} made \`${sha.slice(0, 9)}\` after you said the name in the rename field must be visibly selected. ` +
          "The name was selected, but a title-bar rule blanks the selection highlight for everything inside it, and the rename field sits in the title bar. " +
          "The commit is one CSS rule that paints the highlight again, and a test that fails without it.";
        notes.answer = answer;

        // ---- A rehearsal of the click, for where the Commit card stands. ----
        const commitCard = `(function(){ var s = window.tugdeck.diag.getDeckState(); var c = s.cards.find(function (c) { return c.componentId === "commit"; }); if (!c) return null; var p = s.panes.find(function (p) { return p.cardIds.indexOf(c.id) !== -1; }); return { card: c.id, pane: p ? p.id : null }; })()`;
        const closeCommit = async () => {
          const open = await app.evalJS<{ card: string; pane: string | null } | null>(commitCard);
          if (open !== null && open.pane !== null) await app.evalJS<null>(`(window.__tug.closePane(${JSON.stringify(open.pane)}), null)`);
        };
        await focus(WORKER);
        await worker.click(COMMIT_PILL);
        await app.waitForCondition<boolean>(`${commitCard} !== null`, { timeoutMs: 15_000 });
        await Bun.sleep(1_500);
        const opened = (await app.evalJS<{ card: string; pane: string | null } | null>(commitCard))!;
        const commitRect = (await standIns(app))[opened.card];
        notes.commitCard = { ...opened, rect: commitRect ?? null, panes: await standIns(app) };
        await closeCommit();
        await Bun.sleep(1_000);
        await focus(WORKER);
        await Bun.sleep(600);

        // ---- The views, in window points. ----
        const panes = await standIns(app);
        const window = await contentSize(app);
        const pw = panes[WORKER]!;
        const po = (panes[OVERVIEW] ?? (await app.elementRect(OVERVIEW, '[data-testid="overview-card"]'))) as Rect;
        const receipt = (await app.elementRect(WORKER, RECEIPT)) as Rect;
        const field = (await app.elementRect(OVERVIEW, OVERVIEW_FIELD)) as Rect;
        /** The rect, in window points, of the `index`-th match of `selector` in `card` (from the end when negative), or null. */
        let marks = 0;
        const rectOf = async (card: string, selector: string, index = 0): Promise<Rect | null> => {
          const key = `vd-ring-${marks++}`;
          const found = await app.body(card).evalJS<boolean>(`(function(){
            var all = document.querySelectorAll(${JSON.stringify(selector)});
            var el = all[${index} < 0 ? all.length + ${index} : ${index}];
            if (!el) return false;
            el.setAttribute("data-vd-ring", ${JSON.stringify(key)});
            return true;
          })()`);
          return found ? ((await app.elementRect(card, `[data-vd-ring="${key}"]`)) as Rect | null) : null;
        };
        const rings: { rect: Rect; from: number; to: number; what: string }[] = [];
        const ring = (what: string, rect: Rect | null, span: readonly [number, number]) => {
          if (rect !== null) rings.push({ what, rect, from: span[0], to: span[1] });
          else notes[`noRing.${what}`] = true;
        };
        const nameRect = await rectOf(WORKER, SESSION_PILL);
        const pillRect = await rectOf(WORKER, `${COMMIT_PILL}`);
        ring("open session", nameRect, T.sessionsRing);
        ring("open commit", pillRect, T.commitsRing);
        ring("name", nameRect, T.nameRing);
        ring("receipt commit", pillRect, T.receiptRings);
        ring("click", pillRect, T.clickRing);
        ring("receipt session", await rectOf(WORKER, `[data-testid="session-card-transcript"] ${SESSION_PILL}`, -1), T.receiptRings);

        /** A view is the 9:16 window `width` points wide whose corner is at (x, y); the composer keeps it inside the capture. */
        const whole = (p: Rect) => ({ x: p.x + p.width / 2 - (window.height * 9) / 32, y: 0, width: (window.height * 9) / 16 });
        const CLOSE = 560;
        const MID = 740;
        const tall = (w: number) => (w * 16) / 9;
        const views: Record<string, { x: number; y: number; width: number }> = {
          worker: whole(pw),
          name: { x: pw.x - 6, y: pw.y - 6, width: CLOSE },
          receipt: { x: pw.x - 6, y: receipt.y + receipt.height / 2 - tall(MID) * 0.5, width: MID },
          history: { x: pw.x - 6, y: pw.y - 6, width: MID },
          commit: commitRect === undefined ? whole(pw) : whole(commitRect),
          rail: whole(po),
          // The rail from its composer up, at close to one captured pixel to one frame pixel: the question, and the feed above it where the answer lands.
          ask: { x: po.x - 10, y: window.height - tall(po.width + 20), width: po.width + 20 },
          last: { x: po.x - 70, y: window.height - tall(po.width + 110), width: po.width + 110 },
        };
        const camera = [
          { view: "receipt", from: 0, to: 0 },
          { view: "worker", from: T.open[0], to: T.open[1] },
          { view: "name", from: T.name[0], to: T.name[1] },
          { view: "receipt", from: T.receipt[0], to: T.receipt[1] },
          { view: "history", from: T.history[0], to: T.history[1] },
          { view: "receipt", from: T.back[0], to: T.back[1] },
          { view: "commit", from: T.commit[0], to: T.commit[1] },
          { view: "ask", from: T.toAsk[0], to: T.toAsk[1] },
          { view: "last", from: T.wide[0], to: T.wide[1] },
        ];

        // ---- The burst. ----
        const s = scene().mark("loop-start", 0);
        const ms = (secs: number) => Math.round(secs * 1000);
        s.at(ms(T.historyOn), () => app.dispatchControlAction("toggle-history-view"));
        s.at(ms(T.historyRings[0]) - 300, async () => {
          notes.historyRows = await worker.evalJS<number>(`document.querySelectorAll(${JSON.stringify(HISTORY_ROW)}).length`).catch(() => -1);
          ring("history commit", await rectOf(WORKER, `${HISTORY_ROW} ${COMMIT_PILL}`), T.historyRings);
          ring("history session", await rectOf(WORKER, `${HISTORY_ROW} ${SESSION_PILL}`), T.historyRings);
        });
        s.at(ms(T.historyOff), () => app.dispatchControlAction("toggle-history-view"));
        s.at(ms(T.click), () => worker.click(COMMIT_PILL));
        s.at(ms(T.leave), async () => {
          await closeCommit();
          putPasteboard(keptSession);
        });
        s.at(ms(T.leave) + 500, () => overview.nativeClickAtElement(OVERVIEW_FIELD));
        // The question: a piece typed, an atom pasted, and the next atom's pasteboard put back while the next piece is typed.
        let at = ms(T.type);
        const type = (text: string) => {
          [...text].forEach((ch, i) => s.at(at + i * CHAR_MS, () => app.nativeType(ch)));
          at += text.length * CHAR_MS;
        };
        type(ASK[0]);
        s.at(at + 80, () => paste(app, OVERVIEW, OVERVIEW_FIELD));
        s.at(at + 420, async () => putPasteboard(keptCommit));
        at += 800;
        type(ASK[1]);
        s.at(at + 80, () => paste(app, OVERVIEW, OVERVIEW_FIELD));
        at += 500;
        type(ASK[2]);
        if (at > ms(T.send) - 600) throw new Error(`video: the question is still being typed at ${at} ms, too close to the send at ${ms(T.send)} ms`);
        s.at(ms(T.send) - 300, async () => {
          notes.typed = await overview.evalJS<string>(`document.querySelector(${JSON.stringify(OVERVIEW_FIELD)}).innerText`);
          notes.chips = await overview.evalJS<string[]>(`Array.prototype.map.call(document.querySelectorAll(${JSON.stringify(OVERVIEW_FIELD)} + ' img[data-atom-type]'), function (i) { return i.dataset.atomType + ":" + (i.dataset.chipVariant || ""); })`);
        });
        // Sent with the composer's own chord (⇧⏎ at the shipped `newline` setting).
        s.at(ms(T.send), () => app.nativeKey("Return", ["shift"]));
        s.at(ms(T.send) + 120, () => publish({ id: 9099, at_ms: Date.now(), author: "user", body: `${ASK[0]}${reference}${ASK[1]}${sha.slice(0, 10)}${ASK[2]}`, refs: [], project_dir: repo }));
        // Stamped when it lands, so it reads after the question's echo.
        s.at(ms(T.answer), () => publish({ id: 9100, at_ms: Date.now(), author: "operator", body: answer, refs: [], project_dir: repo, request_id: "vd-atoms-a1", elapsed_ms: 1_400 }));
        s.at(ms(T.answerSessionRing[0]) - 250, async () => {
          const cell = '[data-testid="overview-card"] .overview-cell[data-author="operator"]';
          // One after the other, on "which session" and "which commit": side by side, two rings would cross.
          ring("answer session", await rectOf(OVERVIEW, `${cell} ${SESSION_PILL}`, -1), T.answerSessionRing);
          ring("answer commit", await rectOf(OVERVIEW, `${cell} ${COMMIT_PILL}`, -1), T.answerCommitRing);
        });
        s.mark("loop-end", ms(T.end));
        const reading = await s.record(app, { outDir: outDirFor(SHOT), settleMs: 300 });

        notes.overviewPills = await overview
          .evalJS<string[]>(`Array.prototype.map.call(document.querySelectorAll('[data-testid="overview-card"] ${SESSION_PILL}, [data-testid="overview-card"] ${COMMIT_PILL}'), function (e) { return e.getAttribute("data-slot") + ":" + e.innerText.replace(/\\s+/g, "").trim(); })`)
          .catch(() => []);
        writeFileSync(
          join(outDirFor(SHOT), "shot.json"),
          JSON.stringify({ shot: SHOT, mode: MODE, pageZoom: PAGE_ZOOM, contentSize: window, panes, views, camera, rings, marks: reading.marks, frames: reading.frames, scale: reading.scale, notes }, null, 2),
        );
        note("vd-short-atoms notes", JSON.stringify(notes));
        expectRecorded(reading);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
