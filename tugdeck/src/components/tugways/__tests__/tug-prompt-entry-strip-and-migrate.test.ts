/**
 * tug-prompt-entry — pure-helper + persistence migration unit tests.
 *
 * Key helpers exposed by `tug-prompt-entry.tsx`:
 *
 *   - `computeSideQuestionArg(text, atoms)` — expands atoms and trims
 *     to build the `?`-route side-question argument. Submitted text is
 *     otherwise sent verbatim (route characters are ordinary text).
 *   - `coerceRestorePayload(raw)` — accepts a restored bag, narrows
 *     it to the canonical `{ route, draft }` shape, and
 *     migrates legacy `{ currentRoute, perRoute }` payloads forward
 *     by mapping `perRoute[currentRoute]` onto `draft` and dropping
 *     drafts for other routes per [Q07]=a.
 *
 * Pure helpers — no mounting required.
 */
import { describe, it, expect } from "bun:test";

import {
  buildCommitModeState,
  buildEditingStateFromDraftRestore,
  classifyBlockedSubmit,
  coerceRestorePayload,
  computeCommandChipInsert,
  computeSideQuestionArg,
} from "@/components/tugways/tug-prompt-entry";
import type { CommandLineAtom } from "@/lib/slash-commands";
import type { TugTextEditingState } from "@/lib/tug-text-types";
import type { AtomSegment } from "@/lib/tug-atom-img";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-img";

// ---------------------------------------------------------------------------
// Commit mode ([P03]): the editor holds the message alone — no chip
// ---------------------------------------------------------------------------

describe("buildCommitModeState", () => {
  it("holds the message verbatim with no atoms", () => {
    const state = buildCommitModeState("fix the bug");
    expect(state.text).toBe("fix the bug");
    expect(state.atoms).toEqual([]);
  });

  it("an empty message is an empty document", () => {
    const state = buildCommitModeState("");
    expect(state.text).toBe("");
    expect(state.atoms).toEqual([]);
  });

  it("carries the chips standing in the message ([B04])", () => {
    // The mode restores through this on entry, on the auto-message revert and
    // on a cancel. Handed the text alone it would put the message back with a
    // bare `U+FFFC` where a pasted file or commit chip had been — a demotion
    // performed on a field the user is still editing.
    const state = buildCommitModeState(`land ${TUG_ATOM_CHAR} on main`, [
      {
        kind: "atom",
        type: "commit",
        label: "commit:64747b8c",
        value: "64747b8c9a",
      },
    ]);
    expect(state.text).toBe(`land ${TUG_ATOM_CHAR} on main`);
    expect(state.atoms).toHaveLength(1);
    expect(state.atoms[0]).toMatchObject({
      position: 5,
      type: "commit",
      label: "commit:64747b8c",
      value: "64747b8c9a",
    });
    // The position it claims is where the placeholder actually is.
    expect(state.text.charAt(state.atoms[0]!.position)).toBe(TUG_ATOM_CHAR);
  });

  it("an image chip keeps its bytes-store id through the restore", () => {
    const state = buildCommitModeState(TUG_ATOM_CHAR, [
      {
        kind: "atom",
        type: "image",
        label: "shot.png",
        value: "shot.png",
        id: "1f8c2e04-7b3a-4d51-9c60-2a8e5f7b1d33",
      },
    ]);
    expect(state.atoms[0]!.id).toBe("1f8c2e04-7b3a-4d51-9c60-2a8e5f7b1d33");
  });
});

// ---------------------------------------------------------------------------
// computeCommandChipInsert — the ⌃⌘ chord / picker head-chip transform ([P07])
// ---------------------------------------------------------------------------

describe("computeCommandChipInsert", () => {
  const A = TUG_ATOM_CHAR;

  it("empty draft → a lone command atom + trailing space, caret after it", () => {
    const result = computeCommandChipInsert(
      { text: "", atoms: [], selection: null },
      "shell",
    );
    expect(result.text).toBe(`${A} `);
    expect(result.atoms).toEqual([
      { position: 0, type: "command", label: "shell", value: "shell" },
    ]);
    expect(result.selection).toEqual({ start: 2, end: 2 });
  });

  it("plain-text draft → chip leads, the text becomes args", () => {
    const result = computeCommandChipInsert(
      { text: "-la src", atoms: [], selection: { start: 7, end: 7 } },
      "shell",
    );
    expect(result.text).toBe(`${A} -la src`);
    expect(result.atoms).toEqual([
      { position: 0, type: "command", label: "shell", value: "shell" },
    ]);
    // The caret rides right by the two inserted chars.
    expect(result.selection).toEqual({ start: 9, end: 9 });
  });

  it("existing head command atom → swapped in place, args preserved", () => {
    const result = computeCommandChipInsert(
      {
        text: `${A} commit msg`,
        atoms: [{ position: 0, type: "command", label: "changes", value: "changes" }],
        selection: { start: 11, end: 11 },
      },
      "history",
    );
    // Text + caret untouched; only the atom's name changes.
    expect(result.text).toBe(`${A} commit msg`);
    expect(result.atoms).toEqual([
      { position: 0, type: "command", label: "history", value: "history" },
    ]);
    expect(result.selection).toEqual({ start: 11, end: 11 });
  });

  it("mid-text atom (not at head) → a new head chip; the atom shifts right", () => {
    const result = computeCommandChipInsert(
      {
        text: `look ${A}`,
        atoms: [{ position: 5, type: "file", label: "a.ts", value: "a.ts" }],
        selection: null,
      },
      "find",
    );
    expect(result.text).toBe(`${A} look ${A}`);
    expect(result.atoms).toEqual([
      { position: 0, type: "command", label: "find", value: "find" },
      { position: 7, type: "file", label: "a.ts", value: "a.ts" },
    ]);
    expect(result.selection).toEqual({ start: 2, end: 2 });
  });
});

// ---------------------------------------------------------------------------
// computeSideQuestionArg — the `/btw` submission transform
// ---------------------------------------------------------------------------

// Build draft text + positioned atoms from a piece list — a string piece is
// literal text, an object piece becomes a TUG_ATOM_CHAR placeholder at its
// document position (mirroring the editor substrate).
function mkDraft(
  pieces: ReadonlyArray<string | AtomSegment>,
): { text: string; atoms: CommandLineAtom[] } {
  let text = "";
  const atoms: CommandLineAtom[] = [];
  for (const piece of pieces) {
    if (typeof piece === "string") {
      text += piece;
    } else {
      atoms.push({ position: text.length, segment: piece });
      text += TUG_ATOM_CHAR;
    }
  }
  return { text, atoms };
}

describe("computeSideQuestionArg — btw-route submission", () => {
  it("plain question passes through, trimmed", () => {
    expect(computeSideQuestionArg("  why is this slow?  ", [])).toBe(
      "why is this slow?",
    );
  });

  it("keeps a leading `?` — route characters are ordinary text", () => {
    expect(computeSideQuestionArg("? explain the reducer", [])).toBe(
      "? explain the reducer",
    );
  });

  it("empty / whitespace draft → empty arg (bare submit opens the overlay)", () => {
    expect(computeSideQuestionArg("", [])).toBe("");
    expect(computeSideQuestionArg("   ", [])).toBe("");
  });

  it("expands a file mention to its path so it survives into the question", () => {
    const { text, atoms } = mkDraft([
      "what does ",
      { type: "file", value: "arc/plan.md", label: "plan.md" } as AtomSegment,
      " do?",
    ]);
    expect(computeSideQuestionArg(text, atoms)).toBe(
      "what does arc/plan.md do?",
    );
  });
});

// ---------------------------------------------------------------------------
// coerceRestorePayload — migration from legacy `perRoute` shape
// ---------------------------------------------------------------------------

describe("coerceRestorePayload — new shape", () => {
  it("passes a well-formed new payload through unchanged", () => {
    const draft: TugTextEditingState = {
      text: "hello",
      atoms: [],
      selection: { start: 5, end: 5 },
    };
    const result = coerceRestorePayload({
      route: "$",
      draft,
    });
    expect(result.route).toBe("$");
    expect(result.draft).toEqual(draft);
  });

  it("round-trips the btw route (`?`) — route is stored as an opaque string", () => {
    const result = coerceRestorePayload({ route: "?", draft: null });
    expect(result.route).toBe("?");
  });

  it("treats a malformed draft as null", () => {
    const result = coerceRestorePayload({
      route: "$",
      draft: { text: 42 } as unknown,
    });
    expect(result.draft).toBeNull();
  });
});

describe("coerceRestorePayload — legacy `perRoute` migration", () => {
  it("maps perRoute[currentRoute] onto draft and drops other drafts", () => {
    const codeDraft: TugTextEditingState = {
      text: "code text",
      atoms: [],
      selection: null,
    };
    const shellDraft: TugTextEditingState = {
      text: "shell text",
      atoms: [],
      selection: null,
    };
    const result = coerceRestorePayload({
      currentRoute: "$",
      perRoute: {
        "❯": codeDraft,
        "$": shellDraft,
        ":": { text: "cmd", atoms: [], selection: null },
      },
    });
    expect(result.route).toBe("$");
    // The Code draft and the legacy `:`-route draft are dropped per
    // [Q07]=a; only the current-route (`$`) draft survives migration.
    expect(result.draft).toEqual(shellDraft);
  });

  it("returns a null draft when perRoute has no entry for currentRoute", () => {
    const result = coerceRestorePayload({
      currentRoute: "$",
      perRoute: {
        "❯": { text: "code", atoms: [], selection: null },
      },
    });
    expect(result.route).toBe("$");
    expect(result.draft).toBeNull();
  });
});

describe("coerceRestorePayload — defaults", () => {
  it("returns the default shape for null", () => {
    const result = coerceRestorePayload(null);
    expect(result.route).toBe("❯");
    expect(result.draft).toBeNull();
  });

  it("returns the default shape for a non-object", () => {
    const result = coerceRestorePayload(42);
    expect(result.route).toBe("❯");
    expect(result.draft).toBeNull();
  });

  it("returns the default shape for an empty object", () => {
    const result = coerceRestorePayload({});
    expect(result.route).toBe("❯");
    expect(result.draft).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// coerceRestorePayload — orphaned image-atom pruning
//
// `capDurableCardState` strips `attachmentBytes` from the durable bag, so a
// reload / relaunch restores a draft whose image atoms have no surviving
// bytes. `coerceRestorePayload` prunes those atoms (splicing the U+FFFC
// placeholder, shifting positions + selection) so the editor mounts clean
// typed text instead of a dead placeholder chip. HMR carries the bytes, so
// an image atom WITH matching bytes is preserved untouched.
// ---------------------------------------------------------------------------

describe("coerceRestorePayload — orphaned image-atom pruning", () => {
  const A = TUG_ATOM_CHAR;

  it("keeps an image atom whose bytes rode along (the HMR path)", () => {
    const draft: TugTextEditingState = {
      text: `pic ${A}`,
      atoms: [
        { position: 4, type: "image", label: "image-1", value: "image-1", id: "b1" },
      ],
      selection: { start: 5, end: 5 },
    };
    const result = coerceRestorePayload({
      route: "❯",
      draft,
      attachmentBytes: { b1: { content: "AAAA", mediaType: "image/png" } },
    });
    expect(result.draft).toEqual(draft);
  });

  it("drops an image atom with no bytes and splices its placeholder", () => {
    const result = coerceRestorePayload({
      route: "❯",
      draft: {
        text: `pic ${A}`,
        atoms: [
          { position: 4, type: "image", label: "image-1", value: "image-1", id: "b1" },
        ],
        selection: { start: 5, end: 5 },
      },
      // attachmentBytes absent — the reload / relaunch case.
    });
    expect(result.draft?.text).toBe("pic ");
    expect(result.draft?.atoms).toEqual([]);
    // Selection rides left by the one spliced char.
    expect(result.draft?.selection).toEqual({ start: 4, end: 4 });
  });

  it("keeps self-contained atoms while dropping a later orphaned image", () => {
    const result = coerceRestorePayload({
      route: "❯",
      draft: {
        text: `${A} and ${A}`,
        atoms: [
          { position: 0, type: "file", label: "a.ts", value: "a.ts" },
          { position: 6, type: "image", label: "image-1", value: "image-1", id: "b2" },
        ],
        selection: null,
      },
    });
    expect(result.draft?.text).toBe(`${A} and `);
    expect(result.draft?.atoms).toEqual([
      { position: 0, type: "file", label: "a.ts", value: "a.ts" },
    ]);
  });

  it("shifts a selection that sits past a dropped atom", () => {
    const result = coerceRestorePayload({
      route: "❯",
      draft: {
        text: `${A}hi`,
        atoms: [
          { position: 0, type: "image", label: "image-1", value: "image-1", id: "b3" },
        ],
        selection: { start: 3, end: 3 },
      },
    });
    expect(result.draft?.text).toBe("hi");
    expect(result.draft?.selection).toEqual({ start: 2, end: 2 });
  });
});

// ---------------------------------------------------------------------------
// classifyBlockedSubmit — drop while replaying, defer otherwise
// ---------------------------------------------------------------------------

describe("classifyBlockedSubmit", () => {
  it("drops a submit that lands while a resume card is replaying", () => {
    // A resume card replays real prior content; a deferred send that
    // committed after replay finished would surprise the user — mirrors
    // the reducer's `handleSend` guard.
    expect(classifyBlockedSubmit("replaying", "resume")).toBe("drop");
  });

  it("defers a submit that lands while a new card flashes through replaying", () => {
    // A new card has no prior content but still flashes through
    // `replaying` (spawn fires `request_replay` against an absent JSONL).
    // On a cold first launch tugcode's boot widens that window, so a
    // first Shift+Return must defer — not silently drop — and flush the
    // instant `canSubmit` flips true.
    expect(classifyBlockedSubmit("replaying", "new")).toBe("defer");
  });

  it("defers a submit blocked on an idle card (transport still settling)", () => {
    // The only other way `performSubmit` reaches the blocked branch:
    // phase idle/errored with the transport not yet online — the
    // settling window on a fresh / reconnecting card. The submission
    // is valid; it should flush the instant `canSubmit` flips true.
    expect(classifyBlockedSubmit("idle", "new")).toBe("defer");
    expect(classifyBlockedSubmit("idle", "resume")).toBe("defer");
  });

  it("defers a submit blocked on an errored card (transport still settling)", () => {
    expect(classifyBlockedSubmit("errored", "resume")).toBe("defer");
  });
});

// ---------------------------------------------------------------------------
// buildEditingStateFromDraftRestore — atom round-trip (cancel → editor)
//
// A queued-send cancel routes the un-sent `(text, atoms)` pair back
// through `pendingDraftRestore`; this helper zips it into the editor's
// restore shape. Image atoms keep their bytes out-of-band in the
// per-card bytes-store keyed by `id`, so the `id` MUST survive the
// conversion — drop it and the restored chip loses its thumbnail and a
// re-submit ships no image. Self-contained atoms carry no `id`.
// ---------------------------------------------------------------------------

describe("buildEditingStateFromDraftRestore — atom id round-trip", () => {
  const A = TUG_ATOM_CHAR;

  it("preserves an image atom's bytes-store id", () => {
    const atoms: AtomSegment[] = [
      { kind: "atom", type: "image", label: "image-1", value: "image-1", id: "bytes-abc" },
    ];
    const state = buildEditingStateFromDraftRestore(`look ${A}`, atoms);
    expect(state.atoms).toHaveLength(1);
    expect(state.atoms[0]).toMatchObject({
      position: 5,
      type: "image",
      label: "image-1",
      value: "image-1",
      id: "bytes-abc",
    });
  });

  it("leaves id undefined for a self-contained (file) atom", () => {
    const atoms: AtomSegment[] = [
      { kind: "atom", type: "file", label: "main.rs", value: "src/main.rs" },
    ];
    const state = buildEditingStateFromDraftRestore(`${A}`, atoms);
    expect(state.atoms[0]!.id).toBeUndefined();
    expect(state.atoms[0]!.value).toBe("src/main.rs");
  });

  it("zips ids positionally across a mixed run of atoms", () => {
    const atoms: AtomSegment[] = [
      { kind: "atom", type: "file", label: "a.ts", value: "a.ts" },
      { kind: "atom", type: "image", label: "image-1", value: "image-1", id: "bytes-1" },
      { kind: "atom", type: "image", label: "image-2", value: "image-2", id: "bytes-2" },
    ];
    const state = buildEditingStateFromDraftRestore(`${A} mid ${A}${A}`, atoms);
    expect(state.atoms.map((a) => a.id)).toEqual([undefined, "bytes-1", "bytes-2"]);
    // Positions point at each U+FFFC in document order.
    expect(state.atoms.map((a) => a.position)).toEqual([0, 6, 7]);
  });
});

// ---------------------------------------------------------------------------
// coerceRestorePayload — durable attachment references
//
// `capDurableCardState` no longer throws the attachment bag away; it reduces
// each entry to `{content: "", mediaType, path}`. Two things have to hold for
// that to mean anything: the coercion must forward `path` (it reconstructs
// entries field by field and silently discards anything it does not name), and
// the prune must read a path-bearing entry as "bytes are coming" rather than
// as an orphan.
// ---------------------------------------------------------------------------

describe("coerceRestorePayload — durable attachment references", () => {
  const A = TUG_ATOM_CHAR;

  const draftWithImage: TugTextEditingState = {
    text: `pic ${A}`,
    atoms: [
      { position: 4, type: "image", label: "image-1", value: "image-1", id: "b1" },
    ],
    selection: { start: 5, end: 5 },
  };

  it("forwards path through the coercion filter", () => {
    const result = coerceRestorePayload({
      route: "❯",
      draft: draftWithImage,
      attachmentBytes: {
        b1: { content: "", mediaType: "image/png", path: "/d/abc.png" },
      },
    });
    expect(result.attachmentBytes?.b1).toEqual({
      content: "",
      mediaType: "image/png",
      path: "/d/abc.png",
    });
  });

  it("keeps an image atom whose entry has a path but no bytes yet", () => {
    const result = coerceRestorePayload({
      route: "❯",
      draft: draftWithImage,
      attachmentBytes: {
        b1: { content: "", mediaType: "image/png", path: "/d/abc.png" },
      },
    });
    expect(result.draft).toEqual(draftWithImage);
  });

  it("drops an image atom whose entry has neither bytes nor a path", () => {
    const result = coerceRestorePayload({
      route: "❯",
      draft: draftWithImage,
      // The upload never landed before the save: media type only.
      attachmentBytes: { b1: { content: "", mediaType: "image/png" } },
    });
    expect(result.draft?.text).toBe("pic ");
    expect(result.draft?.atoms).toEqual([]);
  });
});
