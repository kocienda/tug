/**
 * matchers.test.ts — Pure-logic unit tests for the trace-assertion
 * matchers. Parent plan Step 10 test: "toContainOrderedSubset returns
 * true for an in-order subset, false for out-of-order or missing
 * entries."
 *
 * The matcher is pure logic, so no DOM is needed.
 */

import { describe, expect, test } from "bun:test";
import {
  summarizeEvent,
  toContainOrderedSubset,
  HARNESS_KNOWN_TRACE_KINDS,
  type DeckTraceEventShape,
} from "./matchers";

describe("toContainOrderedSubset — pass cases", () => {
  test("exact-match single-entry trace", () => {
    const result = toContainOrderedSubset(
      [{ kind: "fr-flip", trigger: "activateCard", to: "c2" }],
      [{ kind: "fr-flip", trigger: "activateCard" }],
    );
    expect(result.pass).toBe(true);
  });

  test("in-order subset with intervening entries", () => {
    const trace = [
      { kind: "fr-flip", trigger: "activateCard", to: "c2" },
      { kind: "card-host-mount", cardId: "c2", hostStackId: "s1" },
      { kind: "destination-flip", cardId: "c2", from: false, to: true },
      { kind: "focusin", el: "input#c2" },
      { kind: "focus-call", cardId: "c2", site: "a3" },
    ];
    const result = toContainOrderedSubset(trace, [
      { kind: "fr-flip", trigger: "activateCard", to: "c2" },
      { kind: "destination-flip", cardId: "c2", to: true },
      { kind: "focus-call", cardId: "c2" },
    ]);
    expect(result.pass).toBe(true);
  });

  test("partial match: unspecified keys are wildcards", () => {
    const result = toContainOrderedSubset(
      [
        {
          kind: "fr-flip",
          from: "c1",
          to: "c2",
          trigger: "activateCard",
          timestamp: 123.456,
          seq: 42,
        },
      ],
      [{ kind: "fr-flip", to: "c2" }],
    );
    expect(result.pass).toBe(true);
  });

  test("partial match: loc field on actual does not constrain expected", () => {
    // Step 0a adds `loc` to DeckTraceEvent. The matcher must continue
    // to ignore fields the expected subset does not name; otherwise
    // every existing test that asserts trace shape without `loc`
    // would suddenly fail once the deck-trace module starts stamping
    // it.
    const result = toContainOrderedSubset(
      [
        {
          kind: "fr-flip",
          to: "c2",
          trigger: "activateCard",
          timestamp: 123.456,
          seq: 42,
          loc: "deck-manager.ts:189:3",
        },
      ],
      [{ kind: "fr-flip", to: "c2" }],
    );
    expect(result.pass).toBe(true);
  });

  test("partial match: store field on actual does not constrain expected", () => {
    // Step 0c adds `store` to DeckTraceEvent. Same semantics as `loc`:
    // if the expected subset does not name `store`, the matcher must
    // ignore it on the actual entry.
    const result = toContainOrderedSubset(
      [
        {
          kind: "destination-flip",
          cardId: "c2",
          from: false,
          to: true,
          timestamp: 1,
          seq: 1,
          loc: "deck-manager.ts:234:5",
          store: { activePaneId: "p1", activeCardId: "c1", hasFocus: true },
        },
      ],
      [{ kind: "destination-flip", cardId: "c2", to: true }],
    );
    expect(result.pass).toBe(true);
  });

  test("partial match: explicit store in expected does enforce the match", () => {
    // A test can assert the store snapshot exactly the same way
    // it can assert `loc` — useful for ordering diagnoses where
    // the question is "was activeCardId already c2 when this
    // event fired, or still c1?"
    const result = toContainOrderedSubset(
      [
        {
          kind: "destination-flip",
          cardId: "c2",
          to: true,
          store: { activePaneId: "p1", activeCardId: "c1", hasFocus: true },
        },
      ],
      [
        {
          kind: "destination-flip",
          cardId: "c2",
          store: { activeCardId: "c2" },
        },
      ],
    );
    expect(result.pass).toBe(false);
  });

  test("partial match: explicit loc in expected does enforce the match", () => {
    // If a test wants to assert that a specific emission site fired
    // (e.g. `deck-manager.ts:189:3` vs `:234:5`), it can name `loc`
    // in the expected entry and the matcher enforces it like any
    // other field.
    const result = toContainOrderedSubset(
      [
        {
          kind: "fr-flip",
          to: "c2",
          loc: "deck-manager.ts:234:5",
        },
      ],
      [{ kind: "fr-flip", to: "c2", loc: "deck-manager.ts:189:3" }],
    );
    expect(result.pass).toBe(false);
  });

  test("empty expected subset trivially matches any trace", () => {
    const result = toContainOrderedSubset(
      [{ kind: "fr-flip", trigger: "x" }],
      [],
    );
    expect(result.pass).toBe(true);
  });

  test("nested object partial-match recurses", () => {
    // Synthetic event with a nested object — exercises the matcher's
    // recursive partial-match on object-typed fields. The kind is
    // arbitrary; matchers accept Record<string, unknown> so any
    // shape works for testing structural recursion.
    const result = toContainOrderedSubset(
      [
        {
          kind: "synthetic-nested",
          cardId: "c1",
          payload: { kind: "selector", selector: "[data-x=y]", cardId: "c1" },
        },
      ],
      [{ kind: "synthetic-nested", payload: { kind: "selector" } }],
    );
    expect(result.pass).toBe(true);
  });

  test("array values deep-equal", () => {
    const result = toContainOrderedSubset(
      [{ kind: "selection-restore", anchorPath: [0, 1, 2] }],
      [{ kind: "selection-restore", anchorPath: [0, 1, 2] }],
    );
    expect(result.pass).toBe(true);
  });
});

describe("toContainOrderedSubset — fail cases", () => {
  test("missing entry returns false with informative message", () => {
    const result = toContainOrderedSubset(
      [{ kind: "fr-flip", trigger: "activateCard" }],
      [
        { kind: "fr-flip", trigger: "activateCard" },
        { kind: "focus-call", cardId: "c2" },
      ],
    );
    expect(result.pass).toBe(false);
    const msg = result.message();
    expect(msg).toContain("entry #1");
    expect(msg).toContain("focus-call");
  });

  test("out-of-order sequence returns false", () => {
    const trace = [
      { kind: "focus-call", cardId: "c2" },
      { kind: "fr-flip", trigger: "activateCard", to: "c2" },
    ];
    const result = toContainOrderedSubset(trace, [
      { kind: "fr-flip", trigger: "activateCard" },
      { kind: "focus-call", cardId: "c2" },
    ]);
    expect(result.pass).toBe(false);
  });

  test("out-of-order match emits Order violation annotation citing both indices", () => {
    // AT0001-shaped scenario: the trace contains destination-flip BEFORE
    // fr-flip, but the test expects fr-flip → destination-flip. The
    // annotation should call this out explicitly so the reader
    // doesn't have to eyeball the JSON to reach the same conclusion.
    const trace = [
      { kind: "destination-flip", cardId: "B", from: false, to: true }, // idx 0
      { kind: "card-host-mount", cardId: "B", hostStackId: "s1" },       // idx 1
      { kind: "fr-flip", from: "A", to: "B", trigger: "activateCard" },  // idx 2
      { kind: "focus-call", cardId: "B", site: "a3" },                   // idx 3
    ];
    const result = toContainOrderedSubset(trace, [
      { kind: "fr-flip", to: "B" },
      { kind: "destination-flip", cardId: "B", to: true },
      { kind: "focus-call", cardId: "B" },
    ]);
    expect(result.pass).toBe(false);
    const msg = result.message();
    // Annotation banner present
    expect(msg).toContain("Order violation");
    // Cites the earlier-index for the failing expected entry (destination-flip at 0)
    expect(msg).toContain("actual[0]");
    // Cites the prior match's index (fr-flip at 2)
    expect(msg).toContain("actual[2]");
    // Cites the expected entry labels (terse summary)
    expect(msg).toContain("destination-flip");
    expect(msg).toContain("fr-flip");
    // The annotation appears BEFORE the existing JSON dump
    expect(msg.indexOf("Order violation")).toBeLessThan(msg.indexOf("full trace:"));
  });

  test("genuinely-absent entry omits Order violation annotation", () => {
    // When the failed entry does not exist anywhere in the trace,
    // the existing diagnostic should be unchanged — no spurious
    // "Order violation" banner.
    const trace = [
      { kind: "fr-flip", to: "B" },
      { kind: "focus-call", cardId: "B" },
    ];
    const result = toContainOrderedSubset(trace, [
      { kind: "fr-flip", to: "B" },
      { kind: "save-callback", cardId: "A", source: "manual" },
    ]);
    expect(result.pass).toBe(false);
    const msg = result.message();
    expect(msg).not.toContain("Order violation");
    // The existing message format is preserved.
    expect(msg).toContain("entry #1");
    expect(msg).toContain("save-callback");
  });

  test("multiple earlier matches list all indices", () => {
    // If the failed entry appears multiple times in the earlier
    // section, the annotation should list all of them so the reader
    // can see where the duplicate emissions live.
    const trace = [
      { kind: "save-callback", cardId: "A", source: "debounced" }, // idx 0
      { kind: "save-callback", cardId: "A", source: "manual" },    // idx 1
      { kind: "fr-flip", to: "B" },                                // idx 2
    ];
    const result = toContainOrderedSubset(trace, [
      { kind: "fr-flip", to: "B" },
      { kind: "save-callback", cardId: "A" },
    ]);
    expect(result.pass).toBe(false);
    const msg = result.message();
    expect(msg).toContain("Order violation");
    expect(msg).toContain("actual[0, 1]");
  });

  test("value mismatch returns false", () => {
    const result = toContainOrderedSubset(
      [{ kind: "fr-flip", trigger: "activateCard", to: "c2" }],
      [{ kind: "fr-flip", trigger: "activateCard", to: "c3" }],
    );
    expect(result.pass).toBe(false);
  });

  test("nested object key mismatch returns false", () => {
    // Synthetic event — exercises the matcher's nested-object
    // mismatch path. See "nested object partial-match recurses" for
    // the kind-agnostic pattern.
    const result = toContainOrderedSubset(
      [{ kind: "synthetic-nested", payload: { kind: "selector", selector: "x" } }],
      [{ kind: "synthetic-nested", payload: { kind: "focus-key" } }],
    );
    expect(result.pass).toBe(false);
  });

  test("array element mismatch returns false", () => {
    const result = toContainOrderedSubset(
      [{ kind: "selection-restore", anchorPath: [0, 1, 2] }],
      [{ kind: "selection-restore", anchorPath: [0, 1, 3] }],
    );
    expect(result.pass).toBe(false);
  });

  test("actual is not an array returns false", () => {
    const result = toContainOrderedSubset(
      null,
      [{ kind: "fr-flip" }],
    );
    expect(result.pass).toBe(false);
    expect(result.message()).toContain("array of trace entries");
  });

  test("reuses actual entries across expected positions only monotonically", () => {
    // If the same entry appears twice in `expected`, we must find it
    // at two distinct indices in `actual` (strictly increasing).
    // Trace below has exactly one `fr-flip`, so asking for two must fail.
    const trace = [{ kind: "fr-flip", trigger: "x" }];
    const result = toContainOrderedSubset(trace, [
      { kind: "fr-flip" },
      { kind: "fr-flip" },
    ]);
    expect(result.pass).toBe(false);
  });

  test("explicit undefined requires actual undefined (not missing)", () => {
    // An explicit undefined in expected is NOT a wildcard — that way
    // tests can assert absence of a field by setting it to null.
    // Missing keys in expected are the wildcard form.
    const result = toContainOrderedSubset(
      [{ kind: "fr-flip", from: "c1", to: null }],
      [{ kind: "fr-flip", from: undefined }],
    );
    expect(result.pass).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Step 0e: summarizeEvent + summary-table placement
// ---------------------------------------------------------------------------

/**
 * Hand-built fixtures covering every branch of
 * {@link DeckTraceEventShape}. Keeping these inline (rather than
 * generating them) documents the label grammar by example and makes
 * the exhaustiveness test read as a checklist: every kind in
 * {@link HARNESS_KNOWN_TRACE_KINDS} must appear below.
 */
const EVENT_FIXTURES: Record<
  (typeof HARNESS_KNOWN_TRACE_KINDS)[number],
  DeckTraceEventShape
> = {
  "fr-flip": {
    kind: "fr-flip",
    from: "c1",
    to: "c2",
    trigger: "activateCard",
  },
  "destination-flip": {
    kind: "destination-flip",
    cardId: "c2",
    from: false,
    to: true,
  },
  "card-host-mount": {
    kind: "card-host-mount",
    cardId: "c2",
    hostStackId: "s1",
  },
  "card-host-unmount": {
    kind: "card-host-unmount",
    cardId: "c2",
    hostStackId: "s1",
  },
  "focus-call": {
    kind: "focus-call",
    site: "focus-transfer",
    cardId: "c2",
    targetSelector: "[data-tug-focus-key=\"primary\"]",
    activeBefore: "body",
    activeAfter: "input#c2",
    hidden: false,
  },
  focusin: {
    kind: "focusin",
    el: "input#c2",
    relatedTarget: "input#c1",
  },
  focusout: {
    kind: "focusout",
    el: "input#c1",
    relatedTarget: "input#c2",
  },
  "save-callback": {
    kind: "save-callback",
    cardId: "c1",
    source: "debounced",
  },
  "selection-restore": {
    kind: "selection-restore",
    cardId: "c2",
    via: "applyFocusSnapshot",
  },
  "commit-tick": {
    kind: "commit-tick",
    count: 3,
  },
  "engine-ready": {
    kind: "engine-ready",
    cardId: "c2",
    engine: "tug-prompt-input",
  },
  "engine-activation-dispatched": {
    kind: "engine-activation-dispatched",
    cardId: "c2",
    engine: "tug-prompt-input",
    dispatchedFrom: "row-1",
  },
  "cold-boot-restore-snapshot": {
    kind: "cold-boot-restore-snapshot",
    cardId: "c2",
    hasContent: true,
    engineSelection: { start: 3, end: 7 },
  },
  "engine-restore-applied": {
    kind: "engine-restore-applied",
    cardId: "c2",
    engine: "gallery-prompt-entry",
    selectionApplied: { start: 3, end: 7 },
    domSelectionAfter: { start: 3, end: 7 },
  },
  "focus-measurement": {
    kind: "focus-measurement",
    phase: "post-sync",
    site: "focus-transfer:framework",
    cardId: "c2",
    activeElement: "input#c2",
  },
  "engine-paint-mirror-active": {
    kind: "engine-paint-mirror-active",
    cardId: "c2",
    caller: "via-engine-hook",
  },
  "engine-paint-mirror-inactive": {
    kind: "engine-paint-mirror-inactive",
    cardId: "c1",
  },
  "macrotask-focus-claim": {
    kind: "macrotask-focus-claim",
    cardId: "c2",
    delegate: "cardDidActivate",
  },
  "caret-responder-divergence": {
    kind: "caret-responder-divergence",
    editorResponderId: "card-1-entry-editor",
    firstResponderId: "card-1-content",
  },
  "follow-bottom": {
    kind: "follow-bottom",
    following: true,
    source: "submit",
  },
  "scroll-displacement": {
    kind: "scroll-displacement",
    from: 19199,
    to: 16831,
    scrollHeight: 19619,
    clientHeight: 420,
    following: true,
    evicting: true,
  },
  "kbf-caret-divergence": {
    kind: "kbf-caret-divergence",
    editorResponderId: "composer-A",
  },
  "return-promise-collision": {
    kind: "return-promise-collision",
    count: 2,
    wearers: "session-history-done | tug-prompt-entry-submit-button",
  },
  "extent-rebase": {
    kind: "extent-rebase",
    from: 19618,
    to: 18990,
    scrollTop: 18571,
    clientHeight: 420,
    clamped: true,
    following: true,
  },
  "store-notify": {
    kind: "store-notify",
    caller: "_commitImposition",
    version: 42,
  },
  "settle-arm": {
    kind: "settle-arm",
    signature: "flow|0:p1|1:p2",
    panes: 2,
    armed: true,
  },
  "settle-retarget": {
    kind: "settle-retarget",
    paneId: "p1",
    mode: "snap",
  },
  "session-lifecycle": {
    kind: "session-lifecycle",
    event: "perf.replay_ingest",
    fields: { frames: 3396, dispatchMs: 11 },
  },
};

describe("summarizeEvent — exhaustive per-kind coverage", () => {
  test("every kind in HARNESS_KNOWN_TRACE_KINDS has a fixture", () => {
    // Defensive: the drift test in tugdeck pins the mirror to the
    // real DeckTraceEvent union at compile time; this runtime pin
    // guards against someone shipping a branch in summarizeEvent
    // without adding a fixture here.
    for (const kind of HARNESS_KNOWN_TRACE_KINDS) {
      expect(EVENT_FIXTURES[kind]?.kind).toBe(kind);
    }
  });

  test("returns a non-empty string for every kind", () => {
    for (const kind of HARNESS_KNOWN_TRACE_KINDS) {
      const label = summarizeEvent(EVENT_FIXTURES[kind]);
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
      // The kind itself must appear in the label so scanners can
      // filter by kind without knowing the per-variant grammar.
      expect(label).toContain(kind);
    }
  });
});

describe("summarizeEvent — label grammar per kind", () => {
  test("fr-flip renders arrow + trigger", () => {
    expect(summarizeEvent(EVENT_FIXTURES["fr-flip"])).toBe(
      "fr-flip c1→c2 trigger=activateCard",
    );
  });

  test("fr-flip null endpoints render as ∅", () => {
    expect(
      summarizeEvent({
        kind: "fr-flip",
        from: null,
        to: "c2",
        trigger: "_removeCard",
      }),
    ).toBe("fr-flip ∅→c2 trigger=_removeCard");
  });

  test("destination-flip compacts cardId and boolean pair", () => {
    expect(summarizeEvent(EVENT_FIXTURES["destination-flip"])).toBe(
      "destination-flip c2:false→true",
    );
  });

  test("focus-call renders cardId, site, selector, and active arrow", () => {
    expect(summarizeEvent(EVENT_FIXTURES["focus-call"])).toBe(
      "focus-call c2 site=focus-transfer target=[data-tug-focus-key=\"primary\"] active=body→input#c2",
    );
  });

  test("focus-call marks hidden=true when the target was not visible", () => {
    expect(
      summarizeEvent({
        kind: "focus-call",
        site: "a3-snapshot",
        cardId: "c2",
        targetSelector: "[data-tug-state-key]",
        activeBefore: "body",
        activeAfter: "body",
        hidden: true,
      }),
    ).toContain("hidden=true");
  });

  test("focusin omits relatedTarget when null", () => {
    expect(
      summarizeEvent({
        kind: "focusin",
        el: "input#c2",
        relatedTarget: null,
      }),
    ).toBe("focusin el=input#c2");
  });

  test("save-callback uses src= (not source=) shorthand", () => {
    expect(summarizeEvent(EVENT_FIXTURES["save-callback"])).toBe(
      "save-callback c1 src=debounced",
    );
  });
});

describe("toContainOrderedSubset — one-line summary above JSON dump", () => {
  test("failure message places summary between preamble and full trace JSON", () => {
    // Sequence: destination-flip → fr-flip, but the matcher looks for
    // fr-flip → destination-flip → focus-call. That order-violates
    // at expected #1; we expect the annotation + summary to sit
    // above the final `full trace:` JSON block.
    const trace = [
      { kind: "destination-flip", cardId: "B", from: false, to: true },
      { kind: "fr-flip", from: "A", to: "B", trigger: "activateCard" },
      { kind: "focusin", el: "input#B", relatedTarget: null },
    ];
    const result = toContainOrderedSubset(trace, [
      { kind: "fr-flip", to: "B" },
      { kind: "destination-flip", cardId: "B", to: true },
      { kind: "focus-call", cardId: "B" },
    ]);
    expect(result.pass).toBe(false);
    const msg = result.message();
    const summaryPos = msg.indexOf("actual trace summary");
    const jsonPos = msg.indexOf("full trace:");
    expect(summaryPos).toBeGreaterThanOrEqual(0);
    expect(jsonPos).toBeGreaterThanOrEqual(0);
    expect(summaryPos).toBeLessThan(jsonPos);
  });

  test("summary lists every actual entry with indexed prefix", () => {
    const trace = [
      { kind: "fr-flip", from: "A", to: "B", trigger: "activateCard" },
      { kind: "destination-flip", cardId: "B", from: false, to: true },
      // expected #2 below (focus-call) is absent — genuine miss
    ];
    const result = toContainOrderedSubset(trace, [
      { kind: "fr-flip", to: "B" },
      { kind: "destination-flip", cardId: "B", to: true },
      { kind: "focus-call", cardId: "B" },
    ]);
    expect(result.pass).toBe(false);
    const msg = result.message();
    expect(msg).toContain("[0] fr-flip A→B trigger=activateCard");
    expect(msg).toContain("[1] destination-flip B:false→true");
    expect(msg).toContain("matched #0");
    expect(msg).toContain("matched #1");
    // Summary footer spells out the missing-entry index + summary.
    expect(msg).toContain("expected #2");
    expect(msg).toContain("focus-call");
  });

  test("summary marks the cursor position when it sits inside the trace", () => {
    // Two matches, then cursor lands at index 2 and scans the
    // remainder without a match. The cursor marker should appear on
    // the row at index 2.
    const trace = [
      { kind: "fr-flip", from: "A", to: "B", trigger: "activateCard" },
      { kind: "destination-flip", cardId: "B", from: false, to: true },
      { kind: "focusin", el: "input#B", relatedTarget: null },
      { kind: "save-callback", cardId: "A", source: "debounced" },
    ];
    const result = toContainOrderedSubset(trace, [
      { kind: "fr-flip", to: "B" },
      { kind: "destination-flip", cardId: "B", to: true },
      { kind: "focus-call", cardId: "B" },
    ]);
    expect(result.pass).toBe(false);
    const msg = result.message();
    expect(msg).toContain("cursor stopped here");
    // Cursor is at index 2, so the marker should appear on that row.
    const focusinLine = msg.split("\n").find((l) => l.includes("[2]"));
    expect(focusinLine).toBeDefined();
    expect(focusinLine!).toContain("cursor stopped here");
  });

  test("summary annotates pre-cursor wrong-order match", () => {
    // Mirror of the AT0001-shaped scenario: destination-flip sits at
    // index 0 but the test wants fr-flip first. After fr-flip at
    // index 2 matches expected #0, the matcher scans [3..) for
    // expected #1 and fails. The summary should mark index 0 as a
    // "wrong order" would-have-matched for expected #1.
    const trace = [
      { kind: "destination-flip", cardId: "B", from: false, to: true }, // 0
      { kind: "card-host-mount", cardId: "B", hostStackId: "s1" },       // 1
      { kind: "fr-flip", from: "A", to: "B", trigger: "activateCard" },  // 2
      { kind: "focus-call",
        site: "a3",
        cardId: "B",
        targetSelector: "[x]",
        activeBefore: "",
        activeAfter: "",
        hidden: false },                                                 // 3
    ];
    const result = toContainOrderedSubset(trace, [
      { kind: "fr-flip", to: "B" },
      { kind: "destination-flip", cardId: "B", to: true },
      { kind: "focus-call", cardId: "B" },
    ]);
    expect(result.pass).toBe(false);
    const msg = result.message();
    // Order-violation annotation from Step 0b still anchors the header.
    expect(msg).toContain("Order violation");
    // The annotation line ALSO contains "actual[0]", so match the
    // summary row's distinctive leading `  [0] ` prefix, not just
    // the bare "[0]" substring.
    const summaryRowZero = msg
      .split("\n")
      .find((l) => /^\s+\[\s*0\s*\]\s/.test(l));
    expect(summaryRowZero).toBeDefined();
    expect(summaryRowZero!).toContain("wrong order");
    expect(summaryRowZero!).toContain("expected #1");
  });

  test("empty actual trace yields a short summary note (no rows)", () => {
    const result = toContainOrderedSubset([], [{ kind: "fr-flip" }]);
    expect(result.pass).toBe(false);
    const msg = result.message();
    expect(msg).toContain("trace is empty");
  });
});
