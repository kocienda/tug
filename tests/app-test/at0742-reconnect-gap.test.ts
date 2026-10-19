/**
 * at0742-reconnect-gap.test.ts — a Session card's turn runs on while its
 * socket is down, and the card shows all of it once the socket is back.
 *
 * ## Why this exists
 *
 * A reconnect to the same tugcast keeps the card's stores: nothing is cleared
 * and nothing is read back from disk. But tugcode does not stop for a dropped
 * socket. The turn streams on, and tugcast does not replay what a
 * reconnecting client missed: its ring backfills a client that lagged, never
 * one that subscribes. Whatever tugcode sent in the gap reached nobody. A
 * message that finished in the gap stayed half-written on the card, and a
 * turn whose end came in the gap never ended there.
 *
 * The card closes the gap by asking tugcode for the turn as it now stands
 * (`request_inflight`), once its rebind is acknowledged. tugcode answers with
 * a bracket marked `inflight_only` around the same mid-turn snapshot a replay
 * closes with, and no JSONL. The card takes from the snapshot what it lacks,
 * and the snapshot carries the turn's end if the turn finished in the gap.
 *
 * ## What is driven here
 *
 * Bodies are on, as they were for every reading this work was built on. One
 * Session card is spawned onto a stub session whose one turn streams three
 * messages at the fixture's token pace, about a second each. The prompt goes
 * in, and the moment the card is streaming its body drops its own socket.
 * That is the body's connection, not the shell's, because a body card's
 * frames ride its own page. The reconnect backoff holds the socket down for
 * about two seconds, so the first messages, and possibly the turn's end, are
 * sent while nobody is listening.
 *
 * The verdict is the card at rest: the turn ended (the prompt entry idle) and
 * every message on it whole, word for word.
 *
 * @covers tugdeck/src/lib/session-control-actions.ts
 * @covers tugdeck/src/lib/session-restore.ts
 * @covers tugdeck/src/lib/code-session-store/reducer.ts
 * @covers tugcode/src/session.ts
 * @covers tugcode/src/stub-replay.ts
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor/control/session.rs
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { onTestRunEnd } from "./_harness/test-cleanup";
import { STUB_TRANSCRIPT_DIR_ENV, streamingTranscript, stubDirectory } from "./streaming-stub-fixture";

const TEST_NAME = "at0742-reconnect-gap";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = "at0742-card";
const MESSAGES = 3;

/** A body's cold start plus a stub spawn. */
const BODY_READY_MS = 30_000;
/** Three paced messages, a two-second reconnect, and the answer to the ask. */
const AT_REST_MS = 20_000;

/** One message's text: plain words, so the card's text reads back verbatim. */
function messageText(index: number): string {
  const words = Array.from({ length: 36 }, (_, i) => `m${index}w${i}`);
  return `Message ${index} begins. ${words.join(" ")} Message ${index} ends.`;
}

const oneCard = {
  cards: [{ id: CARD, componentId: "session", title: "Gap", closable: true }],
  panes: [
    {
      id: `${CARD}-pane`,
      position: { x: 40, y: 40 },
      size: { width: 720, height: 560 },
      cardIds: [CARD],
      activeCardId: CARD,
      title: "",
      acceptsFamilies: ["maker"],
      slot: 0,
    },
  ],
  activePaneId: `${CARD}-pane`,
  imposition: { kind: "four-up", layout: "flow", sidebars: {} },
  hasFocus: true,
};

const promptPhase = `(function () {
  var entry = document.querySelector('[data-slot="tug-prompt-entry"]');
  return entry === null ? null : entry.getAttribute("data-phase");
})()`;

const transcriptText = `(function () {
  var t = document.querySelector('[data-testid="session-card-transcript"]');
  return t === null ? null : t.textContent.replace(/\\s+/g, " ");
})()`;

async function pollFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await Bun.sleep(100);
    value = await read();
  }
  return value;
}

describe.skipIf(!SHOULD_RUN)("at0742 — a turn that runs on through a dropped socket", () => {
  test(
    "the card shows every message whole and the turn ended, after the socket comes back",
    async () => {
      const stubDir = stubDirectory();
      const app: App = await launchTugApp({
        testName: TEST_NAME,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: oneCard, focusCardId: CARD });
        const tugSessionId = randomUUID();
        const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0742-project-")));
        onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
        writeFileSync(
          join(stubDir, `${tugSessionId}.json`),
          JSON.stringify(streamingTranscript(MESSAGES, 1, messageText)),
        );
        await app.spawnSessionNew(CARD, { tugSessionId, projectDir });
        await pollFor(
          () => app.bodies(),
          (all) => all.some((b) => b.cardId === CARD && b.state === "ready" && b.visible),
          BODY_READY_MS,
        );

        const body = app.body(CARD);
        await body.waitForCondition<boolean>(`document.querySelector('[data-testid="session-card-transcript"]') !== null`, {
          timeoutMs: BODY_READY_MS,
        });
        await body.driveSession({ op: "send", text: "Say the three messages." });
        await body.waitForCondition<boolean>(`${promptPhase} === "streaming"`, { timeoutMs: BODY_READY_MS });

        // Drop the body's own socket, the way the network would.
        const closed = await body.evalJS<boolean>(`window.__tug.connectionClose()`);
        expect(closed, "the body had a socket to drop").toBe(true);
        const atDrop = await body.evalJS<string | null>(transcriptText);
        note(`at the drop the card held ${atDrop?.length ?? 0} characters of transcript`);

        const phase = await pollFor(
          () => body.evalJS<string | null>(promptPhase),
          (p) => p === "idle",
          AT_REST_MS,
        );
        const text = (await body.evalJS<string | null>(transcriptText)) ?? "";
        const whole = Array.from({ length: MESSAGES }, (_, i) => text.includes(messageText(i)));
        note(`at rest: phase ${phase}; messages whole ${JSON.stringify(whole)}`);
        if (whole.some((w) => !w)) {
          // What the card holds, and what its page did across the reconnect.
          note(`card text: ${text.slice(0, 1200)}`);
          const trace = await body.evalJS<string[]>(
            `(window.__deckTrace ? window.__deckTrace.dump() : [])
              .filter(function (e) { return e.kind === "session-lifecycle"; })
              .map(function (e) { return e.event + " " + JSON.stringify(e.fields); })
              .slice(-40)`,
          );
          note(`session lifecycle: ${trace.join(" | ")}`);
          // And what tugcast and the stub did for the session, from the
          // instance's own log (swept when the app quits).
          const logs = join(homedir(), "Library/Application Support/Tug/instances", app.instanceId, "Logs");
          const tugcast = existsSync(logs) ? readdirSync(logs).find((f) => f.startsWith("tugcast.log")) : undefined;
          if (tugcast !== undefined) {
            const lines = readFileSync(join(logs, tugcast), "utf8")
              // oxlint-disable-next-line no-control-regex -- strips the log's ANSI colour codes, which begin with ESC
              .replace(/\x1b\[[0-9;]*m/g, "")
              .split("\n")
              .filter((l) => /replay|inflight|spawn\.|stub|reconnect/i.test(l))
              .map((l) => l.slice(0, 220));
            note(`tugcast: ${lines.slice(-40).join(" | ")}`);
          }
        }

        expect(phase, "the turn ended on the card, its end included").toBe("idle");
        for (let i = 0; i < MESSAGES; i++) {
          expect(whole[i], `message ${i} is on the card whole`).toBe(true);
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
