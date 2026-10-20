/**
 * A host↔page message is declared in the host vocabulary or it does not
 * exist.
 *
 * Before the vocabulary, every page module reached
 * `window.webkit.messageHandlers.<name>` with its own cast, and the host
 * parsed each body by hand out of `[String: Any]` in one long switch. This
 * scan holds the line on both sides: a page reaches the host only through
 * `host/channel.ts`, and the host reads a message's body only in
 * `HostChannel.swift`, the one dispatcher that decodes it. The way back is
 * held the same way: only `host/` defines a `__tugBridge` member, no page
 * installs a `__tug…Callback` global, and the host evaluates script in a
 * page only in `HostChannel.swift` — or to read the page, under the marker
 * `// host-channel: diagnostic read` in the three lines above the call.
 * And the geometry family is typed on the host's side: no file that places,
 * carries or plans a body names `[String: Any]`, so nothing there can read a
 * field the decode did not check.
 *
 * The DEBUG spike (`body/spike-page.ts`, `TestHarness/SpikeBodyHandlers.swift`)
 * and the harness (`TestHarness/`) are exempt by name: they read pages and
 * run experiments with their own handlers, and carry no message of the
 * product.
 *
 * @covers tugdeck/src/host/channel.ts
 * @covers tugapp/Sources/HostChannel.swift
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const TUGDECK_SRC = join(import.meta.dir, "..", "..");
const CHECKOUT = join(TUGDECK_SRC, "..", "..");
const TUGAPP_SOURCES = join(CHECKOUT, "tugapp", "Sources");

/** Every file under `root` whose name matches `ext`, skipping `skip` directories. */
function files(root: string, ext: RegExp, skip: readonly string[]): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.includes(entry.name)) walk(path);
      } else if (ext.test(entry.name)) {
        out.push({ path, text: readFileSync(path, "utf8") });
      }
    }
  };
  walk(root);
  return out;
}

/** Page sources: no tests, which fake the host to observe it. */
const PAGE = files(TUGDECK_SRC, /\.tsx?$/, ["node_modules", "__tests__"]);
/** Host sources: the harness evaluates and reads pages, and is exempt. */
const HOST = files(TUGAPP_SOURCES, /\.swift$/, ["TestHarness"]);

/** Where `pattern` matches a code line (not a comment), as checkout-relative `file:line`. */
function hits(sources: Array<{ path: string; text: string }>, pattern: RegExp, allowed: readonly string[]): string[] {
  const found: string[] = [];
  for (const { path, text } of sources) {
    const rel = relative(CHECKOUT, path);
    if (allowed.includes(rel)) continue;
    text.split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (pattern.test(line)) found.push(`${rel}:${i + 1}`);
    });
  }
  return found;
}

/** The comment that marks a host-evaluated script as a read of the page, not a message. */
const DIAGNOSTIC_MARKER = "// host-channel: diagnostic read";

/**
 * Where the host evaluates script in a page, as `file:line`, other than in
 * `allowed` files or within three lines under the diagnostic marker.
 */
function unmarkedEvaluations(allowed: readonly string[]): string[] {
  const found: string[] = [];
  for (const { path, text } of HOST) {
    const rel = relative(CHECKOUT, path);
    if (allowed.includes(rel)) continue;
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (!/\b(evaluateJavaScript|callAsyncJavaScript)\(/.test(line)) return;
      const above = lines.slice(Math.max(0, i - 3), i);
      if (above.some((l) => l.includes(DIAGNOSTIC_MARKER))) return;
      found.push(`${rel}:${i + 1}`);
    });
  }
  return found;
}

const CHANNEL = "tugdeck/src/host/channel.ts";
const HOST_DIR = "tugdeck/src/host/";
const SPIKE_PAGE = "tugdeck/src/body/spike-page.ts";
const HOST_CHANNEL = "tugapp/Sources/HostChannel.swift";

describe("no hand-made host channel", () => {
  test("the scan reads both trees", () => {
    expect(PAGE.some(({ path }) => relative(CHECKOUT, path) === CHANNEL)).toBe(true);
    expect(HOST.some(({ path }) => relative(CHECKOUT, path) === "tugapp/Sources/MainWindow.swift")).toBe(true);
  });

  test("messageHandlers is named only by the channel", () => {
    expect(hits(PAGE, /messageHandlers/, [CHANNEL, SPIKE_PAGE])).toEqual([]);
  });

  test("no page module but the channel reaches the webkit global to post", () => {
    expect(hits(PAGE, /(?<![-\w])webkit\b/, [CHANNEL, SPIKE_PAGE])).toEqual([]);
  });

  test("the host reads a message's body only in its one dispatcher", () => {
    expect(hits(HOST, /\bmessage\.body\b/, [HOST_CHANNEL])).toEqual([]);
  });

  test("only host/ defines a __tugBridge member", () => {
    const outsideHost = PAGE.filter(({ path }) => !relative(CHECKOUT, path).startsWith(HOST_DIR));
    expect(hits(outsideHost, /__tugBridge\s*\?\?=|__tugBridge\s*=(?!=)|__tugBridge\??\.\w+\s*=(?!=)/, [])).toEqual([]);
  });

  test("no page installs a __tug…Callback global", () => {
    expect(hits(PAGE, /__tug\w*Callback\s*=(?!=)/, [])).toEqual([]);
  });

  test("the host evaluates script in a page only through its channel, or to read it", () => {
    expect(unmarkedEvaluations([HOST_CHANNEL])).toEqual([]);
  });

  test("no geometry file on the host names [String: Any]", () => {
    const GEOMETRY = ["BodyViewController.swift", "BodyGeometry.swift", "BodyBeats.swift", "CardGeometry.swift"].map(
      (name) => `tugapp/Sources/${name}`,
    );
    const geometry = HOST.filter(({ path }) => GEOMETRY.includes(relative(CHECKOUT, path)));
    expect(geometry.length).toBe(GEOMETRY.length);
    expect(hits(geometry, /\[String:\s*Any\]/, [])).toEqual([]);
  });
});
