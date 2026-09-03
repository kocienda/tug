/**
 * at0096-effort-chip.test.ts — the AI chip carries the reasoning-effort level
 * when the active model supports one, and the mixer's EFFORT row sets it
 * ([AT0096], [#step-4]).
 *
 * ## Why this exists
 *
 * Effort is one of the three settings the composite AI chip shows and the AI
 * mixer sets. Two parity-critical properties this test pins:
 *
 *   1. **The token is present or absent, never a placeholder.** Reasoning
 *      effort is per-model (opus supports five levels, sonnet four, haiku
 *      none). When the active model has no level, the composite OMITS the
 *      effort token rather than showing an arc — in a two-token line an arc
 *      reads as a value. Inject `session_capabilities` with effort support + a
 *      level → the token appears; inject one without support → it goes.
 *   2. **No live set verb.** Picking a level sends `effort_change` (tugcode
 *      respawns claude with `--effort` + `--resume`, [R07]); there is no
 *      `system_metadata` round-trip, so the chip reflects the pick
 *      optimistically via `SessionMetadataStore.applyEffort`. This test
 *      asserts that optimistic update (the observable effect of the set path).
 *
 * The chip reads its own `SESSION_METADATA` FeedStore — unreachable by the
 * `driveSession`/`ingestFrame` (CodeSessionStore) path — so capabilities are
 * injected via the `ingestSessionMetadata` surface seam; no live claude
 * handshake needed. The respawn-with-resume round-trip itself ([R07]) is an
 * integration concern (live tugcode), out of this UI test's reach.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/effort.ts
 * @covers tugdeck/src/lib/use-effort.ts
 * @covers tugdeck/src/lib/default-effort-store.ts
 * @covers tugdeck/src/components/tugways/cards/ai-chip.tsx
 * @covers tugdeck/src/components/tugways/cards/ai-config-sheet.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const CHIP = `${CARD} [data-slot="ai-chip"]`;
// The chip's composite face.
const CHIP_CONTENT = `${CHIP} [data-slot="ai-chip-value"]`;
const SHEET = '[data-slot="tug-sheet"]';
/** The sheet's readout — its own statement of what OK would commit. */
const READOUT = `${SHEET} [data-slot="ai-config-summary"]`;
/** The effort channel is a stepped `TugSlider`: a track, ticks, tick labels. */
const EFFORT_TRACK = `${SHEET} [data-testid="ai-config-effort"]`;
const EFFORT_THUMB = `${EFFORT_TRACK} .tug-slider-thumb`;
const OK_BUTTON = `${SHEET} [data-slot="ai-config-ok"]`;

/** Capability payload whose active (default → opus) model supports all five levels. */
function effortCapabilities(effort: string | null) {
  return {
    type: "session_capabilities",
    models: [
      {
        value: "default",
        displayName: "Default (recommended)",
        description: "Opus 4.8 (1M context)",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        value: "sonnet",
        displayName: "Sonnet",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "max"],
      },
      { value: "haiku", displayName: "Haiku" },
    ],
    commands: [],
    agents: [],
    available_output_styles: [],
    output_style: "default",
    account: null,
    effort,
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
        size: { width: 760, height: 560 },
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
 * Whether the chip's composite carries `label` as its EFFORT token.
 *
 * A substring match on ` · <label> · ` rather than a token split, because a
 * model label can itself contain the separator (`Opus 4.8 · 1M`). Effort is
 * always followed by the mode, so the flanked form is exact — and no model or
 * mode label is ever an effort label, so there is nothing to collide with.
 */
function hasEffortTokenExpr(label: string): string {
  return `(function(){
    var el = document.querySelector(${JSON.stringify(CHIP_CONTENT)});
    return el !== null && el.textContent.trim().indexOf(" \\u00b7 " + ${JSON.stringify(label)} + " \\u00b7 ") !== -1;
  })()`;
}

/** Whether the composite carries ANY effort token. */
function hasAnyEffortTokenExpr(): string {
  return `(function(){
    var el = document.querySelector(${JSON.stringify(CHIP_CONTENT)});
    if (el === null) return false;
    var t = el.textContent.trim();
    var labels = ["Low", "Medium", "High", "Extra-High", "Max"];
    for (var i = 0; i < labels.length; i++) {
      if (t.indexOf(" \\u00b7 " + labels[i] + " \\u00b7 ") !== -1) return true;
    }
    return false;
  })()`;
}

describe.skipIf(!SHOULD_RUN)(
  "AT0096: the AI chip carries the effort level, and the mixer's EFFORT row sets it",
  () => {
    test(
      "supported model → the row sets the level; unsupported → the token goes, the chip stays",
      async () => {
        const app = await launchTugApp({ testName: "at0096-effort-chip" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          await app.bindSession("A");
          await app.awaitEngineReady("A");

          // The AI chip is a permanent Z4B fixture, so it is present from
          // mount. Before any capability lands the active model's effort
          // support is unknown → the composite carries no effort token, and
          // the chip does not hide.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CHIP_CONTENT)}) !== null`,
            { timeoutMs: 8000 },
          );
          expect(
            await app.evalJS<boolean>(hasAnyEffortTokenExpr()),
            "no effort token before capabilities land",
          ).toBe(false);

          // Capabilities whose active model (default → opus) supports effort,
          // with NO explicit override (`effort: null`) → the chip shows the
          // session's effective default, "High" (claude runs a fresh session at
          // high effort). A supported session is never blank — only an
          // unsupported model shows `-`.
          await app.ingestSessionMetadata("A", effortCapabilities(null));
          await app.waitForCondition<boolean>(hasEffortTokenExpr("High"), {
            timeoutMs: 6000,
          });

          // Open the mixer (synthetic click — the chip sits at the card's
          // bottom-right edge, below the window's clickable region for a
          // CGEvent, so we drive its real `onClick` directly — the
          // DOM-driven-chip app-test pattern).
          await app.click(CHIP);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(EFFORT_THUMB)}) !== null`,
            { timeoutMs: 4000 },
          );

          // Raise the effort to "Max", then OK. Nothing is sent before OK (the
          // sheet is a transaction), and the chip then reflects the new level
          // optimistically — there is no metadata round-trip on an effort
          // change ([R07]). The track is the sheet's second focus stop, so Tab
          // off the model list rings it; the thumb rests on the effective
          // default ("High"), two notches below "Max".
          await app.nativeKey("Tab");
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(EFFORT_THUMB)});
              return el !== null && el.hasAttribute("data-key-view-kbd");
            })()`,
            { timeoutMs: 4000 },
          );
          await app.nativeKey("ArrowRight");
          await app.nativeKey("ArrowRight");
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(READOUT)});
              return el !== null && el.textContent.indexOf("Max") >= 0;
            })()`,
            { timeoutMs: 4000 },
          );
          expect(
            await app.evalJS<boolean>(hasEffortTokenExpr("High")),
            "the chip must not move before OK",
          ).toBe(true);
          await app.click(OK_BUTTON);
          await app.waitForCondition<boolean>(hasEffortTokenExpr("Max"), {
            timeoutMs: 4000,
          });

          // Model gate: an active model that does NOT support effort drops the
          // effort token entirely — the chip stays present, it just has no
          // level to name.
          await app.ingestSessionMetadata("A", {
            type: "system_metadata",
            model: "haiku",
            ipc_version: 2,
          });
          await app.waitForCondition<boolean>(
            `!${hasAnyEffortTokenExpr()}`,
            { timeoutMs: 4000 },
          );
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(CHIP)}) !== null`,
            ),
            "chip stays present (never hides)",
          ).toBe(true);
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(`\n[at0096-effort-chip] log tail:\n${tail}\n`);
          }
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "resumed session (model via system_metadata, no caps) repopulates the chip",
      async () => {
        const app = await launchTugApp({ testName: "at0096-effort-chip-resume" });
        try {
          await app.enableDeckTrace(true);

          // A resumed session resolves effort support from the PERSISTED live
          // catalog (a machine that resumes has, by definition, run a session
          // that reported capabilities before) — there is no hardcoded model
          // list. Persist that catalog before the card mounts, exactly as the
          // prior session's capabilities would have.
          await app.waitForCondition<boolean>(
            `typeof window.__tug !== "undefined"`,
          );
          await app.evalJS(
            `window.__tug.setTugbankValue("dev.tugapp.models", "catalog", {
              kind: "json",
              value: ${JSON.stringify(effortCapabilities(null).models)},
            })`,
          );

          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
          );
          await app.bindSession("A");
          await app.awaitEngineReady("A");

          // Simulate a resumed session: its model id arrives via
          // `system_metadata` (ledger replay) but it carries NO `initialize`
          // capabilities, so `models[]` stays empty. (The `sessionMode` of the
          // bind is irrelevant to the chip — only `models` + `model` drive its
          // resolution.) The effort chip must resolve support from that known
          // model via the persisted catalog and repopulate — not go silent.
          await app.ingestSessionMetadata("A", {
            type: "system_metadata",
            model: "claude-opus-4-8[1m]",
            ipc_version: 2,
          });
          await app.waitForCondition<boolean>(hasEffortTokenExpr("High"), {
            timeoutMs: 6000,
          });
          expect(
            await app.evalJS<boolean>(hasEffortTokenExpr("High")),
            "resumed opus session → effort repopulates to the default High",
          ).toBe(true);
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(`\n[at0096-effort-chip-resume] log tail:\n${tail}\n`);
          }
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
