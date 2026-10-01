/**
 * The theme catalog is a hand-kept reading of the theme stylesheets. These
 * hold it to them.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { SHIPPED_THEME_NAMES } from "../action-dispatch";
import { THEME_CATALOG, themeCatalogEntry } from "../theme-catalog";
import { BASE_THEME_NAME } from "../theme-constants";

const THEMES_DIR = resolve(import.meta.dir, "..", "..", "styles", "themes");

function declared(theme: string, token: string): string | null {
  const css = readFileSync(resolve(THEMES_DIR, `${theme}.css`), "utf8");
  const match = css.match(new RegExp(`${token}:\\s*([^;]+);`));
  return match === null ? null : match[1].trim().toLowerCase();
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

  test("groups the dark themes ahead of the light ones", () => {
    const modes = THEME_CATALOG.map((entry) => entry.mode);
    const firstLight = modes.indexOf("light");
    expect(firstLight).toBeGreaterThan(0);
    expect(modes.slice(firstLight).every((mode) => mode === "light")).toBe(true);
  });

  test("answers the base theme for a name that is not shipped", () => {
    expect(themeCatalogEntry("no-such-theme").name).toBe(BASE_THEME_NAME);
    expect(themeCatalogEntry(undefined).name).toBe(BASE_THEME_NAME);
    expect(themeCatalogEntry("sloop").canvasColor).toBe("#3d4446");
  });
});
