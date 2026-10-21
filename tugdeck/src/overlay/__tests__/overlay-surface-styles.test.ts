/**
 * The overlay loads every stylesheet the surface it draws can reach.
 *
 * The overlay draws a body's Z2 placard from the body's markup, so the
 * components that wrote that markup never run in the overlay's page and
 * their CSS imports never reach it. The page loads the stylesheets itself
 * (`overlay-surface-styles.ts`), and a stylesheet missing from that list is a
 * surface that draws as bare text in the overlay while the hidden original in
 * the body looks right. The ARC placard's head did exactly that: it mounted the
 * Arcs card's lifecycle block, whose stylesheets the old hand-picked list of
 * four did not hold.
 *
 * So the list is checked against the source: walk the static imports of the
 * module whose surface the overlay draws, collect every `.css` it reaches, and
 * require each one in the list.
 *
 * @covers tugdeck/src/overlay/overlay-surface-styles.ts
 * @covers tugdeck/src/overlay/overlay-surface-drawer.ts
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = join(import.meta.dir, "..", "..");

/** The module whose surface the overlay draws (`getSurfaceHost` callers). */
const SURFACE_ROOTS = ["components/tugways/cards/session-card-telemetry-renderers.tsx"];

/** Static, value-bearing imports and re-exports; `import type` carries no CSS. */
const IMPORT_RE = /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;

function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  if (spec.endsWith(".css")) return base;
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const path = base + ext;
    if (existsSync(path) && statSync(path).isFile()) return path;
  }
  return null;
}

function cssClosure(roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const css = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT_RE)) {
      const target = resolveSpec(file, match[1]);
      if (target === null) continue;
      if (target.endsWith(".css")) css.add(relative(SRC, target));
      else walk(target);
    }
  };
  for (const root of roots) walk(join(SRC, root));
  return css;
}

function listedStyles(): Set<string> {
  const file = join(SRC, "overlay", "overlay-surface-styles.ts");
  const listed = new Set<string>();
  for (const match of readFileSync(file, "utf8").matchAll(IMPORT_RE)) {
    const target = resolveSpec(file, match[1]);
    if (target !== null && target.endsWith(".css")) listed.add(relative(SRC, target));
  }
  return listed;
}

describe("overlay surface styles", () => {
  test("every stylesheet the drawn surface reaches is loaded by the overlay", () => {
    const listed = listedStyles();
    const missing = [...cssClosure(SURFACE_ROOTS)].filter((path) => !listed.has(path));
    expect(missing).toEqual([]);
  });

  test("every listed stylesheet exists", () => {
    const gone = [...listedStyles()].filter((path) => !existsSync(join(SRC, path)));
    expect(gone).toEqual([]);
  });

  test("the ARC placard's head block is among them", () => {
    const listed = listedStyles();
    for (const path of [
      "components/tugways/arc-lifecycle-block.css",
      "components/tugways/arc-lifecycle-line.css",
      "components/tugways/tug-arc-atom.css",
      "components/tugways/tug-arc-track.css",
    ]) {
      expect(listed.has(path)).toBe(true);
    }
  });

  test("the drawer loads the list", () => {
    const drawer = readFileSync(join(SRC, "overlay", "overlay-surface-drawer.ts"), "utf8");
    expect(drawer).toContain('import "./overlay-surface-styles";');
  });
});
