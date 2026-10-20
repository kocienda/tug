/**
 * at0743-body-close-unanswered.test.ts — a body card that does not answer its
 * close decision says so on its pane, rather than the close silently not
 * happening.
 *
 * ## What this gates
 *
 * A close the shell carries out asks a body card's own guard
 * (`card.closeDecision`) whatever it says it needs. A clean Text card's guard
 * says it will not ask, so the shell waits on the body's page with a deadline
 * ([L33]); a page that is busy past it is not answering. Before, that ended
 * in a dev-log line and a close that did not happen: the person pressed the ×
 * and nothing visible came of it.
 *
 * The front card draws its pane's tab bar in its own page, and a × pressed
 * there on its own tab is decided in that page; the × on a sibling's tab is
 * the shell's close, which asks the sibling's page. So B's page is held busy
 * (a main-thread loop longer than the deadline), B's × is pressed in A's
 * page, and B is fronted so its banner can stand. Then the shell is read: B
 * still stands, and a status banner on its pane says the card did not
 * answer, naming Option-click on the close box — which closes without
 * asking — as the way out. The banner is the card's, not the pane's:
 * fronting the other tab takes it down.
 *
 * @covers tugdeck/src/lib/close-decision.ts
 * @covers tugdeck/src/lib/close-refusal-store.ts
 * @covers tugdeck/src/components/chrome/card-host.tsx
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { launchTugApp, note } from "./_harness";
import { ORIGINAL, SHOULD_RUN, waitForEditor } from "./text-card-manual-save-fixture";

const TEST_TIMEOUT_MS = 60_000;
const BANNER = '[data-pane-id="p1"] [data-slot="tug-pane-banner"][data-visible="true"]';

describe.skipIf(!SHOULD_RUN)("at0743: a body card that does not answer its close", () => {
  test(
    "the tab × on a busy body card's tab leaves the card standing under a banner that says it did not answer",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0743-"));
      const fileA = path.join(dir, "a.txt");
      const fileB = path.join(dir, "b.txt");
      fs.writeFileSync(fileA, ORIGINAL, "utf8");
      fs.writeFileSync(fileB, "other\n", "utf8");
      const app = await launchTugApp({ testName: "at0743-close-unanswered" });
      try {
        // Two clean Text cards in one pane, so the tab bar renders; A is active.
        await app.seedDeckState({
          state: {
            cards: [
              { id: "A", componentId: "text", title: "File", closable: true },
              { id: "B", componentId: "text", title: "File", closable: true },
            ],
            panes: [
              {
                id: "p1",
                position: { x: 40, y: 40 },
                size: { width: 760, height: 560 },
                cardIds: ["A", "B"],
                activeCardId: "A",
                title: "",
                acceptsFamilies: ["standard"],
              },
            ],
            activePaneId: "p1",
            hasFocus: true,
          },
          cardStates: {
            A: { content: { path: fileA, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
            B: { content: { path: fileB, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
          },
          focusCardId: "A",
        });
        await waitForEditor(app.body("A"), "alpha");
        await app.body("B").waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector('[data-card-id="B"] [data-slot="tug-text-card-editor"] .cm-content');
            return el !== null && el.innerText.indexOf("other") !== -1;
          })()`,
          { timeoutMs: 15000 },
        );

        // Hold B's page busy past the shell's 2 s close deadline. The loop
        // starts after this eval returns, so the eval itself answers.
        await app
          .body("B")
          .evalJS<boolean>(`(setTimeout(function(){var t=Date.now();while(Date.now()-t<4000){}},0), true)`);
        // B's × on the tab bar A's page draws: the shell's close, which asks
        // B's busy page. Then B is fronted, from the same bar, so the banner
        // the refusal raises is the tab shown.
        await app.body("A").click(`[data-testid="tug-tab-close-B"]`);
        await app.body("A").click(`[data-testid="tug-tab-B"]`);

        // card-dom: shell — the banner is pane chrome, drawn by the shell over the body.
        try {
          await app.waitForCondition<boolean>(`document.querySelector('${BANNER}') !== null`, { timeoutMs: 6000 });
        } catch (error) {
          // What the shell holds when the banner never came: any banner at all, the placeholders, the bodies.
          note(
            "no banner",
            await app.evalJS<unknown>(
              `({banners: Array.from(document.querySelectorAll('[data-slot="tug-pane-banner"]')).map(function(e){return {visible: e.getAttribute('data-visible'), inPane: e.closest('[data-pane-id]') ? e.closest('[data-pane-id]').getAttribute('data-pane-id') : null}}),
                placeholders: Array.from(document.querySelectorAll('[data-body-placeholder]')).map(function(e){return e.getAttribute('data-card-id')})})`,
            ),
          );
          note("bodies", (await app.bodies()).map((b) => ({ cardId: b.cardId, state: b.state })));
          throw error;
        }
        const text = await app.evalJS<string>(`document.querySelector('${BANNER}').innerText`);
        expect(text).toContain("Not closed");
        expect(text).toContain("Option-click");

        // The close did not happen: the card is still in the deck, and its body still stands.
        const cards = await app.evalJS<string[]>(
          `Array.from(document.querySelectorAll('[data-body-placeholder]')).map(function(e){return e.getAttribute('data-card-id')})`,
        );
        expect(cards).toContain("B");
        expect((await app.bodies()).some((b) => b.cardId === "B")).toBe(true);

        // The banner says this card did not answer, so it does not stand over
        // the card beside it: fronting A takes it down. The tab bar is the
        // front card's page's, B's, which answers again once its loop is done.
        await app.body("B").click(`[data-testid="tug-tab-A"]`);
        // card-dom: shell — the banner is pane chrome.
        await app.waitForCondition<boolean>(`document.querySelector('${BANNER}') === null`, { timeoutMs: 3000 });
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
