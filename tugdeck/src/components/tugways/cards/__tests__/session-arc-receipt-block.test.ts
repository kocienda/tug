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
  arcReceiptFindParts,
  matchesArcReceipt,
  parseArcReceipt,
} from "@/components/tugways/cards/session-arc-receipt-block";
import { resolveCommandAttribution } from "@/components/tugways/cards/session-command-block-registry";
import { sessionAtomLabel } from "@/components/tugways/tug-atom-ref";
import type { ShellExchangeMessage } from "@/lib/code-session-store/types";

const COMPLETE = [
  "arc complete · foo",
  "opened on dash/foo-brief.md",
  "devise · opus · claude-a",
  "review · opus · claude-b",
  "implement · sonnet · claude-c",
  "plan dash/foo.md",
].join("\n");

const STOPPED = [
  "arc stopped · foo · in review — the review ended without stamping the plan",
  "resume with tugtool arc run foo",
  "opened on dash/foo-brief.md",
  "devise · opus · claude-a",
  "review · opus · claude-b",
].join("\n");

function message(output: string): ShellExchangeMessage {
  return {
    kind: "shell_exchange",
    messageKey: "k",
    createdAt: 0,
    exchangeId: "k",
    command: "/dash-arc",
    output,
    exitCode: 0,
    cwd: "/repo",
    cwdAfter: null,
    startedAtMs: 0,
    settledAtMs: 0,
  };
}

describe("parsing a completed arc", () => {
  it("reads the dash, the document, every stage, and the plan", () => {
    const parsed = parseArcReceipt(COMPLETE);
    expect(parsed).toEqual({
      outcome: "complete",
      dash: "foo",
      document: "dash/foo-brief.md",
      stages: [
        { stage: "devise", model: "opus", sessionId: "claude-a" },
        { stage: "review", model: "opus", sessionId: "claude-b" },
        { stage: "implement", model: "sonnet", sessionId: "claude-c" },
      ],
      plan: "dash/foo.md",
      stop: null,
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
  it("reads the stage it stopped in, the reason, and what resumes it", () => {
    const parsed = parseArcReceipt(STOPPED);
    expect(parsed?.outcome).toBe("stopped");
    expect(parsed?.stop).toEqual({
      stage: "review",
      reason: "the review ended without stamping the plan",
      next: "resume with tugtool arc run foo",
    });
    // The stages it did walk are still the record, and still parsed.
    expect(parsed?.stages).toHaveLength(2);
  });

  it("takes the resume sentence and not the document line", () => {
    // The resume line carries no marker of its own — it is simply whatever
    // followed the header — so the two marked lines must not be eligible.
    const parsed = parseArcReceipt(STOPPED);
    expect(parsed?.stop?.next).not.toContain("opened on");
    expect(parsed?.document).toBe("dash/foo-brief.md");
  });
});

describe("what does not parse", () => {
  it("refuses a line that is not one of the two headers", () => {
    expect(parseArcReceipt("arc: something nobody wrote a format for")).toBeNull();
    expect(parseArcReceipt("")).toBeNull();
    expect(arcReceiptFindParts(message("not a receipt"))).toBeNull();
  });

  it("never reads a document line as a stage", () => {
    // `opened on …` and `plan …` both carry the `·`-free shape the stage
    // vocabulary excludes; a receipt with neither stage must show none.
    const parsed = parseArcReceipt(
      "arc complete · foo\nopened on dash/foo-brief.md\nplan dash/foo.md",
    );
    expect(parsed?.stages).toEqual([]);
  });
});

describe("the row the transcript builds around it", () => {
  it("claims /dash-arc and nothing adjacent", () => {
    expect(matchesArcReceipt("/dash-arc")).toBe(true);
    expect(matchesArcReceipt("/dash-arc foo")).toBe(true);
    expect(matchesArcReceipt("/dash-archive")).toBe(false);
    expect(matchesArcReceipt("/arc-join")).toBe(false);
  });

  it("attributes the row to the wheel, not the shell that carried it", () => {
    // The attribution is what takes away the `Shell` identifier and the
    // `exit 0 · 0ms` end-state: an arc ends on a server tick, having shelled
    // nothing and having committed nothing on the base.
    expect(resolveCommandAttribution("/dash-arc")).toBe("wheel");
  });

  it("projects the dash and the stages, and never a truncated id", () => {
    const parts = arcReceiptFindParts(message(COMPLETE));
    expect(parts).toContain("foo");
    expect(parts).toContain("implement");
    expect(parts).not.toContain("claude-a");
  });
});

describe("the session atom's label", () => {
  it("carries the word, because eight hex characters carry none", () => {
    expect(sessionAtomLabel("d0a7daa1-fe05-4ad9-bbce-5f261d222d41")).toBe(
      "session:d0a7daa1",
    );
  });
});
