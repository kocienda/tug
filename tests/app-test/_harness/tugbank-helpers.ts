/**
 * tugbank-helpers.ts — Shell wrappers around the `tugbank` CLI for
 * cold-boot tests that need to read tugbank state from disk between
 * two Tug.app launches.
 *
 * Why shell out instead of opening sqlite directly: tugbank's storage
 * format (typed value-kind discriminators, json-string encoding) is
 * the source of truth that lives in `tugbank-core`. Re-implementing
 * the decode in TS would drift; calling the canonical CLI is cheap
 * (single fork+exec, ~5ms on a warm cache) and keeps the test surface
 * thin.
 *
 * Binary resolution: requires `process.env.TUGAPP_TUGBANK_BINARY` to
 * point at a built `tugbank` binary. The `just test-in-app-fast`
 * recipe sets this; tests that try to use these helpers without it
 * throw a clear error rather than silently shelling to whatever
 * `tugbank` is on PATH.
 *
 * Per-test isolation: pair {@link mkTempTugbank} with
 * `launchTugApp({ env: { TUGBANK_PATH: <path> } })` so Tug.app's
 * `TugbankClient` and the spawned tugcast both write to the temp
 * file. The Swift side reads `TUGBANK_PATH` in
 * `AppDelegate.applicationDidFinishLaunching`; tugcast inherits
 * Tug.app's full env when spawned (`ProcessManager.startProcess`).
 *
 * Lifecycle: tests own their temp DB. `mkTempTugbank` returns a
 * unique path; sqlite creates the file on first write. After the
 * second-process read is done, call {@link rmTempTugbank} to remove
 * the file plus its WAL/SHM siblings. Calling it is still the right
 * habit — it frees the file as soon as the test is done with it — but
 * it is no longer the only thing standing between a forgetful test and
 * a leak: every minted path is tracked and swept on process exit.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as pathResolve } from "node:path";
import { randomUUID } from "node:crypto";

import { onTestRunEnd } from "./test-cleanup";

/**
 * The tagged-value envelope tugbank emits for `read --json`.
 *
 * Mirrors the CLI's S04 output for a single key:
 *
 *     { "ok": true, "data": { "value": <v>, "type": "<t>" } }
 *
 * `type` is the value-kind name from `tugbank-core/src/value.rs`
 * ("null" | "bool" | "int" | "float" | "string" | "bytes" | "json");
 * `value` is the decoded JSON form (bytes are base64 strings).
 */
export interface TugbankReadResult<T = unknown> {
  value: T;
  type: "null" | "bool" | "int" | "float" | "string" | "bytes" | "json";
}

/**
 * Generate a unique tugbank temp-DB path under `os.tmpdir()`. Does
 * NOT create the file — tugbank/sqlite create it on first write.
 *
 * Caller passes the returned path to `launchTugApp({ env: { TUGBANK_PATH } })`
 * so Tug.app and tugcast use the same per-test DB. Pair with
 * {@link rmTempTugbank} in a `finally` block.
 */
export function mkTempTugbank(): string {
  const path = `${tmpdir()}/tugapp-test-tugbank-${randomUUID()}.db`;
  minted.add(path);
  return path;
}

/**
 * Every path {@link mkTempTugbank} has handed out and {@link rmTempTugbank}
 * has not yet reclaimed. Caller discipline alone left 373 of these in
 * `$TMPDIR` — many tests simply never called the cleanup.
 */
const minted = new Set<string>();

onTestRunEnd(() => {
  for (const path of [...minted]) rmTempTugbank(path);
});

/**
 * Remove a temp tugbank DB plus its sqlite WAL/SHM siblings.
 * Idempotent — missing files are silently ignored.
 *
 * tugbank-core opens with `journal_mode=WAL`, which produces
 * `<path>-wal` and `<path>-shm` files alongside the main DB. A
 * naive `unlink(path)` leaves them behind to leak across test runs.
 */
export function rmTempTugbank(path: string): void {
  minted.delete(path);
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      unlinkSync(p);
    } catch {
      // missing — fine
    }
  }
}

/**
 * Read a single key from a tugbank DB via the CLI. Returns `null`
 * when the key does not exist (CLI exit code 2).
 *
 * Throws on any other non-zero exit so the caller doesn't have to
 * defensively branch on every shell-out.
 *
 *     const r = tugbankRead(path, "dev.tugapp.test", "smoke-key");
 *     if (r === null) throw new Error("expected key on disk");
 *     expect(r.type).toBe("string");
 *     expect(r.value).toBe("hello");
 */
export function tugbankRead<T = unknown>(
  path: string,
  domain: string,
  key: string,
): TugbankReadResult<T> | null {
  const result = runTugbank(["--path", path, "--json", "read", domain, key]);
  if (result.exitCode === 2) return null;
  if (result.exitCode !== 0) {
    throw new Error(
      `tugbank read failed (exit=${result.exitCode}, path=${path}, ${domain}/${key}): ${result.stderr || result.stdout}`,
    );
  }
  let envelope: { ok: boolean; data?: TugbankReadResult<T>; error?: string };
  try {
    envelope = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(
      `tugbank read returned non-JSON output: ${String(err)} (stdout=${result.stdout.slice(0, 200)})`,
    );
  }
  if (!envelope.ok) {
    throw new Error(`tugbank read returned ok=false: ${envelope.error ?? "unknown"}`);
  }
  if (!envelope.data) {
    throw new Error("tugbank read envelope missing 'data'");
  }
  return envelope.data;
}

/**
 * Delete a single key from a tugbank DB via the CLI. Idempotent —
 * "not found" (exit 2) is treated as success.
 */
export function tugbankDelete(path: string, domain: string, key: string): void {
  const result = runTugbank(["--path", path, "delete", domain, key]);
  if (result.exitCode !== 0 && result.exitCode !== 2) {
    throw new Error(
      `tugbank delete failed (exit=${result.exitCode}, path=${path}, ${domain}/${key}): ${result.stderr || result.stdout}`,
    );
  }
}

/**
 * The value-kind discriminator the `tugbank write` CLI accepts via
 * its `--type` flag. Mirrors `tugbank-core/src/value.rs` minus
 * `null` (which has its own no-value branch in the CLI).
 */
export type TugbankWriteType = "string" | "bool" | "int" | "float" | "json";

/**
 * Write a single key into a tugbank DB via the CLI. Use this to
 * seed values into a fresh per-test temp DB before launching
 * Tug.app — see {@link seedTugbankForLaunch} for the standard
 * minimum-boot seeding.
 *
 * `value` is passed as a string and parsed by the CLI per `type`:
 *   - `"string"` — verbatim
 *   - `"bool"` — "true" or "false"
 *   - `"int"` — decimal integer
 *   - `"float"` — decimal float
 *   - `"json"` — must be valid JSON (the test-side caller typically
 *     calls `JSON.stringify(value)` to produce this).
 */
export function tugbankWrite(
  path: string,
  domain: string,
  key: string,
  type: TugbankWriteType,
  value: string,
): void {
  const result = runTugbank([
    "--path", path,
    "write", domain, key,
    "--type", type,
    value,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `tugbank write failed (exit=${result.exitCode}, path=${path}, ${domain}/${key}=${type}:${value}): ${result.stderr || result.stdout}`,
    );
  }
}

/**
 * Seed a fresh temp tugbank with the minimum values Tug.app reads
 * at startup so it can boot through to a usable tugdeck.
 *
 * Without this, `AppDelegate.applicationDidFinishLaunching` reads
 * `dev.tugapp.app/source-tree-path` (via `loadPreferences`),
 * finds nothing, and renders the "Source Tree Required" alert
 * instead of bringing up tugdeck. The harness's `launchTugApp`
 * post-handshake wait for `window.__tug` then times out, masking
 * the real failure as a generic launch timeout.
 *
 * Seeded:
 *   - `dev.tugapp.app/source-tree-path` = repo root, so
 *     ProcessManager can locate `tugdeck/dist` and tugcast can
 *     ServeDir from it.
 *
 * Maker mode is not seeded: it is derived from the build profile and
 * pinned off under the app-test harness.
 *
 * `sourceTreePath` defaults to the repo root derived from this
 * module's location: `tests/app-test/_harness/tugbank-helpers.ts`
 * sits three directories below the repo root.
 */
export function seedTugbankForLaunch(
  path: string,
  opts?: {
    sourceTreePath?: string;
  },
): void {
  const sourceTreePath = opts?.sourceTreePath ?? defaultRepoRoot();
  tugbankWrite(path, "dev.tugapp.app", "source-tree-path", "string", sourceTreePath);
}

function defaultRepoRoot(): string {
  // import.meta.dir → tests/app-test/_harness/ ; go up three levels.
  return pathResolve(import.meta.dir, "..", "..", "..");
}

interface TugbankSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runTugbank(args: string[]): TugbankSpawnResult {
  const binary = process.env.TUGAPP_TUGBANK_BINARY;
  if (!binary) {
    throw new Error(
      "TUGAPP_TUGBANK_BINARY is not set. The cold-boot harness requires the tugbank CLI; " +
        "set this env var to a built tugbank binary (the `just test-in-app-fast` recipe does this automatically).",
    );
  }
  const spawnSync = (
    globalThis as unknown as {
      Bun?: {
        spawnSync: (opts: Record<string, unknown>) => {
          exitCode: number;
          stdout: Uint8Array;
          stderr: Uint8Array;
        };
      };
    }
  ).Bun?.spawnSync;
  if (!spawnSync) {
    throw new Error("Bun.spawnSync is unavailable; tugbank-helpers requires bun");
  }
  const result = spawnSync({
    cmd: [binary, ...args],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}
