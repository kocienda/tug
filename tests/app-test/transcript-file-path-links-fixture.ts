/**
 * transcript-file-path-links-fixture.ts — the constants, frame builders and
 * gestures the at0307-transcript-file-path-links-* files share.
 *
 * A path the assistant writes is inert text until the annotator has asked the
 * filesystem about it; each file drives that round trip against the real app
 * and the real `POST /api/fs/stat` from a different source the annotation
 * comes from. Each file seeds its own scratch project holding `FILE_NAME` and
 * naming a `MISSING_NAME` sibling that does not exist.
 *
 * @module tests/app-test/transcript-file-path-links-fixture
 */

import { resolve } from "node:path";
import { launchTugApp } from "./_harness";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

export const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
export const SID = "test-session-A";

/** This repository, which is the app-test bootstrap FILETREE workspace. */
export const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** A file that exists exactly once here, named the way prose names it. */
export const INDEXED_NAME = "tug-button.css";

export const FILE_NAME = "notes.md";
export const MISSING_NAME = "not-here.md";
export const CITED_LINE = 3;
export const FILE_BODY = ["alpha", "bravo", "charlie", "delta", "echo"].join("\n");

export type Harness = Awaited<ReturnType<typeof launchTugApp>>;

/**
 * Open the annotation's context menu with a trusted native right-click
 * and wait for `action`'s item to mount. Synthetic events don't fire the
 * menu's real activation path, so the gestures here are native.
 */
export async function openAnnotationMenu(
  app: Harness,
  selector: string,
  action: string,
): Promise<void> {
  await app.nativeRightClickAtElement(selector);
  await app.waitForCondition<boolean>(
    `document.querySelector('[data-item-action="' + ${JSON.stringify(action)} + '"]') !== null`,
    { timeoutMs: 3000 },
  );
}

/** Trusted native-click the open menu's item with `data-item-action === action`. */
export async function activateMenuItem(app: Harness, action: string): Promise<void> {
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

/** Read one assistant code span's annotation state by a text substring. */
export const spanStateJS = (needle: string) => `JSON.stringify((function(){
  var codes = Array.from(document.querySelectorAll(
    '[data-card-id="A"] .session-card-transcript-code-body code'));
  var el = codes.find(function(c){
    return (c.textContent || '') === ${JSON.stringify(needle)};
  });
  if (!el) return { found: false };
  return {
    found: true,
    kind: el.getAttribute('data-tug-annotation'),
    path: el.getAttribute('data-path'),
    line: el.getAttribute('data-line'),
    focus: el.getAttribute('data-tug-focus'),
    noActivate: el.hasAttribute('data-no-activate'),
  };
})())`;
