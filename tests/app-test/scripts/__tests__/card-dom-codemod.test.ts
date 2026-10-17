/**
 * The codemod's provable shape: a call naming one card by a literal (or a
 * `const` bound to one), reading nothing of the shell's deck, on a plain
 * receiver, moves onto `app.body(<id>)`; anything else is reported `manual`
 * and left exactly as it was.
 */
import { describe, expect, test } from "bun:test";

import { censusOfSource, rewriteSource, type CensusVocabulary } from "../card-dom";

const VOCAB: CensusVocabulary = { kindRoots: [], extraSelectors: [], coversKinds: [] };

function codemod(src: string) {
  return rewriteSource(src, censusOfSource("at9999.test.ts", src, VOCAB));
}

describe("the codemod", () => {
  test("rewrites the provable shape onto the card's body", () => {
    const src = `await app.waitForCondition<boolean>(\`document.querySelector(\${JSON.stringify(cardHost("a"))}) !== null\`, { timeoutMs: 5000 });\n`;
    const result = codemod(src);
    expect(result.manual).toEqual([]);
    expect(result.source).toBe(
      `await app.body("a").waitForCondition<boolean>(\`document.querySelector(\${JSON.stringify(cardHost("a"))}) !== null\`, { timeoutMs: 5000 });\n`,
    );
  });

  test("writes a const-bound id by its name", () => {
    const result = codemod(`const CARD = "a";\nawait app.evalJS(cardHost(CARD));\n`);
    expect(result.source).toBe(`const CARD = "a";\nawait app.body(CARD).evalJS(cardHost(CARD));\n`);
  });

  test("reports a mixed shell/body expression manual and leaves it unchanged", () => {
    const src = `await app.evalJS(\`window.__tug.getActiveCardId() === "a" && document.querySelector(\${JSON.stringify(cardHost("a"))}) !== null\`);\n`;
    const result = codemod(src);
    expect(result.rewritten).toEqual([]);
    expect(result.manual.map((m) => m.reason)).toEqual(["reads the shell's deck"]);
    expect(result.source).toBe(src);
  });

  test("moves a reach that names no card onto the named body handle, and leaves a shell read", () => {
    const src = `await app.evalJS(\`document.querySelector('.cm-content') !== null\`);\nawait app.evalJS(\`window.__tug.getActiveCardId() === document.querySelector('.cm-content')\`);\n`;
    const result = rewriteSource(src, censusOfSource("at9999.test.ts", src, VOCAB), "ov");
    expect(result.source).toBe(`await ov.evalJS(\`document.querySelector('.cm-content') !== null\`);\nawait app.evalJS(\`window.__tug.getActiveCardId() === document.querySelector('.cm-content')\`);\n`);
    expect(result.manual.map((m) => m.reason)).toEqual(["reads the shell's deck"]);
  });

  test("reports a call naming two cards, or a card it cannot resolve, manual", () => {
    expect(codemod(`await app.evalJS(cardHost("a") + cardHost("b"));\n`).manual[0].reason).toBe("no single card");
    expect(codemod(`await app.evalJS(cardHost(some.id));\n`).manual[0].reason).toBe("card id not a literal");
  });

  test("a card named through one plain variable in scope takes that variable as its body handle", () => {
    expect(codemod(`await app.evalJS(cardHost(someId));\n`).source).toBe(`await app.body(someId).evalJS(cardHost(someId));\n`);
  });

  test("a reach naming no card, in a file seeding one card of its kind, lands on that card", () => {
    const vocab: CensusVocabulary = { kindRoots: [{ componentId: "jots", root: ".jots-list" }], extraSelectors: [], coversKinds: [] };
    const src = `const J = "j1";\nawait app.seedDeckState({ state: { cards: [{ id: J, componentId: "jots" }] } });\nawait app.evalJS(\`document.querySelector(".jots-list")\`);\n`;
    const result = rewriteSource(src, censusOfSource("at9999.test.ts", src, vocab));
    expect(result.manual).toEqual([]);
    expect(result.source).toContain(`await app.body(J).evalJS(`);
  });
});
