/**
 * The Keyboard pane's chord probe — "what does this chord mean?", asked
 * without binding anything.
 *
 * The verdict is the whole feature: the strip renders one sentence from it
 * and the list narrows to the ids it carries. So every case is asserted here
 * against a constructed multi-layer world, which is the only way to reach the
 * ones the shipped keymap does not happen to contain — a chord eaten by a
 * disabled menu item, a chord claimed at two layers at once.
 *
 * The live registry is used where the live registry is the point: the probe
 * shipping with a real answer for ⌘K is a claim about this app, not about a
 * fixture.
 */

import { describe, expect, test } from "bun:test";

import { probeChord } from "../settings-keymap-probe";
import type { Chord, CommandEntry } from "../../command-registry";
import { COMMANDS_BY_ID, GLOBAL_SCOPE } from "../../command-registry";
import {
  KeymapRegistry,
  type NativeChordClaim,
  type ScopedBinding,
} from "../../keymap-registry";

const DIGIT_1: Chord = { key: "Digit1", meta: true, label: "1" };

const FIXTURE: readonly CommandEntry[] = [
  {
    id: "deck.slot1",
    title: "Move Card to Slot 1",
    routing: "first-responder",
    bindings: [{ chord: DIGIT_1, scope: GLOBAL_SCOPE, source: "default" }],
  },
];

function registryWith(
  scoped: ScopedBinding[] = [],
  native: NativeChordClaim[] = [],
  entries: readonly CommandEntry[] = FIXTURE,
): KeymapRegistry {
  const registry = new KeymapRegistry(entries);
  registry.setEnvironment({
    scopedBindings: () => scoped,
    nativeChords: () => native,
  });
  return registry;
}

describe("a chord nothing could be bound to", () => {
  test("a bare letter is unrecordable, and nothing is resolved for it", () => {
    // Bare `K` would fire on every keystroke everywhere. There is no conflict
    // worth reporting because there is no binding to be had.
    const verdict = probeChord({ key: "KeyK", label: "K" }, registryWith());
    expect(verdict.kind).toBe("unrecordable");
  });

  test("shift alone is a capital letter, not a modifier", () => {
    const verdict = probeChord(
      { key: "KeyK", shift: true, label: "K" },
      registryWith(),
    );
    expect(verdict.kind).toBe("unrecordable");
  });

  test("a function key is recordable with no modifier at all", () => {
    const verdict = probeChord({ key: "F7", label: "F7" }, registryWith());
    expect(verdict.kind).toBe("free");
  });
});

describe("a chord nobody claims", () => {
  test("reads free", () => {
    const verdict = probeChord(
      { key: "KeyJ", meta: true, alt: true, label: "J" },
      registryWith(),
    );
    expect(verdict.kind).toBe("free");
    if (verdict.kind !== "free") return;
    expect(verdict.menuEligible).toBe(true);
    expect(verdict.label).toBe("⌥⌘J");
  });

  test("free is still free when the chord has no menu-bar form", () => {
    // The caveat rides on a yes: the chord is bindable, and a command wearing
    // it simply would not appear on a menu item.
    const verdict = probeChord(
      { key: "IntlBackslash", meta: true, label: "IntlBackslash" },
      registryWith(),
    );
    expect(verdict.kind).toBe("free");
    if (verdict.kind !== "free") return;
    expect(verdict.menuEligible).toBe(false);
  });
});

describe("a chord something claims", () => {
  test("a global binding is named, and the layer goes unremarked", () => {
    const verdict = probeChord(DIGIT_1, registryWith());
    expect(verdict.kind).toBe("taken");
    if (verdict.kind !== "taken") return;
    expect(verdict.commandId).toBe("deck.slot1");
    // Titles come from the shipped table, which a fixture command is not in,
    // so this one falls back to its id. That fallback is the point: a probe
    // that rendered `undefined` for a command the table has drifted away
    // from would be worse than one that says the id out loud.
    expect(verdict.title).toBe("deck.slot1");
    expect(verdict.layer).toBe("everywhere");
    expect(verdict.others).toBe(0);
  });

  test("a scoped claim wins over the global one and says so", () => {
    // This is the case the layer phrase exists for: the chord is taken here
    // and free everywhere else, which is a different answer from "taken".
    const scoped: ScopedBinding = {
      commandId: "pdf.firstPage",
      chord: DIGIT_1,
      scope: { kind: "responder", responderId: "pdf-view" },
      depth: 1,
    };
    const verdict = probeChord(DIGIT_1, registryWith([scoped]));
    expect(verdict.kind).toBe("taken");
    if (verdict.kind !== "taken") return;
    expect(verdict.commandId).toBe("pdf.firstPage");
    expect(verdict.layer).toBe("in one surface");
    // The command it shadows is still a claimant, and still filtered to.
    expect(verdict.others).toBe(1);
    expect(verdict.commandIds.has("deck.slot1")).toBe(true);
  });

  test("a menu item beats both, regardless of focus", () => {
    const scoped: ScopedBinding = {
      commandId: "pdf.firstPage",
      chord: DIGIT_1,
      scope: { kind: "responder", responderId: "pdf-view" },
      depth: 1,
    };
    const claim: NativeChordClaim = {
      menuItemId: "window.slot1",
      commandId: "window.slot1Command",
      chord: DIGIT_1,
      enabled: true,
      claims: true,
    };
    const verdict = probeChord(DIGIT_1, registryWith([scoped], [claim]));
    expect(verdict.kind).toBe("taken");
    if (verdict.kind !== "taken") return;
    expect(verdict.commandId).toBe("window.slot1Command");
    expect(verdict.layer).toBe("on the menu bar");
    expect(verdict.others).toBe(2);
  });

  test("a disabled menu item that still claims reads taken, not free", () => {
    // It fires nothing and beeps — but the chord does not fall through, so
    // reporting it free would be the probe's one unforgivable answer.
    const claim: NativeChordClaim = {
      menuItemId: "window.slot1",
      commandId: "window.slot1Command",
      chord: DIGIT_1,
      enabled: false,
      claims: true,
    };
    const verdict = probeChord(DIGIT_1, registryWith([], [claim], []));
    expect(verdict.kind).toBe("taken");
    if (verdict.kind !== "taken") return;
    expect(verdict.commandId).toBe("window.slot1Command");
    expect(verdict.layer).toBe("on the menu bar");
  });

  test("a menu whose items are not claiming lets the chord through", () => {
    // The Maker menu with maker mode off. The chord falls to the JS layers,
    // and with nothing there it is genuinely free.
    const claim: NativeChordClaim = {
      menuItemId: "maker.thing",
      commandId: "maker.thingCommand",
      chord: DIGIT_1,
      enabled: true,
      claims: false,
    };
    const verdict = probeChord(DIGIT_1, registryWith([], [claim], []));
    expect(verdict.kind).toBe("free");
  });
});

describe("against the shipped keymap", () => {
  test("⌘K is the command the app actually binds it to", () => {
    const verdict = probeChord({ key: "KeyK", meta: true, label: "K" });
    expect(verdict.kind).toBe("taken");
    if (verdict.kind !== "taken") return;
    expect(verdict.commandIds.has("focus-prompt")).toBe(true);
    // And the title is the command's own, not its id — the fallback above is
    // a fallback, not the normal path.
    expect(verdict.title).toBe(
      COMMANDS_BY_ID.get(verdict.commandId)?.title as string,
    );
    expect(verdict.title).not.toBe(verdict.commandId);
  });

  test("the probe resolves without touching the override store", () => {
    // Not a behaviour test so much as the feature's premise: asking twice
    // gives the same answer, because asking changes nothing.
    const chord: Chord = { key: "KeyJ", meta: true, alt: true, label: "J" };
    expect(probeChord(chord).kind).toBe(probeChord(chord).kind);
  });
});
