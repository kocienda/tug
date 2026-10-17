import { describe, expect, test } from "bun:test";

import { bodyEvidenceCause, cardIdsNamed, selectorsQueried, shellTimeoutCause } from "./timeout-cause";

describe("cardIdsNamed", () => {
  test("reads each scoped card once, in either quote, escaped or not", () => {
    expect(cardIdsNamed(`document.querySelector('[data-card-id="A"] .cm-content')`)).toEqual(["A"]);
    expect(cardIdsNamed(`document.querySelector("[data-card-id=\\"B\\"] x") && q('[data-card-id="B"] y')`)).toEqual(["B"]);
    expect(cardIdsNamed(`q("[data-card-id='C1'] z")`)).toEqual(["C1"]);
    expect(cardIdsNamed(`document.body.textContent`)).toEqual([]);
  });
});

describe("shellTimeoutCause", () => {
  test("names a scoped card the host holds as a body", () => {
    const cause = shellTimeoutCause(`q('[data-card-id="A"] .cm-content') !== null`, ["A", "B"]);
    expect(cause).toContain('card "A" is a body');
    expect(cause).toContain('app.body("A")');
  });

  test("says nothing when the named card is not a body", () => {
    expect(shellTimeoutCause(`q('[data-card-id="A"] x')`, ["B"])).toBeNull();
  });

  test("a placeholder read is the shell's on purpose", () => {
    expect(shellTimeoutCause(`q('[data-body-placeholder][data-card-id="A"][data-body-shown]')`, ["A"])).toBeNull();
  });

  test("names every body among several", () => {
    expect(shellTimeoutCause(`q('[data-card-id="A"] x') && q('[data-card-id="B"] y')`, ["A", "B"])).toContain(
      'card "A", "B" are bodies',
    );
  });
});

describe("selectorsQueried", () => {
  test("reads literal selectors in either quote, escaped or not, once each", () => {
    const script = `document.querySelector("[data-slot=\\"tug-sheet\\"]") !== null && document.querySelectorAll('.session-card-picker-form').length > 0 && document.querySelector("[data-slot=\\"tug-sheet\\"]")`;
    expect(selectorsQueried(script)).toEqual(['[data-slot="tug-sheet"]', ".session-card-picker-form"]);
  });

  test("a selector built at run time is not read", () => {
    expect(selectorsQueried(`document.querySelector(card + " .x")`)).toEqual([]);
  });
});

describe("bodyEvidenceCause", () => {
  test("a condition that holds in a body names that body", () => {
    const cause = bodyEvidenceCause([], [{ cardId: "A", holds: true, matches: [] }]);
    expect(cause).toContain(`card "A"'s body`);
    expect(cause).toContain('app.body("A")');
  });

  test("a selector matching only in a body names it and the body", () => {
    const cause = bodyEvidenceCause([], [
      { cardId: "A", holds: false, matches: [] },
      { cardId: "B", holds: false, matches: ['[data-slot="tug-sheet"]'] },
    ]);
    expect(cause).toContain('"[data-slot=\\"tug-sheet\\"]" matches only in card "B"');
  });

  test("a selector the shell matches too is no evidence, and no answer is none", () => {
    expect(bodyEvidenceCause([".tug-pane"], [{ cardId: "A", holds: false, matches: [".tug-pane"] }])).toBeNull();
    expect(bodyEvidenceCause([], [])).toBeNull();
  });
});
