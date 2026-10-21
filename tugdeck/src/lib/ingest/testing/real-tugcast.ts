/**
 * A real tugcast for tests that put several pages on one wire.
 *
 * `startRealTugcast` builds `tugcast` with cargo (a no-op when the binary is
 * current), makes a scratch git repo to serve, and spawns the binary with
 * `--no-auth` on a free port under an isolated environment: a scratch data
 * directory, bank, changes ledger and session index, and none of the host
 * app's per-instance variables, so a run from inside a Tug terminal cannot
 * adopt the live instance or write into its ledgers. Its bridge is
 * `/usr/bin/false`, so no claude session ever starts.
 *
 * `PageClient` is one page: a `WireSocket` — the deck's own socket class —
 * with an optional page identity in its hello, a `FramePeeler` over what it
 * receives, and a way to wait on what has arrived. `WireSocket` reconnects
 * after any close it did not ask for, so every client is closed when its
 * test is done, including one the server already closed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeedId, FrameFlags } from "@/protocol";
import { FramePeeler } from "../frame-peeler";
import { WireSocket, type WireHello } from "../wire-socket";
import type { IngestHandshake, IngestWireStatePatch } from "@tugproto/ingest";

/** The repo root, from `tugdeck/src/lib/ingest/testing/`. */
const REPO_ROOT = join(import.meta.dir, "../../../../..");
const TUGRUST = join(REPO_ROOT, "tugrust");
const TUGCAST_BIN = join(TUGRUST, "target/debug/tugcast");

/** How long a cold `cargo build -p tugcast` may take; a suite's `beforeAll` carries it too. */
export const BUILD_TIMEOUT_MS = 10 * 60_000;

/** How long a spawned tugcast may take to answer HTTP. */
const STARTUP_TIMEOUT_MS = 30_000;

/** How long `waitFor` waits by default. */
const WAIT_TIMEOUT_MS = 10_000;

/**
 * Whether the spawned tugcast may inherit `key`. Nothing Tug-named is: a run
 * from inside a Tug terminal carries the live instance's id, bundle and
 * ledger paths (`TUG_SESSIONS_DB` among them), and any one of them points the
 * child at the user's data. The auth variables are dropped so a claude the
 * bridge's auth probe runs reads the login, never a billed key.
 */
function inherits(key: string): boolean {
  if (key.startsWith("TUG")) return false;
  return !["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].includes(key);
}

export interface RealTugcast {
  readonly port: number;
  /** The `ws://` URL of `/ws`. */
  readonly wsUrl: string;
  /** The scratch git repo tugcast serves. */
  readonly repo: string;
  /** Where tugcast's stderr went, for a failing test to read. */
  readonly logPath: string;
  httpGet(path: string): Promise<{ status: number; body: unknown }>;
  httpPost(path: string, body: unknown): Promise<{ status: number; body: unknown }>;
  httpPut(path: string, body: unknown): Promise<{ status: number; body: unknown }>;
  stop(): Promise<void>;
}

function run(cmd: string[], cwd: string): void {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed in ${cwd}: ${result.stderr.toString()}`);
  }
}

function freePort(): number {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function startRealTugcast(): Promise<RealTugcast> {
  const build = Bun.spawn(["cargo", "build", "-p", "tugcast"], {
    cwd: TUGRUST,
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await build.exited) !== 0) {
    throw new Error(`cargo build -p tugcast failed:\n${await new Response(build.stderr).text()}`);
  }

  const scratch = mkdtempSync(join(tmpdir(), "tug-many-pages-"));
  const repo = join(scratch, "repo");
  const dataDir = join(scratch, "data");
  mkdirSync(repo);
  mkdirSync(dataDir);
  run(["git", "init", "-q"], repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  writeFileSync(join(repo, "b.txt"), "b\n");
  run(["git", "add", "."], repo);
  run(["git", "-c", "user.name=tug-test", "-c", "user.email=tug-test@example.invalid", "commit", "-q", "-m", "seed"], repo);

  const port = freePort();
  const session = `tug-test-${port}`;
  const bankPath = join(scratch, "bank.db");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && inherits(key)) env[key] = value;
  }
  Object.assign(env, {
    TUG_DATA_DIR: dataDir,
    TUG_TEST_ISOLATION: "1",
    TUGBANK_PATH: bankPath,
    TUG_CHANGES_DB: join(scratch, "changes.db"),
    TUG_SESSION_INDEX_DB: join(scratch, "session_index.db"),
    TUG_REPORT_GAPS_DB: join(scratch, "report_gaps.db"),
  });

  const logPath = join(scratch, "tugcast.log");
  const child = Bun.spawn(
    [
      TUGCAST_BIN,
      "--no-auth",
      "--port",
      String(port),
      "--source-tree",
      repo,
      "--session",
      session,
      "--bank-path",
      bankPath,
      "--tugcode-path",
      "/usr/bin/false",
    ],
    { cwd: repo, env, stdout: "ignore", stderr: Bun.file(logPath) },
  );

  const base = `http://127.0.0.1:${port}`;
  // `Bun.fetch`, not the global: in one `bun test` process a neighbouring
  // file may have replaced `globalThis.fetch` with a stub and left it there,
  // and this harness talks to a real server.
  const httpGet = async (path: string) => {
    const response = await Bun.fetch(`${base}${path}`);
    return { status: response.status, body: await readBody(response) };
  };
  const httpSend = async (method: string, path: string, body: unknown) => {
    const response = await Bun.fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await readBody(response) };
  };
  const httpPost = (path: string, body: unknown) => httpSend("POST", path, body);
  const httpPut = (path: string, body: unknown) => httpSend("PUT", path, body);

  const stop = async () => {
    child.kill();
    await child.exited;
    // A host with no tmux has no session to kill — and is the host where
    // tugcast exits before answering, so a throw here would hide its log.
    if (Bun.which("tmux") !== null) {
      Bun.spawnSync(["tmux", "kill-session", "-t", session], { stdout: "ignore", stderr: "ignore" });
    }
    rmSync(scratch, { recursive: true, force: true });
  };

  // Test-harness readiness, not product behaviour: the child is a separate
  // process that announces nothing, so the port is asked until it answers.
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) {
      const log = await Bun.file(logPath).text();
      await stop();
      throw new Error(`tugcast exited with ${child.exitCode} before it answered:\n${log}`);
    }
    try {
      const { status } = await httpGet("/api/pages");
      if (status === 200) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`tugcast did not answer on port ${port} within ${STARTUP_TIMEOUT_MS} ms`);
    }
    await Bun.sleep(100);
  }

  return { port, wsUrl: `ws://127.0.0.1:${port}/ws`, repo, logPath, httpGet, httpPost, httpPut, stop };
}

/** One frame a page received. `json` is the payload parsed, when it parses. */
export interface ReceivedFrame {
  feedId: number;
  flags: number;
  payload: Uint8Array;
  json: unknown;
}

/** One `wire-state` the socket reported. */
export type WireState = IngestWireStatePatch["payload"];

/** One page on the wire. */
export class PageClient {
  readonly frames: ReceivedFrame[] = [];
  readonly states: WireState[] = [];
  private readonly peeler = new FramePeeler();
  private readonly socket: WireSocket;
  private waiters: Array<() => void> = [];

  constructor(url: string, hello: WireHello | null = null) {
    this.socket = new WireSocket(
      url,
      {
        wireState: (payload) => this.states.push(payload),
        disconnectState: () => {},
        bytes: (chunk) => {
          for (const frame of this.peeler.push(chunk)) {
            const payload = new Uint8Array(frame.payload);
            let json: unknown = undefined;
            try {
              json = JSON.parse(new TextDecoder().decode(payload));
            } catch {
              // A binary or empty payload; the bytes are still kept.
            }
            this.frames.push({ feedId: frame.feedId, flags: frame.flags, payload, json });
          }
        },
        handshakeComplete: () => {},
        endOfEvent: () => this.wake(),
      },
      undefined,
      hello,
    );
  }

  /** Open the socket and wait for the handshake reply. */
  async connect(): Promise<IngestHandshake> {
    this.socket.connect();
    return this.handshake();
  }

  /** Open the socket without waiting for anything. */
  open(): void {
    this.socket.connect();
  }

  /** The handshake reply, once it has arrived. */
  handshake(): Promise<IngestHandshake> {
    return this.waitFor(() => this.states.find((s) => s.state === "open")?.handshake, "the handshake reply");
  }

  /** Each `closed` wire-state, in order. */
  get closes(): WireState[] {
    return this.states.filter((s) => s.state === "closed");
  }

  /** Narrow this page's feeds, and optionally its sessions. */
  subscribe(feeds: readonly number[], sessions?: "all" | string[]): void {
    this.sendControl("subscribe_feeds", { feeds: [...feeds], ...(sessions === undefined ? {} : { sessions }) });
  }

  /** Send a JSON payload on `feed`. */
  sendJson(feed: number, obj: unknown): boolean {
    return this.socket.send(feed, FrameFlags.DATA, new TextEncoder().encode(JSON.stringify(obj)));
  }

  /** Send a CONTROL action. */
  sendControl(action: string, obj: Record<string, unknown> = {}): boolean {
    return this.sendJson(FeedId.CONTROL, { action, ...obj });
  }

  /** Resolve with `probe`'s first truthy answer, re-asked after every socket event. */
  waitFor<T>(probe: () => T | undefined | null | false, what: string, timeoutMs = WAIT_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const check = (): boolean => {
        const value = probe();
        if (value === undefined || value === null || value === false) return false;
        clearTimeout(timer);
        resolve(value as T);
        return true;
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}`));
      }, timeoutMs);
      const waiter = () => {
        if (check()) this.waiters = this.waiters.filter((w) => w !== waiter);
      };
      if (!check()) this.waiters.push(waiter);
    });
  }

  /** The first received frame on `feed` whose parsed payload satisfies `match`. */
  frameOn(feed: number, match: (json: Record<string, unknown>) => boolean): ReceivedFrame | undefined {
    return this.frames.find(
      (f) => f.feedId === feed && typeof f.json === "object" && f.json !== null && match(f.json as Record<string, unknown>),
    );
  }

  close(): void {
    this.socket.close();
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}
