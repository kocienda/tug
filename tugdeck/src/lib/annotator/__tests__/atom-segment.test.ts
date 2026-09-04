/**
 * The rule that decides whether an entity inserts as an atom.
 *
 * `atomSegmentFor` is read by two menu items — the insert and the atom copy —
 * so what is pinned here is the pair of facts those items depend on: which
 * kinds answer a segment at all, and that the segment a kind answers is the
 * inverse of `payloadForAtom`, so an atom minted from an annotation resolves
 * back to the same annotation. `atomPlainTextFor` is pinned beside it: the
 * flavor that rides on the clipboard for a reader who is not in Tug.
 */

import { describe, expect, test } from "bun:test";

import { atomPlainTextFor, atomSegmentFor } from "../atom-segment";
import { payloadForAtom, type AnnotationPayload } from "../payloads";
import { sessionTagStore } from "@/lib/session-tag-store";

/** Every kind whose insert is a jot, with a live payload each. */
const TEXT_KINDS: ReadonlyArray<[string, AnnotationPayload]> = [
  ["email", { kind: "email", address: "kocienda@pobox.com" }],
  [
    "slash command",
    { kind: "slash-command", name: "tugplug:draft", args: "" },
  ],
  ["shell command", { kind: "shell-command", command: "just app-test" }],
];

/** One commit, shared by the block below and the plain-flavor block. */
const COMMIT_SHA = "63de5762a1b2c3d4e5f60718293a4b5c6d7e8f90";
const COMMIT: AnnotationPayload = {
  kind: "commit-sha",
  sha: COMMIT_SHA,
  root: "/repo",
  paths: ["lib/a.ts"],
};

describe("atomSegmentFor", () => {
  test("a file path answers a file segment labelled by its filename", () => {
    const segment = atomSegmentFor({
      kind: "file-path",
      path: "/repo/tugdeck/src/lib/annotator/registry.ts",
    });
    expect(segment).toEqual({
      kind: "atom",
      type: "file",
      label: "registry.ts",
      value: "/repo/tugdeck/src/lib/annotator/registry.ts",
    });
  });

  test("a cited line is dropped — an atom names a file", () => {
    const segment = atomSegmentFor({
      kind: "file-path",
      path: "/repo/lib/a.ts",
      line: 14,
      endLine: 20,
    });
    expect(segment?.value).toBe("/repo/lib/a.ts");
  });

  test("a file path round-trips through payloadForAtom", () => {
    const payload: AnnotationPayload = {
      kind: "file-path",
      path: "/repo/lib/a.ts",
    };
    const segment = atomSegmentFor(payload);
    expect(segment).not.toBeNull();
    expect(
      payloadForAtom({
        type: segment!.type,
        value: segment!.value,
        label: segment!.label,
      }),
    ).toEqual(payload);
  });

  test("a cited file path round-trips to the file itself", () => {
    const segment = atomSegmentFor({
      kind: "file-path",
      path: "/repo/lib/a.ts",
      line: 14,
    });
    expect(
      payloadForAtom({ type: segment!.type, value: segment!.value }),
    ).toEqual({ kind: "file-path", path: "/repo/lib/a.ts" });
  });

  for (const [name, payload] of TEXT_KINDS) {
    test(`a ${name} inserts as text, so it has no atom`, () => {
      expect(atomSegmentFor(payload)).toBeNull();
    });
  }

  test("an image has an atom form but is not offered one here", () => {
    // Per the arc's decision: a copied image atom would paste into another
    // card as a chip with nothing behind it, because the bytes are per-card.
    expect(
      atomSegmentFor({ kind: "image", atomId: "abc", label: "shot.png" }),
    ).toBeNull();
  });
});

describe("a directory", () => {
  test("answers a directory segment labelled by its leaf", () => {
    expect(atomSegmentFor({ kind: "directory", path: "/repo/tugdeck/src" })).toEqual({
      kind: "atom",
      type: "directory",
      label: "src",
      value: "/repo/tugdeck/src",
    });
  });

  test("carries no trailing separator, whichever form it arrived in", () => {
    // The file index's directory form carries one and `payloadForAtom` strips
    // it, so minting without it is what makes the round trip the identity.
    const segment = atomSegmentFor({ kind: "directory", path: "/repo/src/" });
    expect(segment?.value).toBe("/repo/src");
    expect(
      payloadForAtom({ type: segment!.type, value: segment!.value }),
    ).toEqual({ kind: "directory", path: "/repo/src" });
  });
});

describe("a url", () => {
  test("the value is the whole URL, always", () => {
    const url = "https://www.anthropic.com/news/some/deep/page?q=1";
    expect(atomSegmentFor({ kind: "url", url })?.value).toBe(url);
  });

  test("the label is the host, plus the last path segment when there is one", () => {
    const label = (url: string): string | undefined =>
      atomSegmentFor({ kind: "url", url })?.label;
    expect(label("https://www.anthropic.com")).toBe("anthropic.com");
    expect(label("https://anthropic.com/")).toBe("anthropic.com");
    expect(label("https://anthropic.com/research")).toBe("anthropic.com/research");
    // Anything between the host and the leaf is elided rather than dropped
    // silently — the value still carries every segment.
    expect(label("https://www.anthropic.com/news/a/research")).toBe(
      "anthropic.com/…/research",
    );
  });

  test("a URL that will not parse falls back to itself", () => {
    expect(atomSegmentFor({ kind: "url", url: "not a url" })?.label).toBe(
      "not a url",
    );
  });

  test("round-trips through payloadForAtom", () => {
    const payload: AnnotationPayload = {
      kind: "url",
      url: "https://anthropic.com/research",
    };
    const segment = atomSegmentFor(payload);
    expect(
      payloadForAtom({ type: segment!.type, value: segment!.value }),
    ).toEqual(payload);
  });
});

describe("a session", () => {
  const ID = "123e4567-e89b-42d3-a456-426614174000";

  test("an identity the ledger cannot answer for has no atom", () => {
    // [L31] at the source: no segment, so neither menu item is offered, and
    // the kind falls back to the plain text insert.
    expect(atomSegmentFor({ kind: "session", target: ID })).toBeNull();
  });

  test("a session the ledger knows answers its callsign", () => {
    sessionTagStore.setTag(ID, "brisk-otter");
    try {
      const segment = atomSegmentFor({ kind: "session", target: ID });
      expect(segment?.type).toBe("session");
      expect(segment?.value).toBe("brisk-otter");
      expect(segment?.label).toBe("brisk-otter");
    } finally {
      sessionTagStore.setTag(ID, null);
    }
  });
});

describe("a commit", () => {
  test("answers a commit atom labelled the way every commit surface names one", () => {
    expect(atomSegmentFor(COMMIT)).toEqual({
      kind: "atom",
      type: "commit",
      label: "commit:63de5762",
      value: COMMIT_SHA,
    });
  });

  test("round-trips through payloadForAtom against the card's own root", () => {
    // The value carries the sha and nothing else, so the REPOSITORY has to
    // come from the roots — the same `projectDir` a relative file value counts
    // from. `paths` comes back empty and that is the contract: it scopes the
    // diff as an optimization, the descriptor makes it optional, and only the
    // repository knows the answer.
    const segment = atomSegmentFor(COMMIT);
    expect(
      payloadForAtom(
        { type: segment!.type, value: segment!.value },
        { projectDir: "/repo", cwd: null },
      ),
    ).toEqual({
      kind: "commit-sha",
      sha: COMMIT_SHA,
      root: "/repo",
      paths: [],
    });
  });

  test("with no root to resolve against there is no payload", () => {
    // The file arm's rule, for the file arm's reason: a diff descriptor naming
    // no repository opens nothing, and a chip that looks actionable and is not
    // is the failure `payloadForAtom` exists to refuse.
    const segment = atomSegmentFor(COMMIT);
    expect(
      payloadForAtom({ type: segment!.type, value: segment!.value }),
    ).toBeNull();
    expect(
      payloadForAtom(
        { type: segment!.type, value: segment!.value },
        { projectDir: null, cwd: "/elsewhere" },
      ),
    ).toBeNull();
  });
});

describe("the plain-text flavor beside the atom", () => {
  test("a path, a directory and a URL are their own plain form", () => {
    const plain = (payload: AnnotationPayload): string =>
      atomPlainTextFor(payload, atomSegmentFor(payload)!);
    expect(plain({ kind: "file-path", path: "/repo/a.ts", line: 14 })).toBe(
      "/repo/a.ts",
    );
    expect(plain({ kind: "directory", path: "/repo/src/" })).toBe("/repo/src");
    expect(plain({ kind: "url", url: "https://anthropic.com/x" })).toBe(
      "https://anthropic.com/x",
    );
  });

  test("a commit writes its label, never the bare sha", () => {
    // The mirror of the session's rule. Plain text is what leaves Tug, and a
    // bare hash pasted outside the app names nothing a reader can place —
    // while `commit:63de5762` is the spelling every commit surface shows and
    // every commit copy path already writes.
    expect(atomPlainTextFor(COMMIT, atomSegmentFor(COMMIT)!)).toBe(
      "commit:63de5762",
    );
  });

  test("a session writes its citation, never the bare callsign", () => {
    // Plain text is what leaves Tug. `brisk-otter` alone names nothing a
    // reader outside the app can resolve; the citation carries the short id.
    // It is also the exact string a session ROW's Copy as Atom writes, and
    // one item under one name must not put two things on the clipboard.
    const ID = "123e4567-e89b-42d3-a456-426614174000";
    sessionTagStore.setTag(ID, "brisk-otter");
    try {
      const payload: AnnotationPayload = { kind: "session", target: ID };
      const segment = atomSegmentFor(payload);
      expect(segment?.value).toBe("brisk-otter");
      expect(atomPlainTextFor(payload, segment!)).toBe("brisk-otter (123e4567)");
    } finally {
      sessionTagStore.setTag(ID, null);
    }
  });
});
