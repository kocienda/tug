// error-frame-sites — every `error` frame the bridge writes names its site
// and logs a `tugcode.error_frame` line beside the write.
//
// The `error` frame is the only outbound message that locks a card body:
// the deck maps it to the "Protocol error" banner. On 2026-09-04 a card
// raised that banner and nothing on either side of the bridge could say
// which of the dozen emit sites had written it, because none of them
// logged. These tests pin the shape that closed that: one construction
// point, which logs, and a slug per site.

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { emitErrorFrame, errorFrame, drainPendingWrites } from "../ipc.ts";
import type { ErrorEvent, ErrorFrameSite } from "../types.ts";

const SRC_DIR = join(import.meta.dir, "..");

/**
 * Every non-test `.ts` file under `tugcode/src/`, recursively, as a path
 * relative to that directory plus its text. Recursive because the claim the
 * first test makes is about the whole bridge: a hand-rolled frame in a
 * subdirectory is exactly the site that would escape a flat scan.
 */
function sourceFiles(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(join(dir, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      out.push({
        name: `${prefix}${entry.name}`,
        text: readFileSync(join(dir, entry.name), "utf8"),
      });
    }
  };
  walk(SRC_DIR, "");
  return out;
}

/** The slugs of the `ErrorFrameSite` union, read from its declaration. */
function declaredSites(): string[] {
  const types = readFileSync(join(SRC_DIR, "types.ts"), "utf8");
  const decl = types.match(
    /export type ErrorFrameSite =([\s\S]*?);\n/,
  );
  expect(decl).not.toBeNull();
  return [...decl![1].matchAll(/\|\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

/** Capture the JSON lines `writeLine` puts on stdout. */
async function captureIpcOutput(fn: () => void | Promise<void>): Promise<any[]> {
  const captured: any[] = [];
  const originalWrite = Bun.write;
  const decoder = new TextDecoder();
  (Bun as any).write = (dest: unknown, data: unknown) => {
    let text: string | null = null;
    if (dest === Bun.stdout && typeof data === "string") text = data;
    else if (dest === Bun.stdout && data instanceof Uint8Array)
      text = decoder.decode(data);
    if (text !== null) {
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          captured.push(JSON.parse(trimmed));
        } catch {
          // non-JSON lines are not frames
        }
      }
    }
    return Promise.resolve(
      data instanceof Uint8Array ? data.length : (data as string).length,
    );
  };
  try {
    await fn();
    await drainPendingWrites();
  } finally {
    (Bun as any).write = originalWrite;
  }
  return captured;
}

/** Capture the lines `logSessionLifecycle` writes through `console.log`. */
function captureLifecycleLog(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe("error frame sites", () => {
  test("the frame is built in exactly one place", () => {
    // A hand-rolled `{ type: "error", … }` anywhere else is a site that can
    // forget to log — which is the whole defect. `types.ts` declares the
    // shape and `ipc.ts` builds it; nothing else may construct one.
    const constructors = sourceFiles()
      .filter(({ text }) => text.includes('type: "error"'))
      .map(({ name }) => name)
      .sort();
    expect(constructors).toEqual(["ipc.ts", "types.ts"]);
  });

  test("every declared site is used by a real emit site", () => {
    // The union is the catalog a reader consults; a slug nothing emits is a
    // catalog entry that lies, and a site emitting an undeclared slug does
    // not typecheck. Together these make the union the whole set.
    const sites = declaredSites();
    expect(sites.length).toBeGreaterThan(0);
    const callers = sourceFiles().filter(
      ({ name }) => name !== "types.ts" && name !== "ipc.ts",
    );
    const unused = sites.filter(
      (site) => !callers.some(({ text }) => text.includes(`"${site}"`)),
    );
    expect(unused).toEqual([]);
  });

  test("the builder logs the site beside the frame it returns", () => {
    const built: ErrorEvent[] = [];
    const lines = captureLifecycleLog(() => {
      built.push(errorFrame("drain_eof_open_turn", "stream ended", true));
    });
    expect(built[0]).toEqual({
      type: "error",
      message: "stream ended",
      recoverable: true,
      site: "drain_eof_open_turn",
      ipc_version: 2,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("event=tugcode.error_frame");
    expect(lines[0]).toContain("site=drain_eof_open_turn");
    expect(lines[0]).toContain("recoverable=true");
  });

  test("emitErrorFrame writes the frame and logs the same site", async () => {
    let lines: string[] = [];
    const captured = await captureIpcOutput(() => {
      // The log is written synchronously inside the emit; the frame is
      // queued on the write tail and flushed by the capture's own drain.
      lines = captureLifecycleLog(() => {
        emitErrorFrame("send_after_eof", "stream ended", true);
      });
    });
    expect(lines.filter((l) => l.includes("event=tugcode.error_frame"))).toHaveLength(1);
    expect(lines[0]).toContain("site=send_after_eof");
    expect(captured.filter((f) => f.type === "error")).toEqual([
      {
        type: "error",
        message: "stream ended",
        recoverable: true,
        site: "send_after_eof",
        ipc_version: 2,
      },
    ]);
  });

  test("every declared site is a legal argument", () => {
    // A compile-time pin as much as a runtime one: each slug below must be
    // assignable to `ErrorFrameSite`, so deleting one from the union without
    // retiring its emit site fails `tsc` here rather than at a call site.
    const sites: ErrorFrameSite[] = [
      "stub_transcript_load",
      "protocol_version_unsupported",
      "session_prepare_failed",
      "background_spawn_failed",
      "session_init_failed",
      "user_message_failed",
      "inbound_dispatch",
      "local_command_stderr",
      "post_handshake_exit",
      "fresh_init_exit",
      "drain_eof_open_turn",
      "send_after_eof",
      "stub_replay_exhausted",
    ];
    expect([...sites].sort() as string[]).toEqual(declaredSites().sort());
  });
});
