/**
 * annotation-atom-fixture.ts — what the two halves of [AT0346] share: the
 * session frames they ingest, the temp project holding the file they annotate,
 * the gate-aware right-click, and the menu reads. The cases themselves are in
 * `at0346-annotation-atom-and-entity.test.ts` (file atom, mention chip, whole
 * command) and `at0346-annotation-resting-and-commit.test.ts` (the resting
 * rule, the commit atom), split so neither file crosses the 20 s file budget.
 */

import { afterAll, beforeAll } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { App } from "./_harness";
import { restoreGateGone } from "./overlay-fixture";

/**
 * A trusted right-click in A's body, made once the resumed card's restore
 * gate — the overlay's claim on the whole window while the replay reveals —
 * has come down; before that the click is the gate's, not the span's.
 */
export async function rightClickPastGate(app: App, selector: string): Promise<void> {
  await restoreGateGone(app);
  await app.body("A").nativeRightClickAtElement(selector);
}

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

export const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
export const SID = "test-session-A";

export const FILE_NAME = "notes.md";
const FILE_BODY = ["alpha", "bravo", "charlie"].join("\n");

export const KNOWN_CMD = "tugplug:implement";
export const ARG = "arc/find-route.md";
export const UNKNOWN_CMD = "definitely-not-a-command";

/** This repository — a real git repo whose HEAD the app's git feed confirms. */
export const REPO_ROOT = resolve(import.meta.dir, "..", "..");
export const HEAD_SHA = execSync("git rev-parse HEAD", { cwd: REPO_ROOT })
  .toString()
  .trim();
/** The short form prose uses — deliberately longer than the label's eight. */
export const WRITTEN_SHA = HEAD_SHA.slice(0, 10);
/** What every commit surface, and the atom's plain flavor, spell. */
export const COMMIT_LABEL = `commit:${HEAD_SHA.slice(0, 8)}`;

export const PROMPT_INPUT = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';

/** The temp project and the file in it; set by {@link installAnnotationProject}. */
export let projectDir = "";
export let realPath = "";

/** Make the temp project before the file's cases and remove it after them. */
export function installAnnotationProject(): void {
  beforeAll(() => {
    if (!SHOULD_RUN) return;
    projectDir = mkdtempSync(join(tmpdir(), "at0346-annotation-"));
    realPath = join(projectDir, FILE_NAME);
    writeFileSync(realPath, FILE_BODY, "utf8");
  });
  afterAll(() => {
    if (projectDir !== "" && existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
}

export function capabilities(commands: string[]) {
  return {
    type: "session_capabilities",
    models: [{ value: "default", displayName: "Default" }],
    commands,
    agents: [],
    available_output_styles: [],
    output_style: "default",
    account: null,
    effort: null,
    ipc_version: 2,
  };
}

export const userMsg = (text: string) => ({
  type: "add_user_message",
  tug_session_id: SID,
  content: [{ type: "text", text }],
});
export const asstText = (msgId: string, text: string, seq: number) => ({
  type: "assistant_text",
  status: "complete",
  tug_session_id: SID,
  msg_id: msgId,
  text,
  is_partial: false,
  rev: 0,
  seq,
});
export const turnDone = (msgId: string) => ({
  type: "turn_complete",
  seq: 0,
  tug_session_id: SID,
  msg_id: msgId,
  result: "success",
});
export const replayStarted = () => ({ type: "replay_started", tug_session_id: SID });
export const replayComplete = () => ({
  type: "replay_complete",
  tug_session_id: SID,
  count: 1,
  firstLoadedTurnIndex: 0,
  totalTurns: 1,
  hasOlder: false,
});

/** Center a span in the scroller before a native click reaches for it. */
export const revealJS = (selector: string) =>
  `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return false;
    el.scrollIntoView({ block: "center" });
    return true;
  })()`;

/** The viewport point of a menu item, or `null` when it is not open. */
export const menuItemPointJS = (action: string) =>
  `(function(){
    var item = document.querySelector('[data-item-action=${action}]');
    if (item === null) return null;
    var r = item.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`;
