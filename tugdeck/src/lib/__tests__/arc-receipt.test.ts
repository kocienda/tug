/**
 * arc-receipt — the `/arc-run` parser's legacy headers ([B06]).
 *
 * A pick-up and a mid-stage join or discard are arc notes now, but shell
 * ledgers written before that change hold them as `/arc-run` rows, and those
 * replay on every reload. So the parser keeps reading both headers: what is
 * pinned here is that each still parses to its own outcome, carries the words
 * the row's quiet line is recomposed from, and is never read as a stop.
 *
 * The literals are the runner's own former output, verbatim.
 *
 * And an ask's choices: a receipt carries them as `choice · <label>` lines
 * after its question, and a receipt written before them reads as the same
 * stop with none.
 */

import { describe, expect, test } from "bun:test";

import { parseArcReceipt } from "../arc-receipt";

describe("the legacy pick-up header", () => {
  const PICKED_UP = "arc picked back up · demo · in implement · a resume asked for it";

  test("parses to the resumed outcome with its stage and what moved", () => {
    const parsed = parseArcReceipt(PICKED_UP);
    expect(parsed?.outcome).toBe("resumed");
    expect(parsed?.arc).toBe("demo");
    expect(parsed?.resumed).toEqual({ stage: "implement", moved: "a resume asked for it" });
    expect(parsed?.stop).toBeNull();
    expect(parsed?.ended).toBeNull();
  });
});

describe("the legacy ending header", () => {
  const ending = (word: string): string =>
    `arc ${word} · demo · the stage's turn will end and the card returns to the account default`;

  test("a join parses to the ended outcome with its word and its retirement", () => {
    const parsed = parseArcReceipt(ending("joined"));
    expect(parsed?.outcome).toBe("ended");
    expect(parsed?.arc).toBe("demo");
    expect(parsed?.ended).toEqual({
      word: "joined",
      said: "the stage's turn will end and the card returns to the account default",
    });
  });

  test("a discard reads the same, under its own word", () => {
    expect(parseArcReceipt(ending("discarded"))?.ended?.word).toBe("discarded");
  });

  test("is never read as a stop or a pick-up", () => {
    const parsed = parseArcReceipt(ending("joined"));
    expect(parsed?.stop).toBeNull();
    expect(parsed?.resumed).toBeNull();
  });

  test("the other headers parse as they did", () => {
    expect(parseArcReceipt("arc complete · demo")?.outcome).toBe("complete");
    expect(
      parseArcReceipt("arc stopped · demo · in review — the arc went idle")?.outcome,
    ).toBe("stopped");
    expect(parseArcReceipt("arc did a thing")).toBeNull();
  });
});

describe("an ask's question and its choices", () => {
  const HEAD =
    "arc stopped · demo · in implement — it met a decision that is yours to make, so it stopped rather than asking";

  test("a new row reads the question and then each choice, in order", () => {
    const parsed = parseArcReceipt(
      `${HEAD}\nWhich cover hides the band?\nchoice · the neighbour\nchoice · a new one`,
    );
    expect(parsed?.stop?.said).toBe("Which cover hides the band?");
    expect(parsed?.stop?.choices).toEqual(["the neighbour", "a new one"]);
    expect(parsed?.stop?.terminal).toBe(false);
  });

  test("an old row reads the question alone, with no choices", () => {
    const parsed = parseArcReceipt(`${HEAD}\nWhich cover hides the band?`);
    expect(parsed?.stop?.said).toBe("Which cover hides the band?");
    expect(parsed?.stop?.choices).toEqual([]);
  });

  test("a choice line is never taken for the question", () => {
    // The question is the first *unmarked* line; a marked one ahead of it
    // stays a choice and does not become what the stage said.
    const parsed = parseArcReceipt(`${HEAD}\nchoice · yes\nShip it?`);
    expect(parsed?.stop?.said).toBe("Ship it?");
    expect(parsed?.stop?.choices).toEqual(["yes"]);
  });
});
