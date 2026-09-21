/**
 * at0602-session-atom-reach.test.ts — a session atom placed in a prompt gives
 * the model something it can actually read.
 *
 * ## What this gates
 *
 * The unit tests cover each half separately: `build-wire-payload.test.ts`
 * knows the block's text, `session-ref-block.test.ts` knows its grammar,
 * `synthesize-user-message.test.ts` knows it comes back off. What none of
 * them can see is the two halves standing in one app at once — the block on
 * the wire and NOT in the transcript, over the same submission — because the
 * separation is the whole design and a single-sided test passes while it is
 * broken in either direction.
 *
 *   A. **The block rides out.** The submission's `user_message` ends with a
 *      `tug:session-refs` block naming the session's uuid, its project dir,
 *      and the verdict this client holds for it. That is the fact sheet the
 *      model reads the command off, and it is the only place it appears.
 *
 *   B. **And it is not in the transcript.** The same submission's row shows a
 *      session pill and no reference text anywhere in it. The row is rebuilt
 *      from the synthesized substrate rather than from the frame, which is
 *      what lets one submission carry two different things to two readers.
 *
 *   C. **The command the block prints actually answers.** `tugtool session
 *      show <uuid>` run with the instance's own environment reads the
 *      session's transcript back — title, callsign and turn count — from a
 *      project this card is not open on. A block naming a command that
 *      returns nothing is worse than no block: it teaches the model that the
 *      reference is a dead end.
 *
 *   D. **A replay is still a session pill.** The captured wire content is fed
 *      back through the replay path — the real one, `add_user_message` with
 *      those blocks — and what comes out is a pill carrying the session's
 *      uuid, not a file chip and not a line of prose. The typed `@session:`
 *      marker is what makes that possible: the type cannot be recovered from
 *      the value, and the tag store the old discriminator read is a fact
 *      about this run rather than about the reference.
 *
 * The project the atom names is not the project the card is open on, which is
 * the case the whole arc is for: a reference is only worth carrying if it
 * reaches past the instance that minted it.
 *
 * @covers tugdeck/src/lib/build-wire-payload.ts
 * @covers tugdeck/src/lib/synthesize-user-message.ts
 * @covers tugdeck/src/lib/session-ref-block.ts
 * @covers tugdeck/src/lib/atom-mention-marker.ts
 * @covers tugdeck/src/lib/session-atom-shape.ts
 * @covers tugrust/crates/tugcore/src/session_finder.rs
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT

/**
 * This checkout's own `tugtool`, not the one on `PATH` — that one is the
 * installed app's Release binary, which knows nothing of a verb added on this
 * branch. `just app-test-build` builds it.
 */
const TUGTOOL = resolve(import.meta.dir, "../../tugrust/target/debug/tugtool");

/** The card's own session, in project A. */
const SESSION_A = "aa11bb22-0000-4000-8000-00000000a602";
const ALPHA_DIR = "/Users/tester/src/alpha";

/** The session the prompt NAMES — another project entirely. */
const SESSION_B = "bb22cc33-0000-4000-8000-00000000b602";
const BETA_DIR = "/Users/tester/src/beta";
const BETA_TAG = "quiet-harbor";
const BETA_TITLE = "the beta rewrite";
const REFERENCE = `beta/${BETA_TAG}`;

const CARD = '[data-card-id="A"]';
const USER_BODY = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const PILL = `${USER_BODY} [data-slot="tug-session-identity"]`;

/**
 * How claude names its per-project subdir under `~/.claude/projects/` — every
 * character outside `[A-Za-z0-9-]` becomes `-`. Kept inline rather than
 * imported so the app-test graph does not depend on tugcode.
 */
const encodeProjectDir = (absDir: string): string =>
  absDir.replace(/[^A-Za-z0-9-]/g, "-");

const FIXTURE_DIR = join(
  homedir(),
  ".claude",
  "projects",
  encodeProjectDir(BETA_DIR),
);
const FIXTURE_PATH = join(FIXTURE_DIR, `${SESSION_B}.jsonl`);

/** Two turns, in claude's own JSONL shape — what `session show` reads back. */
function writeFixture(): void {
  const base = {
    isSidechain: false,
    userType: "external",
    cwd: BETA_DIR,
    sessionId: SESSION_B,
    version: "2.1.105",
    gitBranch: "main",
  };
  const lines = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: "00000000-0000-4000-8000-0000000006021",
      timestamp: "2026-09-20T10:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "what did the beta rewrite settle" }],
      },
    },
    {
      ...base,
      parentUuid: "00000000-0000-4000-8000-0000000006021",
      type: "assistant",
      uuid: "00000000-0000-4000-8000-0000000006022",
      timestamp: "2026-09-20T10:00:02.000Z",
      message: {
        id: "msg-b-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "It settled the finder's arm order." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 8 },
      },
    },
    {
      ...base,
      parentUuid: "00000000-0000-4000-8000-0000000006022",
      type: "user",
      uuid: "00000000-0000-4000-8000-0000000006023",
      timestamp: "2026-09-20T10:01:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "and the index" }] },
    },
    {
      ...base,
      parentUuid: "00000000-0000-4000-8000-0000000006023",
      type: "assistant",
      uuid: "00000000-0000-4000-8000-0000000006024",
      timestamp: "2026-09-20T10:01:03.000Z",
      message: {
        id: "msg-b-2",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "One row per session, machine-wide." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 9 },
      },
    },
  ];
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(FIXTURE_PATH, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** The ledger's answer for B, through the production `resolve_sessions_ok`. */
function resolveB(): string {
  return `window.__tug.dispatchControlAction("resolve_sessions_ok", ${JSON.stringify({
    sessions: [
      {
        queried: SESSION_B,
        session: {
          session_id: SESSION_B,
          workspace_key: "ws-beta",
          project_dir: BETA_DIR,
          created_at: 1_758_000_000_000,
          last_used_at: 1_758_000_100_000,
          turn_count: 2,
          last_user_prompt: null,
          state: "closed",
          card_id: null,
          name: BETA_TITLE,
          tag: BETA_TAG,
        },
      },
    ],
    elsewhere: [],
    unknown: [],
  })})`;
}

/** The atom a copy of B's session puts on the clipboard, as a segment. */
const SESSION_ATOM = {
  kind: "atom" as const,
  type: "session",
  label: REFERENCE,
  value: REFERENCE,
  session: { id: SESSION_B, projectDir: BETA_DIR },
};

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 20, y: 20 },
        size: { width: 820, height: 560 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

interface WireMessage {
  type: string;
  content: Array<{ type: string; text?: string }>;
}

describe.skipIf(!SHOULD_RUN)("at0602 — a session atom the model can read", () => {
  test(
    "the reference block rides the wire, stays out of the transcript, and names a command that answers",
    async () => {
      writeFixture();
      const app = await launchTugApp({ testName: "at0602-session-atom-reach" });
      const ingest = (decoded: unknown) =>
        app.driveSession("A", { op: "ingestFrame", feedId: CODE_OUTPUT_FEED, decoded });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", {
          tugSessionId: SESSION_A,
          projectDir: ALPHA_DIR,
        });

        // A bound card stands behind its restore veil until a replay bracket
        // closes; an empty one is the cheapest way to raise it.
        await ingest({ type: "replay_started", tug_session_id: SESSION_A });
        await ingest({
          type: "replay_complete",
          tug_session_id: SESSION_A,
          count: 0,
          firstLoadedTurnIndex: 0,
          totalTurns: 0,
          hasOlder: false,
        });

        // The ledger's word about B, so the block can say `here` rather than
        // `unverified`. Delivered through the production handler — everything
        // downstream of it, including the key the answer is filed under, is
        // the real path.
        await app.evalJS<boolean>(resolveB());

        // ---- The submission ------------------------------------------------
        await app.driveSession("A", {
          op: "send",
          text: "read ￼ and tell me what it settled",
          atoms: [SESSION_ATOM],
        });

        // ---- A. The block rides out. ---------------------------------------
        await app.waitForCondition<boolean>(
          `window.__tug.lastSentUserMessage("A") !== null`,
          { timeoutMs: 10_000 },
        );
        const wire = JSON.parse(
          (await app.evalJS<string>(`window.__tug.lastSentUserMessage("A")`))!,
        ) as WireMessage;
        note("at0602 wire", JSON.stringify(wire).slice(0, 600));
        expect(wire.type).toBe("user_message");
        const last = wire.content[wire.content.length - 1];
        expect(last.type).toBe("text");
        const block = last.text ?? "";
        // The block is the LAST thing in the message — a fact sheet reads as
        // one only when it follows what it is about.
        expect(block.startsWith("<!-- tug:session-refs -->")).toBe(true);
        expect(block).toContain(SESSION_B);
        expect(block).toContain(BETA_DIR);
        expect(block).toContain("verdict: here");
        // And the command the model would run is spelled out rather than
        // implied.
        expect(block).toContain(`tugtool session show ${SESSION_B}`);
        // The prose half carries the typed marker, not a bare path-shaped
        // token — that type is what a replay recovers the chip from.
        const body = wire.content
          .slice(0, -1)
          .map((b) => b.text ?? "")
          .join("");
        expect(body).toContain(`\`@session:${REFERENCE}\``);

        // ---- B. And it is not in the transcript. ---------------------------
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PILL)}) !== null`,
          { timeoutMs: 10_000 },
        );
        const row = await app.evalJS<{ text: string; pills: number }>(
          `(function(){
            var body = document.querySelector(${JSON.stringify(USER_BODY)});
            return {
              text: (body.textContent || "").replace(/\\s+/g, " ").trim(),
              pills: body.querySelectorAll('[data-slot="tug-session-identity"]').length,
            };
          })()`,
        );
        note("at0602 row", JSON.stringify(row));
        expect(row.pills).toBe(1);
        expect(row.text).not.toContain("tug:session-refs");
        expect(row.text).not.toContain("verdict:");
        expect(row.text).not.toContain("tugtool session show");

        // ---- C. The command the block prints actually answers. -------------
        //
        // Run with the INSTANCE's environment, which is the whole point: the
        // harness redirects both ledgers per launch, and a `session show` that
        // read the developer's own would prove nothing about this fixture.
        const dataDir = join(
          homedir(),
          "Library",
          "Application Support",
          "Tug",
          "instances",
          app.instanceId,
        );
        const shown = Bun.spawnSync(
          [TUGTOOL, "session", "show", SESSION_B, "--json"],
          {
            env: {
              ...process.env,
              TUG_SESSIONS_DB: join(dataDir, "sessions.db"),
              TUG_SESSION_INDEX_DB: join(dataDir, "session_index.db"),
            },
          },
        );
        const showOut = shown.stdout.toString();
        note(
          "at0602 session show",
          `exit ${shown.exitCode} ${showOut.slice(0, 400)}${shown.stderr.toString().slice(0, 200)}`,
        );
        expect(shown.exitCode).toBe(0);
        const payload = JSON.parse(showOut) as {
          data: { session_id: string; turns: number; project_dir: string };
        };
        expect(payload.data.session_id).toBe(SESSION_B);
        expect(payload.data.project_dir).toBe(BETA_DIR);
        // Two user turns went into the fixture; the reader found them.
        expect(payload.data.turns).toBe(2);

        // ---- D. A replay is still a session pill. --------------------------
        //
        // The exact bytes that went out, fed back through the replay path. A
        // replay is the one reading of a submission that has no editor state
        // to fall back on, so a type the wire cannot carry is a type the
        // replayed row cannot have.
        await ingest({ type: "replay_started", tug_session_id: SESSION_A });
        await ingest({
          type: "add_user_message",
          tug_session_id: SESSION_A,
          content: wire.content,
        });
        await ingest({
          type: "replay_complete",
          tug_session_id: SESSION_A,
          count: 1,
          firstLoadedTurnIndex: 0,
          totalTurns: 1,
          hasOlder: false,
        });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(PILL)}).length >= 1`,
          { timeoutMs: 10_000 },
        );
        const replayed = await app.evalJS<{
          sessionIds: string[];
          text: string;
          bodies: number;
        }>(
          `(function(){
            var bodies = document.querySelectorAll(${JSON.stringify(USER_BODY)});
            var last = bodies[bodies.length - 1];
            return {
              sessionIds: Array.prototype.map.call(
                last.querySelectorAll('[data-slot="tug-session-identity"]'),
                function (p) { return p.getAttribute("data-atom-session-id") || ""; }),
              text: (last.textContent || "").replace(/\\s+/g, " ").trim(),
              bodies: bodies.length,
            };
          })()`,
        );
        note("at0602 replayed", JSON.stringify(replayed));
        // A pill, carrying the uuid — the half of the reference a callsign
        // cannot supply on an instance that never minted it.
        expect(replayed.sessionIds).toContain(SESSION_B);
        // And the block did not come back as prose.
        expect(replayed.text).not.toContain("tug:session-refs");
      } finally {
        await app.close();
        rmSync(FIXTURE_DIR, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
