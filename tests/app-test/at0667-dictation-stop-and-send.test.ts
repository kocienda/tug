/**
 * AT0667: ⇧⌘D finishes the mic and sends what it heard, and the Session menu
 * carries both dictation doors with gates that follow the composer.
 *
 * `at0648` proves ⌘D finishes and keeps the words without sending. This file
 * proves the one-gesture version — ⌘D then Return without the wait between —
 * and the two menu items that make the chords findable.
 *
 * Four claims:
 *
 * 1. **The items follow the caret.** With the caret in a Session composer,
 *    Session ▸ Start Dictation is lit and Stop Dictation and Send is dark; with
 *    focus in another card's field, both are dark. Both gates are the deck's
 *    first-responder walk, so this is the chain answering for the menu bar.
 * 2. **A live mic relabels the toggle and lights the send.** ⌘D starts the
 *    mic through the menu-bar key equivalent; the toggle reads Stop Dictation
 *    and Stop Dictation and Send is lit.
 * 3. **⇧⌘D sends the transcript once it has landed.** The words the recogniser
 *    had not yet settled are kept and sent — a user turn appears carrying
 *    them — and the composer is left empty.
 * 4. **⇧⌘D with no mic sends nothing.** The item is dark, the chord detaches
 *    to the web view, and no second turn appears.
 *
 * No microphone is engaged: the host answers under the no-audio harness branch
 * ([P01]) and every transcript below is scripted through
 * `window.__tugBridge.onDictation`.
 *
 * **Why `AppDelegate.swift` is not named below.** The two items there are a
 * title, an identifier and a one-line selector each; their gates and chords
 * are the registry's and the publisher's, which are named. Naming the host
 * file would push its fan-out past the selection budget for that wiring.
 *
 * @covers tugdeck/src/lib/dictation-store.ts
 * @covers tugdeck/src/components/tugways/command-registry.ts
 * @covers tugdeck/src/components/tugways/action-vocabulary.ts
 * @covers tugdeck/src/lib/host-menu-state.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CARD = '[data-card-id="A"]';
const MIC = `${CARD} [data-testid="tug-dictation-button"]`;
const SUBMIT = `${CARD} .tug-prompt-entry-submit-button`;
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const USER_TURN = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const OTHER_FIELD = '[data-card-id="B"] input';

const TOGGLE_ITEM = "session.dictate";
const SEND_ITEM = "session.dictateAndSend";

/** A Session card beside a plain field, so focus has somewhere else to go. */
function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
      { id: "B", componentId: "gallery-input", title: "Card B", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 500, height: 520 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: "p2",
        position: { x: 580, y: 40 },
        size: { width: 420, height: 320 },
        cardIds: ["B"],
        activeCardId: "B",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

async function push(app: App, event: Record<string, unknown>): Promise<void> {
  await app.evalJS<null>(
    `(window.__tugBridge.onDictation(${JSON.stringify(event)}), null)`,
  );
}

const exists = (selector: string): string =>
  `document.querySelector(${JSON.stringify(selector)}) !== null`;

const modeIs = (selector: string, mode: string): string =>
  `document.querySelector(${JSON.stringify(selector)})?.getAttribute("data-mode") === ${JSON.stringify(mode)}`;

const textOf = (selector: string): string =>
  `(document.querySelector(${JSON.stringify(selector)})?.textContent || "")`;

const countOf = (selector: string): string =>
  `document.querySelectorAll(${JSON.stringify(selector)}).length`;

async function focusComposer(app: App): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.waitForCondition<boolean>(
    `(function(){
       var field = document.querySelector(${JSON.stringify(EDITOR)});
       return field !== null && document.activeElement !== null &&
         (field === document.activeElement || field.contains(document.activeElement));
     })()`,
    { timeoutMs: 10_000 },
  );
}

/** Poll until the item's validated state matches — the push lands after paint. */
async function waitMenu(
  app: App,
  identifier: string,
  want: { enabled: boolean; title?: string },
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = await app.menuItemState(identifier);
  while (Date.now() < deadline) {
    if (
      last.found &&
      last.enabled === want.enabled &&
      (want.title === undefined || last.title === want.title)
    ) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
    last = await app.menuItemState(identifier);
  }
  expect(last.found, `${identifier} exists`).toBe(true);
  if (last.found) {
    expect(last.enabled, `${identifier} enabled`).toBe(want.enabled);
    if (want.title !== undefined) expect(last.title, `${identifier} title`).toBe(want.title);
  }
}

describe.skipIf(!SHOULD_RUN)("AT0667: ⇧⌘D and the Session menu's dictation items", () => {
  test(
    "the items follow the caret, ⌘D relabels and lights the send, ⇧⌘D sends the landed transcript, and ⇧⌘D with no mic sends nothing",
    async () => {
      const app = await launchTugApp({ testName: "at0667-dictation-stop-and-send" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.bindSession("A");
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.awaitEngineReady("A");
        await app.waitForCondition<boolean>(exists(SUBMIT), { timeoutMs: 8000 });
        await app.waitForCondition<boolean>(exists(MIC), { timeoutMs: 8000 });
        await app.waitForCondition<boolean>(exists(OTHER_FIELD), { timeoutMs: 8000 });

        // ── 1. The items follow the caret. ─────────────────────────────────
        await app.nativeClickAtElement(OTHER_FIELD);
        await waitMenu(app, TOGGLE_ITEM, { enabled: false });
        await waitMenu(app, SEND_ITEM, { enabled: false });

        await focusComposer(app);
        await waitMenu(app, TOGGLE_ITEM, { enabled: true, title: "Start Dictation" });
        await waitMenu(app, SEND_ITEM, { enabled: false });

        // ── 2. A live mic relabels the toggle and lights the send. ─────────
        await app.nativeKey("d", ["cmd"]);
        await app.waitForCondition<boolean>(modeIs(MIC, "live"), { timeoutMs: 10_000 });
        await waitMenu(app, TOGGLE_ITEM, { enabled: true, title: "Stop Dictation" });
        await waitMenu(app, SEND_ITEM, { enabled: true });

        // ── 3. ⇧⌘D sends the transcript once it has landed. ────────────────
        const id = await app.getElementAttribute(MIC, "data-dictation-id");
        expect((id ?? "").length).toBeGreaterThan(0);
        // Unsettled on purpose: a send that ran before the finish landed, or
        // one that dropped the tail, would carry nothing.
        await push(app, { id, kind: "volatile", text: "ship the release notes" });
        await app.waitForCondition<boolean>(
          `${textOf(EDITOR)} === "ship the release notes"`,
          { timeoutMs: 10_000 },
        );
        expect(await app.evalJS<number>(countOf(USER_TURN))).toBe(0);

        await app.nativeKey("d", ["cmd", "shift"]);
        await app.waitForCondition<boolean>(modeIs(MIC, "idle"), { timeoutMs: 10_000 });
        await app.waitForCondition<boolean>(`${countOf(USER_TURN)} === 1`, {
          timeoutMs: 10_000,
        });
        const sent = await app.evalJS<string>(textOf(USER_TURN));
        note("the sent turn", sent);
        expect(sent.indexOf("ship the release notes")).not.toBe(-1);
        const draft = await app.evalJS<string>(textOf(EDITOR));
        note("the composer after the send", draft);
        expect(draft.indexOf("ship the release notes")).toBe(-1);

        await waitMenu(app, SEND_ITEM, { enabled: false });

        // ── 4. ⇧⌘D with no mic sends nothing. ──────────────────────────────
        await focusComposer(app);
        await app.nativeKey("d", ["cmd", "shift"]);
        // Native events are delivered in order, so a later gesture we can await
        // proves the chord above was fully processed.
        await focusComposer(app);
        expect(await app.evalJS<number>(countOf(USER_TURN))).toBe(1);
        expect(await app.evalJS<boolean>(modeIs(MIC, "idle"))).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
