/**
 * at0480-session-line-relaunch.test.ts — a card comes back under the callsign
 * and the name it had, however many claude ids it has worn.
 *
 * ## What this gates
 *
 * The whole point of the line model ([P01]): a `sessions` row is a **segment**
 * of a line of work, and the line — not the segment — owns the callsign and
 * the user's name. A card that rotated into an arc stage, was rewound, or had
 * its subprocess respawn has several segments and one identity, and a relaunch
 * must seat it on the segment the resume rule picks ([P06]) while showing the
 * line's identity.
 *
 * The failure this replaces was real and repeated: identity was copied onto
 * each new row at the moment it was minted, so a row minted by a path that
 * forgot to copy came back wearing a hash. There is no copy to forget now, and
 * this test is what says so from the outside.
 *
 * The shape follows from what an app-test can drive:
 *
 *   1. **The rotation is seeded, not performed.** A real one needs a live
 *      `claude` to announce a `session_segment`; the announcement path itself
 *      is covered at the Rust layer. What a relaunch reads is the ledger state
 *      a rotation leaves behind — two rows on one `line_id` — and that is
 *      exactly what the seed writes.
 *   2. **A full process relaunch, not a deck reload.** The bindings are read
 *      when tugcast opens its ledger, so both phases share one `instanceId`
 *      and therefore one `sessions.db`.
 *   3. **Truth read from the STORES.** `cardLineFacts` reports the binding and
 *      the resolved identity; a title bar can paint a stale string while the
 *      stores hold the right one, and the reverse.
 *
 * @covers tugrust/crates/tugcast/src/session_ledger.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugdeck/src/lib/session-line-store.ts
 * @covers tugdeck/src/lib/session-identity.ts
 * @covers tugdeck/src/lib/card-session-binding-store.ts
 * @covers tugdeck/src/lib/session-restore.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

/** The line of work. Both segments below are segments of it. */
const LINE = "c1a0d1ea-0000-4000-8000-000000000480";
/** The root segment — closed, and forked from by the stage. */
const ROOT = "c1a0d1ea-0000-4000-8000-000000000481";
/** The stage the card rotated into — the line's tip, and the resume target. */
const STAGE = "c1a0d1ea-0000-4000-8000-000000000482";

const TAG = "stout-heron";
const NAME = "line test";

const INSTANCE_ID = `${process.env.TUG_APPTEST_ID_PREFIX ?? "apptest"}-line-relaunch-${randomUUID()}`;

let projectDir = "";
let fixtureDir = "";

/** Mirrors tugcode's `encodeProjectDir` (see at0192 for the rationale). */
const encodeProjectDir = (absDir: string): string => absDir.replace(/[^A-Za-z0-9-]/g, "-");

/**
 * One committed turn, so the segment has a transcript on disk. `has_jsonl` is
 * what routes a restore to `mode=resume` rather than to a fresh spawn, so a
 * segment with no file would never be seated at all.
 */
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
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0480-")));
  writeFileSync(join(projectDir, "README.md"), "at0480\n");
  fixtureDir = join(homedir(), ".claude", "projects", encodeProjectDir(projectDir));
  mkdirSync(fixtureDir, { recursive: true });
  for (const id of [ROOT, STAGE]) {
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

/** The two segments of one line, exactly as a rotation leaves the ledger. */
function seedTheLine(app: App): void {
  app.seedLedger({
    sessions: [
      {
        session_id: ROOT,
        workspace_key: projectDir,
        project_dir: projectDir,
        card_id: "A",
        line_id: LINE,
        tag: TAG,
        name: NAME,
        state: "closed",
      },
      {
        session_id: STAGE,
        workspace_key: projectDir,
        project_dir: projectDir,
        card_id: "A",
        line_id: LINE,
        forked_from_session_id: ROOT,
        stage_label: "devise",
        stage_model: "opus",
      },
    ],
  });
}

/** Wait for the card's binding to settle, then read the line facts. */
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

async function awaitDeck(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 15_000 },
  );
}

/** Everything the line owns, asserted the same way in both phases. */
function expectTheLine(facts: LineFacts, phase: string, seated: string): void {
  expect(facts.lineId, `${phase}: the card is bound to the line, not a segment`).toBe(LINE);
  expect(facts.tugSessionId, `${phase}: seated on the segment that was resumed`).toBe(seated);
  expect(facts.tag, `${phase}: the callsign belongs to the line`).toBe(TAG);
  expect(facts.name, `${phase}: the user's name belongs to the line`).toBe(NAME);
  expect(facts.title, `${phase}: the title leads with the user's name`).toContain(NAME);
  // The citation names the line's callsign; the short id beside it is the
  // line's own eight characters, which is what a commit trailer writes.
  expect(facts.citation, `${phase}: the citation carries the callsign`).toContain(TAG);
}

describe.skipIf(!SHOULD_RUN)("at0480 — a line of work survives a relaunch", () => {
  test(
    "a card with two segments comes back on its line, under its callsign and name",
    async () => {
      // ── Phase A: write the ledger state a rotation leaves behind. ──
      //
      // Nothing is asserted here and nothing is bound: the seed runs the
      // bundle's own `tugcast --seed-ledger`, and the deck's restore already
      // ran at connect, so this launch exists only to give the seeder an
      // instance to write into.
      {
        const app = await launchTugApp({
          testName: "at0480-session-line-relaunch-A",
          instanceId: INSTANCE_ID,
        });
        try {
          await awaitDeck(app);
          // Seeded after launch: `demote_live_to_closed` flips every live row
          // at startup, so a row seeded before one would arrive closed.
          seedTheLine(app);
        } finally {
          await app.close();
        }
      }

      // ── Phases B and C: two relaunches, each resuming a DIFFERENT segment
      //    of the same line. ──
      //
      // This is the invariant stated as plainly as it can be: whichever id
      // the card comes back on, it comes back under one callsign and one
      // name. A build that copied identity onto each row at mint time passes
      // the phase that happens to resume the row it copied to, and fails the
      // other; a build that owns identity on the line passes both.
      for (const [letter, seated, phase] of [
        ["B", STAGE, "resumed on the tip"],
        ["C", ROOT, "resumed on the root"],
      ] as const) {
        const app = await launchTugApp({
          testName: `at0480-session-line-relaunch-${letter}`,
          instanceId: INSTANCE_ID,
        });
        try {
          await app.enableDeckTrace(true);
          await awaitDeck(app);
          await app.spawnSessionResume("A", { tugSessionId: seated, projectDir });
          expectTheLine(await awaitLineFacts(app), phase, seated);
        } finally {
          await app.close();
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});
