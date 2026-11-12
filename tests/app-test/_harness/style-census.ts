/**
 * style-census.ts — the computed-style census a CSS-moving change is held to.
 *
 * A change that moves CSS without meaning to change what anyone sees — a
 * reach-in selector replaced by a primitive's own variant, a repeated shape
 * extracted into one rule — is exactly the change that alters a computed value
 * silently. The census is the persistent proof that it did not: a fixed list
 * of properties, read off a fixed list of elements, compared against a
 * baseline recorded before the edit.
 *
 * One app-test file per surface family reads its entries with `censusRead` and
 * hands the result to `expectCensus`. With `TUG_STYLE_CENSUS_RECORD=1` the
 * reading is written as the family's baseline,
 * `tests/app-test/style-census/<family>.json`, and the test passes; otherwise a
 * difference fails naming the selector, the property, and both values.
 *
 * A reading waits for the faces its elements draw in: a census read before
 * the page's web font for a weight has arrived measures the fallback face, and
 * a legend's width is then a fact about load order rather than about CSS.
 *
 * Every selector must match exactly one element, so the reading cannot drift
 * onto a sibling as the list around it changes: a selector that matches none
 * or several fails with the selector and the count.
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Anything that evaluates a script in a page — an `App` or a card body. */
export interface CensusCaller {
  evalJS<T = unknown>(script: string, opts?: { timeoutMs?: number }): Promise<T>;
}

/** One element to read, and optionally which properties. */
export interface CensusEntry {
  selector: string;
  properties?: readonly string[];
}

/** selector → property → computed value. */
export type CensusReading = Record<string, Record<string, string>>;

/** The properties read when an entry names none. */
export const CENSUS_DEFAULT_PROPERTIES: readonly string[] = [
  "display", "position", "box-sizing", "width", "height", "min-width",
  "min-height", "max-width", "padding-top", "padding-right", "padding-bottom",
  "padding-left", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "border-top-width", "border-bottom-width", "border-left-width",
  "border-right-width", "border-top-color", "border-bottom-color",
  "border-radius", "background-color", "color", "font-family", "font-size",
  "font-weight", "line-height", "letter-spacing", "text-transform", "gap",
  "row-gap", "column-gap", "align-items", "justify-content", "flex-direction",
  "flex-grow", "flex-shrink", "flex-basis", "grid-template-columns", "opacity",
  "outline-style", "overflow-x", "overflow-y",
];

const CENSUS_DIR = resolve(import.meta.dir, "..", "style-census");

/** How long a read waits for its elements' faces, and the beat between tries. */
const FONT_BUDGET_MS = 5_000;
const FONT_BEAT_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Read every entry's properties in one evaluation, once every element's own
 * font is loaded for the text it draws: an evaluation that finds a face still
 * unloaded asks `document.fonts` to load it and is tried again, up to a
 * budget. Fails when a selector matches none or more than one element.
 */
export async function censusRead(
  caller: CensusCaller,
  entries: readonly CensusEntry[],
): Promise<CensusReading> {
  const plan = entries.map((e) => ({
    selector: e.selector,
    properties: e.properties ?? null,
  }));
  const readOnce = () => caller.evalJS<{
    reading: CensusReading;
    misses: Array<{ selector: string; count: number }>;
    fontsReady: boolean;
  }>(
    `(function(){
       var plan = ${JSON.stringify(plan)};
       var defaults = ${JSON.stringify(CENSUS_DEFAULT_PROPERTIES)};
       var reading = {};
       var misses = [];
       var fontsReady = true;
       plan.forEach(function (p) {
         var found = document.querySelectorAll(p.selector);
         if (found.length !== 1) { misses.push({ selector: p.selector, count: found.length }); return; }
         var cs = getComputedStyle(found[0]);
         var font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
         var text = found[0].textContent || "x";
         try {
           if (!document.fonts.check(font, text)) {
             fontsReady = false;
             document.fonts.load(font, text).catch(function () {});
           }
         } catch (e) { /* a font string the page cannot parse waits for nothing */ }
         var row = {};
         (p.properties || defaults).forEach(function (prop) { row[prop] = cs.getPropertyValue(prop); });
         reading[p.selector] = row;
       });
       return { reading: reading, misses: misses, fontsReady: fontsReady };
     })()`,
    { timeoutMs: 5_000 },
  );
  const deadline = Date.now() + FONT_BUDGET_MS;
  let result = await readOnce();
  while (result.misses.length === 0 && !result.fontsReady && Date.now() < deadline) {
    await sleep(FONT_BEAT_MS);
    result = await readOnce();
  }
  if (result.misses.length > 0) {
    const lines = result.misses.map(
      (m) => `  ${m.selector} matched ${m.count} element(s), not 1`,
    );
    throw new Error(`style census: selectors must match exactly one element\n${lines.join("\n")}`);
  }
  return result.reading;
}

/** Sort an object's keys, recursively one level, for a stable baseline. */
function sorted(reading: CensusReading): CensusReading {
  const out: CensusReading = {};
  for (const sel of Object.keys(reading).sort()) {
    const row: Record<string, string> = {};
    for (const prop of Object.keys(reading[sel]).sort()) row[prop] = reading[sel][prop];
    out[sel] = row;
  }
  return out;
}

/**
 * Compare a reading with the family's baseline, or write the baseline when
 * `TUG_STYLE_CENSUS_RECORD=1`.
 */
export function expectCensus(family: string, actual: CensusReading): void {
  const path = join(CENSUS_DIR, `${family}.json`);
  const reading = sorted(actual);
  if (process.env.TUG_STYLE_CENSUS_RECORD === "1") {
    mkdirSync(CENSUS_DIR, { recursive: true });
    writeFileSync(path, `${JSON.stringify(reading, null, 2)}\n`);
    return;
  }
  if (!existsSync(path)) {
    throw new Error(
      `style census: no baseline at ${path} — record one with TUG_STYLE_CENSUS_RECORD=1`,
    );
  }
  const expected = JSON.parse(readFileSync(path, "utf8")) as CensusReading;
  const diffs: string[] = [];
  const selectors = new Set([...Object.keys(expected), ...Object.keys(reading)]);
  for (const sel of [...selectors].sort()) {
    const want = expected[sel];
    const got = reading[sel];
    if (want === undefined || got === undefined) {
      diffs.push(`  ${sel}: ${want === undefined ? "not in the baseline" : "not read"}`);
      continue;
    }
    const props = new Set([...Object.keys(want), ...Object.keys(got)]);
    for (const prop of [...props].sort()) {
      if (want[prop] !== got[prop]) {
        diffs.push(`  ${sel} { ${prop} }: expected ${JSON.stringify(want[prop])}, got ${JSON.stringify(got[prop])}`);
      }
    }
  }
  expect(diffs, `style census "${family}" differs from its baseline:\n${diffs.join("\n")}`).toEqual([]);
}
