/**
 * at0749 — `tugtool host instance quit` quits the app the way the OS does.
 *
 * The quit verb sends the `quit` Apple Event straight to the host app's
 * pid and waits for the process to go, never signalling it. So this test
 * launches the harness app, runs the verb against its instance, and reads
 * the app's own account of what happened:
 *
 * - the host's run-loop watch answers `/api/host/state` while the app is
 *   up, in the default mode, with its count of bodies;
 * - the verb reports `quit`, and the app was gone within 5 s;
 * - `tugapp.log` carries the pre-dispatch line for `aevt/quit` naming the
 *   verb's own pid as the sender — the event arrived as an Apple Event,
 *   from the verb, not as a signal from anywhere;
 * - the same log carries the termination pipeline's verdict line, so the
 *   deck was asked to save before the app went;
 * - `quiesce-report.json` was written, with no SIGKILL in it.
 *
 * The verb is this checkout's `tugtool`, not the one on `PATH`, which is
 * the installed app's build and knows nothing of a verb added on a branch.
 *
 * @covers tugrust/crates/tugtool/src/commands/instance_quit.rs
 * @covers tugrust/crates/tugtool/src/commands/instance.rs
 * @covers tugrust/crates/tugcore/src/apple_event.rs
 * @covers tugapp/Sources/HostRunLoopWatch.swift
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugapp/Sources/TugLog.swift
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch } from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;
const EXIT_WITHIN_MS = 5_000;
const REGISTERED_WITHIN_MS = 10_000;

const TUGTOOL = resolve(import.meta.dir, "../../tugrust/target/debug/tugtool");

interface RegistryEntry {
  instance_id: string;
  host_pid: number;
  tugcast_port: number;
}

/** The instance's registry entry, once tugcast has written it with its host. */
async function registered(instanceId: string): Promise<RegistryEntry | null> {
  const deadline = Date.now() + REGISTERED_WITHIN_MS;
  while (Date.now() < deadline) {
    const out = Bun.spawnSync({ cmd: [TUGTOOL, "--json", "host", "instance", "list"], stdout: "pipe", stderr: "pipe" });
    if (out.exitCode === 0) {
      const doc = JSON.parse(new TextDecoder().decode(out.stdout)) as { data: { instances: RegistryEntry[] } };
      const entry = doc.data.instances.find((i) => i.instance_id === instanceId);
      if (entry !== undefined && entry.host_pid > 0) return entry;
    }
    await Bun.sleep(100);
  }
  return null;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!SHOULD_RUN)("at0749: the native quit verb", () => {
  test(
    "quits the app with the quit Apple Event, through the termination pipeline, within 5 s",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const app = await launchTugApp({
        testName: "at0749",
        env: { TUGBANK_PATH: tugbankPath },
        skipAccessibilityPreflight: true,
      });
      try {
        const entry = await registered(app.instanceId);
        expect(entry, "tugcast registered the instance with its host pid").not.toBeNull();
        const hostPid = entry!.host_pid;

        // The run-loop watch answers while the app is up.
        const stateResponse = await fetch(`http://127.0.0.1:${entry!.tugcast_port}/api/host/state`);
        const state = (await stateResponse.json()) as { state?: { mode?: string; body_count?: number } };
        note(`host state: ${JSON.stringify(state.state)}`);
        expect(stateResponse.status, "/api/host/state answers").toBe(200);
        expect(state.state?.mode, "the host is in the default run-loop mode").toBe("kCFRunLoopDefaultMode");
        expect(typeof state.state?.body_count, "and counts the bodies it holds").toBe("number");

        const started = Date.now();
        const quit = Bun.spawn({
          cmd: [TUGTOOL, "--json", "host", "instance", "quit", app.instanceId, "--timeout", "15"],
          stdout: "pipe",
          stderr: "pipe",
        });
        const senderPid = quit.pid;
        const exitCode = await quit.exited;
        const wallMs = Date.now() - started;
        const stdout = await new Response(quit.stdout).text();
        note(`quit (${wallMs} ms, exit ${exitCode}): ${stdout.trim()}`);
        expect(exitCode, "the verb succeeds").toBe(0);
        const report = JSON.parse(stdout) as { status: string; data: { outcome: string; exit_ms: number | null } };
        expect(report.data.outcome, "the verb reports the app quit").toBe("quit");
        expect(report.data.exit_ms ?? Infinity, "the app exited within 5 s of the event").toBeLessThan(EXIT_WITHIN_MS);
        expect(alive(hostPid), "the host app is gone").toBe(false);

        const log = app.tugappLog();
        const dispatch = log.split("\n").filter((line) => line.includes("tugapp::appleevent: dispatch") && line.includes("id=quit"));
        note(`dispatch: ${dispatch.join(" / ") || "no quit dispatch in tugapp.log"}`);
        expect(dispatch.length, "the quit arrived as an Apple Event").toBeGreaterThan(0);
        expect(dispatch.at(-1), "of class aevt").toContain("class=aevt");
        expect(dispatch.at(-1), "sent by the verb itself").toContain(`sender_pid=${senderPid}`);

        const verdict = log.split("\n").filter((line) => line.includes("termination verdicts")).pop() ?? "";
        note(`verdict: ${verdict.trim() || "no verdict line in tugapp.log"}`);
        expect(verdict, "the termination pipeline ran and reported").not.toBe("");

        const quiesce = app.quiesceReport();
        expect(quiesce, "the app wrote its quiesce report").not.toBeNull();
        expect(quiesce!.sigkills, "and nothing had to be killed").toEqual([]);
      } finally {
        // The app is gone; this reclaims the harness's own bookkeeping.
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
