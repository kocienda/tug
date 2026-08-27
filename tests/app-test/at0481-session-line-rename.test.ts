/**
 * at0481-session-line-rename.test.ts — `/rename` names the line, so the name
 * survives the card's next id change.
 *
 * ## What this gates
 *
 * A rename is addressed by `line_id` ([P11]), not by whichever segment the
 * card is seated on. That is the whole difference from the model this
 * replaces: a name written onto a `sessions` row went blank the next time the
 * card rotated, rewound, or respawned, because the new row was a different
 * row. A name written onto the line is read by every segment of it — including
 * one recorded *after* the rename.
 *
 * The test proves exactly that, and does it the only way an outside observer
 * can: rename through the real composer route, then stand up a **new segment**
 * on the same line and relaunch onto it. If the write had landed on the
 * segment, the relaunched card would come back wearing the callsign.
 *
 * The rename goes through `/rename <text>` in the composer — the production
 * path, optimistic write and `rename_session` frame included — rather than a
 * seeded store value, so what is pinned is the gesture and not a fixture.
 *
 * @covers tugrust/crates/tugcast/src/session_ledger.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugdeck/src/components/tugways/cards/rename-session-sheet.tsx
 * @covers tugdeck/src/lib/session-name-store.ts
 * @covers tugdeck/src/lib/session-line-store.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const LINE = "c1a0d1ea-0000-4000-8000-000000000490";
/** The segment the card is seated on when the user types `/rename`. */
const FIRST = "c1a0d1ea-0000-4000-8000-000000000491";
/** A segment recorded on the same line *after* the rename landed. */
const NEXT = "c1a0d1ea-0000-4000-8000-000000000492";

const TAG = "stout-heron";
const RENAME = "alpha";

const INSTANCE_ID = `${process.env.TUG_APPTEST_ID_PREFIX ?? "apptest"}-line-rename-${randomUUID()}`;

const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;

let projectDir = "";
let fixtureDir = "";

const encodeProjectDir = (absDir: string): string => absDir.replace(/[^A-Za-z0-9-]/g, "-");

function buildFixtureJsonl(cwd: string, sessionId: string): string {
  const t0 = new Date(Date.now() - 600_000).toISOString();
  const t1 = new Date(Date.now() - 599_000).toISOString();
  const base = {
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId,
    version: "2.1.105",
    gitBranch: "main",
  };
  const head = `00000000-0000-4000-8000-0000000${sessionId.slice(-5)}`;
  const lines = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: head,
      timestamp: t0,
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      ...base,
      parentUuid: head,
      type: "assistant",
      uuid: `00000000-0000-4000-8000-0000001${sessionId.slice(-5)}`,
      timestamp: t1,
      message: {
        id: `msg-${sessionId.slice(-6)}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "hi there" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1200,
          output_tokens: 50,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 8000,
        },
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0481-")));
  writeFileSync(join(projectDir, "README.md"), "at0481\n");
  fixtureDir = join(homedir(), ".claude", "projects", encodeProjectDir(projectDir));
  mkdirSync(fixtureDir, { recursive: true });
  for (const id of [FIRST, NEXT]) {
    writeFileSync(join(fixtureDir, `${id}.jsonl`), buildFixtureJsonl(projectDir, id));
  }
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
  if (fixtureDir !== "" && existsSync(fixtureDir)) {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session A", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 640 },
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

interface LineFacts {
  tugSessionId: string;
  lineId: string;
  tag: string | null;
  name: string | null;
  title: string;
  citation: string;
}

async function awaitDeck(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 15_000 },
  );
}

async function awaitLineFacts(app: App): Promise<LineFacts> {
  await app.waitForCondition<boolean>(
    `(function(){
       if (typeof window.__tug === "undefined") return false;
       try { return window.__tug.cardLineFacts("A").lineId.length > 0; }
       catch (e) { return false; }
     })()`,
    { timeoutMs: 30_000 },
  );
  return app.evalJS<LineFacts>(`window.__tug.cardLineFacts("A")`);
}

describe.skipIf(!SHOULD_RUN)("at0481 — a rename names the line", () => {
  test(
    "a name typed on one segment is read by a segment recorded after it",
    async () => {
      // ── Phase A: write the line and its first segment. ──
      //
      // The seed runs the bundle's own `tugcast --seed-ledger`; the deck's
      // restore has already run at connect, so nothing binds in this launch
      // and nothing is asserted. It exists to give the seeder an instance.
      {
        const app = await launchTugApp({
          testName: "at0481-session-line-rename-A",
          instanceId: INSTANCE_ID,
        });
        try {
          await awaitDeck(app);
          app.seedLedger({
            sessions: [
              {
                session_id: FIRST,
                workspace_key: projectDir,
                project_dir: projectDir,
                card_id: "A",
                line_id: LINE,
                tag: TAG,
              },
            ],
          });
        } finally {
          await app.close();
        }
      }

      // ── Phase B: rename the card, through the composer. ──
      {
        const app = await launchTugApp({
          testName: "at0481-session-line-rename-B",
          instanceId: INSTANCE_ID,
        });
        try {
          await app.enableDeckTrace(true);
          await awaitDeck(app);
          // The synthetic binding, as at0462's write phase uses: the card's
          // editor mounts and accepts real gestures without a live `claude`
          // to drive. The line is named explicitly, because that is what the
          // `rename_session` frame is addressed by.
          await app.bindSession("A", {
            tugSessionId: FIRST,
            lineId: LINE,
            projectDir,
          });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });
          const before = await awaitLineFacts(app);
          expect(before.lineId).toBe(LINE);
          expect(before.name, "the line is untitled before the rename").toBeNull();
          expect(before.tag).toBe(TAG);

          await app.nativeClickAtElement(PROMPT);
          await app.nativeType(`/rename ${RENAME}`);
          await new Promise((r) => setTimeout(r, 150));
          await app.nativeKey("Enter", ["cmd"]);

          // The optimistic write lands immediately; waiting for the ack is
          // what proves the ledger took it, and the ack is what a refusal
          // would have rolled back.
          await app.waitForCondition<boolean>(
            `(function(){
               try { return window.__tug.cardLineFacts("A").name === ${JSON.stringify(RENAME)}; }
               catch (e) { return false; }
             })()`,
            { timeoutMs: 20_000 },
          );

          // The card's next claude id, joining the line the rename just named.
          // A real rotation announces this; the announcement is covered at the
          // Rust layer, and what a relaunch reads is the row it leaves.
          app.seedLedger({
            sessions: [
              {
                session_id: NEXT,
                workspace_key: projectDir,
                project_dir: projectDir,
                card_id: "A",
                line_id: LINE,
                forked_from_session_id: FIRST,
              },
            ],
          });
        } finally {
          await app.close();
        }
      }

      // ── Phase C: relaunch onto the segment that did not exist when the
      //    user typed the name. ──
      {
        const app = await launchTugApp({
          testName: "at0481-session-line-rename-C",
          instanceId: INSTANCE_ID,
        });
        try {
          await app.enableDeckTrace(true);
          await awaitDeck(app);
          await app.bindSession("A", {
            tugSessionId: NEXT,
            lineId: LINE,
            projectDir,
          });
          const after = await awaitLineFacts(app);

          expect(
            after.tugSessionId,
            "the resumed segment is the one recorded after the rename",
          ).toBe(NEXT);
          expect(after.lineId, "still one line").toBe(LINE);
          expect(
            after.name,
            "the name was written to the line, so a later segment reads it",
          ).toBe(RENAME);
          expect(after.title).toContain(RENAME);
          // The callsign never moved either — it is the line's, and the
          // citation is what a commit trailer would carry.
          expect(after.tag).toBe(TAG);
          expect(after.citation).toContain(TAG);
        } finally {
          await app.close();
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});
