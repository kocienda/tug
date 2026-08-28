/**
 * at0491-bundle-leads-child-path.test.ts — the running bundle's own
 * `Contents/MacOS/` is the first entry on the PATH tugcast inherits.
 *
 * Everything a session runs descends from tugcast: tugcode, the claude it
 * spawns, the plugin hooks, the shell panes. On a machine with only Tug.app
 * installed there is no `~/.local/bin/tugutil` symlink and no checkout, so the
 * only way `tugutil` resolves for any of them is the app seeding the child PATH
 * with the bundle's binary directory — and seeding it *first*, so a session
 * inside an instance runs that instance's binaries rather than whatever a
 * stale symlink points at.
 *
 * The probe reads the live process: find the tugcast child of the launched
 * app, read its environment, and compare PATH's head with the directory the
 * tugcast executable itself lives in.
 *
 * @covers tugapp/Sources/ProcessManager.swift
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

function sh(cmd: string[]): string {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(proc.stdout).trim();
}

/** The tugcast child of the app process, once it exists. */
async function tugcastPidUnder(hostPid: number): Promise<number> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const out = sh(["pgrep", "-P", String(hostPid), "-x", "tugcast"]);
    const pid = Number.parseInt(out.split("\n")[0] ?? "", 10);
    if (Number.isFinite(pid) && pid > 0) return pid;
    await Bun.sleep(250);
  }
  throw new Error(`no tugcast child under app pid ${hostPid} within 30s`);
}

describe.skipIf(!SHOULD_RUN)("the bundle leads the child PATH", () => {
  test(
    "tugcast's PATH starts with the directory its own executable is in",
    async () => {
      const app = await launchTugApp({ testName: "at0491-bundle-leads-child-path" });
      try {
        expect(app.hostPid).toBeGreaterThan(0);
        const pid = await tugcastPidUnder(app.hostPid);

        const exe = sh(["ps", "-o", "comm=", "-p", String(pid)]);
        expect(exe.endsWith("/tugcast")).toBe(true);
        const binDir = dirname(exe);
        expect(existsSync(join(binDir, "tugutil"))).toBe(true);

        const command = sh(["ps", "-E", "-ww", "-o", "command=", "-p", String(pid)]);
        const pathVar = command.split(" ").find((word) => word.startsWith("PATH="));
        expect(pathVar).toBeDefined();
        const entries = pathVar!.slice("PATH=".length).split(":");
        expect(entries[0]).toBe(binDir);
        expect(entries.filter((e) => e === binDir)).toHaveLength(1);
      } finally {
        await app.quitGracefully();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
