/**
 * at0292 — a settled deck writes nothing.
 *
 * The idle contract: an idle deck schedules zero rendering updates. Renderer
 * busy is `rendering updates per second × cost per update`, and the prior
 * phase spent itself on the cost term while the wake term went unmeasured —
 * so this test gates the wake term directly, where it can be seen. A DOM
 * write is the wake: assigning `textContent` replaces the text node and
 * setting an attribute to the value it already holds is still delivered as a
 * mutation, and either one dirties style and schedules an update for a
 * display that did not change. On the deck this seeds, the measured cost of
 * one such update is ~10ms, so a single 4Hz writer nobody notices is ~4% of
 * a core, forever.
 *
 * The deck is a cold-restored `session-transcript-basic` — 29 tool calls,
 * ~1,470 elements — settled and then left alone. Measured 2026-07-29 at 0
 * writes per 5s window, twice, before this gate was written; it is holding a
 * line that is already true, which is the only kind of line worth holding.
 *
 * Two things make it non-vacuous. A deliberate write is performed first and
 * the census must count it, so a census that silently stopped observing
 * fails instead of reading a comfortable zero. And the transcript's own dot
 * population is asserted, so a restore that quietly produced an empty
 * transcript cannot pass by having nothing to write.
 *
 * The measured window reopens once before failing. The app-test workspace is
 * transient and its changeset entries retire on a clock of their own, so a
 * window can catch the tail of that churn even after the settle; one such
 * window was observed in roughly eight runs. A deck that is genuinely writing
 * fails both windows, so the retry costs no strictness — and both are printed
 * when they disagree, which is what would name the writer next time.
 *
 * The waker assertion is narrower than the write assertion on purpose: the
 * perf monitor's own 1Hz heartbeat is a `setTimeout` chain that exists only
 * in dev and test builds, so what is asserted is that no repeating INTERVAL
 * fires at rest — which is the shape every waker convicted so far has had.
 *
 * @covers tugdeck/src/lib/perf-monitor.ts
 * @covers tugdeck/src/components/tugways/cards/session-activity-card.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";
import {
  mkTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { seedFixtureSession } from "./fixtures/resolve";
import {
  openFixtureSession,
  waitForTranscriptSettled,
} from "./fixtures/runner";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/**
 * Settle before measuring. The app-test workspace is transient, so its
 * changeset entries appear and retire within ~2s of the restore; this window
 * has to outlast that churn or the gate measures the harness, not the deck.
 */
const SETTLE_MS = 4_000;
/** The measured quiet window. */
const CENSUS_MS = 3_000;

interface MutationCensus {
  windowMs: number;
  totalWrites: number;
  writesPerSecond: number;
  byTarget: [string, number][];
  byType: { childList: number; attributes: number; characterData: number };
}

interface WakerCensus {
  windowMs: number;
  entries: {
    kind: string;
    callsite: string;
    activeCount: number;
    firesPerSecond: number;
    periodMs: number | null;
  }[];
  totalFiresPerSecond: number;
}

function reportWrites(label: string, census: MutationCensus): void {
  console.log(
    [
      `\n=== DOM writes: ${label} ===`,
      `${census.totalWrites} in ${census.windowMs}ms (${census.writesPerSecond}/s) — ` +
        `childList ${census.byType.childList}, ` +
        `attributes ${census.byType.attributes}, ` +
        `characterData ${census.byType.characterData}`,
      ...census.byTarget.map(([bucket, n]) => `  ${n}  ${bucket}`),
    ].join("\n"),
  );
}

/** One measured window, plus the waker census taken across the same span. */
async function measureQuiet(app: App, slot: string): Promise<MutationCensus> {
  await app.evalJS<void>(`(function(){
    window.tugPerfMonitor.mutationCensus(${CENSUS_MS}).then(function(r){
      window.__at0292[${JSON.stringify(slot)}] = r;
    });
    window.tugPerfMonitor.readWakerCensus(${CENSUS_MS}).then(function(r){
      window.__at0292.wakers = r;
    });
  })()`);
  await app.waitForCondition<boolean>(
    `window.__at0292[${JSON.stringify(slot)}] !== undefined && window.__at0292.wakers !== undefined`,
    { timeoutMs: 20_000 },
  );
  return app.evalJS<MutationCensus>(
    `window.__at0292[${JSON.stringify(slot)}]`,
  );
}

describe.skipIf(!SHOULD_RUN)("at0292: idle silence", () => {
  test(
    "a settled restored transcript performs no DOM writes and runs no interval",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const seeded = await seedFixtureSession(
        "session-transcript-basic",
        "at0292",
      );
      tugbankWrite(
        tugbankPath,
        "dev.tugapp.dev",
        "recent-projects",
        "json",
        JSON.stringify({ paths: [seeded.projectDir] }),
      );

      const app = await launchTugApp({
        testName: "at0292-idle-silence",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        // Arm before the restore so every timer the session card registers
        // on its way up is attributed — the census only sees registrations
        // made after it starts.
        await app.evalJS<void>(`window.tugPerfMonitor.startWakerCensus()`);

        await openFixtureSession(app, seeded);
        await waitForTranscriptSettled(app);
        await new Promise((r) => setTimeout(r, SETTLE_MS));

        const dots = await app.evalJS<number>(
          `document.querySelectorAll('[data-slot="tug-progress-pulsing-dot"]').length`,
        );
        // The floor under the whole test: a transcript with nothing in it
        // would satisfy every zero below by having nothing to say.
        expect(
          dots,
          "restored transcript mounted no pulsing dots — fixture or restore path broke",
        ).toBeGreaterThanOrEqual(20);

        // --- anti-vacuity: the instrument is observing right now ---------
        await app.evalJS<void>(`(function(){
          window.__at0292 = {};
          var el = document.createElement("div");
          el.className = "at0292-floor";
          el.style.position = "absolute";
          el.style.left = "-9999px";
          document.body.appendChild(el);
          window.tugPerfMonitor.mutationCensus(1000).then(function(r){
            window.__at0292.floor = r;
          });
          el.textContent = "the census must see this";
          el.remove();
        })()`);
        await app.waitForCondition<boolean>(
          `window.__at0292.floor !== undefined`,
          { timeoutMs: 10_000 },
        );
        const floor = await app.evalJS<MutationCensus>(
          `window.__at0292.floor`,
        );
        reportWrites("anti-vacuity floor (deliberate write)", floor);
        expect(
          floor.totalWrites,
          "the mutation census did not see a deliberate write — it is not observing",
        ).toBeGreaterThan(0);

        // --- the gate ------------------------------------------------------
        // One reopened window before failing. The app-test workspace is
        // transient and its changeset entries retire on their own clock, so a
        // window can catch the tail of that churn; a deck that is genuinely
        // writing fails both windows, and both are printed when they differ.
        let quiet = await measureQuiet(app, "quiet-1");
        reportWrites("settled deck (the gate)", quiet);
        if (quiet.totalWrites !== 0) {
          console.log("=== writes seen; reopening the window once ===");
          await new Promise((r) => setTimeout(r, 2_000));
          quiet = await measureQuiet(app, "quiet-2");
          reportWrites("settled deck (second window)", quiet);
        }
        const wakers = await app.evalJS<WakerCensus>(
          `window.__at0292.wakers`,
        );
        console.log(
          [
            `\n=== wakers: settled deck === total ${wakers.totalFiresPerSecond}/s`,
            ...wakers.entries.map(
              (e) =>
                `  ${e.firesPerSecond}/s  ${e.kind} ` +
                `${e.periodMs === null ? "raf" : `${e.periodMs}ms`} ×${e.activeCount}` +
                `\n      ${e.callsite}`,
            ),
          ].join("\n"),
        );

        expect(
          quiet.totalWrites,
          `a settled deck wrote to the DOM:\n${JSON.stringify(quiet.byTarget, null, 2)}`,
        ).toBe(0);

        const firingIntervals = wakers.entries.filter(
          (e) => e.kind === "interval" && e.firesPerSecond > 0,
        );
        expect(
          firingIntervals,
          `an interval is still firing on a settled deck:\n${JSON.stringify(firingIntervals, null, 2)}`,
        ).toEqual([]);
      } finally {
        await app.quitGracefully();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
