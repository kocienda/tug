/**
 * at0772-close-stops-the-tool.test.ts — closing a Session card ends the work
 * running on its behalf, even when that work is the middle of a tool call.
 *
 * ## Why this exists
 *
 * A close is a promise the user reads as absolute: all work for the session
 * stops. A foreground Bash call leads a process group of its own, so nothing Tug
 * signals reaches it directly: tugcode signals claude, and claude ends the call.
 * What no unit test can say is that a real claude and a real tool do that at the
 * far end of the chain, so this file closes a card whose session is
 * inside a long Bash call and reads `ps`. The call is a script in the scratch
 * project, standing in for a build: claude refuses a bare long `sleep` as a
 * wasted wait, and a build is the shape of work the close has to reach.
 *
 * The sleep's fraction carries this run's pid, which makes its argv unique on a
 * machine that is also running the suite. It is a child of the script, as a
 * compiler is of a build, and it is the one that has to die.
 *
 * It seats a real claude, so it is on demand only:
 *
 *     TUG_REAL_CLAUDE=1 just app-test tests/app-test/at0772-close-stops-the-tool.test.ts
 *
 * @covers tugrust/crates/tugcast/src/feeds/agent_bridge.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor/control/session.rs
 * @covers tugcode/src/main.ts
 * @covers tugcode/src/claude-process.ts
 * @covers tugdeck/src/lib/card-services-store.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import { rmScratchSession, seedScratchSession } from "./arc-fixture";

/**
 * Two gates: `TUGAPP_APP_TEST` is every app-test's; `TUG_REAL_CLAUDE` is this
 * file's own, because a real turn is not something a derived selection should
 * start on its own.
 */
const SHOULD_RUN =
  process.env.TUGAPP_APP_TEST === "1" && process.env.TUG_REAL_CLAUDE === "1";
const GATED_OFF = process.env.TUGAPP_APP_TEST === "1" && !SHOULD_RUN;

const TEST_TIMEOUT_MS = 120_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000772";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const PERMISSION_ALLOW = `${CARD} [data-slot="session-permission-dialog"] .tug-inline-dialog-actions .tug-button-primary-action`;
const CLOSE_CONFIRM = '[data-slot="tug-confirm-confirm"]';

const SLEEP = `sleep 300.${process.pid}`;
const TASK = "./long-task.sh";

/**
 * How long the close has to end everything: tugcast's bounded wait on tugcode,
 * `tugcore::quiesce::DRAIN_DEADLINE_MS`, plus room to read `ps`.
 */
const GONE_WITHIN_MS = 6_000;

let projectDir = "";
let sessionDir = "";

interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

/** Every process on the machine. */
function processTable(): ProcessRow[] {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .split("\n")
    .flatMap((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return m === null
        ? []
        : [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4]! }];
    });
}

/** The sleep itself, which never matches its wrapping shell's longer argv. */
const sleepRow = (): ProcessRow | undefined =>
  processTable().find((p) => p.command === SLEEP);

const alive = (pid: number): boolean => processTable().some((p) => p.pid === pid);

/** The sleep's ancestors, nearest first, as far as tugcode. */
function ancestorsToTugcode(start: ProcessRow): ProcessRow[] {
  const table = new Map(processTable().map((p) => [p.pid, p]));
  const chain: ProcessRow[] = [];
  let at = table.get(start.ppid);
  while (at !== undefined) {
    chain.push(at);
    if (/\btugcode\b/.test(at.command.split(/\s+/)[0] ?? "")) return chain;
    at = table.get(at.ppid);
  }
  throw new Error(`at0772: no tugcode above the sleep — ${JSON.stringify(chain)}`);
}

beforeAll(() => {
  if (GATED_OFF) {
    note(
      "at0772 skipped",
      "real-claude only — run with TUG_REAL_CLAUDE=1 just app-test tests/app-test/at0772-close-stops-the-tool.test.ts",
    );
  }
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0772-")));
  const task = join(projectDir, TASK);
  writeFileSync(task, `#!/bin/sh\n${SLEEP}\n`);
  chmodSync(task, 0o755);
  sessionDir = seedScratchSession(projectDir, SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  // Outliving the test is the failure this file is about, so the sleep is swept
  // either way rather than left for the next run to find.
  try {
    execFileSync("/usr/bin/pkill", ["-f", SLEEP], { stdio: "ignore" });
  } catch {
    // Nothing matched, which is the green case.
  }
  rmScratchSession(sessionDir);
  if (projectDir !== "") rmSync(projectDir, { recursive: true, force: true });
});

describe.skipIf(!SHOULD_RUN)("AT0772: a close ends the tool call", () => {
  test(
    "closing a card mid-Bash leaves neither the sleep nor claude running",
    async () => {
      const app = await launchTugApp({ testName: "at0772-close-stops-the-tool" });
      const left: ProcessRow[] = [];
      try {
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });

        await app.body("A").nativeClickAtElement(EDITOR);
        // Keys sent before the editor holds the focus have no responder.
        await app.body("A").waitForCondition<boolean>(
          `document.hasFocus() && document.activeElement === document.querySelector(${JSON.stringify(EDITOR)})`,
          { timeoutMs: 10_000 },
        );
        await app.nativeType(
          `This is an automated test of closing a card while a tool runs. Please use the Bash tool to run ${TASK} in the foreground, with a timeout of 400000 ms; it stands in for a long build, and the test closes this card while it runs.`,
        );
        await new Promise((r) => setTimeout(r, 200));
        await app.nativeKey("Escape");
        await new Promise((r) => setTimeout(r, 200));
        await app.nativeKey("Return", ["cmd"]);

        const startDeadline = Date.now() + 60_000;
        let sleep = sleepRow();
        while (sleep === undefined && Date.now() < startDeadline) {
          // The call asks first, and the answer is the one a person gives.
          await app.body("A").evalJS<null>(
            `(document.querySelector(${JSON.stringify(PERMISSION_ALLOW)})?.click(), null)`,
          );
          await new Promise((r) => setTimeout(r, 100));
          sleep = sleepRow();
        }
        if (sleep === undefined) {
          note(
            "at0772 the card when no sleep ran",
            await app.body("A").evalJS<string>(
              `(document.querySelector(${JSON.stringify(CARD)})?.textContent ?? "").slice(-1500)`,
            ),
          );
          note(
            "at0772 sleep-shaped processes",
            JSON.stringify(processTable().filter((p) => p.command.includes(SLEEP))),
          );
        }
        expect(sleep, "the turn reached the tool call").toBeDefined();

        // Named before the close, while the chain is there to walk.
        const chain = ancestorsToTugcode(sleep!);
        const tugcode = chain[chain.length - 1]!;
        const claude = chain[chain.length - 2]!;
        note(
          "at0772 the chain under the card",
          JSON.stringify([sleep!, ...chain].map((p) => ({ ...p, command: p.command.slice(0, 80) }))),
        );
        await app.dispatchControlAction("close");
        // A Session card asks first, and the close is the answer.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CLOSE_CONFIRM)}) !== null`,
          { timeoutMs: 5_000 },
        );
        await app.body("A").evalJS<null>(
          `(document.querySelector(${JSON.stringify(CLOSE_CONFIRM)}).click(), null)`,
        );
        const closedAt = Date.now();

        const watched = { sleep: sleep!, claude, tugcode };
        const goneAfter: Record<string, number | null> = { sleep: null, claude: null, tugcode: null };
        while (Date.now() - closedAt < GONE_WITHIN_MS) {
          const table = new Set(processTable().map((p) => p.pid));
          for (const [name, row] of Object.entries(watched)) {
            if (goneAfter[name] === null && !table.has(row.pid)) {
              goneAfter[name] = Date.now() - closedAt;
            }
          }
          if (Object.values(goneAfter).every((ms) => ms !== null)) break;
          await new Promise((r) => setTimeout(r, 25));
        }
        note("at0772 ms from the close to each exit", JSON.stringify(goneAfter));
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CARD)}) === null`,
          { timeoutMs: 5_000 },
        );

        for (const row of Object.values(watched)) {
          if (alive(row.pid)) left.push(row);
        }
        note("at0772 still running after the close", left.map((p) => p.command.slice(0, 40)).join(" | "));
        expect(goneAfter.sleep, "the tool's subprocess is gone").not.toBeNull();
        expect(goneAfter.claude, "claude is gone").not.toBeNull();
        expect(goneAfter.tugcode, "tugcode is gone").not.toBeNull();
      } finally {
        for (const row of left) {
          try {
            process.kill(row.pid, "SIGKILL");
          } catch {
            // It went on its own while the assertions ran.
          }
        }
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
