/**
 * What `operator-eval` reads out of `tugcast operator-ask`'s output. The shape
 * below is what `feeds/operator_ask.rs` prints, so a change to either that loses
 * the refs fails here rather than scoring every answer as a miss.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { citedAnchors, citedRefs, citesExpected, placeHistory, retrievedAnchors, verbsChosen } from "../operator-eval";

const OUTPUT = `model: sonnet
question: how do I create an arc?

  round 1: help.search {"query":"create arc"} → 6 row(s)
             query_used: create arc
  round 2: help.read {"doc":"features","name":"Opening an arc"} → 812 bytes

ANSWER:
Type /arc. A REFS: line in prose is not a heading.

REFS:
  help features#opening-an-arc
  session 0f3c1e5a
  help glossary#door

REFS DROPPED (target not verified):
  help glossary#nothing
`;

describe("operator-eval's reading of a run", () => {
  test("only kept help refs count as cited", () => {
    expect(citedAnchors(OUTPUT)).toEqual(["features#opening-an-arc", "glossary#door"]);
  });

  test("an answer with no refs cites nothing", () => {
    expect(citedAnchors("ANSWER:\nNo idea.\n")).toEqual([]);
  });

  test("every kept ref is read, and none that was dropped", () => {
    expect(citedRefs(OUTPUT)).toEqual([
      { kind: "help", target: "features#opening-an-arc" },
      { kind: "session", target: "0f3c1e5a" },
      { kind: "help", target: "glossary#door" },
    ]);
  });

  test("a file ref is the same ref at any line, and nothing else loses its tail", () => {
    const file = { kind: "file", target: "briefs/x.md" };
    expect(citesExpected([{ kind: "file", target: "briefs/x.md:42" }], file)).toBe(true);
    expect(citesExpected([file], { kind: "file", target: "briefs/x.md:15" })).toBe(true);
    expect(citesExpected([{ kind: "file", target: "briefs/x.md:3-9" }], file)).toBe(true);
    expect(citesExpected([{ kind: "file", target: "briefs/y.md:42" }], file)).toBe(false);
    expect(citesExpected([{ kind: "session", target: "briefs/x.md" }], file)).toBe(false);
    const session = { kind: "session", target: "a1b2:3" };
    expect(citesExpected([{ kind: "session", target: "a1b2" }], session)).toBe(false);
    expect(citesExpected([], file)).toBe(false);
  });

  test("the history fixture lands where the Claude home would hold it", () => {
    const source = mkdtempSync(join(tmpdir(), "history-source-"));
    mkdirSync(join(source, "briefs"));
    writeFileSync(join(source, "briefs/a.md"), "# A\n");
    mkdirSync(join(source, "transcripts"));
    writeFileSync(join(source, "transcripts/s.jsonl"), '{"cwd":"{{PROJECT}}"}\n{"cwd":"{{PROJECT}}"}\n');
    const placed = placeHistory(source, mkdtempSync(join(tmpdir(), "history-run-")));

    expect(placed.project).toBe(realpathSync(placed.project));
    expect(existsSync(join(placed.project, "briefs/a.md"))).toBe(true);
    const encoded = placed.project.replace(/[^A-Za-z0-9-]/g, "-");
    const written = readFileSync(join(placed.claudeHome ?? "", "projects", encoded, "s.jsonl"), "utf8");
    expect(written).toBe(`{"cwd":"${placed.project}"}\n{"cwd":"${placed.project}"}\n`);
  });

  test("the verbs are read with their arguments", () => {
    expect(verbsChosen(OUTPUT)).toEqual([
      'help.search {"query":"create arc"}',
      'help.read {"doc":"features","name":"Opening an arc"}',
    ]);
  });

  test("a passage is retrieved when a verb's JSON returned its text", () => {
    const rounds = `model: sonnet

  round 1: help.outline {} → 139 row(s)
{
  "count": 139,
  "features": [{ "anchor": "the-join", "heading": "The join", "level": 3 }]
}
  round 1: help.read {"doc":"glossary","entry":"Nope"} → error: no such entry
  round 1: help.search {"query":"arc"} → 1 row(s)
{
  "count": 1,
  "hits": [{ "anchor": "opening-an-arc", "doc": "features", "text": "An arc begins" }]
}
  round 2: help.read {"doc":"glossary"} → 900 bytes
{
  "doc": "glossary",
  "kind": "document",
  "text": "the whole of it"
}

ANSWER:
{ "doc": "features", "anchor": "not-a-round", "text": "prose" }
`;
    expect(retrievedAnchors(rounds)).toEqual(["features#opening-an-arc", "glossary#*"]);
  });
});
