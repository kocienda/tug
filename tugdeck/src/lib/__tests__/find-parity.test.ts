/**
 * find-parity — the literal matches tugcast's find must reproduce.
 *
 * tugcast answers a literal find over the text it renders with a matcher of
 * its own (`find_index.rs`), and every match it returns is painted as if
 * the page's `RegExp` had found it. `fixtures/find-parity.json` is a table
 * of texts, queries and options — case folding (`ſ`, the Kelvin sign, `ß`,
 * Greek, Turkish `İ`/`ı`), whole words beside non-ASCII letters, overlapping
 * candidates, astral characters — with the matches the page's `search()`
 * finds for each. This test regenerates those matches and fails when the
 * file is not current; tugcast's test reads the same file and asserts its
 * matcher finds exactly them.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { search } from "../transcript-search";

interface ParityRow {
  text: string;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  matches: [number, number][];
}

const FIXTURE = join(import.meta.dir, "fixtures/find-parity.json");

test("every row's matches are what the page's search finds", () => {
  const rows = JSON.parse(readFileSync(FIXTURE, "utf8")) as ParityRow[];
  expect(rows.length).toBeGreaterThanOrEqual(20);
  for (const row of rows) {
    const found = search(
      [row.text],
      row.query,
      { caseSensitive: row.caseSensitive, wholeWord: row.wholeWord, grep: false },
      Number.MAX_SAFE_INTEGER,
    ).map((m): [number, number] => [m.start, m.end]);
    expect({ text: row.text, query: row.query, matches: found }).toEqual({
      text: row.text,
      query: row.query,
      matches: row.matches,
    });
  }
});
