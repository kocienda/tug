/**
 * at0740-body-switch.test.ts — bodies are a switch, off unless set.
 *
 * The host reads one tugbank setting, `dev.tugapp.deck` / `bodies`, once at
 * window creation, and makes body views only when it is true. The shipping
 * build has no value for it, so a launch with nothing seeded — and without
 * the harness's own `TUG_BODY_VIEWS=1` opt-in — makes no bodies at all: the
 * shell is told so before its first script, a Session card spawned onto a
 * session mounts in the shell's own document (its composer is there, and no
 * body placeholder is), and the host's body snapshot stays empty, the warm
 * spare included.
 *
 * The same launch shape with the setting seeded true in its tugbank makes the
 * card a body, which is the door the Layout card's Bodies row opens: that row
 * writes the setting, and the host applies it at the next launch.
 *
 * @covers tugapp/Sources/BodyGeometry.swift
 * @covers tugapp/Sources/MainWindow.swift
 * @covers tugapp/Sources/HostCapabilitiesScript.swift
 * @covers tugdeck/src/lib/body-handoff.ts
 * @covers tugdeck/src/lib/body-shell.ts
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import type { BodyViewSnapshot } from "./_harness/client";
import { onTestRunEnd } from "./_harness/test-cleanup";
import { mkTempTugbank, seedTugbankForLaunch, tugbankWrite } from "./_harness/tugbank-helpers";
import { STUB_TRANSCRIPT_DIR_ENV, streamingTranscript, stubDirectory } from "./streaming-stub-fixture";

const TEST_NAME = "at0740-body-switch";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = "at0740-a";
const PROMPT_INPUT = '[data-slot="tug-text-editor"] .cm-content';
const PLACEHOLDER = `[data-body-placeholder][data-card-id="${CARD}"]`;
/** A body's cold start plus a stub spawn. */
const BODY_READY_MS = 30_000;
/** Long enough for the shell to have mounted the card and the host to have made a spare, had it meant to. */
const SETTLE_MS = 5_000;

const oneCard = {
  cards: [{ id: CARD, componentId: "session", title: "Switch", closable: true }],
  panes: [
    {
      id: `${CARD}-pane`,
      position: { x: 40, y: 40 },
      size: { width: 640, height: 480 },
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

const capabilitiesJs = `JSON.stringify(window.__tugHostCapabilities || null)`;
const shellHasComposer = `document.querySelector(${JSON.stringify(PROMPT_INPUT)}) !== null`;
const shellHasPlaceholder = `document.querySelector(${JSON.stringify(PLACEHOLDER)}) !== null`;

async function pollFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const started = Date.now();
  let last = await read();
  while (!done(last) && Date.now() - started < timeoutMs) {
    await Bun.sleep(50);
    last = await read();
  }
  return last;
}

async function bodyOf(app: App): Promise<BodyViewSnapshot | null> {
  return (await app.bodies()).find((b) => b.cardId === CARD) ?? null;
}

async function spawnStub(app: App, stubDir: string): Promise<void> {
  const tugSessionId = randomUUID();
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0740-project-")));
  onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
  writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(streamingTranscript(2, 1)));
  await app.spawnSessionNew(CARD, { tugSessionId, projectDir });
}

describe.skipIf(!SHOULD_RUN)("at0740: bodies are a switch", () => {
  test(
    "with nothing set, the host makes no bodies and every card mounts in the shell",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: TEST_NAME,
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: oneCard, focusCardId: CARD });
        const capabilities = await app.evalJS<string>(capabilitiesJs);
        note(`host capabilities: ${capabilities}`);
        expect(JSON.parse(capabilities), "the shell is told the host makes no bodies").toEqual({ bodyViews: false });

        await spawnStub(app, stubDir);
        const mounted = await pollFor(() => app.evalJS<boolean>(shellHasComposer), (v) => v, BODY_READY_MS);
        expect(mounted, "the card's composer is in the shell's own document").toBe(true);
        expect(await app.evalJS<boolean>(shellHasPlaceholder), "no body placeholder stands for the card").toBe(false);

        // Give the host every chance it would have taken: a bound body and the
        // warm spare both arrive within this on a host that makes them.
        await Bun.sleep(SETTLE_MS);
        const bodies = await app.bodies();
        note(`bodies with the switch off: ${JSON.stringify(bodies)}`);
        expect(bodies, "the host holds no body view, the spare included").toEqual([]);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "with the setting seeded true, the host makes the card a body",
    async () => {
      const stubDir = stubDirectory();
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck", "bodies", "bool", "true");
      const app = await launchTugApp({
        testName: TEST_NAME,
        env: { TUGBANK_PATH: tugbankPath, [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({ state: oneCard, focusCardId: CARD });
        const capabilities = await app.evalJS<string>(capabilitiesJs);
        note(`host capabilities: ${capabilities}`);
        expect(JSON.parse(capabilities), "the shell is told the host makes bodies").toEqual({ bodyViews: true });

        await spawnStub(app, stubDir);
        const ready = await pollFor(
          () => bodyOf(app),
          (b) => b !== null && b.state === "ready" && b.visible,
          BODY_READY_MS,
        );
        note(`body with the setting on: ${JSON.stringify(ready)}`);
        expect(ready?.state, "the card's body reports ready").toBe("ready");
        expect(await app.evalJS<boolean>(shellHasPlaceholder), "the shell holds the card's placeholder").toBe(true);
        expect(await app.evalJS<boolean>(shellHasComposer), "and no composer of its own for it").toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
