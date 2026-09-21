/**
 * Pure-logic coverage for the annotation kind registry.
 *
 * The gestures themselves are app-tested against the real app — a real
 * click seeding the real composer (at0225), a real right-click driving the
 * real clipboard (at0237). What this file pins is the routing table those
 * gestures read: that every kind the annotator can stamp resolves to an
 * entry, and that each kind's menu items and standard-item suppression are
 * what the interaction layer will find when it asks.
 *
 * Deliberately no dispatch assertions here: verifying a click by handing
 * the registry a hand-rolled store and counting calls would prove only
 * that the fake was called, which is the pattern this project bans.
 */

import { describe, expect, test } from "bun:test";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { sessionTagStore } from "@/lib/session-tag-store";
import { annotationEntryFor } from "../registry";
import type { AnnotationKind } from "../types";

const ALL_KINDS: ReadonlyArray<AnnotationKind> = [
  "url",
  "email",
  "slash-command",
  "shell-command",
  "file-path",
  "directory",
  "image",
  "commit-sha",
];

/** A payload per kind, for the tables that walk every kind. */
const SAMPLE: Record<AnnotationKind, unknown> = {
  url: { kind: "url", url: "https://x.y" },
  email: { kind: "email", address: "a@b.com" },
  "slash-command": { kind: "slash-command", name: "diff", args: "" },
  "shell-command": { kind: "shell-command", command: "just x" },
  "file-path": { kind: "file-path", path: "/repo/a.ts" },
  directory: { kind: "directory", path: "/repo/src" },
  image: { kind: "image", atomId: "atom-7", label: "image-1" },
  "commit-sha": {
    kind: "commit-sha",
    sha: "b089d34a8",
    root: "/repo",
    paths: ["a.ts"],
  },
  session: {
    kind: "session",
    target: "123e4567-e89b-42d3-a456-426614174000",
  },
};

type SamplePayload = Parameters<
  NonNullable<ReturnType<typeof annotationEntryFor>>["menuEntries"]
>[0];

/** The entries a kind offers knowing only its payload. */
function bareEntries(kind: AnnotationKind) {
  return (
    annotationEntryFor(kind)?.menuEntries(SAMPLE[kind] as SamplePayload, {
      kind: "none",
    }) ?? []
  );
}

describe("every stampable kind is registered", () => {
  for (const kind of ALL_KINDS) {
    test(kind, () => {
      expect(annotationEntryFor(kind)).not.toBeNull();
    });
  }
});

describe("command kinds replace the standard menu block", () => {
  for (const kind of ["slash-command", "shell-command"] as const) {
    test(kind, () => {
      const entry = annotationEntryFor(kind);
      expect(entry?.suppressStandardItems).toBe(true);
    });
  }

  test("a shell command offers the copies and the insert, and nothing else", () => {
    expect(bareEntries("shell-command").map((e) => e.label)).toEqual([
      "Copy Command",
      "Copy Command as Plain Text",
      "Insert into Prompt",
    ]);
  });

  test("a slash command leads with the two runs, then the same copies", () => {
    expect(bareEntries("slash-command").map((e) => e.label)).toEqual([
      "Run Here",
      "Run in New Session",
      "Copy Command",
      "Copy Command as Plain Text",
      "Insert into Prompt",
    ]);
  });

  test("the copy items name real vocabulary actions", () => {
    expect(
      annotationEntryFor("slash-command")
        ?.menuEntries({ kind: "slash-command", name: "diff", args: "" }, { kind: "none" })
        .map((e) => e.action),
    ).toEqual([
      TUG_ACTIONS.RUN_COMMAND_HERE,
      TUG_ACTIONS.RUN_COMMAND_IN_NEW_SESSION,
      TUG_ACTIONS.COPY_COMMAND,
      TUG_ACTIONS.COPY_COMMAND_AS_PLAIN_TEXT,
      TUG_ACTIONS.INSERT_INTO_PROMPT,
    ]);
  });

  test("and a command click is registered at all", () => {
    expect(annotationEntryFor("slash-command")?.primaryClick).toBeDefined();
    expect(annotationEntryFor("shell-command")?.primaryClick).toBeDefined();
  });

  /**
   * [B08]/[F05]: a run a surface cannot perform right now is dimmed, never
   * dropped — the menu is the same height on every right-click, and the
   * reason it is dim is a fact the surface supplied rather than a guess.
   */
  describe("the runs dim rather than vanish", () => {
    const runs = (facts: Parameters<
      NonNullable<ReturnType<typeof annotationEntryFor>>["menuEntries"]
    >[1]) =>
      annotationEntryFor("slash-command")
        ?.menuEntries({ kind: "slash-command", name: "arc", args: "x @b.md" }, facts)
        .filter((e) => e.label.startsWith("Run ")) ?? [];

    test("a surface that knows only the payload offers them live", () => {
      expect(runs({ kind: "none" }).map((e) => e.disabled)).toEqual([
        false,
        false,
      ]);
    });

    test("a surface with a composer and a path that resolves offers them live", () => {
      expect(
        runs({
          kind: "slash-command",
          hasComposer: true,
          argsPathMissing: false,
        }).map((e) => e.disabled),
      ).toEqual([false, false]);
    });

    test("no composer dims both, and both are still there", () => {
      const entries = runs({
        kind: "slash-command",
        hasComposer: false,
        argsPathMissing: false,
      });
      expect(entries.map((e) => e.label)).toEqual([
        "Run Here",
        "Run in New Session",
      ]);
      expect(entries.map((e) => e.disabled)).toEqual([true, true]);
    });

    test("a path the surface could not find dims both", () => {
      expect(
        runs({
          kind: "slash-command",
          hasComposer: true,
          argsPathMissing: true,
        }).map((e) => e.disabled),
      ).toEqual([true, true]);
    });
  });
});

describe("link kinds leave the standard menu block alone", () => {
  for (const kind of ["url", "email"] as const) {
    test(kind, () => {
      expect(annotationEntryFor(kind)?.suppressStandardItems).toBe(false);
    });
  }

  test("email registers no click — a mailto anchor's own default is correct", () => {
    expect(annotationEntryFor("email")?.primaryClick).toBeUndefined();
  });

  test("url registers a click only for the hosts that are not anchors", () => {
    // A link chip the user attached is a span, not an `<a>`, so something
    // has to open it. Anchors never reach this handler — the delegated
    // listener leaves them to their own navigation, which is what keeps a
    // real link from opening twice.
    expect(annotationEntryFor("url")?.primaryClick).toBeDefined();
  });

  test("each names its value in the idiom of its kind", () => {
    // A url inserts as an atom and an email does not, which is the rule
    // discriminating between two kinds whose menus were once identical.
    expect(
      annotationEntryFor("url")
        ?.menuEntries({ kind: "url", url: "https://x.y" }, { kind: "none" })
        .map((e) => e.label),
    ).toEqual(["Copy Link", "Copy as Atom", "Insert Atom into Prompt"]);
    expect(
      annotationEntryFor("email")
        ?.menuEntries({ kind: "email", address: "a@b.com" }, { kind: "none" })
        .map((e) => e.label),
    ).toEqual(["Copy Address", "Insert into Prompt"]);
  });
});

describe("a file offers one way into the composer", () => {
  // Whether the composer receives a chip or characters is the handler's
  // call, not a second menu item's — at0346 is where that lands.
  test("open, reveal, both copies, insert — and no second insert", () => {
    expect(
      annotationEntryFor("file-path")
        ?.menuEntries({ kind: "file-path", path: "/repo/a.ts" }, { kind: "none" })
        .map((e) => e.label),
    ).toEqual([
      "Open in Editor",
      "Show in Finder",
      "Copy Path",
      "Copy as Atom",
      "Insert Atom into Prompt",
    ]);
  });
});

/**
 * The rule, as the menu states it in both directions.
 *
 * `atomSegmentFor` is the single predicate behind two items, and what would
 * go wrong without this test is the drift it exists to prevent: a kind
 * promoted to atom-insert whose label still says the plain word, or an atom
 * copy offered over an entity that inserts as text. Either one is the menu
 * telling the reader something untrue about what the gesture will do.
 */
describe("an entity names its atom in both directions, or in neither", () => {
  for (const kind of ALL_KINDS) {
    test(kind, () => {
      const labels = bareEntries(kind).map((e) => e.label);
      const saysAtom = labels.includes("Insert Atom into Prompt");
      expect(labels).toContain(
        saysAtom ? "Insert Atom into Prompt" : "Insert into Prompt",
      );
      expect(labels.includes("Copy as Atom")).toBe(saysAtom);
    });
  }

  test("a file says it, and the copy dispatches the atom action", () => {
    const entries = bareEntries("file-path");
    expect(entries.map((e) => e.label)).toContain("Insert Atom into Prompt");
    expect(
      entries.find((e) => e.label === "Copy as Atom")?.action,
    ).toBe(TUG_ACTIONS.COPY_ANNOTATION_ATOM);
  });

  test("a command inserts as text, so it keeps the plain label", () => {
    // The regression that proves the rule discriminates: at0225 asserts this
    // label on a slash command in the running app.
    for (const kind of ["slash-command", "shell-command", "email"] as const) {
      const labels = bareEntries(kind).map((e) => e.label);
      expect(labels).toContain("Insert into Prompt");
      expect(labels).not.toContain("Copy as Atom");
    }
  });
});

describe("every kind offers to send its value back into the conversation", () => {
  for (const kind of ALL_KINDS) {
    test(kind, () => {
      expect(bareEntries(kind).map((e) => e.action)).toContain(
        TUG_ACTIONS.INSERT_INTO_PROMPT,
      );
    });
  }
});

/**
 * The grammar, as a check rather than as prose.
 *
 * A menu is a vocabulary before it is a list, and the failure this pins is
 * the one the whole standardization pass was for: a kind added later that
 * spells its copy `Copy`, or offers no copy at all, so the same entity reads
 * differently depending on which surface drew it. See the Context menus
 * section of `tuglaws/menus.md`.
 */
describe("the copy row names its noun", () => {
  /**
   * `Copy` alone belongs to the standard editing block, where the noun is
   * "the selection" and the surface supplies it. An entity menu has no
   * selection to mean, so its copy says what it copies.
   *
   * `Copy as <Format>` is the one other shape, and it is reserved for a
   * genuinely different SERIALIZATION of one entity — the atom beside the
   * citation, the plain text beside the code-formatted command — never for a
   * second entity or a second field.
   */
  const COPY_NOUN = /^Copy (?!as\b)\S/;
  const COPY_AS_FORMAT = /^Copy as \S/;

  for (const kind of ALL_KINDS) {
    test(`${kind} offers a copy, and none of its copies is bare`, () => {
      const copies = bareEntries(kind)
        .map((e) => e.label)
        .filter((label) => label.startsWith("Copy"));
      expect(copies.length).toBeGreaterThan(0);
      for (const label of copies) {
        expect(
          COPY_NOUN.test(label) || COPY_AS_FORMAT.test(label),
          `"${label}" is a bare Copy — name the noun it copies`,
        ).toBe(true);
      }
    });
  }
});

describe("no kind opens its menu with a rule", () => {
  for (const kind of ALL_KINDS) {
    test(kind, () => {
      expect(bareEntries(kind)[0]?.separatorBefore).not.toBe(true);
    });
  }
});

describe("a session is offered only the copies its surface can perform", () => {
  // The atom and the citation are written from the identity record. A payload
  // carries an id, so a surface holding one is offered the id alone — an item
  // dispatching into silence is the failure [L31] exists to prevent.
  test("a payload alone offers the id, not the atom or the citation", () => {
    expect(bareEntries("session").map((e) => e.action)).toEqual([
      TUG_ACTIONS.COPY_SESSION_ID,
      TUG_ACTIONS.INSERT_INTO_PROMPT,
    ]);
  });

  // The rule reaches the transcript's session ink, which is the one surface
  // that holds a payload and nothing else. A session the ledger CAN answer
  // for inserts as an atom, so it must offer the atom copy too — the
  // half-named entity is what the whole arc exists to prevent, and this is
  // the only kind whose predicate depends on state a payload cannot carry.
  test("a resolvable session names its atom in both directions", () => {
    const ID = (SAMPLE.session as { target: string }).target;
    sessionTagStore.setTag(ID, "brisk-otter");
    try {
      const entries = bareEntries("session");
      expect(entries.map((e) => e.label)).toEqual([
        "Copy as Atom",
        "Copy Session ID",
        "Insert Atom into Prompt",
      ]);
      expect(
        entries.find((e) => e.label === "Copy as Atom")?.action,
        // The generic verb, not COPY_SESSION_ATOM: this surface has no
        // identity record behind it, so the handler that reads the payload
        // is the only one that can perform the item.
      ).toBe(TUG_ACTIONS.COPY_ANNOTATION_ATOM);
    } finally {
      sessionTagStore.setTag(ID, null);
    }
  });

  test("a surface holding the record is offered all three", () => {
    const labels = annotationEntryFor("session")
      ?.menuEntries(SAMPLE.session as SamplePayload, {
        kind: "session",
        openCardId: null,
        isOwnCard: true,
        resumable: true,
        projectDir: "/repo",
      })
      .map((e) => e.label);
    expect(labels).toEqual([
      "Copy as Atom",
      "Copy as Citation",
      "Copy Session ID",
      "Insert into Prompt",
    ]);
  });

  test("the go-to row states which of the two it will be", () => {
    const raise = annotationEntryFor("session")?.menuEntries(
      SAMPLE.session as SamplePayload,
      {
        kind: "session",
        openCardId: "card-3",
        isOwnCard: false,
        resumable: true,
        projectDir: "/repo",
      },
    );
    expect(raise?.[0]?.label).toBe("Show Session");
    const resume = annotationEntryFor("session")?.menuEntries(
      SAMPLE.session as SamplePayload,
      {
        kind: "session",
        openCardId: null,
        isOwnCard: false,
        resumable: false,
        projectDir: "/repo",
      },
    );
    expect(resume?.[0]?.label).toBe("Resume Session");
    // Held by another process: a real session, unresumable for a reason the
    // reader can act on, so it is dim rather than gone.
    expect(resume?.[0]?.disabled).toBe(true);
  });
});

describe("a commit's menu grows with what the surface holds", () => {
  test("a sha alone opens its diff and copies either hash form", () => {
    expect(bareEntries("commit-sha").map((e) => e.label)).toEqual([
      "Open Commit",
      "Open Diff",
      "Copy Short Hash",
      "Copy Full Hash",
      "Copy as Atom",
      "Insert Atom into Prompt",
    ]);
  });

  test("a row holding the record offers the header and the whole record", () => {
    const items = annotationEntryFor("commit-sha")?.menuEntries(
      SAMPLE["commit-sha"] as SamplePayload,
      {
        kind: "commit-sha",
        expanded: false,
        hasRecord: true,
        canOpenDiff: false,
      },
    );
    expect(items?.map((e) => e.label)).toEqual([
      "Show Detail",
      "Open Commit",
      "Copy Short Hash",
      "Copy Full Hash",
      "Copy Commit Header",
      "Copy Commit Record",
      // The record does not displace the object. A pill in a receipt or a
      // History row is the same commit a prose mention is, so it offers the
      // same way of carrying it away as one.
      "Copy as Atom",
    ]);
  });

  test("the fold row states the direction it will move", () => {
    const expanded = annotationEntryFor("commit-sha")?.menuEntries(
      SAMPLE["commit-sha"] as SamplePayload,
      {
        kind: "commit-sha",
        expanded: true,
        hasRecord: true,
        canOpenDiff: false,
      },
    );
    expect(expanded?.[0]?.label).toBe("Hide Detail");
  });
});
