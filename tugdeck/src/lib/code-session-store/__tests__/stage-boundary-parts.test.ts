/**
 * `stageBoundaryParts` — which stage, which document, which model.
 *
 * The stage bar used to say `Stage` and leave `devise · opus · <path>` to the
 * detail, so a reader had to parse a ` · `-joined line to learn which stage
 * they had crossed into. The boundary puts the three facts in three slots, and
 * this is the function that decides them.
 *
 * It is also read twice: the renderer fills the bar with it, and the
 * transcript's search index projects `event` as the row's one search unit —
 * marked containers pair positionally with projected parts, so the two
 * readings have to be the same string. Pinning the function pins both.
 *
 * The count deserves its own note. `session_stage` carries no stage ordinal
 * and no stage total — an arc's stage count is not fixed — so the only count
 * available is `steps`, the inclusive step range a *continued* implement stage
 * walks. `4-9` therefore reads `Stage 4 of 9`, naming where in the walk the
 * reader landed, and every other stage reads `Stage · <stage>` rather than
 * inventing a denominator.
 */

import { describe, expect, test } from "bun:test";

import {
  STAGE_BOUNDARY_EVENT,
  stageBoundaryParts,
  stageNoteText,
} from "@/lib/code-session-store/stages";

describe("stageBoundaryParts", () => {
  test("a first stage names itself, its document and its model", () => {
    expect(
      stageBoundaryParts({
        stage: "devise",
        model: "opus",
        document: ".tug/arcs/foo/brief.md",
      }),
    ).toEqual({
      event: "Stage · devise",
      detail: ".tug/arcs/foo/brief.md",
      badge: "opus",
    });
  });

  test("a continued stage counts the steps it walks", () => {
    expect(
      stageBoundaryParts({
        stage: "implement, continued",
        model: "opus",
        document: ".tug/arcs/foo/plan.md",
        steps: "4-9",
      }),
    ).toEqual({
      event: "Stage 4 of 9 · implement",
      detail: ".tug/arcs/foo/plan.md",
      badge: "opus",
    });
  });

  test("the range says the stage is continued, so the suffix does not", () => {
    // `stageNoteText` writes ", continued" because its one line has no other
    // way to say so. The boundary's run would then read it twice.
    const parts = stageBoundaryParts({
      stage: "implement, continued",
      model: "",
      document: "",
      steps: "12-14",
    });
    expect(parts.event).toBe("Stage 12 of 14 · implement");
    expect(parts.event).not.toContain("continued");
  });

  test("a steps value that is not a range is not a count", () => {
    // Never written today, but the field is a string off the wire: a shape
    // this function cannot read must degrade to the no-count event rather
    // than render half a range.
    for (const steps of ["4", "4–9", "", "n-m", "4-9-12"]) {
      expect(
        stageBoundaryParts({ stage: "implement", model: "", document: "", steps }).event,
      ).toBe("Stage · implement");
    }
  });

  test("the account default leaves the badge off rather than rendering a gap", () => {
    const parts = stageBoundaryParts({
      stage: "review",
      model: "",
      document: ".tug/arcs/foo/plan.md",
    });
    expect(parts.badge).toBeUndefined();
    expect(parts.detail).toBe(".tug/arcs/foo/plan.md");
  });

  test("an empty document leaves the detail empty, and the bar renders none", () => {
    expect(
      stageBoundaryParts({ stage: "audit", model: "opus", document: "" }),
    ).toEqual({ event: "Stage · audit", detail: "", badge: "opus" });
  });

  test("an empty stage falls back to the bare event", () => {
    // The floor a note with no facts reads, reached here by facts that carry
    // no stage — so the event is never a dangling separator.
    expect(
      stageBoundaryParts({ stage: "", model: "opus", document: "x.md" }).event,
    ).toBe(STAGE_BOUNDARY_EVENT);
  });

  test("every fact the note's own text shows is somewhere on the bar", () => {
    // The note text is the row's copy text and stays what it was; the bar is
    // the same facts rearranged, so nothing the reader could see before has
    // gone missing from the row.
    const facts = {
      stage: "devise",
      model: "opus",
      document: ".tug/arcs/foo/brief.md",
    };
    const text = stageNoteText(facts.stage, facts.model, facts.document);
    const parts = stageBoundaryParts(facts);
    const onBar = `${parts.event} ${parts.detail} ${parts.badge ?? ""}`;
    for (const segment of text.split(" · ")) {
      expect(onBar).toContain(segment);
    }
  });
});
