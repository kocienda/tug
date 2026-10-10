/**
 * plugin-dir — unit tests for {@link resolvePluginDir}, the universal
 * app-level tugplug `--plugin-dir` resolution shared by the spawn and the
 * context-breakdown emitter. Pure logic; no claude spawn.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { dirname, resolve } from "node:path";

import { resolvePluginDir } from "../spawn-config.ts";

const savedOverride = process.env.TUG_PLUGIN_DIR;
afterEach(() => {
  if (savedOverride === undefined) delete process.env.TUG_PLUGIN_DIR;
  else process.env.TUG_PLUGIN_DIR = savedOverride;
});

describe("resolvePluginDir", () => {
  test("resolves the bundled app resource beside the binary (never the project)", () => {
    delete process.env.TUG_PLUGIN_DIR;
    // App-level: one level up from the binary's MacOS dir into Resources.
    // Independent of any project directory.
    const expected = resolve(
      dirname(process.execPath),
      "..",
      "Resources",
      "tugplug",
    );
    expect(resolvePluginDir()).toBe(expected);
  });

  test("honors the TUG_PLUGIN_DIR override (dev bun-run harness)", () => {
    process.env.TUG_PLUGIN_DIR = "/dev/harness/tugplug";
    expect(resolvePluginDir()).toBe("/dev/harness/tugplug");
  });
});
