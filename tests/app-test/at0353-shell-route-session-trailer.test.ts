/**
 * at0353-shell-route-session-trailer.test.ts — a commit made from the Shell
 * route carries the session citation and the machine id ([P10], Spec S03).
 *
 * Why this needs the real app rather than a Rust unit test: `session_citation()`
 * resolves the committing session through the `TUG_SESSION_ID` environment
 * variable, and env parity on the Shell route is exactly what `dc9263805` had
 * to repair. A unit test constructs the environment it wants and therefore
 * cannot see a route that forgets to export it — this test runs the real
 * command through the real shell child of a real bound session.
 *
 * The run builds a throwaway tug project in a temp dir (a git repo plus the
 * `.tugtool/` marker), creates a dash there, writes a file on its worktree,
 * commits the round, and reads the trailers back out with `git log`. What it
 * asserts:
 *
 *   - `Tug-Session:` is the citation — `<tag> (<shortid8>)` for a tagged
 *     session, the bare `<shortid8>` for a legacy tagless one. The session's
 *     *name* never appears.
 *   - `Tug-Session-Id:` is the full uuid of the session that ran the command,
 *     which is what makes an old citation resolvable.
 *   - Both land together; neither appears without the other.
 *
 * Which of the two citation shapes the run exercises depends on whether the
 * ledger minted a callsign for the resumed session, so both are accepted; the
 * grammar of each is pinned by the `tugchanges_core::session_citation` unit
 * tests. What only this test can see is that the pair reaches a real commit at
 * all, over the real route.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugrust/crates/tugdash-core/src/ops.rs
 * @covers tugrust/crates/tugchanges-core/src/trailer.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** UUID-shaped so the session id is the real thing the trailer must carry. */
const SID = "a7c0d1ea-0000-4000-8000-000000000353";
/** The first 8 characters — the short id the citation prints. */
const SHORT_ID = SID.slice(0, 8);

const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;

/** Encode a project dir the way claude names its per-project subdir. */
const encodeProjectDir = (absDir: string): string =>
  absDir.replace(/[^A-Za-z0-9-]/g, "-");

/**
 * This checkout's `tugutil`, by absolute path.
 *
 * A bare `tugutil` in the shell resolves through `~/.local/bin`, which the
 * main checkout owns — a linked worktree deliberately does not repoint those
 * symlinks. Running the installed binary would test whatever is on the user's
 * machine and quietly pass against the old trailer grammar, which is exactly
 * the failure this test exists to catch.
 */
const TUGUTIL = join(import.meta.dir, "..", "..", "tugrust", "target", "debug", "tugutil");

/**
 * The environment prefixed onto every `tugutil` line below.
 *
 * `TUG_DATA_DIR` because the project here lives under `$TMPDIR`, and a dash op
 * resolves its per-project state dir from the data root. A `tugutil` spawned by
 * the shell route inherits the app's environment, not cargo's, so without this
 * the run leaves a directory in the user's live `Tug/projects/` — one per
 * invocation, forever. `tugdash-core` refuses the write outright in a debug
 * build, which is the build this uses.
 *
 * The redirect would take the session ledger with it — the citation is read
 * from `sessions.db` under the data root, and a scratch root holds no row, so
 * `session_citation` omits **both** trailers silently by design and the
 * assertions below would measure the redirect rather than the trailer grammar.
 * `TUG_SESSIONS_DB` is what keeps the two apart, and it is set on the app's
 * launch (see below) so the app and every shell child of it agree.
 */
const REDIRECT = (dir: string): string => `TUG_DATA_DIR=${join(dir, ".tugdata")}`;

let projectDir = "";
let fixtureDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  // realpath: the shell's cwd is the resolved path, so encode the same string.
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0353-proj-")));
  // A throwaway tug project: a git repo with one commit, plus the `.tugtool/`
  // marker a dash needs. Built here rather than through the shell so the only
  // thing the shell route has to carry is the command under test.
  mkdirSync(join(projectDir, ".tugtool"), { recursive: true });
  writeFileSync(join(projectDir, "seed.txt"), "seed\n");
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", projectDir, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "at0353@example.test");
  git("config", "user.name", "AT0353");
  git("add", "-A");
  git("commit", "-qm", "seed");
  fixtureDir = join(homedir(), ".claude", "projects", encodeProjectDir(projectDir));
  mkdirSync(fixtureDir, { recursive: true });
  // A real one-turn transcript: a thin fixture makes `claude --resume` fail,
  // which reverts the card to the picker before any shell command can run.
  const base = {
    isSidechain: false,
    userType: "external",
    cwd: projectDir,
    sessionId: SID,
    version: "2.1.105",
    gitBranch: "main",
  };
  const lines = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000f01",
      timestamp: new Date(Date.now() - 2000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      ...base,
      parentUuid: "00000000-0000-4000-8000-000000000f01",
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000f02",
      timestamp: new Date(Date.now() - 1000).toISOString(),
      message: {
        id: "msg-at0353-1",
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
  writeFileSync(
    join(fixtureDir, `${SID}.jsonl`),
    lines.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
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

/** Submit one `/shell <cmd>` line and block until its row settles. */
async function execAndSettle(
  app: App,
  line: string,
  expectedIndex: number,
): Promise<string> {
  await app.nativeClickAtElement(PROMPT);
  await app.nativeType(line);
  await new Promise((r) => setTimeout(r, 150));
  await app.nativeKey("Enter", ["cmd"]);
  await app.waitForCondition<boolean>(
    `(function(){
      var rows = document.querySelectorAll(${JSON.stringify(SHELL_ROWS)});
      if (rows.length !== ${expectedIndex + 1}) return false;
      var foot = rows[${expectedIndex}].querySelector('[data-slot="session-z1b-end-state"]');
      return foot !== null && foot.textContent.indexOf("exit") !== -1;
    })()`,
    { timeoutMs: 60_000 },
  );
  return app.evalJS<string>(
    `(function(){
      var rows = document.querySelectorAll(${JSON.stringify(SHELL_ROWS)});
      var out = rows[${expectedIndex}].querySelector(".tugx-term-content");
      return out ? out.textContent : "";
    })()`,
  );
}

describe.skipIf(!SHOULD_RUN)(
  "AT0353: a Shell-route commit carries the session citation and the machine id",
  () => {
    test(
      "the dash round's trailers name the session that ran the command",
      async () => {
        const app = await launchTugApp({
          testName: "at0353-shell-route-session-trailer",
          // The session ledger, named explicitly and off in the scratch
          // project. The app writes its `sessions` row here, and the shell
          // child inherits the variable — which is what makes the citation
          // survive the `TUG_DATA_DIR` redirect the commands carry: the
          // redirect moves the data *root*, and the ledger the citation is
          // read from lives under it. Named on the launch rather than typed
          // into the shell line because the per-instance path contains a
          // space, and an unquoted assignment would split mid-path.
          env: { TUG_SESSIONS_DB: join(projectDir, "sessions.db") },
        });
        try {
          // `isEngineReady` reads a deck-trace event; without tracing on, the
          // event is never recorded and the wait can only time out.
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          // A REAL spawn, not `bindSession`: the synthetic binding writes no
          // `sessions` row, and with no row there is no callsign to cite — the
          // commit would correctly omit both trailers and the test would be
          // asserting the harness's shape rather than the product's.
          await app.spawnSessionResume("A", { tugSessionId: SID, projectDir });
          await app.awaitEngineReady("A", { timeoutMs: 60_000 });

          // Everything except the command under test is prepared off-shell, so
          // the typed lines stay short and quote-free — a long compound line
          // typed into the composer is a source of failure that has nothing to
          // do with what this test is about.
          const dash = join(projectDir, ".tug", "worktrees", "at0353");
          await execAndSettle(app, `/shell cd ${projectDir}`, 0);
          await execAndSettle(
            app,
            `/shell ${REDIRECT(projectDir)} ${TUGUTIL} dash create at0353`,
            1,
          );
          writeFileSync(join(dash, "w.txt"), "work\n");
          const committed = await execAndSettle(
            app,
            `/shell ${REDIRECT(projectDir)} ${TUGUTIL} dash commit at0353 --message Addw`,
            2,
          );
          expect(committed).toContain("Committed changes to dash");
          // One trailer per command: a terminal row's `textContent` runs its
          // lines together with no separator, so a multi-value format would
          // have to be parsed by guessing where one value ends.
          const trailer = async (key: string, row: number): Promise<string> =>
            (
              await execAndSettle(
                app,
                `/shell git -C ${dash} log -1 "--format=%(trailers:key=${key},valueonly)"`,
                row,
              )
            ).trim();

          const session = await trailer("Tug-Session", 3);
          const id = await trailer("Tug-Session-Id", 4);
          note("citation", session);
          note("machine id", id);

          // The machine id is the whole point: it is what makes a citation
          // written today still resolvable years from now.
          expect(id).toBe(SID);
          // The citation is the callsign and the short id — or, for a session
          // the ledger never minted a callsign for, the bare short id. Either
          // way it carries the short id and NOT the session's name.
          expect(session).toContain(SHORT_ID);
          expect(session).not.toContain("Session A");
          if (session !== SHORT_ID) {
            expect(session).toMatch(
              new RegExp(`^[a-z][a-z0-9-]* \\(${SHORT_ID}\\)$`),
            );
          }
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
