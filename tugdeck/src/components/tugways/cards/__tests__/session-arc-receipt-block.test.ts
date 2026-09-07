/**
 * The arc receipt's parser, against the exact strings the Rust formatter
 * asserts. The complete-arc literal is copied verbatim from
 * `the_receipt_names_every_stage_its_model_and_its_session`, and the account-
 * default and stop literals from their own tests — that copy is the point: it
 * is what keeps the two ends pinned to one format, and it fails loudly if
 * either end drifts.
 */

import { describe, expect, it } from "bun:test";

import {
  ARC_FINISH_SLOT,
  ARC_RESUME_OFFER_TITLE,
  arcFinishNote,
  arcReceiptFindParts,
  arcReceiptPhase,
  arcReceiptPresentation,
  arcStagesPhrase,
  matchesArcReceipt,
  parseArcReceipt,
  shouldOfferResume,
  trackModelFor,
} from "@/components/tugways/cards/session-arc-receipt-block";
import { resolveCommandAttribution } from "@/components/tugways/cards/session-command-block-registry";
import { arcNoteParts } from "@/lib/arc-note-command";
import type { ShellExchangeMessage } from "@/lib/code-session-store/types";

const COMPLETE = [
  "arc complete · foo",
  "opened on arc/foo-brief.md",
  "devise · opus · claude-a",
  "review · opus · claude-b",
  "implement · sonnet · claude-c",
  "plan arc/foo.md",
].join("\n");

const STOPPED = [
  "arc stopped · foo · in review — the review ended without stamping the plan",
  "opened on arc/foo-brief.md",
  "devise · opus · claude-a",
  "review · opus · claude-b",
].join("\n");

/** A stop that ends the arc: the one shape that still writes a tail. */
const TERMINAL = [
  "arc stopped · foo · in review — the arc was discarded",
  "there is nothing to resume",
].join("\n");

/**
 * A `NeedsDecision` stop: the stage's own question, written as the record's
 * last note and read back beneath the header. It is the row's tail, and it is
 * why that stop needs no answer affordance of its own.
 */
const ASKED = [
  "arc stopped · foo · in implement — it met a decision that is yours to make, so it stopped rather than asking",
  "Should the cache key include the locale?",
].join("\n");

/**
 * A receipt already in a shell ledger, from before the resume became a
 * button. These rows replay on every card reload and nothing rewrites them.
 */
const LEGACY = [
  "arc stopped · foo · in review — the review ended without stamping the plan",
  "resume with tugtool arc run foo",
  "opened on arc/foo-brief.md",
].join("\n");

function message(output: string): ShellExchangeMessage {
  return {
    kind: "shell_exchange",
    messageKey: "k",
    createdAt: 0,
    exchangeId: "k",
    command: "/arc-run",
    output,
    exitCode: 0,
    cwd: "/repo",
    cwdAfter: null,
    startedAtMs: 0,
    settledAtMs: 0,
  };
}

describe("parsing a completed arc", () => {
  it("reads the arc, the document, every stage, and the plan", () => {
    const parsed = parseArcReceipt(COMPLETE);
    expect(parsed).toEqual({
      outcome: "complete",
      arc: "foo",
      document: "arc/foo-brief.md",
      stages: [
        { stage: "devise", model: "opus", sessionId: "claude-a" },
        { stage: "review", model: "opus", sessionId: "claude-b" },
        { stage: "implement", model: "sonnet", sessionId: "claude-c" },
      ],
      plan: "arc/foo.md",
      stop: null,
      resumed: null,
    });
  });

  it("keeps the server's word for a stage on the account default", () => {
    // `format_arc_receipt` writes the phrase rather than leaving a blank, so
    // the absence arrives here already spelled and is never reconstructed.
    const parsed = parseArcReceipt(
      "arc complete · foo\ndevise · account default · claude-a",
    );
    expect(parsed?.stages[0]?.model).toBe("account default");
    // Nothing to open on and nothing that came out: both absences are the
    // server omitting a line, and both must read as absent rather than empty.
    expect(parsed?.document).toBeNull();
    expect(parsed?.plan).toBeNull();
  });

  it("reads the audit stage the four-stage arc ends on", () => {
    const parsed = parseArcReceipt(
      "arc complete · foo\naudit · opus · claude-d",
    );
    expect(parsed?.stages[0]?.stage).toBe("audit");
  });
});

describe("parsing a stopped arc", () => {
  it("reads the stage it stopped in and the reason, and names no command", () => {
    const parsed = parseArcReceipt(STOPPED);
    expect(parsed?.outcome).toBe("stopped");
    expect(parsed?.stop).toEqual({
      stage: "review",
      reason: "the review ended without stamping the plan",
      said: null,
      terminal: false,
    });
    // The stages it did walk are still the record, and still parsed.
    expect(parsed?.stages).toHaveLength(2);
  });

  it("never reads a marked line as the stage's own words", () => {
    // A stop's tail carries no marker of its own — it is simply whatever
    // followed the header — so the marked lines must not be eligible.
    const parsed = parseArcReceipt(STOPPED);
    expect(parsed?.stop?.said).toBeNull();
    expect(parsed?.document).toBe("arc/foo-brief.md");
  });

  it("reads terminality off the frozen sentence, and off nothing else", () => {
    // The one marker a restored transcript has: no wire field carries this.
    expect(parseArcReceipt(TERMINAL)?.stop?.terminal).toBe(true);
    expect(parseArcReceipt(TERMINAL)?.stop?.said).toBeNull();
    expect(parseArcReceipt(STOPPED)?.stop?.terminal).toBe(false);
  });

  it("keeps the question a stage stopped over as the row's tail", () => {
    const parsed = parseArcReceipt(ASKED);
    expect(parsed?.stop?.said).toBe("Should the cache key include the locale?");
    expect(parsed?.stop?.terminal).toBe(false);
  });

  it("drops the command an older receipt still carries", () => {
    // The rows that predate the button replay forever, and the whole point of
    // the change is that the user never sees the verb — so the line is
    // recognized and spent, never mistaken for something the stage said.
    const parsed = parseArcReceipt(LEGACY);
    expect(parsed?.stop?.said).toBeNull();
    expect(parsed?.document).toBe("arc/foo-brief.md");
    expect(arcReceiptFindParts(message(LEGACY))).not.toContain(
      "resume with tugtool arc run foo",
    );
  });
});

/**
 * The gate, which is the whole of the offer's logic.
 *
 * Every fact it reads comes off the row: the parse, and the supersession the
 * transcript derived from its own later rows. There is deliberately no fact
 * about whether the arc is *still* stopped, because asking would mean reading
 * the present into a row that reports a past — and the server is what makes
 * that safe, since a resume on an arc carrying no stop binds and writes
 * nothing.
 *
 * The press itself is driven in `at0476-arc-interruptions.test.ts`, against a
 * real stopped arc on a real card: the deck has no React render harness, and a
 * unit test of the button would be a test of a mock.
 */
describe("offering the resume", () => {
  it("offers on a live, resumable stop", () => {
    const parsed = parseArcReceipt(STOPPED);
    expect(parsed).not.toBeNull();
    expect(shouldOfferResume(parsed!, undefined)).toBe(true);
    expect(shouldOfferResume(parsed!, false)).toBe(true);
  });

  it("does not offer on a stop a later row has answered", () => {
    // The arc stopped, was resumed, and joined: the row is still the record,
    // and a button on it would offer a way back into work that has landed.
    const parsed = parseArcReceipt(STOPPED);
    expect(shouldOfferResume(parsed!, true)).toBe(false);
  });

  it("does not offer on a stop that ended the arc", () => {
    // A discard and a join leave nothing to pick up, and the frozen sentence
    // is the only marker of that a restored transcript has.
    const parsed = parseArcReceipt(TERMINAL);
    expect(parsed?.stop?.terminal).toBe(true);
    expect(shouldOfferResume(parsed!, undefined)).toBe(false);
  });

  it("does not offer on a completed arc", () => {
    const parsed = parseArcReceipt(COMPLETE);
    expect(shouldOfferResume(parsed!, undefined)).toBe(false);
  });

  it("still offers on an older receipt that carried the command", () => {
    // The rows that predate the button are still live stops, and the line the
    // parser now spends does not change what they are.
    const parsed = parseArcReceipt(LEGACY);
    expect(shouldOfferResume(parsed!, undefined)).toBe(true);
  });

  it("titles the offer with the gesture its button performs", () => {
    // The title and the button are one gesture, so they say one word. The
    // older "Pick this arc back up" made the reader translate the title into
    // the `Resume` button before pressing it.
    expect(ARC_RESUME_OFFER_TITLE).toBe("Resume this arc");
  });
});

describe("what does not parse", () => {
  it("refuses a line that is not one of the three headers", () => {
    expect(parseArcReceipt("arc: something nobody wrote a format for")).toBeNull();
    expect(parseArcReceipt("")).toBeNull();
    expect(arcReceiptFindParts(message("not a receipt"))).toBeNull();
  });

  it("never reads a document line as a stage", () => {
    // `opened on …` and `plan …` both carry the `·`-free shape the stage
    // vocabulary excludes; a receipt with neither stage must show none.
    const parsed = parseArcReceipt(
      "arc complete · foo\nopened on arc/foo-brief.md\nplan arc/foo.md",
    );
    expect(parsed?.stages).toEqual([]);
  });
});

/**
 * The third outcome: a silence-judged stop the stopped stage itself
 * contradicted, which the runner undoes on its own. The literal is copied
 * verbatim from `a_step_closing_on_a_stopped_arc_picks_it_back_up`, the same
 * pinning every other literal in this file does.
 *
 * `outcome` is a three-member union with three readers that each split it two
 * ways, so the risk this block covers is not the parse — it is a reader falling
 * through: a pick-up drawn as an audited arc, labelled with the word *stopped*,
 * in the error tone.
 */
describe("parsing an arc picked back up", () => {
  const PICKED_UP = "arc picked back up · demo · in implement · a step closed";

  it("reads the arc, the stage, and what moved", () => {
    const parsed = parseArcReceipt(PICKED_UP);
    expect(parsed?.outcome).toBe("resumed");
    expect(parsed?.arc).toBe("demo");
    expect(parsed?.resumed).toEqual({
      stage: "implement",
      moved: "a step closed",
    });
  });

  it("carries no stop, because the stop is what it undid", () => {
    expect(parseArcReceipt(PICKED_UP)?.stop).toBeNull();
  });

  it("offers no resume: the arc is already running again", () => {
    const parsed = parseArcReceipt(PICKED_UP);
    expect(parsed).not.toBeNull();
    expect(shouldOfferResume(parsed!, undefined)).toBe(false);
  });

  it("is not read as a stop by the header before it", () => {
    // The two headers differ in their second word, so `STOPPED_RE` cannot
    // match this line — asserted rather than assumed, because the order the
    // parser tries them in is the only thing that would hide a collision.
    const parsed = parseArcReceipt(PICKED_UP);
    expect(parsed?.outcome).not.toBe("stopped");
  });

  it("a stop is still a stop", () => {
    // The negative control: adding a third header must not have changed what
    // the other two parse to.
    expect(parseArcReceipt(STOPPED)?.outcome).toBe("stopped");
    expect(parseArcReceipt(COMPLETE)?.outcome).toBe("complete");
  });

  it("draws as an arc that is running, not one the audit finished", () => {
    // The fall-through this covers: `trackModelFor`'s complete arm seats the
    // strip at `audit` with `done: true`, which is what a pick-up would have
    // been drawn as. It is running in the stage the header names instead.
    const parsed = parseArcReceipt(PICKED_UP);
    expect(parsed).not.toBeNull();
    const model = trackModelFor(parsed!);
    const audited = trackModelFor(parseArcReceipt(COMPLETE)!);
    expect(model.phase).not.toBe(audited.phase);
  });

  it("wears the success tone, never the error one", () => {
    // `error` says *do something about this*, and there is nothing to do about
    // an arc that picked itself back up.
    const parsed = parseArcReceipt(PICKED_UP);
    expect(arcReceiptPhase(parsed!, false)).toBe("success");
    expect(arcReceiptPhase(parseArcReceipt(STOPPED)!, false)).toBe("error");
    expect(arcReceiptPhase(parseArcReceipt(STOPPED)!, true)).toBe("idle");
  });
});

describe("the row the transcript builds around it", () => {
  it("claims /arc-run and nothing adjacent", () => {
    expect(matchesArcReceipt("/arc-run")).toBe(true);
    expect(matchesArcReceipt("/arc-run foo")).toBe(true);
    expect(matchesArcReceipt("/arc-running")).toBe(false);
    expect(matchesArcReceipt("/arc-join")).toBe(false);
  });

  it("still claims the command name the receipt wrote before it was renamed", () => {
    // These rows are in the shell ledger and replay on every card reload. Drop
    // them and every arc ending already recorded reverts to a raw shell row.
    expect(matchesArcReceipt("/dash-arc")).toBe(true);
    expect(matchesArcReceipt("/dash-arc foo")).toBe(true);
    expect(matchesArcReceipt("/dash-archive")).toBe(false);
  });

  it("attributes the row to the wheel, not the shell that carried it", () => {
    // The attribution is what takes away the `Shell` identifier and the
    // `exit 0 · 0ms` end-state: an arc ends on a server tick, having shelled
    // nothing and having committed nothing on the base.
    expect(resolveCommandAttribution("/arc-run")).toBe("wheel");
  });

  it("projects the arc and the stages, and never a truncated id", () => {
    // The two outcomes that stay receipts. A finished arc is a line and
    // projects as one — see the finish's own describe below.
    const parts = arcReceiptFindParts(message(STOPPED));
    expect(parts).toContain("foo");
    expect(parts).toContain("review");
    expect(parts).not.toContain("claude-a");
  });
});

/**
 * A finished arc is a quiet line ([B04]).
 *
 * The receipt's record is not lost with it — it folds behind the `Joined`
 * boundary once the arc lands ([B02]) — so what is asserted here is that the
 * row takes the quiet seat, says the same words the strip said, and projects
 * exactly the one unit the line paints.
 */
describe("a complete arc finishes as a quiet line", () => {
  it("takes the quiet seat, and leaves the other two outcomes in their entry", () => {
    expect(arcReceiptPresentation(message(COMPLETE))).toBe("quiet");
    expect(arcReceiptPresentation(message(STOPPED))).toBe("entry");
    expect(
      arcReceiptPresentation(
        message("arc picked back up · demo · in implement · a step closed"),
      ),
    ).toBe("entry");
    // A row that does not parse falls through to the generic block, which has
    // always worn the entry.
    expect(arcReceiptPresentation(message("arc did a thing"))).toBe("entry");
  });

  it("says what the lifecycle strip said, through the arc-note grammar", () => {
    const finish = arcFinishNote(parseArcReceipt(COMPLETE)!);
    const { name, label, subject, glyph } = arcNoteParts(finish.command, finish.sentence);
    // The arc's own quiet run, then the gesture as one bold label — the event
    // rather than a detail under one ([B09]).
    expect(name).toBe("foo");
    expect(label).toBe("Finished · 3 stages");
    expect(subject).toBeNull();
    expect(glyph).toBe("ShipWheel");
  });

  it("counts one stage in the singular", () => {
    expect(arcStagesPhrase(1)).toBe("1 stage");
    expect(arcStagesPhrase(0)).toBe("0 stages");
    const one = arcFinishNote(parseArcReceipt("arc complete · solo\ndevise · opus · c-a")!);
    expect(arcNoteParts(one.command, one.sentence).label).toBe("Finished · 1 stage");
  });

  it("projects the line it paints, and nothing behind it", () => {
    // One unit: the label node, whose bytes are the name and the verb with one
    // space between them, exactly as `ArcNoteLine` renders them. The record's
    // stages and documents are not on screen here, so projecting them would be
    // matches the painter could never reach.
    expect(arcReceiptFindParts(message(COMPLETE))).toEqual(["foo Finished · 3 stages"]);
  });

  it("names the slot the line wears", () => {
    expect(ARC_FINISH_SLOT).toBe("arc-finish-line");
  });
});

/**
 * The frozen-text claim, asserted rather than asserted about.
 *
 * A superseded stop is demoted — folded, muted — and that is the whole of it.
 * The parser is the one thing every rendered word and `copyText` comes from, so
 * a parse that is byte-identical either way is what proves the receipt still
 * says what the server said. Nothing in the demotion is allowed to reach the
 * text; a row that rewrote its own record would stop being a record.
 */
describe("a demoted stop receipt is still the same receipt", () => {
  it("parses byte-identically whether or not the row is superseded", () => {
    // `parseArcReceipt` reads the output alone — there is no supersession
    // parameter to pass, and that is the design. The demotion lives entirely in
    // the block's pose, so the same output cannot parse two ways.
    const a = parseArcReceipt(STOPPED);
    const b = parseArcReceipt(STOPPED);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a?.stop?.reason).toBe("the review ended without stamping the plan");
    // And the copy text a demoted block hands `BlockChrome` is the message
    // output verbatim — the same string, folded or not.
    expect(message(STOPPED).output).toBe(STOPPED);
  });
});
