/**
 * at0172-session-menu-live-state.test.ts — Session-menu validation
 * tracks live session state.
 *
 * Three live transitions on one bound session card:
 *
 *   1. **The AI item's live title** — the Session menu's one AI row is a
 *      state display, not just a door: its title carries the same composite
 *      the Z4B chip shows. Dispatching the menu's own
 *      `cycle-permission-mode` control action moves the chip AND the menu
 *      title together. (This replaced a radio-submenu checkmark assertion:
 *      the four mode items were deleted with the submenu, and a title that
 *      states the mode says more than a checkmark that marked it.)
 *   2. **Stop** — disabled idle, enabled the moment a turn is in
 *      flight (`canInterrupt`), disabled again after `turn_complete`.
 *   3. **Copy Last Response / Rewind** — flip enabled once the
 *      transcript commits a turn carrying an assistant message.
 *   4. **AI + Cycle Permission Mode** — the inverse of Stop: enabled idle,
 *      disabled mid-turn (`canChangeSettings` / `canSubmit`) so a settings
 *      change can never race the running turn, re-enabled at idle.
 *
 * The turn is driven through the real `CodeSessionStore` wire path
 * (`driveSession` send + ingestFrame — the at0099 pattern); the
 * mode change goes through `dispatchControlAction`, byte-identical to
 * the control frame the Swift menu item posts.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugdeck/src/lib/host-menu-state.ts
 * @covers tugdeck/src/lib/session-lifecycle.ts
 * @covers tugdeck/src/lib/card-session-binding-store.ts
 * @covers tugdeck/src/components/tugways/cards/ai-chip.tsx
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugdeck/src/components/tugways/cards/use-menu-state-publication.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0172-session";
const FEED_CODE_OUTPUT = 0x40;

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const MODE_CHIP = `${CARD} [data-slot="ai-chip"]`;

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 820, height: 620 },
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

/**
 * The mode the chip is SHOWING — the last token of its face, which is what
 * the user reads. The chip used to carry a native `title`
 * and this expression read that; the face is the more direct statement of the
 * same fact, and it does not move when the hover copy is reworded.
 */
function chipModeExpr(): string {
  const value = `${MODE_CHIP} [data-slot="ai-chip-value"]`;
  return `(function(){
    var e = document.querySelector(${JSON.stringify(value)});
    if (e === null) return null;
    var parts = (e.textContent || "").split(" \\u00b7 ");
    return parts[parts.length - 1];
  })()`;
}

/** Poll until the item's validated enabled state matches. */
async function waitMenuEnabled(
  app: App,
  identifier: string,
  wantEnabled: boolean,
  timeoutMs = 8000,
): Promise<{ found: boolean; enabled?: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let last: { found: boolean; enabled?: boolean } = { found: false };
  while (Date.now() < deadline) {
    last = await app.menuItemState(identifier);
    if (last.found && last.enabled === wantEnabled) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

async function expectEnabled(app: App, identifier: string, want: boolean): Promise<void> {
  const state = await waitMenuEnabled(app, identifier, want);
  expect(state.found, `${identifier} must exist`).toBe(true);
  expect(state.enabled, `${identifier} enabled=${want}`).toBe(want);
}

/**
 * Poll until the item's live title ends with `suffix`.
 *
 * A suffix rather than the whole title: the summary's leading model token
 * depends on what the session reports, and this test is about the mode moving,
 * not about which model a headless session resolves to.
 */
async function waitMenuTitleEndsWith(
  app: App,
  identifier: string,
  suffix: string,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastTitle: string | undefined;
  while (Date.now() < deadline) {
    const item = await app.menuItemState(identifier);
    if (item.found) {
      lastTitle = item.title;
      if (item.title.startsWith("AI: ") && item.title.endsWith(suffix)) return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(
    lastTitle,
    `${identifier} title should be "AI: …${suffix}"`,
  ).toBe(`AI: …${suffix}`);
}

describe.skipIf(!SHOULD_RUN)("AT0172: Session-menu live-state validation", () => {
  test(
    "the AI item title follows the mode; Stop tracks the turn; copy/rewind flip on a committed turn",
    async () => {
      const app = await launchTugApp({ testName: "at0172-live-state" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");

        // ── 1. The AI item's live title ──
        // Fresh session: the chip reads Default, and the menu item says so too
        // rather than carrying only the static "AI Settings…" door label.
        await app.waitForCondition<boolean>(
          `${chipModeExpr()} === "Default"`,
          { timeoutMs: 8000 },
        );
        await waitMenuTitleEndsWith(app, "session.ai", "Default…");

        // Focus the card so the key-card-scoped dispatch resolves it,
        // then fire the exact control action the menu item posts.
        await app.nativeClickAtElement(PROMPT_INPUT);
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("cycle-permission-mode"), null)`,
        );
        // default → acceptEdits is the cycle's first step.
        await app.waitForCondition<boolean>(
          `${chipModeExpr()} === "Accept Edits"`,
          { timeoutMs: 8000 },
        );
        // The menu title followed the chip — one published summary, two faces.
        await waitMenuTitleEndsWith(app, "session.ai", "Accept Edits…");

        // ── 2 + 3. Stop across a turn; copy/rewind on commit ──
        await expectEnabled(app, "session.stop", false);
        await expectEnabled(app, "edit.copyLastResponse", false);
        await expectEnabled(app, "session.rewind", false);
        // Transcript navigation shares Rewind's "there is a turn to move
        // to" gate: an empty transcript offers nowhere to step.
        await expectEnabled(app, "go.previousTurn", false);
        await expectEnabled(app, "go.lastTurn", false);

        const frame = (decoded: Record<string, unknown>) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: { tug_session_id: SID, ...decoded },
          });

        // A turn in flight: canInterrupt → Stop enables.
        await app.driveSession("A", { op: "send", text: "hello there" });
        await expectEnabled(app, "session.stop", true);

        // The AI controls lock mid-turn: the AI item and Cycle gate on
        // canChangeSettings (canSubmit) exactly like the Z4B chip, so a
        // settings change can never race the running turn.
        await expectEnabled(app, "session.ai", false);
        await expectEnabled(app, "session.permissionMode.cycle", false);

        // Commit the turn with an assistant message.
        await frame({ type: "prompt_anchor", promptUuid: "uuid-1" });
        await frame({ type: "content_block_start", msg_id: "m1", block_index: 0, kind: "text" });
        await frame({ type: "assistant_text", msg_id: "m1", block_index: 0, text: "hi", is_partial: false });
        await frame({ type: "turn_complete", msg_id: "m1", result: "success" });

        // Back to idle: Stop gates off; the committed transcript
        // enables Copy Last Response and Rewind; the Mode control unlocks.
        await expectEnabled(app, "session.stop", false);
        await expectEnabled(app, "session.ai", true);
        await expectEnabled(app, "session.permissionMode.cycle", true);
        await expectEnabled(app, "edit.copyLastResponse", true);
        await expectEnabled(app, "session.rewind", true);
        await expectEnabled(app, "go.previousTurn", true);
        await expectEnabled(app, "go.nextTurn", true);
        await expectEnabled(app, "go.firstTurn", true);
        await expectEnabled(app, "go.lastTurn", true);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0172-live-state] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
