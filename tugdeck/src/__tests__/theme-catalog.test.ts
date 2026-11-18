/**
 * The theme catalog is a hand-kept reading of the theme stylesheets. These
 * hold it to them.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";

import postcssTugColor from "../../postcss-tug-color";
import { SHIPPED_THEME_NAMES } from "../action-dispatch";
import {
  THEME_CATALOG,
  THEME_MODES,
  themeCatalogEntry,
  themeModeOf,
} from "../theme-catalog";
import { BASE_THEME_NAME } from "../theme-constants";

const THEMES_DIR = resolve(import.meta.dir, "..", "..", "styles", "themes");

function declared(theme: string, token: string): string | null {
  const css = readFileSync(resolve(THEMES_DIR, `${theme}.css`), "utf8");
  const match = css.match(new RegExp(`${token}:\\s*([^;]+);`));
  return match === null ? null : match[1].trim().toLowerCase();
}

/** A declared value as the build emits it, `--tug-color(…)` expanded. */
function built(value: string): string {
  const result = postcss([postcssTugColor()]).process(`a { color: ${value}; }`, {
    from: undefined,
  });
  let expanded = value;
  result.root.walkDecls("color", (decl) => {
    expanded = decl.value;
  });
  return expanded;
}

describe("theme catalog", () => {
  test("lists exactly the shipped themes, in the cycle's order", () => {
    expect(THEME_CATALOG.map((entry) => entry.name)).toEqual([
      ...SHIPPED_THEME_NAMES,
    ]);
  });

  test("has an entry for every theme stylesheet", () => {
    const onDisk = readdirSync(THEMES_DIR)
      .filter((file) => file.endsWith(".css"))
      .map((file) => file.slice(0, -".css".length))
      .sort();
    expect(THEME_CATALOG.map((entry) => entry.name).sort()).toEqual(onDisk);
  });

  test("carries each stylesheet's canvas color", () => {
    const fromCatalog: Record<string, string | null> = {};
    const fromDisk: Record<string, string | null> = {};
    for (const entry of THEME_CATALOG) {
      fromCatalog[entry.name] = entry.canvasColor;
      fromDisk[entry.name] = declared(entry.name, "--tugx-host-canvas-color");
    }
    expect(fromCatalog).toEqual(fromDisk);
  });

  test("carries each stylesheet's Key hue, as the build resolves it", () => {
    const fromCatalog: Record<string, string | null> = {};
    const fromDisk: Record<string, string | null> = {};
    for (const entry of THEME_CATALOG) {
      fromCatalog[entry.name] = entry.keyColor;
      const value = declared(
        entry.name,
        "--tug7-surface-control-primary-filled-action-rest",
      );
      fromDisk[entry.name] = value === null ? null : built(value);
    }
    expect(fromCatalog).toEqual(fromDisk);
  });

  test("gives every theme in a mode its own Key hue", () => {
    for (const mode of THEME_MODES) {
      const keys = THEME_CATALOG.filter((entry) => entry.mode === mode).map(
        (entry) => entry.keyColor,
      );
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  test("keeps each family contiguous, in the order dark, dusk, light", () => {
    const runs: string[] = [];
    for (const entry of THEME_CATALOG) {
      if (runs[runs.length - 1] !== entry.mode) runs.push(entry.mode);
    }
    // One run per mode present, and those runs in the families' order: a mode
    // split in two, or out of order, shows here as an extra or misplaced run.
    expect(runs).toEqual(THEME_MODES.filter((mode) => runs.includes(mode)));
    expect(runs[0]).toBe("dark");
  });

  test("gives each theme the mode its stylesheet declares", () => {
    const fromCatalog: Record<string, string> = {};
    const fromDisk: Record<string, string> = {};
    for (const entry of THEME_CATALOG) {
      fromCatalog[entry.name] = entry.mode;
      fromDisk[entry.name] = themeModeOf(
        declared(entry.name, "--tugx-theme-appearance") ?? "",
      );
    }
    expect(fromCatalog).toEqual(fromDisk);
  });

  test("reads an appearance token as one of the three modes", () => {
    expect(themeModeOf("dark")).toBe("dark");
    expect(themeModeOf(" dusk ")).toBe("dusk");
    expect(themeModeOf("light")).toBe("light");
    expect(themeModeOf("")).toBe("dark");
    expect(themeModeOf("twilight")).toBe("dark");
  });

  test("answers the base theme for a name that is not shipped", () => {
    expect(themeCatalogEntry("no-such-theme").name).toBe(BASE_THEME_NAME);
    expect(themeCatalogEntry(undefined).name).toBe(BASE_THEME_NAME);
    expect(themeCatalogEntry("sloop").canvasColor).toBe("#3d4446");
  });
});
