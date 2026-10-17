import { describe, expect, test } from "bun:test";

import { cardIdsNamed, shellTimeoutCause } from "./timeout-cause";

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
