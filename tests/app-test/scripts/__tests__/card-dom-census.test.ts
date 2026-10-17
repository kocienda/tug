/**
 * The card-DOM census over source strings: a shell-evaluated call that holds
 * a card selector is an entry naming its card and that card's kind; the same
 * call on the card's body is not, nor is a read of the shell's deck that
 * names no card, nor one marked as reading the shell on purpose. Selectors
 * held in a file's constants and in what it imports count.
 */
import { describe, expect, test } from "bun:test";

import { censusOfSource, importedBindings, maskComments, pairsOf, stalePairs, unallowed, type CensusVocabulary } from "../card-dom";

const VOCAB: CensusVocabulary = {
  kindRoots: [{ componentId: "overview", root: ".overview-card" }],
  extraSelectors: [],
  coversKinds: [["components/jots/", "jots"]],
};

const census = (src: string, imported = new Map<string, string>()) => censusOfSource("at9999.test.ts", src, VOCAB, { imported });

const SEED = `await app.seedDeckState({ state: { cards: [{ id: "a", componentId: "session", title: "" }] } });\n`;

describe("an entry", () => {
  test("is a shell-evaluated call whose text holds cardHost(\"a\"), with its card and kind", () => {
    const entries = census(`${SEED}await app.evalJS(\`document.querySelector(\${JSON.stringify(cardHost("a"))}) !== null\`);\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ method: "evalJS", receiver: "app", cardId: "a", kind: "session", line: 2 });
  });

  test("is not the same call on app.body(\"a\")", () => {
    expect(census(`${SEED}await app.body("a").evalJS(\`document.querySelector(\${JSON.stringify(cardHost("a"))}) !== null\`);\n`)).toEqual([]);
  });

  test("is not a call on a name bound to a body", () => {
    expect(census(`${SEED}const page = app.body("a");\nawait page.waitForCondition(\`document.querySelector('.cm-content') !== null\`);\n`)).toEqual([]);
  });

  test("is not a call on a name bound to a kind's body, or on an arrow that finds one", () => {
    expect(census(`${SEED}const jots = kindBody(app, "jots");\nawait jots.evalJS(\`document.querySelector(\${JSON.stringify(cardHost("a"))}) !== null\`);\n`)).toEqual([]);
    expect(census(`${SEED}const jots = (app: App) => kindBody(app, "jots");\nawait jots(app).evalJS(\`document.querySelector(\${JSON.stringify(cardHost("a"))}) !== null\`);\n`)).toEqual([]);
  });

  test("is a call on an arrow that finds no body", () => {
    expect(census(`${SEED}const page = (app: App) => app;\nawait page(app).evalJS(\`document.querySelector(\${JSON.stringify(cardHost("a"))}) !== null\`);\n`)).toHaveLength(1);
  });

  test("is not a window.__tug read with no card selector", () => {
    expect(census(`${SEED}await app.evalJS(\`window.__tug.getActiveCardId()\`);\n`)).toEqual([]);
  });

  test("is not a call marked as reading the shell on purpose", () => {
    expect(census(`${SEED}// card-dom: shell\nawait app.evalJS(\`document.querySelector('.cm-content') === null\`);\n`)).toEqual([]);
  });

  test("counts a selector held in a file constant, and resolves a card id held in one", () => {
    const entries = census(`${SEED}const CARD = "a";\nconst COMPOSER = \`[data-card-id="\${CARD}"] .cm-content\`;\nawait app.waitForCondition(present(COMPOSER));\n`);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ cardId: "a", kind: "session", cardIdSource: "CARD" });
  });

  test("counts a selector an imported constant holds, and the kind an imported deck shape seeds", () => {
    const imported = importedBindings(`import { PROMPT, oneSession } from "./shapes";\n`, () =>
      `export const PROMPT = '[data-slot="tug-prompt-entry"]';\nexport function oneSession(options: { title?: string } = {}) {\n  return { cards: [{ id: "b", componentId: "session" }] };\n}\n`,
    );
    const entries = census(`await app.seedDeckState({ state: oneSession() });\nawait app.evalJS(\`document.querySelector(\${JSON.stringify(PROMPT)})\`);\n`, imported);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("session");
  });

  test("takes a kind's root selector as that kind, and a file's @covers when nothing else says", () => {
    expect(census(`await app.evalJS(\`document.querySelector(".overview-card")\`);\n`)[0].kind).toBe("overview");
    const covered = census(`/**\n * @covers tugdeck/src/components/jots/jots-card.tsx\n */\nawait app.evalJS(\`document.querySelector('[data-card-host]')\`);\n`);
    expect(covered[0].kind).toBe("jots");
  });

  test("ignores calls inside comments", () => {
    expect(census(`${SEED}// await app.evalJS(cardHost("a"));\n/* app.evalJS(cardHost("a")) */\n`)).toEqual([]);
    expect(maskComments(`a // b\nc`)).toBe(`a     \nc`);
  });
});

describe("the allow-list", () => {
  const entries = census(`${SEED}await app.evalJS(cardHost("a"));\n`);

  test("allows an entry by its file and kind, and no other", () => {
    expect(unallowed(entries, [{ file: "at9999.test.ts", kind: "session" }])).toEqual([]);
    expect(unallowed(entries, [{ file: "at9999.test.ts", kind: "overview" }])).toHaveLength(1);
  });

  test("names the pairs no entry needs any more, and seeds from the entries", () => {
    expect(stalePairs(entries, [{ file: "gone.test.ts", kind: "session" }])).toEqual([{ file: "gone.test.ts", kind: "session" }]);
    expect(pairsOf(entries)).toEqual([{ file: "at9999.test.ts", kind: "session" }]);
  });
});
