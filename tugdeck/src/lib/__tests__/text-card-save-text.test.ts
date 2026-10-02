/**
 * text-card-save-text.test.ts — the Text card's save-state wording.
 *
 * Seven wordings across two save contracts, and one displacement rule: an
 * unresolved conflict in manual mode — or on a folded card in either mode —
 * outranks everything else the buffer could say about itself.
 */

import { describe, test, expect } from "bun:test";

import { saveText, type SaveTextFacts } from "@/lib/text-card-save-text";

/** A bound, clean buffer with no write behind it — the base case. */
const FILE: SaveTextFacts = {
  saveMode: "manual",
  saveState: "clean",
  conflict: null,
  lastSavedAt: null,
  bound: true,
};

function text(facts: Partial<SaveTextFacts>): string {
  return saveText({ ...FILE, ...facts });
}

describe("saveText", () => {
  test("manual mode says Edited while dirty, automatic mode says Unsaved", () => {
    expect(text({ saveState: "editing" })).toBe("Edited");
    expect(text({ saveMode: "automatic", saveState: "editing" })).toBe("Unsaved");
  });

  test("a write in flight says Saving… under either contract", () => {
    expect(text({ saveState: "writing" })).toBe("Saving…");
    expect(text({ saveMode: "automatic", saveState: "writing" })).toBe("Saving…");
  });

  test("a clean file says Saved, and names the time once it has one", () => {
    expect(text({})).toBe("Saved");
    const at = new Date(2026, 7, 10, 12, 4, 11).getTime();
    expect(text({ lastSavedAt: at })).toBe(
      `Saved: ${new Date(at).toLocaleTimeString()}`,
    );
  });

  test("a buffer that is not a file yet says Draft, never Saved", () => {
    // The bug this rung exists to retire: a card opened seconds ago, on a
    // buffer nothing has ever written, announcing that it was saved. Clean is
    // not the same fact for a draft as it is for a file.
    expect(text({ bound: false })).toBe("Draft");
    expect(text({ bound: false, saveMode: "automatic" })).toBe("Draft");
  });

  test("a draft that has autosaved times it like any other write", () => {
    // "Draft" is what an UNWRITTEN buffer says. Once autosave has put bytes
    // somewhere there is an event to name, and naming it is the truth whether
    // or not the file has a home yet.
    const at = new Date(2026, 7, 10, 12, 4, 11).getTime();
    expect(text({ bound: false, saveMode: "automatic", lastSavedAt: at })).toBe(
      `Saved: ${new Date(at).toLocaleTimeString()}`,
    );
    expect(text({ bound: false, saveMode: "automatic", saveState: "editing" })).toBe(
      "Unsaved",
    );
  });

  test("an unresolved manual conflict displaces the save state", () => {
    expect(
      text({ saveState: "editing", conflict: { reason: "hash" }, lastSavedAt: 1 }),
    ).toBe("File changed");
    expect(text({ conflict: { reason: "missing" }, lastSavedAt: 1 })).toBe(
      "File deleted",
    );
  });

  test("automatic mode has no conflict wording — its conflict is a banner", () => {
    expect(text({ saveMode: "automatic", conflict: { reason: "hash" } })).toBe(
      "Saved",
    );
  });

  test("a folded card names the conflict in automatic mode, where its banner is held", () => {
    // The banner waits for the unfold, so the masthead is the only surface
    // still saying it — in automatic mode exactly as in manual.
    expect(
      text({ saveMode: "automatic", conflict: { reason: "hash" }, folded: true }),
    ).toBe("File changed");
    expect(
      text({ saveMode: "automatic", conflict: { reason: "missing" }, folded: true }),
    ).toBe("File deleted");
    expect(text({ saveMode: "automatic", folded: true })).toBe("Saved");
  });
});
