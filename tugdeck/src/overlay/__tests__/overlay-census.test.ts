/**
 * The transient-surface census holds to the source, and the overlay follows
 * no card.
 *
 * Every module that draws through the canvas overlay root or a body's
 * mirror of a surface the overlay draws is listed, with the page it is drawn
 * in, so a new surface cannot land without saying where it lives; and none is
 * drawn by the shell, which draws nothing over a card ([B08]). And nothing the
 * overlay page runs — its own modules, and every surface the census puts in
 * it — reads a card's geometry: no gesture report, no placement, no card
 * context, no crossing. A surface anchored to a card reads
 * `overlay.surfaces`, which holds a card only at rest
 * (`lib/__tests__/overlay-surfaces.test.ts`).
 *
 * @covers tugdeck/src/overlay/overlay-census.ts
 * @covers tugdeck/src/overlay/overlay-main.ts
 * @covers tugdeck/src/overlay/overlay-root.tsx
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SURFACE_CENSUS } from "../overlay-census";

const SRC = join(import.meta.dir, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" || name === "spikes" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const IMPORT = /^\s*import[^"']*["']([^"']+)["']/gm;

function importsOf(path: string): string[] {
  return [...readFileSync(path, "utf8").matchAll(IMPORT)].map((m) => m[1]);
}

/** Through what a surface is drawn: the portal root, or a body's mirror of a surface the overlay draws. */
const SURFACE_PLUMBING = /(^|\/)(use-canvas-overlay|canvas-overlay-registry|surface-mirror)$/;

/** What a card's geometry crosses as: a gesture report, a placement, a card's context or crossing. */
const CARD_GEOMETRY_MODULES = /(^|\/)(card-placement|host-card-gesture|card-gesture-commit|card-plan)$/;
const CARD_GEOMETRY_NAMES = /\b(cardGestureToPage|onCardGesture|cardContext|cardCrossing|cardInsetsToPage|bodyCrossingToPage|placeCardsToHost)\b/;

describe("the transient-surface census", () => {
  test("lists every module that draws through the overlay root or a body's surface mirror", () => {
    const listed = new Set(SURFACE_CENSUS.map((e) => e.module));
    const missing = sources(SRC)
      .filter((path) => importsOf(path).some((spec) => SURFACE_PLUMBING.test(spec)))
      .map((path) => relative(SRC, path))
      .filter((module) => !listed.has(module));
    expect(missing).toEqual([]);
  });

  test("names only modules that exist, once each", () => {
    const modules = SURFACE_CENSUS.map((e) => e.module);
    expect(modules.filter((m) => !existsSync(join(SRC, m)))).toEqual([]);
    expect(new Set(modules).size).toBe(modules.length);
  });

  test("says how every overlay surface gets what it shows, and only for those", () => {
    for (const entry of SURFACE_CENSUS) {
      expect(entry.how !== undefined, `${entry.module}: how`).toBe(entry.page === "overlay");
    }
  });

  test("puts no surface in the shell's page", () => {
    expect(SURFACE_CENSUS.filter((e) => e.page === "shell").map((e) => e.module)).toEqual([]);
  });
});

describe("the overlay follows no card", () => {
  const overlayModules = [
    ...sources(join(SRC, "overlay")).map((path) => relative(SRC, path)),
    ...SURFACE_CENSUS.filter((e) => e.page === "overlay").map((e) => e.module),
  ];

  test("nothing it runs imports what a card's geometry crosses as", () => {
    const offenders = overlayModules.filter((module) =>
      importsOf(join(SRC, module)).some((spec) => CARD_GEOMETRY_MODULES.test(spec)),
    );
    expect(offenders).toEqual([]);
  });

  test("nothing it runs subscribes to a card's gesture, placement, context or crossing", () => {
    // A surface may measure its own panel; what it may not read is where a card is.
    const offenders = overlayModules.filter((module) => CARD_GEOMETRY_NAMES.test(readFileSync(join(SRC, module), "utf8")));
    expect(offenders).toEqual([]);
  });
});
