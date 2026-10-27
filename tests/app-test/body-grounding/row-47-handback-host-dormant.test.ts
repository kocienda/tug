/**
 * row-47-handback-host-dormant.test.ts — a hidden body goes dormant on the
 * host's clock alone, the page's own clock left long.
 *
 * The host's dormant clock is the one WebKit cannot freeze: a hidden page's
 * timers may be suspended, so the page's own clock cannot be what puts it to
 * sleep. Here only the host's delay is shortened and every page keeps its
 * five-minute constant, so whatever puts the body to sleep within seconds is
 * the host. The Session card's workspace is parked; the host's log says it
 * declared the card dormant — the line written as it tells tugcast — and the
 * page, told by the host, reads dormant though its own clock is nowhere near
 * due.
 *
 * @family row-47
 * @covers tugapp/Sources/BodyState.swift
 * @covers tugdeck/src/lib/body-visibility-store.ts
 * @covers tugrust/crates/tugcast/src/actions.rs
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "../_harness";
import { stubDirectory, STUB_TRANSCRIPT_DIR_ENV } from "../streaming-stub-fixture";
import { bodyOf, pollFor, sessionPane, settleFor, spawnStub, waitForBody } from "./_bodies";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "r47h-a";
/** The host's delay before dormancy, shortened; the pages keep their constant. */
const HOST_DORMANT_AFTER_MS = 800;
/** Eviction held far off, so the body stays dormant rather than going. */
const EVICT_AFTER_MS = 600_000;
/** How long past the host's delay the declaration may take to land. */
const DECLARED_WITHIN_MS = 3_000;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: A, componentId: "session", title: "A", closable: true }],
    panes: [sessionPane(A, 0)],
    activePaneId: `${A}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** The host's `bodies dormant` lines for `cardId`, from its own log. */
function declarations(log: string, cardId: string): string[] {
  return log.split("\n").filter((line) => line.includes("tugapp::bodies: dormant") && line.includes(`card=${cardId}`));
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 47: a hidden card's hand-back", () => {
  test(
    "a parked body goes dormant on the host's clock with the page's clock left long",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({ testName: "body-grounding-row-47-handback-host-dormant", env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        await spawnStub(app, A, stubDir);
        await waitForBody(app, A);
        const body = app.body(A);
        await app.bodyDelays({ dormantAfterMs: HOST_DORMANT_AFTER_MS, pageDormantAfterMs: null, evictAfterMs: EVICT_AFTER_MS });
        expect(declarations(app.tugappLog(), A), "no declaration while the card is shown").toEqual([]);

        // ---- Parked: the host's clock runs, the page's stays minutes off ----
        const home = await app.evalJS<string>(ACTIVE_SPACE);
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("new-space"), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id !== home, 5_000);
        await pollFor(() => bodyOf(app, A), (b) => b?.shown === false, 5_000);
        const hiddenAt = Date.now();

        // ---- The host declares it, to tugcast and in its log ----
        const declared = await settleFor(
          () => Promise.resolve(declarations(app.tugappLog(), A)),
          (lines) => lines.length > 0,
          HOST_DORMANT_AFTER_MS + DECLARED_WITHIN_MS,
        );
        note(`the host declared ${A} dormant ${Date.now() - hiddenAt} ms after the hide: ${declared[0]?.trim() ?? "no line"}`);
        expect(declared.at(-1) ?? "", "the host's last word on the card is dormant").toContain("dormant=yes");

        // ---- And the page hears it from the host, its own clock not due ----
        const told = await settleFor(
          () => body.evalJS<{ shown: boolean; dormant: boolean }>("window.__tug.bodyDormancy()"),
          (d) => d.dormant,
          DECLARED_WITHIN_MS,
        );
        const asleepAt = Date.now() - hiddenAt;
        note(`the page reads dormant ${asleepAt} ms after the hide, on a page clock of five minutes`);
        expect({ shown: told.shown, dormant: told.dormant }, "the page is hidden and dormant on the host's word").toEqual({ shown: false, dormant: true });
        expect(asleepAt, "well before the page's own clock could have run").toBeLessThan(30_000);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
