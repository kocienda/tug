/**
 * add-directory.test.ts — a folder grant is applied live, keeps the whole
 * list, and survives every respawn as `--add-dir`; a removal takes it back
 * out, live or by a respawn in place.
 *
 * Claude Code's `apply_flag_settings` replaces the directory list it last
 * received, validates nothing, and dies with the process. So tugcode must
 * send the session's whole list on every grant, refuse a bad path itself,
 * keep a folder only once claude has accepted it, and re-apply the list as
 * `--add-dir` flags when it spawns again.
 *
 * The request cannot withdraw a folder claude was spawned with, since
 * `--add-dir` is a layer it does not replace; removing one of those respawns
 * claude with a list that leaves it out.
 *
 * Every grant and removal is answered on a `directory_result` frame — done
 * with the whole list, or refused with the reason — never an `error` frame,
 * which would put the card in its errored state over a mistyped path.
 *
 * The manager runs for real; only the two spawn primitives (`Bun.which`,
 * `Bun.spawn`) are stubbed, claude's stdin is a recorder, and stdout is
 * captured through `Bun.write`. Claude's answers are fed through the same
 * `handleClaudeLine` its stdout drain uses.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../session.ts";
import { reportedAdditionalDirectories } from "../event-mapping.ts";
import { tugDataRoot } from "../spawn-config.ts";
import { drainPendingWrites } from "../ipc.ts";

const SID = "44444444-4444-4444-4444-444444444444";
const FAKE_CLAUDE = "/usr/local/bin/claude-under-test";

const realWhich = Bun.which;
const realSpawn = Bun.spawn;
const realWrite = Bun.write;

/** The JSON frames tugcode wrote to stdout since the last reset. */
let frames: any[] = [];

let root = "";
let dirA = "";
let dirB = "";
let aFile = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tugcode-add-dir-"));
  dirA = join(root, "a");
  dirB = join(root, "b");
  mkdirSync(dirA);
  mkdirSync(dirB);
  aFile = join(root, "file.txt");
  writeFileSync(aFile, "not a folder\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Every argv `Bun.spawn` was handed since the last reset, in launch order. */
let spawns: string[][] = [];

beforeEach(() => {
  spawns = [];
  frames = [];
  (Bun as any).write = (dest: unknown, data: unknown) => {
    if (dest === Bun.stdout && typeof data === "string") {
      for (const line of data.split("\n")) {
        if (line.trim() !== "") frames.push(JSON.parse(line));
      }
      return Promise.resolve(data.length);
    }
    return realWrite(dest as any, data as any);
  };
  (Bun as unknown as { which: unknown }).which = (cmd: string) =>
    cmd === "claude" ? FAKE_CLAUDE : null;
  (Bun as unknown as { spawn: unknown }).spawn = (cmd: string[]) => {
    spawns.push(cmd.slice(1));
    return fakeProcess([]);
  };
});

afterEach(() => {
  (Bun as any).write = realWrite;
  (Bun as unknown as { which: unknown }).which = realWhich;
  (Bun as unknown as { spawn: unknown }).spawn = realSpawn;
});

/** A claude stand-in whose stdin records every line written to it. */
function fakeProcess(written: string[]): unknown {
  return {
    stdin: {
      write: (data: string) => {
        written.push(data);
      },
      flush: () => {},
      end: () => {},
    },
    stdout: null,
    exited: Promise.resolve(0),
    kill: () => {},
    pid: 4343,
  };
}

/** A manager with a live (fake) claude whose stdin lines land in `written`. */
function manager(written: string[], grantedDirectories?: string[]): any {
  const m = new SessionManager(
    "/tmp/tugcode-add-dir-" + SID,
    SID,
    "new",
    undefined,
    { sessionsDbPath: null, grantedDirectories },
  ) as any;
  m.claudeCodeVersion = "2.1.322";
  m.startStdoutDrain = () => {};
  m.claudeProcess = fakeProcess(written);
  return m;
}

/** The `apply_flag_settings` requests written to claude's stdin, parsed. */
function flagRequests(written: string[]): Array<{ request_id: string; list: string[] }> {
  return written
    .map((line) => JSON.parse(line))
    .filter((msg) => msg.type === "control_request" && msg.request?.subtype === "apply_flag_settings")
    .map((msg) => ({
      request_id: msg.request_id,
      list: msg.request.settings.permissions.additionalDirectories,
    }));
}

/** Claude's answer to a control request, as its stdout would carry it. */
function answer(m: any, requestId: string, error?: string): void {
  const response =
    error === undefined
      ? { subtype: "success", request_id: requestId }
      : { subtype: "error", request_id: requestId, error };
  m.handleClaudeLine(JSON.stringify({ type: "control_response", response }));
}

/** Let the grant chain reach its request before claude answers it. */
async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** The `directory_result` frames written so far, once flushed. */
async function results(): Promise<any[]> {
  await drainPendingWrites();
  return frames.filter((f) => f.type === "directory_result");
}

/** The `system_metadata` frames written so far, once flushed. */
async function metadata(): Promise<any[]> {
  await drainPendingWrites();
  return frames.filter((f) => f.type === "system_metadata");
}

/** The values following each `--add-dir` in an argv. */
function addDirs(args: string[]): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === "--add-dir") out.push(args[i + 1]);
  });
  return out;
}

describe("a grant is applied live", () => {
  test("the folder is sent in apply_flag_settings and kept on success", async () => {
    const written: string[] = [];
    const m = manager(written);
    const grant = m.handleAddDirectory(dirA);
    await tick();
    const [req] = flagRequests(written);
    expect(req.list).toEqual([dirA]);
    answer(m, req.request_id);
    await grant;
    expect(m.additionalDirectories).toEqual([dirA]);
    expect(spawns.length).toBe(0);
    const [result] = await results();
    expect(result).toMatchObject({
      op: "add",
      directory: dirA,
      ok: true,
      additional_directories: [dirA],
      tug_session_id: SID,
    });
    expect(result.reason).toBeUndefined();
  });

  test("a second grant sends the whole list, because the request replaces it", async () => {
    const written: string[] = [];
    const m = manager(written);
    const first = m.handleAddDirectory(dirA);
    const second = m.handleAddDirectory(dirB);
    await tick();
    answer(m, flagRequests(written)[0].request_id);
    await first;
    await tick();
    const requests = flagRequests(written);
    expect(requests.length).toBe(2);
    expect(requests[1].list).toEqual([dirA, dirB]);
    answer(m, requests[1].request_id);
    await second;
    expect(m.additionalDirectories).toEqual([dirA, dirB]);
    expect((await results()).map((r) => r.additional_directories)).toEqual([[dirA], [dirA, dirB]]);
  });

  test("a folder already granted sends nothing", async () => {
    const written: string[] = [];
    const m = manager(written);
    const grant = m.handleAddDirectory(dirA);
    await tick();
    answer(m, flagRequests(written)[0].request_id);
    await grant;
    await m.handleAddDirectory(dirA + "/");
    expect(flagRequests(written).length).toBe(1);
    expect(m.additionalDirectories).toEqual([dirA]);
  });

  test("before claude is up the folder is kept for the first spawn", async () => {
    const written: string[] = [];
    const m = manager(written);
    m.claudeProcess = null;
    await m.handleAddDirectory(dirA);
    expect(m.additionalDirectories).toEqual([dirA]);
    expect(written.length).toBe(0);
  });
});

describe("a grant that cannot be applied is refused", () => {
  test("a path that is not a directory is refused before anything is sent", async () => {
    const written: string[] = [];
    const m = manager(written);
    await m.handleAddDirectory(aFile);
    await m.handleAddDirectory(join(root, "missing"));
    await m.handleAddDirectory("relative/dir");
    expect(written.length).toBe(0);
    expect(m.additionalDirectories).toEqual([]);
    const refused = await results();
    expect(refused.map((r) => r.ok)).toEqual([false, false, false]);
    expect(refused[0].reason).toContain("is not a directory");
    expect(refused[1].reason).toContain("does not exist");
    expect(refused[2].reason).toContain("is not an absolute path");
    expect(refused[0].additional_directories).toEqual([]);
  });

  test("an error answer refuses the grant, names the folder, and keeps nothing", async () => {
    const written: string[] = [];
    const m = manager(written);
    const grant = m.handleAddDirectory(dirA);
    await tick();
    answer(m, flagRequests(written)[0].request_id, "settings rejected");
    await grant;
    expect(m.additionalDirectories).toEqual([]);
    const [result] = await results();
    expect(result).toMatchObject({ directory: dirA, ok: false, additional_directories: [] });
    expect(result.reason).toBe(`${dirA}: settings rejected`);
  });

  test("a refusal is never an error frame", async () => {
    const m = manager([]);
    await m.handleAddDirectory(aFile);
    await drainPendingWrites();
    expect(frames.some((f) => f.type === "error")).toBe(false);
  });

  test("a refused grant does not stop the next one", async () => {
    const written: string[] = [];
    const m = manager(written);
    const bad = m.handleAddDirectory(dirA);
    const good = m.handleAddDirectory(dirB);
    await tick();
    answer(m, flagRequests(written)[0].request_id, "nope");
    await bad;
    await tick();
    const requests = flagRequests(written);
    expect(requests[1].list).toEqual([dirB]);
    answer(m, requests[1].request_id);
    await good;
    expect(m.additionalDirectories).toEqual([dirB]);
  });
});

describe("the deck learns the session's folders", () => {
  test("a granted folder is sent on system_metadata ahead of its answer", async () => {
    const written: string[] = [];
    const m = manager(written);
    const grant = m.handleAddDirectory(dirA);
    await tick();
    answer(m, flagRequests(written)[0].request_id);
    await grant;
    await drainPendingWrites();
    const kinds = frames.map((f) => f.type);
    expect(kinds.indexOf("system_metadata")).toBeLessThan(kinds.indexOf("directory_result"));
    const [meta] = await metadata();
    expect(meta.additional_directories).toEqual([dirA]);
    expect(meta.model).toBeUndefined();
  });

  test("a refused folder sends no folder list", async () => {
    const m = manager([]);
    await m.handleAddDirectory(aFile);
    expect(await metadata()).toEqual([]);
  });

  test("the list sent between turns keeps what claude's init reported", async () => {
    const written: string[] = [];
    const m = manager(written);
    m.handleClaudeLine(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: SID,
        cwd: "/tmp",
        additional_directories: [tugDataRoot(), dirB],
      }),
    );
    frames = [];
    const grant = m.handleAddDirectory(dirA);
    await tick();
    answer(m, flagRequests(written)[0].request_id);
    await grant;
    const sent = (await metadata()).at(-1);
    expect(sent.additional_directories).toEqual([dirB, dirA]);
  });

  test("a new session's spawn frame says it has no folders", async () => {
    const m = manager([], [dirA]);
    await m.handleNewSession();
    const sent = (await metadata()).at(-1);
    expect(sent.additional_directories).toEqual([]);
  });
});

describe("the folders an init reports", () => {
  test("every one Claude reports, once, in its order, without the Tug data root", () => {
    const init = {
      additional_directories: [`${tugDataRoot()}/`, "/u/b/", "/u/a", "/u/b", 7, ""],
    };
    expect(reportedAdditionalDirectories(init)).toEqual(["/u/b", "/u/a"]);
  });

  test("a missing or malformed field is none", () => {
    expect(reportedAdditionalDirectories({})).toEqual([]);
    expect(reportedAdditionalDirectories({ additional_directories: "/u/a" })).toEqual([]);
    expect(reportedAdditionalDirectories(null)).toEqual([]);
  });
});

describe("the granted folders survive a respawn", () => {
  test("an effort respawn carries one --add-dir per granted folder", async () => {
    const written: string[] = [];
    const m = manager(written);
    m.claudeProcess = null;
    await m.handleAddDirectory(dirA);
    await m.handleAddDirectory(dirB);
    m.claudeProcess = fakeProcess([]);
    await m.handleEffortChange("high");
    expect(spawns.length).toBe(1);
    const dirs = addDirs(spawns[0]);
    // The Tug data root's flag comes first and is untouched.
    expect(dirs.length).toBe(3);
    expect(dirs.slice(1)).toEqual([dirA, dirB]);
  });
});

describe("the folders a session holds across launches", () => {
  test("the folders tugcast read off the row seed the list and the first spawn", async () => {
    // `--granted-dir` from tugcast, as main.ts passes them on.
    const m = manager([], [dirA, dirB, dirA]);
    expect(m.additionalDirectories).toEqual([dirA, dirB]);
    await m.handleEffortChange("high");
    expect(addDirs(spawns[0]).slice(1)).toEqual([dirA, dirB]);
  });

  test("a later grant sends the seeded folders with the new one", async () => {
    const written: string[] = [];
    const m = manager(written, [dirA]);
    const grant = m.handleAddDirectory(dirB);
    await tick();
    expect(flagRequests(written)[0].list).toEqual([dirA, dirB]);
    answer(m, flagRequests(written)[0].request_id);
    await grant;
  });

  test("a new session starts without the folders the last one held", async () => {
    const m = manager([], [dirA]);
    await m.handleNewSession();
    expect(m.additionalDirectories).toEqual([]);
    expect(addDirs(spawns[spawns.length - 1]).length).toBe(1);
  });
});

/** A manager whose live claude was spawned with `dirs` by `--add-dir`. */
async function spawnedWith(dirs: string[]): Promise<{ m: any; written: string[] }> {
  const m = manager([], dirs);
  const written: string[] = [];
  (Bun as unknown as { spawn: unknown }).spawn = (cmd: string[]) => {
    spawns.push(cmd.slice(1));
    return fakeProcess(written);
  };
  await m.handleEffortChange("high");
  await drainPendingWrites();
  spawns = [];
  frames = [];
  return { m, written };
}

describe("a removal takes a granted folder back out", () => {
  test("a folder only the flag layer granted goes with the shorter list, no respawn", async () => {
    const written: string[] = [];
    const m = manager(written);
    const grant = m.handleAddDirectory(dirA);
    const grantB = m.handleAddDirectory(dirB);
    await tick();
    answer(m, flagRequests(written)[0].request_id);
    await grant;
    await tick();
    answer(m, flagRequests(written)[1].request_id);
    await grantB;
    await drainPendingWrites();
    frames = [];
    const removal = m.handleRemoveDirectory(dirA + "/");
    await tick();
    const requests = flagRequests(written);
    expect(requests.length).toBe(3);
    expect(requests[2].list).toEqual([dirB]);
    answer(m, requests[2].request_id);
    await removal;
    expect(m.additionalDirectories).toEqual([dirB]);
    expect(spawns.length).toBe(0);
    const [result] = await results();
    expect(result).toMatchObject({
      op: "remove",
      directory: dirA + "/",
      ok: true,
      additional_directories: [dirB],
    });
    expect((await metadata()).at(-1).additional_directories).toEqual([dirB]);
  });

  test("the folder leaves the reported list too, so the deck stops showing it", async () => {
    const written: string[] = [];
    const m = manager(written, [dirA]);
    m.handleClaudeLine(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: SID,
        cwd: "/tmp",
        additional_directories: [tugDataRoot(), dirA],
      }),
    );
    frames = [];
    const removal = m.handleRemoveDirectory(dirA);
    await tick();
    answer(m, flagRequests(written)[0].request_id);
    await removal;
    expect(m.reportedDirectories).toEqual([]);
    expect((await metadata()).at(-1).additional_directories).toEqual([]);
    const kinds = frames.map((f) => f.type);
    expect(kinds.indexOf("system_metadata")).toBeLessThan(kinds.indexOf("directory_result"));
  });

  test("a removal waits behind a grant in flight, and its list carries that grant", async () => {
    const written: string[] = [];
    const m = manager(written, [dirA]);
    const grant = m.handleAddDirectory(dirB);
    const removal = m.handleRemoveDirectory(dirA);
    await tick();
    expect(flagRequests(written).length).toBe(1);
    answer(m, flagRequests(written)[0].request_id);
    await grant;
    await tick();
    const requests = flagRequests(written);
    expect(requests.length).toBe(2);
    expect(requests[1].list).toEqual([dirB]);
    answer(m, requests[1].request_id);
    await removal;
    expect(m.additionalDirectories).toEqual([dirB]);
  });

  test("a folder claude was spawned with is removed by a respawn that leaves it out", async () => {
    const { m, written } = await spawnedWith([dirA, dirB]);
    frames = [];
    await m.handleRemoveDirectory(dirA);
    expect(flagRequests(written).length).toBe(0);
    expect(spawns.length).toBe(1);
    expect(addDirs(spawns[0]).slice(1)).toEqual([dirB]);
    expect(m.additionalDirectories).toEqual([dirB]);
    const [result] = await results();
    expect(result).toMatchObject({ op: "remove", ok: true, additional_directories: [dirB] });
  });

  test("a folder granted since the spawn does not respawn", async () => {
    const { m, written } = await spawnedWith([dirA]);
    const grant = m.handleAddDirectory(dirB);
    await tick();
    answer(m, flagRequests(written)[0].request_id);
    await grant;
    const removal = m.handleRemoveDirectory(dirB);
    await tick();
    expect(flagRequests(written)[1].list).toEqual([dirA]);
    answer(m, flagRequests(written)[1].request_id);
    await removal;
    expect(spawns.length).toBe(0);
    expect(m.additionalDirectories).toEqual([dirA]);
  });

  test("a removal that needs a respawn is refused while a turn is running", async () => {
    const { m } = await spawnedWith([dirA]);
    m.activeTurn = {};
    frames = [];
    await m.handleRemoveDirectory(dirA);
    expect(spawns.length).toBe(0);
    expect(m.additionalDirectories).toEqual([dirA]);
    const [result] = await results();
    expect(result).toMatchObject({ op: "remove", ok: false, additional_directories: [dirA] });
    expect(result.reason).toContain("only between turns");
    m.activeTurn = null;
  });

  test("before claude is up the folder is dropped and the first spawn never carries it", async () => {
    const m = manager([], [dirA, dirB]);
    m.claudeProcess = null;
    await m.handleRemoveDirectory(dirA);
    expect(m.additionalDirectories).toEqual([dirB]);
    await m.handleEffortChange("high");
    expect(addDirs(spawns[0]).slice(1)).toEqual([dirB]);
  });
});

describe("a removal that cannot be done is refused", () => {
  test("a folder the session does not hold, or a relative path, is refused before anything is sent", async () => {
    const written: string[] = [];
    const m = manager(written, [dirA]);
    await m.handleRemoveDirectory(dirB);
    await m.handleRemoveDirectory("relative/dir");
    expect(written.length).toBe(0);
    expect(m.additionalDirectories).toEqual([dirA]);
    const refused = await results();
    expect(refused.map((r) => [r.op, r.ok])).toEqual([
      ["remove", false],
      ["remove", false],
    ]);
    expect(refused[0].reason).toContain("is not a folder this session was granted");
    expect(refused[1].reason).toContain("is not an absolute path");
    expect(await metadata()).toEqual([]);
  });

  test("an error answer refuses the removal and keeps the folder", async () => {
    const written: string[] = [];
    const m = manager(written, [dirA]);
    const removal = m.handleRemoveDirectory(dirA);
    await tick();
    answer(m, flagRequests(written)[0].request_id, "settings rejected");
    await removal;
    expect(m.additionalDirectories).toEqual([dirA]);
    const [result] = await results();
    expect(result.reason).toBe(`${dirA}: settings rejected`);
  });
});
