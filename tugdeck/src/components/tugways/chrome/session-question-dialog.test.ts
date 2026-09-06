/**
 * Pure-logic tests for `session-question-dialog.tsx`.
 *
 * `QuestionWizard`'s behaviour is its exported pure helpers — the
 * `AskUserQuestion` payload parser, the initial-selection seed, the
 * per-question selection apply, and the `answers`-record builder. Per
 * project policy (pure-logic `bun:test` +
 * real-app tests only, no fake-DOM render tests), the suite pins those
 * exhaustively; the answer round-trip, the radio/checkbox paint, and
 * primary-button focus are HMR / live-smoke vetted because the
 * app-test harness can't inject `control_request_forward` events (the
 * same gap that gates the permission dialog).
 *
 * Coverage:
 *  - `parseQuestions` — the real `input.questions` shape, the
 *    `multiSelect` flag, option descriptions, the drop rules
 *    (no question text, no options, malformed option), and the
 *    degenerate `[]` for a non-object / question-less payload.
 *  - `initialQuestionSelections` — single-select pre-selects the
 *    first option, multi-select starts empty.
 *  - `applyQuestionSelection` — single-select replaces, multi-select
 *    toggles on and off.
 *  - `buildQuestionAnswers` — keyed by question text, single label,
 *    multi-select comma-join (no spaces), empty-selection passthrough.
 */

import { describe, it, expect } from "bun:test";

import { TUG_ATOM_CHAR } from "@/lib/tug-atom-img";

import {
  QUESTION_DIALOG_PRESERVATION_KEY_PREFIX,
  applyQuestionSelection,
  buildQuestionAnswers,
  composeRowAnswerLabel,
  countAnswered,
  countConfirmedAnswers,
  initialQuestionSelections,
  nextAdvanceIndex,
  parseQuestions,
  questionAnswered,
  questionDialogPreservationKey,
  rowStatus,
  seedQuestionDialogState,
  type ParsedQuestion,
  type QuestionDialogPreservedState,
} from "./session-question-dialog";
import type { ControlRequestForward } from "@/lib/code-session-store";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A question `control_request_forward` carrying the real tugcode
 *  `AskUserQuestion` input shape (`input.questions[]`). */
function questionForward(questions: unknown): ControlRequestForward {
  return {
    request_id: "q-req-1",
    is_question: true,
    tool_name: "AskUserQuestion",
    input: { questions },
  };
}

/** A `ParsedQuestion` literal for the selection / answer helpers. */
function parsed(
  question: string,
  multiSelect: boolean,
  labels: string[],
): ParsedQuestion {
  return {
    question,
    multiSelect,
    options: labels.map((label) => ({ label })),
  };
}

// ---------------------------------------------------------------------------
// parseQuestions
// ---------------------------------------------------------------------------

describe("parseQuestions", () => {
  it("parses a single-select question with options", () => {
    const out = parseQuestions(
      questionForward([
        {
          question: "Which approach?",
          options: [
            { label: "Refactor", description: "Restructure first" },
            { label: "Patch" },
          ],
        },
      ]),
    );
    expect(out).toEqual([
      {
        question: "Which approach?",
        multiSelect: false,
        options: [
          { label: "Refactor", description: "Restructure first" },
          { label: "Patch", description: undefined },
        ],
      },
    ]);
  });

  it("carries the multiSelect flag", () => {
    const out = parseQuestions(
      questionForward([
        {
          question: "Pick all that apply",
          multiSelect: true,
          options: [{ label: "A" }, { label: "B" }],
        },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].multiSelect).toBe(true);
  });

  it("parses a multi-question payload", () => {
    const out = parseQuestions(
      questionForward([
        { question: "First?", options: [{ label: "Yes" }] },
        { question: "Second?", options: [{ label: "No" }] },
      ]),
    );
    expect(out.map((q) => q.question)).toEqual(["First?", "Second?"]);
  });

  it("drops a question with no text", () => {
    const out = parseQuestions(
      questionForward([
        { question: "   ", options: [{ label: "A" }] },
        { options: [{ label: "B" }] },
      ]),
    );
    expect(out).toEqual([]);
  });

  it("drops a question with no usable options (it cannot round-trip)", () => {
    const out = parseQuestions(
      questionForward([
        { question: "No options here", options: [] },
        { question: "Bad options", options: [{ description: "no label" }, null] },
      ]),
    );
    expect(out).toEqual([]);
  });

  it("drops a single malformed option but keeps the rest of the question", () => {
    const out = parseQuestions(
      questionForward([
        {
          question: "Mixed options",
          options: [{ label: "Good" }, { label: "  " }, 7, { label: "Also good" }],
        },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].options.map((o) => o.label)).toEqual(["Good", "Also good"]);
  });

  it("returns [] for a non-object input or a missing questions array", () => {
    expect(parseQuestions({ request_id: "r", is_question: true })).toEqual([]);
    expect(
      parseQuestions({ request_id: "r", is_question: true, input: "nope" }),
    ).toEqual([]);
    expect(parseQuestions(questionForward("not-an-array"))).toEqual([]);
    expect(parseQuestions(questionForward([]))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// initialQuestionSelections
// ---------------------------------------------------------------------------

describe("initialQuestionSelections", () => {
  it("pre-selects the first option of a single-select question", () => {
    expect(
      initialQuestionSelections([parsed("Q", false, ["A", "B", "C"])]),
    ).toEqual([["A"]]);
  });

  it("pre-selects the first option of a multi-select question too", () => {
    // A bare Return through the wizard should commit a sane default
    // answer for every question; multi-select participates in that.
    expect(
      initialQuestionSelections([parsed("Q", true, ["A", "B"])]),
    ).toEqual([["A"]]);
  });

  it("seeds each question of a mixed payload independently", () => {
    expect(
      initialQuestionSelections([
        parsed("single", false, ["X", "Y"]),
        parsed("multi", true, ["P", "Q"]),
      ]),
    ).toEqual([["X"], ["P"]]);
  });
});

// ---------------------------------------------------------------------------
// applyQuestionSelection
// ---------------------------------------------------------------------------

describe("applyQuestionSelection", () => {
  it("single-select replaces the current choice (radio semantics)", () => {
    const q = parsed("Q", false, ["A", "B"]);
    expect(applyQuestionSelection(q, ["A"], "B")).toEqual(["B"]);
  });

  it("multi-select adds an unselected option (checkbox semantics)", () => {
    const q = parsed("Q", true, ["A", "B"]);
    expect(applyQuestionSelection(q, [], "A")).toEqual(["A"]);
    expect(applyQuestionSelection(q, ["A"], "B")).toEqual(["A", "B"]);
  });

  it("multi-select toggles a selected option back off", () => {
    const q = parsed("Q", true, ["A", "B"]);
    expect(applyQuestionSelection(q, ["A", "B"], "A")).toEqual(["B"]);
  });
});

// ---------------------------------------------------------------------------
// buildQuestionAnswers
// ---------------------------------------------------------------------------

describe("buildQuestionAnswers", () => {
  it("keys answers by question text, single-select value is the label", () => {
    expect(
      buildQuestionAnswers([parsed("Which approach?", false, ["Refactor"])], [
        ["Refactor"],
      ]),
    ).toEqual({ "Which approach?": "Refactor" });
  });

  it("comma-joins multi-select labels with no spaces", () => {
    // tugcode's formatQuestionAnswer expects bare-comma joins (PN-5).
    expect(
      buildQuestionAnswers([parsed("Pick all", true, ["A", "B", "C"])], [
        ["A", "C"],
      ]),
    ).toEqual({ "Pick all": "A,C" });
  });

  it("emits an empty-string value for a question with no selection", () => {
    expect(
      buildQuestionAnswers([parsed("Skipped?", true, ["A"])], [[]]),
    ).toEqual({ "Skipped?": "" });
  });

  it("builds one entry per question of a multi-question payload", () => {
    expect(
      buildQuestionAnswers(
        [parsed("First?", false, ["Yes"]), parsed("Second?", true, ["X", "Y"])],
        [["Yes"], ["X", "Y"]],
      ),
    ).toEqual({ "First?": "Yes", "Second?": "X,Y" });
  });

  it("sends free text verbatim, overriding any labels ([P01])", () => {
    expect(
      buildQuestionAnswers(
        [parsed("Which approach?", false, ["Refactor"])],
        [["Refactor"]],
        ["something else entirely"],
      ),
    ).toEqual({ "Which approach?": "something else entirely" });
  });

  it("falls back to labels when free text is blank/whitespace", () => {
    expect(
      buildQuestionAnswers(
        [parsed("Q?", false, ["A"]), parsed("R?", false, ["B"])],
        [["A"], ["B"]],
        ["   ", ""],
      ),
    ).toEqual({ "Q?": "A", "R?": "B" });
  });

  it("composes a mixed payload — free text for one, labels for the other", () => {
    expect(
      buildQuestionAnswers(
        [parsed("Q?", false, ["A"]), parsed("R?", true, ["X", "Y"])],
        [[], ["X", "Y"]],
        ["typed answer", ""],
      ),
    ).toEqual({ "Q?": "typed answer", "R?": "X,Y" });
  });

  it("flattens a chip in the answer to its plain form ([B05])", () => {
    // The exit. The answer leaves Tug here, and the reader on the other side
    // is Claude Code, which reads prose — so the chip becomes the [B03] plain
    // form rather than the placeholder character it stands at. Held as a chip
    // for the life of the field, flattened once, on the way out.
    expect(
      buildQuestionAnswers(
        [parsed("Which file?", false, ["A"])],
        [[]],
        [`start with ${TUG_ATOM_CHAR}`],
        [
          [
            {
              position: 11,
              type: "file",
              label: "atom-text.ts",
              value: "tugdeck/src/lib/atom-text.ts",
            },
          ],
        ],
      ),
    ).toEqual({
      "Which file?": "start with [atom-text.ts](<tugdeck/src/lib/atom-text.ts>)",
    });
  });

  it("leaves an answer with no atoms exactly as typed", () => {
    expect(
      buildQuestionAnswers(
        [parsed("Q?", false, ["A"])],
        [[]],
        ["just words"],
        [[]],
      ),
    ).toEqual({ "Q?": "just words" });
  });

  it("a commit chip in an answer reads as its label, not its sha", () => {
    // The answer's spelling is the READER's — `commit:<8>` is what a person
    // recognises. The commit message's spelling is the machine's, and the two
    // are deliberately different ([B05]).
    expect(
      buildQuestionAnswers(
        [parsed("Which?", false, ["A"])],
        [[]],
        [TUG_ATOM_CHAR],
        [
          [
            {
              position: 0,
              type: "commit",
              label: "commit:64747b8c",
              value: "64747b8c9a1d3f0e5b2c7a8d9e0f1a2b3c4d5e6f",
            },
          ],
        ],
      ),
    ).toEqual({ "Which?": "commit:64747b8c" });
  });
});

// ---------------------------------------------------------------------------
// questionAnswered — the "answered" predicate ([F1])
// ---------------------------------------------------------------------------

describe("questionAnswered", () => {
  it("is true when there is at least one selected label", () => {
    expect(questionAnswered(["A"], "")).toBe(true);
  });

  it("is true when there is non-blank free text but no labels ([F1])", () => {
    // The Submit gate must enable on a free-text-only answer.
    expect(questionAnswered([], "typed")).toBe(true);
  });

  it("is false for empty selection AND blank/whitespace free text", () => {
    expect(questionAnswered([], "")).toBe(false);
    expect(questionAnswered([], "   ")).toBe(false);
    expect(questionAnswered(undefined, undefined)).toBe(false);
  });
});

// The question surface is no longer a foot-slot `RenderInput` kind routed
// through the dispatch — the `AskUserQuestion` tool block owns its live
// `QuestionWizard` in place. There is therefore no `kind: "question"`
// dispatch routing to assert here.

// ---------------------------------------------------------------------------
// Wizard navigation helpers — countAnswered + nextAdvanceIndex
// ---------------------------------------------------------------------------

describe("countAnswered", () => {
  it("counts entries with at least one selection", () => {
    expect(countAnswered([["a"], [], ["b", "c"], []])).toBe(2);
  });

  it("returns 0 for the all-empty case", () => {
    expect(countAnswered([[], [], []])).toBe(0);
  });

  it("returns 0 for an empty array (no questions)", () => {
    expect(countAnswered([])).toBe(0);
  });

  it("matches the question count when every row carries a selection", () => {
    expect(countAnswered([["a"], ["b"], ["c"]])).toBe(3);
  });
});

describe("nextAdvanceIndex", () => {
  it("advances by 1 when the next row exists", () => {
    expect(nextAdvanceIndex(0, 3)).toBe(1);
    expect(nextAdvanceIndex(1, 3)).toBe(2);
  });

  it("advances past the last row into the review state (index === total)", () => {
    expect(nextAdvanceIndex(2, 3)).toBe(3);
  });

  it("stays at the review index (no wrap)", () => {
    expect(nextAdvanceIndex(3, 3)).toBe(3);
  });

  it("stays at 0 for an empty list", () => {
    expect(nextAdvanceIndex(0, 0)).toBe(0);
  });

  it("advances a single-question wizard from 0 to the review index", () => {
    expect(nextAdvanceIndex(0, 1)).toBe(1);
  });
});

describe("composeRowAnswerLabel", () => {
  it("renders a single-select pick as the bare label", () => {
    expect(composeRowAnswerLabel(["Refactor"])).toBe("Refactor");
  });

  it("renders a multi-select picks list with comma+space joins", () => {
    // The wire round-trip uses a bare-comma join (PN-5); the visual
    // representation uses comma+space because it's human-readable
    // prose, not a serialised value.
    expect(composeRowAnswerLabel(["A", "B", "C"])).toBe("A, B, C");
  });

  it("returns the empty string for no selection (renderer short-circuits)", () => {
    expect(composeRowAnswerLabel([])).toBe("");
  });

  it("surfaces free text verbatim, overriding the labels ([P01])", () => {
    expect(composeRowAnswerLabel(["A", "B"], "my typed answer")).toBe(
      "my typed answer",
    );
  });

  it("ignores blank free text and falls back to the labels", () => {
    expect(composeRowAnswerLabel(["A"], "   ")).toBe("A");
  });
});

// ---------------------------------------------------------------------------
// countConfirmedAnswers — user-engagement headline count
// ---------------------------------------------------------------------------

describe("countConfirmedAnswers", () => {
  it("counts only rows that are visited AND have a selection", () => {
    const selections = [["a"], ["b"], [], ["c"]];
    const visited =  [true,  false, true, true];
    // 0: visited+answer → +1; 1: !visited (preseed) → no; 2: visited+empty → no; 3: visited+answer → +1.
    expect(countConfirmedAnswers(selections, visited)).toBe(2);
  });

  it("returns 0 when nothing has been visited yet", () => {
    // The preseeded recommendations all carry a selection, but the
    // user hasn't engaged — the headline must read 0.
    expect(countConfirmedAnswers([["a"], ["b"], ["c"]], [false, false, false])).toBe(0);
  });

  it("returns 0 for empty inputs", () => {
    expect(countConfirmedAnswers([], [])).toBe(0);
  });

  it("ignores rows past the end of the visited array", () => {
    // Defensive — if the parallel arrays drift in length, the
    // shorter one wins.
    expect(countConfirmedAnswers([["a"], ["b"]], [true])).toBe(1);
  });

  it("counts a visited free-text-only answer ([F1])", () => {
    // Row 1 has no selection but a typed answer — it must count once
    // visited, so the Submit gate enables.
    expect(
      countConfirmedAnswers([["a"], []], [true, true], ["", "typed"]),
    ).toBe(2);
  });

  it("does not count blank free text on a row with no selection", () => {
    expect(
      countConfirmedAnswers([["a"], []], [true, true], ["", "   "]),
    ).toBe(1);
  });
});

describe("countAnswered with free text", () => {
  it("counts a free-text-only row as answered", () => {
    expect(countAnswered([[], ["b"]], ["typed", ""])).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// rowStatus — the four wizard states
// ---------------------------------------------------------------------------

describe("rowStatus", () => {
  it("returns `current` when the row is in focus, regardless of other axes", () => {
    expect(rowStatus(true, false, false)).toBe("current");
    expect(rowStatus(true, true, true)).toBe("current");
    expect(rowStatus(true, false, true)).toBe("current");
  });

  it("returns `done` when the user has visited and there is a selection", () => {
    expect(rowStatus(false, true, true)).toBe("done");
  });

  it("returns `recommended` for a preseeded but unvisited row", () => {
    // The single-select arrival state — first option already
    // selected, but the user hasn't acknowledged it.
    expect(rowStatus(false, false, true)).toBe("recommended");
  });

  it("returns `pending` for an empty unvisited row", () => {
    // The multi-select arrival state — empty selection, no
    // engagement.
    expect(rowStatus(false, false, false)).toBe("pending");
  });

  it("returns `pending` when visited but empty", () => {
    // Edge case: the user clicked into a multi-select row and
    // back-clicked without picking anything. Still pending — the
    // selection is the source of truth for the answer summary.
    expect(rowStatus(false, true, false)).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// [L23] A9 preservation — key derivation + seed/capture round-trip
// ---------------------------------------------------------------------------

describe("questionDialogPreservationKey", () => {
  it("namespaces the request id under the question-dialog prefix", () => {
    expect(questionDialogPreservationKey("req-42")).toBe(
      "question-dialog/req-42",
    );
  });

  it("uses the exported prefix constant", () => {
    expect(QUESTION_DIALOG_PRESERVATION_KEY_PREFIX).toBe("question-dialog/");
    expect(questionDialogPreservationKey("x")).toBe(
      `${QUESTION_DIALOG_PRESERVATION_KEY_PREFIX}x`,
    );
  });
});

describe("seedQuestionDialogState", () => {
  const twoQuestions: ParsedQuestion[] = [
    parsed("First?", false, ["A", "B"]),
    parsed("Second?", true, ["X", "Y", "Z"]),
  ];

  it("returns the default seed when no saved state is present", () => {
    const seeded = seedQuestionDialogState(undefined, twoQuestions);
    expect(seeded.selections).toEqual([["A"], ["X"]]);
    expect(seeded.visited).toEqual([false, false]);
    expect(seeded.currentIndex).toBe(0);
  });

  it("rehydrates a well-formed saved tuple verbatim", () => {
    const saved: QuestionDialogPreservedState = {
      selections: [["B"], ["X", "Z"]],
      visited: [true, false],
      currentIndex: 1,
      freeTexts: ["", ""],
      freeTextAtoms: [[], []],
      declineMode: false,
      declineText: "",
      declineAtoms: [],
    };
    const seeded = seedQuestionDialogState(saved, twoQuestions);
    expect(seeded).toEqual(saved);
  });

  it("defaults freeTexts to empty strings when the saved envelope omits it ([F4])", () => {
    // An older (pre-free-text) saved envelope still validates and
    // realigns; the missing freeTexts falls back to empty per slot,
    // keeping the rest of the tuple intact.
    const saved = {
      selections: [["B"], ["X"]],
      visited: [true, true],
      currentIndex: 1,
    } as QuestionDialogPreservedState;
    const seeded = seedQuestionDialogState(saved, twoQuestions);
    expect(seeded.freeTexts).toEqual(["", ""]);
    expect(seeded.selections).toEqual([["B"], ["X"]]);
    expect(seeded.visited).toEqual([true, true]);
  });

  it("rehydrates and realigns saved free text ([P01])", () => {
    const saved: QuestionDialogPreservedState = {
      selections: [[], ["X"]],
      visited: [true, false],
      currentIndex: 0,
      freeTexts: ["my own answer"],
    };
    const seeded = seedQuestionDialogState(saved, twoQuestions);
    // Index 0 keeps the saved text; index 1 (absent in the short array)
    // falls back to the empty-string default.
    expect(seeded.freeTexts).toEqual(["my own answer", ""]);
  });

  it("rehydrates decline mode + reply text ([P02])", () => {
    const saved: QuestionDialogPreservedState = {
      selections: [["A"], ["X"]],
      visited: [false, false],
      currentIndex: 0,
      freeTexts: ["", ""],
      declineMode: true,
      declineText: "let's discuss this differently",
    };
    const seeded = seedQuestionDialogState(saved, twoQuestions);
    expect(seeded.declineMode).toBe(true);
    expect(seeded.declineText).toBe("let's discuss this differently");
  });

  it("defaults decline mode off + empty text when the envelope omits them", () => {
    const saved = {
      selections: [["A"], ["X"]],
      visited: [false, false],
      currentIndex: 0,
    } as QuestionDialogPreservedState;
    const seeded = seedQuestionDialogState(saved, twoQuestions);
    expect(seeded.declineMode).toBe(false);
    expect(seeded.declineText).toBe("");
  });

  it("rejects a saved envelope whose declineMode is the wrong type", () => {
    const bad = {
      selections: [["A"], ["X"]],
      visited: [false, false],
      currentIndex: 0,
      declineMode: "yes",
    };
    const seeded = seedQuestionDialogState(bad, twoQuestions);
    expect(seeded.declineMode).toBe(false);
    expect(seeded.declineText).toBe("");
    expect(seeded.selections).toEqual([["A"], ["X"]]);
  });

  it("rejects a saved envelope whose freeTexts contains non-string entries", () => {
    const bad = {
      selections: [["A"], ["X"]],
      visited: [true, false],
      currentIndex: 1,
      freeTexts: ["ok", 42],
    };
    const seeded = seedQuestionDialogState(bad, twoQuestions);
    // The whole envelope is rejected → default seed.
    expect(seeded.selections).toEqual([["A"], ["X"]]);
    expect(seeded.freeTexts).toEqual(["", ""]);
    expect(seeded.currentIndex).toBe(0);
  });

  it("falls back to defaults for a malformed payload", () => {
    // `selections` is wrong type — must reject the whole envelope, not
    // partially trust it.
    const bad = { selections: "nope", visited: [], currentIndex: 0 };
    const seeded = seedQuestionDialogState(bad, twoQuestions);
    expect(seeded.selections).toEqual([["A"], ["X"]]);
    expect(seeded.visited).toEqual([false, false]);
    expect(seeded.currentIndex).toBe(0);
  });

  it("rejects a saved envelope whose selections contain non-string entries", () => {
    const bad = {
      selections: [["A"], [42]],
      visited: [true, false],
      currentIndex: 1,
    };
    const seeded = seedQuestionDialogState(bad, twoQuestions);
    expect(seeded.selections).toEqual([["A"], ["X"]]);
    expect(seeded.visited).toEqual([false, false]);
    expect(seeded.currentIndex).toBe(0);
  });

  it("clamps an out-of-bounds currentIndex into the [0, total] review range", () => {
    const saved: QuestionDialogPreservedState = {
      selections: [["A"], []],
      visited: [false, false],
      currentIndex: 99,
    };
    const seeded = seedQuestionDialogState(saved, twoQuestions);
    // `total` = 2 questions → review state is index 2.
    expect(seeded.currentIndex).toBe(2);
  });

  it("clamps a negative currentIndex to 0", () => {
    const saved: QuestionDialogPreservedState = {
      selections: [["A"], []],
      visited: [false, false],
      currentIndex: -3,
    };
    const seeded = seedQuestionDialogState(saved, twoQuestions);
    expect(seeded.currentIndex).toBe(0);
  });

  it("realigns parallel arrays when the saved length is shorter than the question count", () => {
    const saved = {
      selections: [["B"]],
      visited: [true],
      currentIndex: 0,
    } as QuestionDialogPreservedState;
    const seeded = seedQuestionDialogState(saved, twoQuestions);
    expect(seeded.selections).toEqual([["B"], ["X"]]);
    expect(seeded.visited).toEqual([true, false]);
  });

  it("round-trips a captured tuple through the seed path (encode-then-decode identity)", () => {
    // Simulate the framework's save/restore: the capture closure
    // serializes the live state; `useSavedComponentState` hands the
    // same envelope back to `seedQuestionDialogState`. The result is
    // the input.
    const captured: QuestionDialogPreservedState = {
      selections: [["A"], ["X", "Z"]],
      visited: [true, true],
      currentIndex: 2,
      freeTexts: ["", ""],
      freeTextAtoms: [[], []],
      declineMode: false,
      declineText: "",
      declineAtoms: [],
    };
    // JSON.stringify/parse models the bag's serialization boundary —
    // the payload must survive structural-clone-equivalent storage.
    const roundTripped = JSON.parse(
      JSON.stringify(captured),
    ) as unknown;
    const seeded = seedQuestionDialogState(roundTripped, twoQuestions);
    expect(seeded).toEqual(captured);
  });

  // ── The atoms an answer holds ([B04]) ──────────────────────────────────
  //
  // A chip pasted into a free-text answer or a decline reply is a chip for as
  // long as the dialog is up. The field reports the whole `(text, atoms)`
  // substrate on every edit and the wizard keeps both halves, so the bag has
  // both to save and both to hand back — the text alone would put the answer
  // back with a bare `U+FFFC` where the chip stood and nothing to say what it
  // had been.

  const FILE_ATOM = {
    position: 4,
    type: "file",
    label: "atom-text.ts",
    value: "tugdeck/src/lib/atom-text.ts",
  };

  it("rehydrates and realigns the atoms standing in a free-text answer", () => {
    const saved: QuestionDialogPreservedState = {
      selections: [[], ["X"]],
      visited: [true, false],
      currentIndex: 0,
      freeTexts: [`see ${TUG_ATOM_CHAR}`],
      freeTextAtoms: [[FILE_ATOM]],
    };
    const seeded = seedQuestionDialogState(saved, twoQuestions);
    // Row 0 keeps its atom; row 1 (absent in the short array) takes the empty
    // default, exactly as its text does.
    expect(seeded.freeTextAtoms).toEqual([[FILE_ATOM], []]);
    expect(seeded.freeTexts).toEqual([`see ${TUG_ATOM_CHAR}`, ""]);
    // The position the atom claims is where the placeholder actually is.
    expect(seeded.freeTexts![0]!.charAt(FILE_ATOM.position)).toBe(TUG_ATOM_CHAR);
  });

  it("rehydrates the atoms standing in a decline reply, id and all", () => {
    const imageAtom = {
      position: 0,
      type: "image",
      label: "shot.png",
      value: "shot.png",
      id: "1f8c2e04-7b3a-4d51-9c60-2a8e5f7b1d33",
    };
    const saved: QuestionDialogPreservedState = {
      selections: [["A"], ["X"]],
      visited: [false, false],
      currentIndex: 0,
      declineMode: true,
      declineText: TUG_ATOM_CHAR,
      declineAtoms: [imageAtom],
    };
    const seeded = seedQuestionDialogState(saved, twoQuestions);
    // The bytes-store id is the join key to the image's payload: a restore
    // that drops it hands back a chip with nothing behind it.
    expect(seeded.declineAtoms).toEqual([imageAtom]);
  });

  it("defaults both atom fields to empty when the envelope omits them", () => {
    // The older envelope — written before an answer could hold a chip at all.
    const saved = {
      selections: [["A"], ["X"]],
      visited: [false, false],
      currentIndex: 0,
      freeTexts: ["plain prose", ""],
    } as QuestionDialogPreservedState;
    const seeded = seedQuestionDialogState(saved, twoQuestions);
    expect(seeded.freeTextAtoms).toEqual([[], []]);
    expect(seeded.declineAtoms).toEqual([]);
    expect(seeded.freeTexts).toEqual(["plain prose", ""]);
  });

  it("rejects a saved envelope whose atoms are malformed", () => {
    // Same posture as every other field read back out of JSON storage: a
    // half-trusted atom would put a chip on screen claiming an identity
    // nothing wrote.
    const bad = {
      selections: [["A"], ["X"]],
      visited: [true, false],
      currentIndex: 1,
      freeTexts: [TUG_ATOM_CHAR, ""],
      freeTextAtoms: [[{ position: "4", type: "file", label: "a", value: "a" }], []],
    };
    const seeded = seedQuestionDialogState(bad, twoQuestions);
    expect(seeded.selections).toEqual([["A"], ["X"]]);
    expect(seeded.freeTexts).toEqual(["", ""]);
    expect(seeded.freeTextAtoms).toEqual([[], []]);
  });

  it("rejects a decline-atom entry whose id is not a string", () => {
    const bad = {
      selections: [["A"], ["X"]],
      visited: [false, false],
      currentIndex: 0,
      declineText: TUG_ATOM_CHAR,
      declineAtoms: [
        { position: 0, type: "image", label: "s.png", value: "s.png", id: 7 },
      ],
    };
    const seeded = seedQuestionDialogState(bad, twoQuestions);
    expect(seeded.declineAtoms).toEqual([]);
    expect(seeded.declineText).toBe("");
  });
});
