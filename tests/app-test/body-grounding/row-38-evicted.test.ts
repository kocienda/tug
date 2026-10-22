/**
 * row-38-evicted.test.ts — a card whose body was evicted under memory
 * pressure comes back as an arrival when it is shown, with nothing of the
 * canvas or the bare window at any frame, and with its draft and its turns.
 *
 * Two Session cards share a pane. The second resumes a transcript of plain
 * turns and takes a draft in its composer, saved to the run's tugbank file;
 * then the first tab is chosen, so the second stands behind it as a sibling,
 * still painting. Critical pressure — the host's stand-in for the dispatch
 * source — evicts every body not placed visible, the sibling and the spare
 * with them: the sibling's page writes its card's state, the host keeps
 * no frame — a snapshot under critical pressure would make the sleeping page
 * paint when memory is shortest — and the view goes. Choosing the second tab
 * again asks for its body, cold since critical pressure leaves no spare, and
 * with no cover the card arrives as any card does: its stand-in stands until
 * the new page paints.
 *
 * From the tab's choosing every composited frame is read by row 44's judge
 * (`_row-44.ts`'s `readGesture`): the pane's box shows no more of the canvas
 * than it does settled, its title band holds the settled title, the host's
 * hand-over at the choosing landed, and no face stands once the page has
 * painted. The body is back ready and painted, its transcript settled with
 * the last turn in it and its composer holding the draft.
 *
 * @family row-38
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/body-cards-store.ts
 * @covers tugdeck/src/lib/card-placement.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import { claudeProjectDir } from "../_harness/claude-home";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankRead } from "../_harness/tugbank-helpers";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { bodyOf, composerText, focusBody, pollFor, settleFor } from "./_bodies";
import { readGesture } from "./_row-44";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const A = "r38-a";
const B = "r38-b";
const TURNS = 50;
const DRAFT = "row38 draft before the eviction";
const LAST_TURN = `Turn ${TURNS}: the last reading`;
const CARDSTATE = "dev.tugapp.deck.cardstate";

function deck(): Record<string, unknown> {
  return {
    cards: [
      { id: A, componentId: "session", title: "A", closable: true },
      { id: B, componentId: "session", title: "B", closable: true },
    ],
    panes: [
      {
        id: "r38-pane",
        position: { x: 40, y: 40 },
        size: { width: 640, height: 480 },
        cardIds: [A, B],
        activeCardId: B,
        title: "",
        acceptsFamilies: ["maker"],
        slot: 0,
      },
    ],
    activePaneId: "r38-pane",
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

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
        id: `msg-r38-${i}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: `### ${heading}\n\nThe walk took ${(i * 7) % 23 + 1} ms, and the cache held ${120 + ((i * 37) % 900)} rows.` }],
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
    if (!window.__tug.sessionSettled(${JSON.stringify(B)})) return false;
    var t = document.querySelector('[data-testid="session-card-transcript"]');
    return t !== null && (t.textContent || "").indexOf(${JSON.stringify(LAST_TURN)}) >= 0;
  } catch (e) { return false; }
})()`;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The shell's placeholder for `cardId`, in viewport points, or null while it has no box. */
const placeholderRect = (app: App, cardId: string): Promise<Rect | null> =>
  // card-dom: shell — the placeholder is the shell's.
  app.evalJS<Rect | null>(
    `(function () {
      var el = document.querySelector('[data-body-placeholder][data-card-id="${cardId}"]');
      if (el === null) return null;
      var r = el.getBoundingClientRect();
      return r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    })()`,
  );

describe.skipIf(!SHOULD_RUN)("body-grounding row 38: the evicted body", () => {
  test(
    "a sibling evicted under critical pressure comes back when its tab is chosen, holding row 1's bar, with its draft and its turns",
    async () => {
      const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-r38-project-")));
      const fixtureDir = claudeProjectDir(projectDir);
      mkdirSync(fixtureDir, { recursive: true });
      onTestRunEnd(() => {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(fixtureDir, { recursive: true, force: true });
      });
      const sid = "a7c0d1ea-0038-4000-8000-000000000050";
      writeFileSync(join(fixtureDir, `${sid}.jsonl`), sessionJsonl(projectDir, sid, TURNS));
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const app = await launchTugApp({
        testName: "body-grounding-row-38-evicted",
        persistInTestMode: true,
        restoreInTestMode: true,
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: B });
        await pollFor(() => bodyOf(app, B), (b) => b?.state === "ready" && b.visible, 30_000);

        // ---- A resumed transcript and a draft, saved ----
        await app.spawnSessionResume(B, { tugSessionId: sid, projectDir });
        await app.body(B).waitForCondition<boolean>(SETTLED_WITH_LAST, { timeoutMs: 30_000 });
        await focusBody(app, B, { composer: true });
        await app.nativeType(DRAFT);
        await pollFor(() => app.body(B).evalJS<string | null>(composerText), (t) => t?.includes(DRAFT) === true, 5_000);
        const saved = await settleFor(
          async () => JSON.stringify(tugbankRead<unknown>(tugbankPath, CARDSTATE, B)?.value ?? null),
          (bag) => bag.includes(DRAFT),
          10_000,
        );
        expect(saved, "the draft is in the card's bag on disk before the eviction").toContain(DRAFT);

        // ---- The first tab chosen: the second stands behind it, painting ----
        await app.body(B).click(`[data-testid="tug-tab-${A}"]`);
        await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.visible, 10_000);
        const sibling = await settleFor(() => bodyOf(app, B), (b) => b !== null && !b.visible && b.shown, 5_000);
        expect(sibling, "the second card stands behind the first as a sibling, still painting").toMatchObject({ visible: false, shown: true });
        const rect = await settleFor(() => placeholderRect(app, A), (r) => r !== null, 5_000);
        expect(rect, "the pane's placeholder has a box").not.toBeNull();

        // ---- Critical pressure takes the sibling and the spare ----
        await app.simulateMemoryPressure("critical");
        const gone = await settleFor(
          () => app.bodies(),
          (all) => !all.some((b) => b.cardId === B) && !all.some((b) => b.cardId === null),
          5_000,
        );
        expect(gone.some((b) => b.cardId === B), "the sibling's body is evicted").toBe(false);
        expect(gone.some((b) => b.cardId === null), "the spare is evicted with it").toBe(false);
        expect((await bodyOf(app, A))?.visible, "the shown card keeps its body").toBe(true);

        // ---- The second tab chosen: an arrival with no cover, every frame read by row 44's judge ----
        const bad = await readGesture(app, () => app.body(A).click(`[data-testid="tug-tab-${B}"]`), [B], "row-38-evicted");
        const back = await bodyOf(app, B);
        expect(back?.wasCovered, "critical pressure kept no last frame, so the new body stood under no cover").toBe(false);
        expect(back, "the card's new body is ready, painted and shown, its cover gone").toMatchObject({ state: "ready", painted: true, visible: true, covered: false });
        expect(back?.start, "with no spare under critical pressure the new body is made cold").toBe("cold");
        await app.body(B).waitForCondition<boolean>(SETTLED_WITH_LAST, { timeoutMs: 10_000 });
        const draft = await settleFor(() => app.body(B).evalJS<string | null>(composerText), (t) => t?.includes(DRAFT) === true, 5_000);
        expect(draft, "the new body's composer holds the draft").toContain(DRAFT);
        note(`body ready ${back?.readyMs?.toFixed(0)} ms after its bind`);
        expect(bad, "no frame from the choosing shows more canvas than the settled pane or loses its title, and the hand-over landed").toEqual([]);
      } finally {
        await app.simulateMemoryPressure("normal").catch(() => undefined);
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
