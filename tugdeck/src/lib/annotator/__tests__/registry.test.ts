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
      expect(
        entry
          ?.menuEntries({ kind: "shell-command", command: "just x" }, { kind: "none" })
          .map((e) => e.label),
      ).toEqual([
        "Copy Command",
        "Copy Command as Plain Text",
        "Insert into Prompt",
      ]);
    });
  }

  test("the copy items name real vocabulary actions", () => {
    expect(
      annotationEntryFor("slash-command")
        ?.menuEntries({ kind: "slash-command", name: "diff", args: "" }, { kind: "none" })
        .map((e) => e.action),
    ).toEqual([
      TUG_ACTIONS.COPY_COMMAND,
      TUG_ACTIONS.COPY_COMMAND_AS_PLAIN_TEXT,
      TUG_ACTIONS.INSERT_INTO_PROMPT,
    ]);
  });

  test("and a command is one thing to a secondary click", () => {
    // The whole point of replacing the standard block: the menu's items
    // all act on the entire command, so the click must not leave the
    // browser's smart-selected sub-word painted underneath it.
    for (const kind of ["slash-command", "shell-command"] as const) {
      expect(annotationEntryFor(kind)?.wholeEntitySelection).toBe(true);
    }
  });

  test("and a command click is registered at all", () => {
    expect(annotationEntryFor("slash-command")?.primaryClick).toBeDefined();
    expect(annotationEntryFor("shell-command")?.primaryClick).toBeDefined();
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
    expect(
      annotationEntryFor("url")
        ?.menuEntries({ kind: "url", url: "https://x.y" }, { kind: "none" })
        .map((e) => e.label),
    ).toEqual(["Copy Link", "Insert into Prompt"]);
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
  test("open, reveal, copy, insert — and no second insert beside it", () => {
    expect(
      annotationEntryFor("file-path")
        ?.menuEntries({ kind: "file-path", path: "/repo/a.ts" }, { kind: "none" })
        .map((e) => e.label),
    ).toEqual([
      "Open in Editor",
      "Show in Finder",
      "Copy Path",
      "Insert into Prompt",
    ]);
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

  test("a surface holding the record is offered all three", () => {
    const labels = annotationEntryFor("session")
      ?.menuEntries(SAMPLE.session as SamplePayload, {
        kind: "session",
        openCardId: null,
        isOwnCard: true,
        heldElsewhere: false,
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
        heldElsewhere: false,
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
        heldElsewhere: true,
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
      "Open Diff",
      "Copy Short Hash",
      "Copy Full Hash",
      "Insert into Prompt",
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
      "Copy Short Hash",
      "Copy Full Hash",
      "Copy Commit Header",
      "Copy Commit Record",
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
