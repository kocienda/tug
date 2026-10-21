/**
 * row-37-failed-reveal.test.ts — an evicted card whose new body fails twice
 * stands as the placard saying it needs reloading, and its Reload brings the
 * card back with its turns.
 *
 * The one failure a cold reveal can show. The app launches on two
 * workspaces: a Session card's, shown, and a Text card's, parked. The Session
 * card resumes a transcript of plain turns; its workspace is parked and its
 * body evicted by the clock, the reader's `evictAfterMs` shortened. The host
 * is then told to ignore the next two bodies' readies, and the Session
 * workspace is shown again: the card's new body fails at its deadline, the
 * shell asks once more, and that body fails too. The card stands as the
 * failed placard — no body, no last frame over it — whose sentence says the
 * card needs reloading and never that anything was lost. Its Reload asks for
 * the body once more, and the card is back ready and shown, settled with
 * its last turn.
 *
 * @foreground activation
 * @covers tugdeck/src/components/chrome/card-host.tsx
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "../_harness";
import { claudeProjectDir } from "../_harness/claude-home";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { bodyOf, pollFor, sessionPane } from "./_bodies";
import { activate, textDeck } from "./_row-44";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "r37f-a";
const T = "r37f-text";
const SESSION_SPACE = "r37f-session";
const TEXT_SPACE = "r37f-text-space";
const EVICT_AFTER_MS = 1_500;
/** The host's deadline for a body's ready, shortened so the two failures are quick. */
const READY_DEADLINE_MS = 1_500;
const TURNS = 10;
const LAST_TURN = `Turn ${TURNS}: the last reading`;
const SENTENCE = "This card needs reloading.";

const LAYOUT = {
  version: 5,
  activeSpaceId: SESSION_SPACE,
  spaces: [
    {
      id: SESSION_SPACE,
      name: "Session",
      deck: {
        cards: [{ id: A, componentId: "session", title: "A", closable: true }],
        panes: [sessionPane(A, 0)],
        activePaneId: `${A}-pane`,
        imposition: { kind: "one-up", layout: "fit", sidebars: {} },
        hasFocus: true,
      },
    },
    { id: TEXT_SPACE, name: "Text", deck: textDeck([T]) },
  ],
};

/** A session JSONL of `turns` plain turns, in claude's own line shape. */
function sessionJsonl(cwd: string, sessionId: string, turns: number): string {
  const base = { isSidechain: false, userType: "external", cwd, sessionId, version: "2.1.105", gitBranch: "main" };
  const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  const t0 = Date.now() - turns * 20_000 - 600_000;
  const lines: unknown[] = [];
  let parent: string | null = null;
  for (let i = 0; i < turns; i++) {
    const user = uuid(i * 2 + 1);
    const assistant = uuid(i * 2 + 2);
    const heading = i === turns - 1 ? LAST_TURN : `Turn ${i + 1}: a reading`;
    lines.push({
      ...base,
      parentUuid: parent,
      type: "user",
      uuid: user,
      timestamp: new Date(t0 + i * 20_000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: `Read it again, turn ${i + 1}.` }] },
    });
    lines.push({
      ...base,
      parentUuid: user,
      type: "assistant",
      uuid: assistant,
      timestamp: new Date(t0 + i * 20_000 + 9_000).toISOString(),
      message: {
        id: `msg-r37f-${i}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: `### ${heading}\n\nThe walk took ${(i * 7) % 23 + 1} ms.` }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1_000 + i * 300, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    parent = assistant;
  }
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/** In the body: whether its transcript is settled with the last turn in it. */
const SETTLED_WITH_LAST = `(function () {
  try {
    if (!window.__tug.sessionSettled(${JSON.stringify(A)})) return false;
    var t = document.querySelector('[data-testid="session-card-transcript"]');
    return t !== null && (t.textContent || "").indexOf(${JSON.stringify(LAST_TURN)}) >= 0;
  } catch (e) { return false; }
})()`;

// card-dom: shell — the failed placard is the shell's, the card's only face.
const placard = `document.querySelector('[data-body-placeholder][data-card-id="${A}"] [data-body-failed]')`;

describe.skipIf(!SHOULD_RUN)("body-grounding row 37: a cold reveal that fails", () => {
  test(
    "an evicted card whose new body fails twice stands as the reloading placard, and its Reload brings it back with its turns",
    async () => {
      const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-r37f-project-")));
      const fixtureDir = claudeProjectDir(projectDir);
      mkdirSync(fixtureDir, { recursive: true });
      onTestRunEnd(() => {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(fixtureDir, { recursive: true, force: true });
      });
      const sid = "a7c0d1ea-0037-4000-8000-0000000000f1";
      writeFileSync(join(fixtureDir, `${sid}.jsonl`), sessionJsonl(projectDir, sid, TURNS));
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(LAYOUT));
      tugbankWrite(tugbankPath, "dev.tugapp.body-dormancy", "evictAfterMs", "int", String(EVICT_AFTER_MS));
      const app = await launchTugApp({
        testName: "body-grounding-row-37-failed-reveal",
        foreground: true,
        persistInTestMode: true,
        restoreInTestMode: true,
        env: { TUGBANK_PATH: tugbankPath, TUG_BODY_READY_DEADLINE_MS: String(READY_DEADLINE_MS) },
      });
      try {
        await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.visible, 30_000);
        await app.spawnSessionResume(A, { tugSessionId: sid, projectDir });
        await app.body(A).waitForCondition<boolean>(SETTLED_WITH_LAST, { timeoutMs: 15_000 });

        // ---- Parked, and evicted by the clock ----
        await activate(app, TEXT_SPACE);
        const gone = await pollFor(() => app.bodies(), (all) => !all.some((b) => b.cardId === A), EVICT_AFTER_MS + 6_000);
        expect(gone.some((b) => b.cardId === A), "the parked body is evicted").toBe(false);

        // ---- Shown again, and its next two bodies fail ----
        expect(await app.stallBodyReadies(2), "the host will ignore the next two readies").toBe(2);
        const shownAt = Date.now();
        await activate(app, SESSION_SPACE);
        const standing = await pollFor(() => app.evalJS<boolean>(`${placard} !== null`), (v) => v, READY_DEADLINE_MS * 2 + 6_000);
        note(`placard standing ${Date.now() - shownAt} ms after the reveal, for a ${READY_DEADLINE_MS} ms deadline twice`);
        expect(standing, "the card stands as the placard once its second new body fails").toBe(true);
        expect(await bodyOf(app, A), "no body, and no last frame, stands over the placard").toBeNull();
        const text = await app.evalJS<string>(`${placard}.textContent`);
        note(`placard: ${text}`);
        expect(text, "the placard says the card needs reloading").toContain(SENTENCE);
        expect(text, "and never that anything was lost").not.toMatch(/lost|gone|error|failed/i);

        // ---- Reload: the card is back with its turns ----
        await app.evalJS<null>(
          `(Array.prototype.find.call(${placard}.querySelectorAll("button"), function (b) { return b.textContent.trim() === "Reload"; }).click(), null)`,
        );
        const back = await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.painted && b.visible, 10_000);
        expect(back, "the Reload brings the card back ready, painted and shown").toMatchObject({ state: "ready", painted: true, visible: true });
        await app.body(A).waitForCondition<boolean>(SETTLED_WITH_LAST, { timeoutMs: 10_000 });
        expect(await app.evalJS<boolean>(`${placard} === null`), "the placard is gone").toBe(true);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
