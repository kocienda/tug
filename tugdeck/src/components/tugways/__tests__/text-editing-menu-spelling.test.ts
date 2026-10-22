/**
 * The text-editing context menu's spelling block, and the word helpers it
 * rests on.
 *
 * A misspelled word's guesses lead the menu above their own separator, as in
 * every native text view; a misspelled word with no guesses shows one dim
 * "No Guesses Found"; Ignore Spelling and Learn Spelling follow in their own
 * group; a correctly spelled word shows no block at all. A
 * chosen guess replaces only the word the menu was opened over, keeping any
 * whitespace a word-select reached into.
 *
 * @covers tugdeck/src/components/tugways/text-editing-menu.ts
 * @covers tugdeck/src/lib/spelling-guesses.ts
 */

import { describe, expect, test } from "bun:test";

import { TUG_ACTIONS } from "../action-vocabulary";
import { EMPTY_MENU_FACTS } from "../command-registry";
import type { CommandValidationSource } from "../command-registry";
import { buildTextEditingMenuItems } from "../text-editing-menu";
import {
  correctedText,
  isSpellingCorrection,
  spellableWord,
} from "@/lib/spelling-guesses";

/** A source with no responders: every command reads as having no answer. */
const quiet: CommandValidationSource = {
  validateAction: () => true,
  validateActionInKeyCard: () => true,
  queryActionState: () => undefined,
  queryActionStateInKeyCard: () => undefined,
  menu: EMPTY_MENU_FACTS,
};

describe("spelling block", () => {
  test("guesses lead the menu, each carrying its correction, then a separator", () => {
    const items = buildTextEditingMenuItems({
      hasSelection: true,
      source: quiet,
      spelling: { word: "frsutrated", guesses: ["frustrated", "frustrate"] },
    });
    expect(items[0]).toMatchObject({
      action: TUG_ACTIONS.CORRECT_SPELLING,
      label: "frustrated",
      value: { word: "frsutrated", replacement: "frustrated" },
      disabled: false,
    });
    expect(items[1]).toMatchObject({ label: "frustrate" });
    expect(items[2]).toEqual({ type: "separator" });
    expect(items[3]).toMatchObject({
      action: TUG_ACTIONS.IGNORE_SPELLING,
      label: "Ignore Spelling",
      value: "frsutrated",
    });
    expect(items[4]).toMatchObject({
      action: TUG_ACTIONS.LEARN_SPELLING,
      label: "Learn Spelling",
      value: "frsutrated",
    });
    expect(items[5]).toEqual({ type: "separator" });
    expect(items[6]?.action).toBe(TUG_ACTIONS.LOOK_UP_IN_DICTIONARY);
  });

  test("a misspelled word with no guesses says so, dim", () => {
    const items = buildTextEditingMenuItems({
      hasSelection: true,
      source: quiet,
      spelling: { word: "qzxv", guesses: [] },
    });
    expect(items[0]).toMatchObject({ label: "No Guesses Found", disabled: true });
    expect(items[0]?.value).toBeUndefined();
    expect(items[1]).toEqual({ type: "separator" });
    expect(items[2]?.action).toBe(TUG_ACTIONS.IGNORE_SPELLING);
    expect(items[3]?.action).toBe(TUG_ACTIONS.LEARN_SPELLING);
  });

  test("no spelling sample, no block", () => {
    const items = buildTextEditingMenuItems({ hasSelection: true, source: quiet });
    const spellingActions: readonly string[] = [
      TUG_ACTIONS.CORRECT_SPELLING,
      TUG_ACTIONS.IGNORE_SPELLING,
      TUG_ACTIONS.LEARN_SPELLING,
    ];
    expect(items.some((e) => spellingActions.includes(e.action ?? ""))).toBe(false);
    expect(items[0]?.action).toBe(TUG_ACTIONS.LOOK_UP_IN_DICTIONARY);
  });
});

describe("spellableWord", () => {
  test("one word, its whitespace set aside", () => {
    expect(spellableWord(" frsutrated ")).toBe("frsutrated");
    expect(spellableWord("don't")).toBe("don't");
  });

  test("not a word: blank, several, no letters, too long", () => {
    expect(spellableWord("   ")).toBeNull();
    expect(spellableWord("two words")).toBeNull();
    expect(spellableWord("1234")).toBeNull();
    expect(spellableWord("a".repeat(65))).toBeNull();
  });
});

describe("correctedText", () => {
  test("replaces the word and keeps the whitespace around it", () => {
    expect(correctedText("frsutrated ", { word: "frsutrated", replacement: "frustrated" })).toBe(
      "frustrated ",
    );
    expect(correctedText(" teh", { word: "teh", replacement: "the" })).toBe(" the");
  });

  test("a selection that moved off the word is left alone", () => {
    expect(correctedText("other", { word: "teh", replacement: "the" })).toBeNull();
  });

  test("isSpellingCorrection checks the shape", () => {
    expect(isSpellingCorrection({ word: "teh", replacement: "the" })).toBe(true);
    expect(isSpellingCorrection({ word: "teh" })).toBe(false);
    expect(isSpellingCorrection("the")).toBe(false);
  });
});
