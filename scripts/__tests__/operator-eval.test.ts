/**
 * What `operator-eval` reads out of `tugcast operator-ask`'s output. The shape
 * below is what `feeds/operator_ask.rs` prints, so a change to either that loses
 * the refs fails here rather than scoring every answer as a miss.
 */
import { describe, expect, test } from "bun:test";

import { citedAnchors, retrievedAnchors, verbsChosen } from "../operator-eval";

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
