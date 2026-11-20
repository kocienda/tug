/**
 * at0862-new-arc.test.ts — New Arc, the button in the short arc shade and
 * Session ▸ New Arc, sends `/arc` as a turn in the session it is pressed in,
 * and is dimmed where it has nothing to run in.
 *
 * What is read:
 *
 *   1. A Session card with no session yet: Session ▸ New Arc is dimmed.
 *   2. Bound and idle: the item is live, and the short shade's New Arc
 *      button is live beside its help link, with no `/arc` left to type.
 *   3. A press on the button sends the arc door as this session's turn,
 *      once, from this card; while that turn runs both the button and the
 *      menu item are dimmed, and they come back when it ends.
 *   4. Performing Session ▸ New Arc as the menu performs it sends the door
 *      again, from the same card.
 *
 * Dimmed with an arc is read in `at0859`, whose session has a real seat for
 * an arc to bind to. This one binds by the harness's fake bind, so the turn
 * New Arc sends reaches no claude: it stays in flight until the test ends it.
 *
 * @covers tugdeck/src/components/tugways/cards/session-arc-shade-hint.tsx
 * @covers tugdeck/src/components/tugways/cards/session-arc-shade-hint.css
 * @covers tugdeck/src/components/tugways/cards/session-arc-shade-content.tsx
 * @covers tugdeck/src/components/tugways/cards/use-menu-state-publication.ts
 * @covers tugdeck/src/lib/host-menu-state.ts
 * @covers tugapp/Sources/MenuBarBuilder.swift
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0862-session";
const FEED_CODE_OUTPUT = 0x40;
const MENU_ITEM = "session.newArc";

const CARD = '[data-card-id="A"]';
const SHADE = `${CARD} [data-slot="session-arc-shade"]`;
const HINT = `${SHADE} [data-slot="session-arc-shade-hint"]`;
const BUTTON = `${HINT} [data-slot="session-arc-shade-hint-new-arc"]`;
const COMPOSER = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const STATE_CELL = `${CARD} [data-slot="tug-status-cell"][data-priority="state"]`;

interface LifecycleEvent {
  kind: string;
  event?: string;
  fields?: { card_id?: string; name?: string };
}

/** Poll until the item's validated enabled state matches, and return it. */
async function menuEnabled(app: App, want: boolean, timeoutMs = 8_000): Promise<boolean | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: { found: boolean; enabled?: boolean } = { found: false };
  while (Date.now() < deadline) {
    last = await app.menuItemState(MENU_ITEM);
    if (last.found && last.enabled === want) return last.enabled;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last.found ? last.enabled : undefined;
}

/** Wait until the shade's New Arc button reads `live`, and return what it reads. */
async function buttonLive(app: App, live: boolean): Promise<boolean> {
  const expr = `(() => {
    const b = document.querySelector(${JSON.stringify(BUTTON)});
    if (b === null) return null;
    return !(b.disabled || b.getAttribute("aria-disabled") === "true");
  })()`;
  try {
    // The wait answers with its condition, which is true once the button
    // reads `live`; what it read is `live` itself.
    await app.body("A").waitForCondition<boolean>(`(${expr}) === ${live}`, { timeoutMs: 8_000 });
    return live;
  } catch {
    // Say what the session reads, so a miss names its state.
    const state = await app.body("A").evalJS<string>(
      `(document.querySelector(${JSON.stringify(STATE_CELL)})?.textContent ?? "none").trim()`,
    );
    note("at0862 button missed", JSON.stringify({ want: live, state }));
    return (await app.body("A").evalJS<boolean | null>(expr)) ?? !live;
  }
}

/** The arc door sends this card's page has logged. */
async function sends(app: App): Promise<LifecycleEvent[]> {
  const trace = (await app.body("A").getDeckTrace({})) as unknown as readonly LifecycleEvent[];
  return trace.filter((e) => e.kind === "session-lifecycle" && e.event === "new_arc.sent");
}

async function sendsReach(app: App, count: number): Promise<LifecycleEvent[]> {
  const deadline = Date.now() + 10_000;
  let seen = await sends(app);
  while (seen.length < count && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    seen = await sends(app);
  }
  return seen;
}

describe.skipIf(!SHOULD_RUN)("AT0862: New Arc", () => {
  test(
    "the button and the menu item send /arc in this session, and dim with no session and mid-turn",
    async () => {
      const app = await launchTugApp({ testName: "at0862-new-arc" });
      try {
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );

        // ── No session yet: nothing to run /arc in ────────────────────────
        expect(await menuEnabled(app, false), "New Arc is dimmed on a card with no session").toBe(false);

        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");
        const frame = (decoded: Record<string, unknown>) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: { tug_session_id: SID, ...decoded },
          });
        const endTurn = async (msgId: string): Promise<void> => {
          await frame({ type: "turn_complete", seq: 0, msg_id: msgId, result: "success" });
        };

        // ── Bound and idle: both doors are live ───────────────────────────
        expect(await menuEnabled(app, true), "New Arc is live on an idle session with no arc").toBe(true);
        await app.body("A").nativeClickAtElement(COMPOSER);
        await app.dispatchControlAction("toggle-arc-shade");
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHADE)})?.getAttribute("data-raised") === "true"`,
          { timeoutMs: 10_000 },
        );
        const hint = await app.body("A").evalJS<{ text: string; code: number; label: string; help: boolean }>(
          `(() => {
             const hint = document.querySelector(${JSON.stringify(HINT)});
             const text = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
             return {
               text: text(hint.querySelector(".session-arc-shade-hint-text")),
               code: hint.querySelectorAll("code").length,
               label: text(hint.querySelector(${JSON.stringify(BUTTON)})),
               help: hint.querySelector('[data-slot="session-arc-shade-hint-help"]') !== null,
             };
           })()`,
        );
        note("at0862 hint", JSON.stringify(hint));
        expect(hint.label, "the shade offers New Arc").toBe("New Arc");
        expect(hint.code, "in place of a command to type").toBe(0);
        expect(hint.text, "and still says what an arc is").toContain("An arc is");
        expect(hint.help, "beside the help link").toBe(true);
        expect(await buttonLive(app, true), "the button is live on an idle session").toBe(true);

        // ── The button sends the door, and dims while its turn runs ───────
        await app.body("A").nativeClickAtElement(BUTTON);
        // The turn is in flight from the press: read the dimming first.
        expect(await buttonLive(app, false), "the button is dimmed while the turn runs").toBe(false);
        expect(await menuEnabled(app, false), "and so is the menu item").toBe(false);
        const first = await sendsReach(app, 1);
        note("at0862 first send", JSON.stringify(first));
        expect(first.length, "one press, one send").toBe(1);
        expect(first[0]?.fields?.card_id, "from this card").toBe("A");
        expect(first[0]?.fields?.name, "and it is the arc door").toMatch(/(^|:)arc$/);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelectorAll('${CARD} [data-testid="session-card-transcript-user-body"]').length === 1`,
          { timeoutMs: 10_000 },
        );

        await endTurn("m1");
        expect(await buttonLive(app, true), "the button comes back when the turn ends").toBe(true);
        expect(await menuEnabled(app, true), "and so does the menu item").toBe(true);

        // ── The menu item, performed as the menu performs it ──────────────
        const performed = await app.performMenuItem(MENU_ITEM);
        note("at0862 menu item", JSON.stringify(performed));
        expect(performed.found, "the Session menu holds New Arc").toBe(true);
        if (!performed.found) return;
        expect(performed.title).toBe("New Arc");
        expect(performed.enabled && performed.performed, "New Arc is live and performs").toBe(true);
        const second = await sendsReach(app, 2);
        note("at0862 sends", JSON.stringify(second));
        expect(second.length, "the menu item sends the door once more").toBe(2);
        expect(second[1]?.fields?.card_id, "in the same card").toBe("A");
        expect(await menuEnabled(app, false), "and dims while that turn runs").toBe(false);
        await endTurn("m2");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
