/**
 * row-47-handback-idle-dot.test.ts — a turn that ends while its card's body
 * sleeps stills the card's dot within seconds.
 *
 * The app launches on two workspaces: the Session card's, shown, and one
 * holding a Cards rail, parked. The Session card streams a turn; the Cards
 * workspace is shown under it, which parks the Session card's, and its body
 * goes dormant past its shortened delay — dormant only, never evicted. Its
 * row's dot in the Cards body runs. The turn ends on tugcast, unheard by the
 * sleeping body: the session row's push carries the turn latch closed, and
 * the dot stills within seconds of the shell hearing it, rather than at a
 * horizon half an hour on.
 *
 * @family row-47
 * @covers tugdeck/src/lib/bodiless-facts-store.ts
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor/recorder.rs
 * @covers tugrust/crates/tugcast/src/session_ledger.rs
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { STREAM_PACE_MS, STUB_TRANSCRIPT_DIR_ENV, streamingTranscript, stubDirectory } from "../streaming-stub-fixture";
import { pollFor, promptPhase, sessionPane, settleFor, waitForBody } from "./_bodies";
import { standUpKind } from "./_kind-bodies";
import { cardKind, kindPane, kindSidebars } from "./_kinds";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "r47d-a";
const CARDS = "r47d-cards";
const SESSION_SPACE = "r47d-session";
const CARDS_SPACE = "r47d-cards-space";
/** The body's delay before dormancy, shortened; eviction is held far off so the card stays dormant. */
const DORMANT_AFTER_MS = 800;
const EVICT_AFTER_MS = 600_000;
const WORDS = 200;
/** How long the turn streams, at the stub's pace (a delta a word). */
const TURN_MS = WORDS * STREAM_PACE_MS;
/** How soon after the shell hears the turn's end the dot must still. */
const STILL_WITHIN_MS = 2_000;
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

function cardsDeck(): Record<string, unknown> {
  return {
    cards: [{ id: CARDS, componentId: "cards", title: "Cards", closable: true }],
    panes: [kindPane("cards", CARDS, 0)],
    activePaneId: `${CARDS}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: kindSidebars(["cards"]) },
    hasFocus: true,
  };
}

const LAYOUT = {
  version: 5,
  activeSpaceId: SESSION_SPACE,
  spaces: [
    { id: SESSION_SPACE, name: "Session", deck: deck() },
    { id: CARDS_SPACE, name: "Cards", deck: cardsDeck() },
  ],
};

/** In the Cards body: the state of the dot on the row for `sessionId`, or null while there is no such row. */
function rowDot(sessionId: string): string {
  return `(function () {
    var row = document.querySelector('[data-session-id=${JSON.stringify(sessionId)}]');
    if (row === null) return null;
    var dot = row.querySelector('[data-slot="tug-progress-indicator"]');
    return dot === null ? null : dot.getAttribute("data-state");
  })()`;
}

/** In the shell: the session row's turn latch, or undefined while it holds no row. */
const latchOf = (sessionId: string): string =>
  `(function () { var r = window.__tug.sessionRowFacts(${JSON.stringify(sessionId)}); return r === null ? undefined : r.turnActive; })()`;

describe.skipIf(!SHOULD_RUN)("body-grounding row 47: a hidden card's hand-back", () => {
  test(
    "a dormant card's Cards row stills within seconds of its turn ending unheard",
    async () => {
      const stubDir = stubDirectory();
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(LAYOUT));
      const app = await launchTugApp({
        testName: "body-grounding-row-47-handback-idle-dot",
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir, TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        await app.bodyDelays({ dormantAfterMs: DORMANT_AFTER_MS, evictAfterMs: EVICT_AFTER_MS });
        const sid = randomUUID();
        const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-r47d-project-")));
        onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
        const words = Array.from({ length: WORDS }, (_, i) => `word${i}`).join(" ");
        writeFileSync(join(stubDir, `${sid}.json`), JSON.stringify(streamingTranscript(1, 1, () => words)));
        await app.spawnSessionNew(A, { tugSessionId: sid, projectDir });
        await waitForBody(app, A);
        const body = app.body(A);

        // ---- A turn streams; the Cards workspace is shown under it, parking the Session card's ----
        await body.driveSession({ op: "send", text: "Stream the turn." });
        await body.waitForCondition<boolean>(`${promptPhase} === "streaming"`, { timeoutMs: 10_000 });
        const streamingAt = Date.now();
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(CARDS_SPACE)} }), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === CARDS_SPACE, 5_000);
        const cards = await standUpKind(app, cardKind("cards"), CARDS);

        // ---- Dormant: the body hears nothing, and the row runs ----
        const asleep = await settleFor(() => body.evalJS<boolean>("window.__tug.bodyDormancy().dormant"), (d) => d, 5_000);
        expect(asleep, "the parked body is dormant past its delay").toBe(true);
        const running = await settleFor(() => cards.evalJS<string | null>(rowDot(sid)), (s) => s !== null, 5_000);
        note(`dormant ${Date.now() - streamingAt} ms into a ${TURN_MS} ms turn; the row's dot ${running}`);
        expect(running, "the Cards row runs for a dormant card mid-turn").toBe("running");

        // ---- The turn ends on tugcast: the shell hears the latch close, and the dot stills ----
        const closed = await settleFor(
          () => app.evalJS<boolean | null | undefined>(latchOf(sid)),
          (l) => l === false,
          Math.max(0, streamingAt + TURN_MS - Date.now()) + 5_000,
        );
        const heardAt = Date.now();
        note(`the shell heard the latch close ${heardAt - streamingAt} ms after the turn began`);
        expect(closed, "the session row says the turn ended").toBe(false);
        const still = await settleFor(() => cards.evalJS<string | null>(rowDot(sid)), (s) => s === "stopped", STILL_WITHIN_MS);
        note(`the row's dot ${still} ${Date.now() - heardAt} ms after the shell heard the end`);
        expect(still, "the row's dot stills within seconds of the turn's end").toBe("stopped");
        expect(await body.evalJS<boolean>("window.__tug.bodyDormancy().dormant"), "the body slept through the end").toBe(true);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
