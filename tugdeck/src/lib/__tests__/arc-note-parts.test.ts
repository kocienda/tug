/**
 * arc-note-command — the gesture mapping an arc's quiet line renders from.
 *
 * A row's three weights and its shape are derived from the *synthetic
 * command* tugcast rendered from the record, never from the sentence's prose
 * ([B01], [F05]). So the thing worth pinning is the pairing: for every marker
 * in the [B01] table, the exact command `command_for_line` writes beside the
 * exact sentence `note_for_line` composes, and the parts that fall out.
 *
 * The sentences below are the server's own, copied from the `arc_notes.rs`
 * unit tests rather than paraphrased — a paraphrase would pass here and drift
 * there.
 *
 * Both heads are pinned because the shell ledger is durable and rows written
 * before the word moved carry `dash …` ([F19]); the fallback is pinned
 * because a command this does not recognise must still render a row.
 */

import { describe, test, expect } from "bun:test";

import { arcNoteParts } from "../arc-note-command";

describe("arcNoteParts — the [B01] table", () => {
  test("arc create: the wheel signs the arc's opening, and there is no tail", () => {
    expect(arcNoteParts("arc create demo", "demo: arc created")).toEqual({
      name: "demo",
      label: "Arc opened",
      subject: null,
      glyph: "ShipWheel",
    });
  });

  test("the finish is one bold label, and its command comes from the receipt", () => {
    // The one gesture whose command no server writes: an arc's finish already
    // has a row — the `/arc-run` receipt — and `SessionArcReceiptBlock`
    // composes `arc done <name>` so that row reads out of this one grammar
    // ([B04], [F09]). `Finished · N stages` is the event, not a detail under
    // one, so it is the label whole ([B09]).
    expect(arcNoteParts("arc done demo", "demo: finished · 4 stages")).toEqual({
      name: "demo",
      label: "Finished · 4 stages",
      subject: null,
      glyph: "ShipWheel",
    });
  });

  test("a finish whose sentence did not read keeps its name and its shape", () => {
    expect(arcNoteParts("arc done demo", "demo: something else entirely")).toEqual({
      name: "demo",
      label: null,
      subject: "something else entirely",
      glyph: "ShipWheel",
    });
  });

  test("the run declaration is its own gesture, told apart by --through", () => {
    expect(
      arcNoteParts("arc step demo start --through", "demo: run declared through step 15"),
    ).toEqual({
      name: "demo",
      label: "Run declared",
      subject: "through step 15",
      glyph: "ListChecks",
    });
  });

  test("a start's subject is the step's title, and the verb moves into the glyph", () => {
    expect(
      arcNoteParts("arc step demo start", "demo: step 1/15 started — Rename the crate"),
    ).toEqual({
      name: "demo",
      label: "Step 1/15",
      subject: "Rename the crate",
      glyph: "Wrench",
    });
  });

  test("a close's subject is the round's sha, unwrapped from its parentheses", () => {
    expect(arcNoteParts("arc step demo done", "demo: step 1/15 closed (999353ca1)")).toEqual({
      name: "demo",
      label: "Step 1/15 closed",
      subject: "999353ca1",
      glyph: "CircleCheck",
    });
  });

  test("a close the server gave no sha keeps its label and loses only the tail", () => {
    expect(arcNoteParts("arc step demo done", "demo: step 1/15 closed")).toEqual({
      name: "demo",
      label: "Step 1/15 closed",
      subject: null,
      glyph: "CircleCheck",
    });
  });

  test("a withdrawal carries no tail today, and does not invent one", () => {
    expect(arcNoteParts("arc step demo withdraw", "demo: step 2/15 withdrawn")).toEqual({
      name: "demo",
      label: "Step 2/15 withdrawn",
      subject: null,
      glyph: "CircleMinus",
    });
  });

  test("a park reads as parked — the sentence's 'back to pending' is the label's job", () => {
    expect(
      arcNoteParts("arc step demo reset", "demo: step 2/15 parked back to pending"),
    ).toEqual({
      name: "demo",
      label: "Step 2/15 parked",
      subject: null,
      glyph: "RotateCcw",
    });
  });

  test("a reopen's subject is the title, when the server carried one", () => {
    expect(
      arcNoteParts("arc step demo reopen", "demo: step 2/15 reopened — The second step"),
    ).toEqual({
      name: "demo",
      label: "Step 2/15 reopened",
      subject: "The second step",
      glyph: "Undo2",
    });
  });

  test("both marks are the wheel, and the word is the mark's own", () => {
    expect(arcNoteParts("arc mark demo built", "demo: marked built")).toEqual({
      name: "demo",
      label: "Marked built",
      subject: null,
      glyph: "ShipWheel",
    });
    expect(arcNoteParts("arc mark demo audited", "demo: marked audited")).toEqual({
      name: "demo",
      label: "Marked audited",
      subject: null,
      glyph: "ShipWheel",
    });
  });

  test("a round is labelled by its sha and subjected by its verbatim instruction", () => {
    expect(
      arcNoteParts("arc commit demo", "demo: round 999353ca1 — Step 1: The first step"),
    ).toEqual({
      name: "demo",
      label: "Round 999353ca1",
      subject: "Step 1: The first step",
      glyph: "GitCommitHorizontal",
    });
  });

  test("a round with no instruction keeps its label", () => {
    expect(arcNoteParts("arc commit demo", "demo: round 999353ca1")).toEqual({
      name: "demo",
      label: "Round 999353ca1",
      subject: null,
      glyph: "GitCommitHorizontal",
    });
  });
});

describe("arcNoteParts — the retired head", () => {
  test("a ledger row written as `dash` reads exactly as its `arc` twin", () => {
    expect(arcNoteParts("dash step demo start", "demo: step 1/15 started — Rename the crate")).toEqual(
      arcNoteParts("arc step demo start", "demo: step 1/15 started — Rename the crate"),
    );
  });

  test("every gesture reads under either head", () => {
    const rows: [string, string][] = [
      ["create demo", "demo: arc created"],
      ["step demo start --through", "demo: run declared through step 15"],
      ["step demo start", "demo: step 1/15 started — A title"],
      ["step demo done", "demo: step 1/15 closed (999353ca1)"],
      ["step demo withdraw", "demo: step 2/15 withdrawn"],
      ["step demo reset", "demo: step 2/15 parked back to pending"],
      ["step demo reopen", "demo: step 2/15 reopened — A title"],
      ["mark demo built", "demo: marked built"],
      ["mark demo audited", "demo: marked audited"],
      ["commit demo", "demo: round 999353ca1 — An instruction"],
    ];
    for (const [tail, sentence] of rows) {
      expect(arcNoteParts(`dash ${tail}`, sentence)).toEqual(arcNoteParts(`arc ${tail}`, sentence));
      expect(arcNoteParts(`arc ${tail}`, sentence).label).not.toBeNull();
    }
  });
});

describe("arcNoteParts — never a blank row", () => {
  test("a command from a future marker keeps the whole sentence under the wheel", () => {
    expect(arcNoteParts("arc bless demo", "demo: something new happened")).toEqual({
      name: null,
      label: null,
      subject: "demo: something new happened",
      glyph: "ShipWheel",
    });
  });

  test("a command that is not an arc gesture at all falls back the same way", () => {
    expect(arcNoteParts("just app-test", "some output")).toEqual({
      name: null,
      label: null,
      subject: "some output",
      glyph: "ShipWheel",
    });
  });

  test("a sentence that does not read the way its command says keeps the shape", () => {
    expect(arcNoteParts("arc step demo start", "demo: something unexpected")).toEqual({
      name: "demo",
      label: null,
      subject: "something unexpected",
      glyph: "Wrench",
    });
  });

  test("an unread sentence keeps its tail — the split is only meaningful once it reads", () => {
    // The head/tail split is the parse's own device. On a sentence that did
    // not parse, honouring it would drop everything past the em dash on the
    // one kind of row nothing else can recover the text from.
    expect(
      arcNoteParts("arc step demo start", "demo: something unexpected — and its detail"),
    ).toEqual({
      name: "demo",
      label: null,
      subject: "something unexpected — and its detail",
      glyph: "Wrench",
    });
  });

  test("an empty sentence yields no subject rather than an empty one", () => {
    expect(arcNoteParts("arc bless demo", "   ").subject).toBeNull();
  });

  test("the arc's name survives a sentence that lost its prefix", () => {
    expect(arcNoteParts("arc step demo done", "step 3/15 closed (abc1234)")).toEqual({
      name: "demo",
      label: "Step 3/15 closed",
      subject: "abc1234",
      glyph: "CircleCheck",
    });
  });
});
