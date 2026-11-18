/**
 * at0856-launch-handoff.test.ts — a second copy of Tug launched under an
 * identity that is already running hands its file to the running copy and
 * quits, with no second tugcast.
 *
 * ## What this pins
 *
 * Two copies of Tug with one identity are one app to macOS, so a
 * notification click, a Dock click or a file open can launch the copy that
 * is not running. That copy used to build its window, open the running
 * instance's tugbank, spawn a tugcast that was refused as a duplicate, and
 * put up "Another … instance is already running". Now it reads the
 * registry before `AppDelegate` exists, finds a live host at the registry's
 * bundle path, passes its files to that host through LaunchServices, and
 * quits.
 *
 * ## Shape
 *
 *   1. Launch the harness app and wait for its deck; the registry then holds
 *      its entry (tugcast registers before it reports ready).
 *   2. Launch a second copy of the same bundle with the same
 *      `TUG_INSTANCE_ID`, the hand-off opt-in, and a text file to open.
 *      App-test instances never hand off without the opt-in, so every other
 *      harness launch is untouched.
 *   3. The second copy quits on its own, having logged its hand-off line —
 *      a copy that launched normally would never quit by itself, so the
 *      deadline is a liveness bound, not a speed claim.
 *   4. A Text card holding the file's contents opens in the first copy.
 *   5. The registry still holds exactly one entry for the identity, with
 *      the first copy's host and tugcast pids: no second tugcast was spawned.
 *
 * A second test launches a copy with no file against a first copy whose
 * window is in the Dock. Activation alone leaves a minimised window
 * minimised, so the hand-off posts a `raise` tell to the running copy's
 * tugcast, which relays it to that copy's host over the control socket; the
 * window comes back.
 *
 * @covers tugapp/Sources/LaunchHandoff.swift
 * @covers tugapp/Sources/LaunchHandoffDelegate.swift
 * @covers tugapp/Sources/main.swift
 * @covers tugapp/Sources/ProcessManager.swift
 * @covers tugrust/crates/tugcast/src/actions.rs
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchTugApp } from "./_harness";
import { kindBody } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 60_000;

/** A copy that launched normally never quits by itself; one that hands off does at once. */
const HANDOFF_DEADLINE_MS = 10_000;

const MARKER = "launch-handoff-delivered";

interface RegistryEntry {
  instance_id: string;
  pid: number;
  host_pid?: number;
}

function registryEntries(instanceId: string): RegistryEntry[] {
  const file = path.join(os.tmpdir(), "tug-instances.json");
  const doc = JSON.parse(fs.readFileSync(file, "utf8")) as { instances?: RegistryEntry[] };
  return (doc.instances ?? []).filter((entry) => entry.instance_id === instanceId);
}

describe.skipIf(!SHOULD_RUN)("at0856: a duplicate launch hands off to the running copy", () => {
  test(
    "the second copy passes its file to the first, quits, and spawns no tugcast",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0856-"));
      const file = path.join(dir, "handed-off.md");
      fs.writeFileSync(file, `# Hand-off\n\n${MARKER}\n`);
      const app = await launchTugApp({ skipAccessibilityPreflight: true, testName: "at0856-launch-handoff" });
      try {
        await app.waitForCondition<boolean>(`typeof window.__tug !== "undefined"`, { timeoutMs: 15_000 });

        const before = registryEntries(app.instanceId);
        expect(before.length, "the first copy is registered").toBe(1);
        const tugcastPid = before[0].pid;
        expect(before[0].host_pid, "the registry names the first copy's host").toBe(app.hostPid);

        const second = app.launchSecondCopy({
          env: { TUGAPP_LAUNCH_HANDOFF: "1" },
          files: [file],
          logPath: path.join(dir, "second-copy.log"),
        });
        const quit = await second.exitedWithin(HANDOFF_DEADLINE_MS);
        expect(quit, `the second copy quit on its own; its log:\n${second.log()}`).toBe(true);
        expect(await second.exitCode()).toBe(0);
        expect(second.log(), "the second copy took the hand-off path").toContain("LaunchHandoff: instance");

        await kindBody(app, "text").waitForCondition<boolean>(
          `(function(){
            var ed = document.querySelector('[data-slot="tug-text-card-editor"] .cm-content');
            return ed !== null && (ed.textContent || '').indexOf(${JSON.stringify(MARKER)}) !== -1;
          })()`,
          { timeoutMs: 12_000 },
        );

        const after = registryEntries(app.instanceId);
        expect(after.length, "still one registry entry for the identity").toBe(1);
        expect(after[0].pid, "the same tugcast holds it").toBe(tugcastPid);
        expect(after[0].host_pid, "the same host holds it").toBe(app.hostPid);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0856] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a plain second launch restores the first copy's minimised window",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0856-raise-"));
      const app = await launchTugApp({ skipAccessibilityPreflight: true, testName: "at0856-launch-handoff-raise" });
      try {
        await app.waitForCondition<boolean>(`typeof window.__tug !== "undefined"`, { timeoutMs: 15_000 });
        expect(registryEntries(app.instanceId).length, "the first copy is registered").toBe(1);

        expect(await app.miniaturizeWindow(), "the first copy's window went to the Dock").toBe(true);

        const second = app.launchSecondCopy({
          env: { TUGAPP_LAUNCH_HANDOFF: "1" },
          logPath: path.join(dir, "second-copy.log"),
        });
        const quit = await second.exitedWithin(HANDOFF_DEADLINE_MS);
        expect(quit, `the second copy quit on its own; its log:\n${second.log()}`).toBe(true);
        expect(second.log(), "the second copy took the hand-off path with no files").toContain("handing off 0 file(s)");

        expect(await app.awaitMiniaturized(false, 8000), "the raise brought the window back").toBe(false);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0856] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
