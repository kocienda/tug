/**
 * at0412-dash-review-verb.test.ts — `/dash-review` typed in the card.
 *
 * `/dash-review` is an ordinary turn on whatever model is selected. **Nothing
 * switches the model** — not before the turn, not after it. That is the whole
 * point of the gesture: the moment before clicking the chip is the user's
 * moment to choose a model, and a surface that moved the selection out from
 * under them would take that choice away.
 *
 * So the load-bearing assertion here is a *negative* one: a card sitting on
 * Sonnet is still on Sonnet while the review turn runs, and still on Sonnet
 * after it settles. The chip never says Opus at any point. This replaces the
 * borrow/announce/release machine that used to live behind this verb — it was
 * removed, along with the `plan_review_request` broadcast, because a review
 * scheduled on the user's behalf could silently never happen.
 *
 * **The command is typed, not injected, and the completion popup is not
 * dismissed.** Submitting runs `editor.acceptActiveCompletion()` first, so what
 * reaches the matcher may be a command *atom* rather than plain text — and
 * `matchLocalSlashCommand` only inspects strings. It still matches, because
 * `buildSlashCommandLine` reconstructs a plain `/name …` line from the draft
 * first. That flattening is shipped behavior on the path a user actually takes,
 * so the test exercises it instead of pressing Escape to route around it.
 *
 * The second gesture is the one the resolution order exists for: a **bare**
 * `/dash-review`, which must land on the plan this card just reviewed. That
 * value round-trips through the real tugbank, so a resolver that read the wrong
 * domain or never wrote at submit fails here and nowhere else.
 *
 * @covers tugdeck/src/lib/dash-review-target.ts
 * @covers tugdeck/src/lib/slash-commands.ts
 * @covers tugdeck/src/lib/model-domains.ts
 * @covers tugdeck/src/lib/use-model.ts
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "at0412-session";
const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const CHIP_VALUE = `${CARD} [data-slot="ai-chip"] [data-slot="ai-chip-value"]`;
const USER_ROWS = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const FEED_CODE_OUTPUT = 0x40;

const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));

const settle = (ms = 800): Promise<unknown> =>
  new Promise((r) => setTimeout(r, ms));

/** A catalog where `sonnet` and `opus` are genuinely distinct rows. */
function capabilities() {
  return {
    type: "session_capabilities",
    models: [
      {
        value: "default",
        displayName: "Default (recommended)",
        description: "Chosen for you",
      },
      { value: "opus", displayName: "Opus 5", description: "Opus 5" },
      { value: "sonnet", displayName: "Sonnet 5", description: "Sonnet 5" },
    ],
    commands: [],
    agents: [],
    ipc_version: 2,
  };
}

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 680 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

const chipText = (app: App): Promise<string> =>
  app.evalJS<string>(
    `(document.querySelector(${JSON.stringify(CHIP_VALUE)})?.textContent ?? "").trim()`,
  );

const userRowCount = (app: App): Promise<number> =>
  app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length`,
  );

/** The persisted per-card selector, as served bytes. */
async function persistedModel(app: App, tag: string): Promise<string> {
  const slot = `__at0412_${tag}`;
  await app.evalJS(`(() => {
    window.${slot} = undefined;
    fetch("/api/defaults/dev.model/A")
      .then((r) => r.text())
      .then((t) => { window.${slot} = t; })
      .catch((e) => { window.${slot} = "ERR:" + String(e); });
  })()`);
  return app.waitForCondition<string>(
    `window.${slot} === undefined ? false : window.${slot}`,
    { timeoutMs: 8000 },
  );
}

/**
 * Type a line into the prompt and submit it — deliberately without dismissing
 * the completion popup, so the draft reaches the matcher the way a user's does.
 */
async function runCommand(app: App, line: string): Promise<void> {
  await app.nativeClickAtElement(PROMPT);
  await app.nativeType(line);
  await settle(400);
  await app.nativeKey("Return", ["cmd"]);
}

/** Settle the turn in flight the way the wire would. */
async function settleTurn(app: App, msgId: string): Promise<void> {
  const frame = (decoded: Record<string, unknown>): Promise<void> =>
    app.driveSession("A", {
      op: "ingestFrame",
      feedId: FEED_CODE_OUTPUT,
      decoded: { tug_session_id: SID, ...decoded },
    });
  await frame({ type: "content_block_start", msg_id: msgId, block_index: 0, kind: "text" });
  await frame({
    type: "assistant_text",
    msg_id: msgId,
    block_index: 0,
    text: "reviewed",
    is_partial: false,
  });
  await frame({ type: "turn_complete", msg_id: msgId, result: "success" });
}

/** The last user row's command atom label and its text. */
function submittedRow(app: App): Promise<{ chipLabel: string | null; text: string }> {
  return app.evalJS<{ chipLabel: string | null; text: string }>(
    `(() => {
       const rows = document.querySelectorAll(${JSON.stringify(USER_ROWS)});
       const row = rows[rows.length - 1];
       if (row === undefined) return { chipLabel: null, text: "" };
       const chip = row.querySelector("svg.tug-atom-chip");
       return {
         chipLabel: chip === null ? null : chip.getAttribute("aria-label"),
         text: (row.textContent ?? "").trim(),
       };
     })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0412: the /dash-review card verb", () => {
  test(
    "the review runs on the selected model and never moves it; a bare invocation lands on the plan just reviewed",
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), "at0412-"));
      const planPath = join(scratch, "plan.md");
      writeFileSync(
        planPath,
        "## A plan {#a-plan}\n\n### Execution Steps {#execution-steps}\n",
      );

      const app = await launchTugApp({ testName: "at0412-dash-review-verb" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID, projectDir: PROJECT_DIR });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // A card that remembers Sonnet, running Sonnet.
        await app.evalJS(`(() => {
          window.__at0412_seeded = false;
          fetch("/api/defaults/dev.model/A", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "string", value: "sonnet" }),
          })
            .then(() => { window.__at0412_seeded = true; })
            .catch(() => { window.__at0412_seeded = true; });
        })()`);
        await app.waitForCondition<boolean>(`window.__at0412_seeded === true`, {
          timeoutMs: 8000,
        });
        await app.ingestSessionMetadata("A", capabilities());
        await app.ingestSessionMetadata("A", {
          type: "system_metadata",
          model: "sonnet",
          ipc_version: 2,
        });
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(CHIP_VALUE)})?.textContent ?? "").indexOf("Sonnet") !== -1`,
          { timeoutMs: 10000 },
        );
        const before = await persistedModel(app, "before");
        note("at0412 persisted model before", before);

        // ── The typed gesture, with an explicit path ─────────────────────
        await runCommand(app, `/dash-review ${planPath}`);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length === 1`,
          { timeoutMs: 10000 },
        );

        // The turn carries the command ATOM — `submission.text` never holds a
        // literal "/tugplug:dash-review", so a string assertion would fail on a
        // working implementation.
        const explicit = await submittedRow(app);
        note("at0412 explicit submission", JSON.stringify(explicit));
        expect(explicit.chipLabel).toBe("/tugplug:dash-review");
        expect(explicit.text).toContain(planPath);

        // The card is on Sonnet and STAYS on Sonnet. Asserted while the review
        // turn is in flight, which is exactly when the old borrow would have
        // swapped the chip to Opus.
        expect(
          await chipText(app),
          "the review runs on the selected model — nothing borrows",
        ).toContain("Sonnet");

        const shot = await app.screenshot();
        note("at0412 the typed review on the selected model", shot.path);

        // ── That turn settles: still nothing moved ───────────────────────
        await settleTurn(app, "m-review-1");
        await settle();
        expect(await chipText(app)).toContain("Sonnet");

        // ── Bare: last-reviewed resolves it, through the real tugbank ────
        await runCommand(app, "/dash-review");
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length === 2`,
          { timeoutMs: 10000 },
        );
        const bare = await submittedRow(app);
        note("at0412 bare submission", JSON.stringify(bare));
        expect(bare.chipLabel).toBe("/tugplug:dash-review");
        expect(
          bare.text,
          "a bare /dash-review resolves to the plan this card last reviewed",
        ).toContain(planPath);
        expect(await chipText(app)).toContain("Sonnet");

        await settleTurn(app, "m-review-2");
        await settle();

        // Exactly two turns went out across both gestures.
        expect(await userRowCount(app)).toBe(2);
        expect(await chipText(app)).toContain("Sonnet");

        // ── And the persisted selector is untouched throughout ───────────
        const after = await persistedModel(app, "after");
        note("at0412 persisted model after", after);
        expect(after).toBe(before);
      } finally {
        await app.close();
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
