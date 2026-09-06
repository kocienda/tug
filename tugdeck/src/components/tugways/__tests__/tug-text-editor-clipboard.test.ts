/**
 * tug-text-editor clipboard serialization — pure round-trip tests.
 *
 * Exercises `serializeClipboard`, `parseClipboardSidecar`, and
 * `rehydrateSidecarBytes` in isolation. The DOM event handlers and the
 * native-bridge copy/paste path that wrap these helpers are exercised
 * via app-test (`at0043`, `at0044`); this file proves the wire format
 * itself is bidirectional, carries image bytes / atom ids
 * self-contained, and rejects malformed payloads cleanly.
 */
import { describe, it, expect } from "bun:test";

import {
  parseClipboardSidecar,
  planLeadingCommandPaste,
  planLeadingCommandSidecar,
  rehydrateSidecarBytes,
  serializeClipboard,
} from "@/components/tugways/tug-text-editor/clipboard-filters";
import { TUG_ATOM_CHAR, type AtomSegment } from "@/lib/tug-atom-img";
import {
  createAtomBytesStore,
  type AtomBytesEntry,
} from "@/lib/atom-bytes-store";

const SAMPLE_FILE = {
  position: 2,
  segment: { kind: "atom" as const, type: "file", label: "main.ts", value: "/main.ts" },
};

const SAMPLE_LINK = {
  position: 5,
  segment: { kind: "atom" as const, type: "link", label: "ant", value: "https://anthropic.com" },
};

const SAMPLE_BYTES: AtomBytesEntry = {
  content: "aGVsbG8=",
  mediaType: "image/png",
  thumbnailDataUrl: "data:image/png;base64,aGVsbG8=",
};

// ---------------------------------------------------------------------------
// serializeClipboard — text + fallback
// ---------------------------------------------------------------------------

describe("serializeClipboard — text + fallback", () => {
  it("returns null sidecar when there are no atoms in the slice", () => {
    const out = serializeClipboard("hello world", [], 0);
    expect(out.text).toBe("hello world");
    expect(out.fallback).toBe("hello world");
    expect(out.sidecar).toBeNull();
  });

  it("emits sidecar atoms with positions relative to the slice origin", () => {
    const atomAt12 = { ...SAMPLE_FILE, position: 12 };
    const text = `ab${TUG_ATOM_CHAR}cd`;
    const out = serializeClipboard(text, [atomAt12], 10);
    expect(out.text).toBe(text);
    expect(out.sidecar).not.toBeNull();
    expect(out.sidecar!.text).toBe(text);
    expect(out.sidecar!.atoms).toEqual([
      { position: 2, segment: atomAt12.segment },
    ]);
  });

  it("expands U+FFFC into each atom's plain-text spelling in the fallback", () => {
    // The editor's own copy reads `atomPlainText`, the same table the
    // substrate copy and the annotation menu read — so a file keeps its path
    // here exactly as it does through every other door.
    const text = `pre ${TUG_ATOM_CHAR} mid ${TUG_ATOM_CHAR} end`;
    const atoms = [
      { ...SAMPLE_FILE, position: 4 },
      { ...SAMPLE_LINK, position: 10 },
    ];
    const out = serializeClipboard(text, atoms, 0);
    expect(out.fallback).toBe(
      "pre [main.ts](</main.ts>) mid [ant](<https://anthropic.com>) end",
    );
  });

  it("processes labels back-to-front so earlier replacements don't disturb later positions", () => {
    const text = `${TUG_ATOM_CHAR}_${TUG_ATOM_CHAR}`;
    const atoms = [
      {
        position: 0,
        segment: {
          kind: "atom" as const,
          type: "file",
          label: "a-very-long-filename.tsx",
          value: "v",
        },
      },
      {
        position: 2,
        segment: {
          kind: "atom" as const,
          type: "file",
          label: "x",
          value: "v",
        },
      },
    ];
    const out = serializeClipboard(text, atoms, 0);
    expect(out.fallback).toBe("[a-very-long-filename.tsx](<v>)_[x](<v>)");
  });
});

// ---------------------------------------------------------------------------
// serializeClipboard — self-contained image bytes
// ---------------------------------------------------------------------------

describe("serializeClipboard — image bytes", () => {
  const imageAtom = {
    position: 0,
    segment: {
      kind: "atom" as const,
      type: "image",
      label: "Bug-87A.png",
      value: "image-1",
      id: "id-abc",
    },
  };

  it("attaches stored bytes inline for image atoms with an id", () => {
    const getBytes = (id: string) => (id === "id-abc" ? SAMPLE_BYTES : null);
    const out = serializeClipboard(TUG_ATOM_CHAR, [imageAtom], 0, getBytes);
    expect(out.sidecar!.atoms[0]!.bytes).toEqual(SAMPLE_BYTES);
    // The id rides along on the segment so paste can key the store.
    expect(out.sidecar!.atoms[0]!.segment.id).toBe("id-abc");
  });

  it("omits bytes when no resolver is supplied", () => {
    const out = serializeClipboard(TUG_ATOM_CHAR, [imageAtom], 0);
    expect(out.sidecar!.atoms[0]!.bytes).toBeUndefined();
    expect(out.sidecar!.atoms[0]!.segment.id).toBe("id-abc");
  });

  it("omits bytes when the resolver has no entry for the id", () => {
    const out = serializeClipboard(TUG_ATOM_CHAR, [imageAtom], 0, () => null);
    expect(out.sidecar!.atoms[0]!.bytes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseClipboardSidecar
// ---------------------------------------------------------------------------

describe("parseClipboardSidecar", () => {
  it("round-trips a serialized payload (with text field)", () => {
    const text = `ab${TUG_ATOM_CHAR}cd`;
    const out = serializeClipboard(text, [SAMPLE_FILE], 0);
    const parsed = parseClipboardSidecar(JSON.stringify(out.sidecar));
    expect(parsed).toEqual(out.sidecar);
  });

  it("round-trips an image atom's id and bytes", () => {
    const imageAtom = {
      position: 0,
      segment: {
        kind: "atom" as const,
        type: "image",
        label: "Bug-87A.png",
        value: "image-1",
        id: "id-xyz",
      },
    };
    const out = serializeClipboard(
      TUG_ATOM_CHAR,
      [imageAtom],
      0,
      () => SAMPLE_BYTES,
    );
    const parsed = parseClipboardSidecar(JSON.stringify(out.sidecar));
    expect(parsed).toEqual(out.sidecar);
    expect(parsed!.atoms[0]!.segment.id).toBe("id-xyz");
    expect(parsed!.atoms[0]!.bytes).toEqual(SAMPLE_BYTES);
  });

  it("drops malformed bytes but keeps the atom", () => {
    const payload = {
      version: 1,
      text: TUG_ATOM_CHAR,
      atoms: [
        {
          position: 0,
          segment: { kind: "atom", type: "image", label: "a", value: "v", id: "i" },
          bytes: { content: 42, mediaType: "image/png" },
        },
      ],
    };
    const parsed = parseClipboardSidecar(JSON.stringify(payload));
    expect(parsed).not.toBeNull();
    expect(parsed!.atoms[0]!.bytes).toBeUndefined();
    expect(parsed!.atoms[0]!.segment.id).toBe("i");
  });

  it("returns null for non-JSON input", () => {
    expect(parseClipboardSidecar("not-json")).toBeNull();
    expect(parseClipboardSidecar("")).toBeNull();
  });

  it("returns null for unknown version values", () => {
    const payload = { version: 42, text: "", atoms: [] };
    expect(parseClipboardSidecar(JSON.stringify(payload))).toBeNull();
  });

  it("returns null when text field is missing or wrong type", () => {
    expect(parseClipboardSidecar(JSON.stringify({ version: 1, atoms: [] }))).toBeNull();
    expect(
      parseClipboardSidecar(JSON.stringify({ version: 1, text: 42, atoms: [] })),
    ).toBeNull();
  });

  it("returns null when atoms is missing or not an array", () => {
    expect(parseClipboardSidecar(JSON.stringify({ version: 1, text: "" }))).toBeNull();
    expect(
      parseClipboardSidecar(JSON.stringify({ version: 1, text: "", atoms: "x" })),
    ).toBeNull();
  });

  it("rejects atom entries missing required fields", () => {
    const missingType = {
      version: 1,
      text: TUG_ATOM_CHAR,
      atoms: [{ position: 0, segment: { kind: "atom", label: "a", value: "v" } }],
    };
    expect(parseClipboardSidecar(JSON.stringify(missingType))).toBeNull();

    const missingPosition = {
      version: 1,
      text: TUG_ATOM_CHAR,
      atoms: [{ segment: { kind: "atom", type: "file", label: "a", value: "v" } }],
    };
    expect(parseClipboardSidecar(JSON.stringify(missingPosition))).toBeNull();
  });

  it("ignores unknown segment kinds", () => {
    const wrongKind = {
      version: 1,
      text: TUG_ATOM_CHAR,
      atoms: [
        {
          position: 0,
          segment: { kind: "non-atom", type: "file", label: "a", value: "v" },
        },
      ],
    };
    expect(parseClipboardSidecar(JSON.stringify(wrongKind))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// rehydrateSidecarBytes — restore image bytes into a destination store
// ---------------------------------------------------------------------------

describe("rehydrateSidecarBytes", () => {
  it("puts carried bytes into the store keyed by atom id", () => {
    const store = createAtomBytesStore();
    const payload = {
      version: 1 as const,
      text: TUG_ATOM_CHAR,
      atoms: [
        {
          position: 0,
          segment: {
            kind: "atom" as const,
            type: "image",
            label: "x",
            value: "v",
            id: "id-1",
          },
          bytes: SAMPLE_BYTES,
        },
      ],
    };
    rehydrateSidecarBytes(payload, store);
    expect(store.get("id-1")).toEqual(SAMPLE_BYTES);
  });

  it("skips atoms without bytes or without an id, and tolerates a null store", () => {
    const store = createAtomBytesStore();
    const payload = {
      version: 1 as const,
      text: `${TUG_ATOM_CHAR}${TUG_ATOM_CHAR}`,
      atoms: [
        // bytes but no id — nowhere to key it
        {
          position: 0,
          segment: { kind: "atom" as const, type: "image", label: "x", value: "v" },
          bytes: SAMPLE_BYTES,
        },
        // id but no bytes — a plain file atom
        {
          position: 1,
          segment: {
            kind: "atom" as const,
            type: "file",
            label: "y",
            value: "/y",
            id: "id-2",
          },
        },
      ],
    };
    rehydrateSidecarBytes(payload, store);
    expect(store.size()).toBe(0);
    // Null store is a no-op, not a throw.
    expect(() => rehydrateSidecarBytes(payload, null)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// planLeadingCommandPaste — chip a slash command pasted at offset 0
// ---------------------------------------------------------------------------

describe("planLeadingCommandPaste", () => {
  const atomFor = (name: string): AtomSegment => ({
    kind: "atom",
    type: "command",
    label: name,
    value: name,
  });

  // Resolver that knows one plugin command, matching its full name or leaf.
  const resolve = (token: string): AtomSegment | null => {
    if (token === "tugplug:implement" || token === "implement") {
      return atomFor("tugplug:implement");
    }
    return null;
  };

  it("chips a full-name command and keeps the rest as argument text", () => {
    const plan = planLeadingCommandPaste(
      "/tugplug:implement arc/foo.md",
      0,
      resolve,
    );
    expect(plan).not.toBeNull();
    expect(plan!.insert).toBe(`${TUG_ATOM_CHAR} arc/foo.md`);
    expect(plan!.segment).toEqual(atomFor("tugplug:implement"));
  });

  it("resolves an unqualified leaf to the full command atom", () => {
    const plan = planLeadingCommandPaste("/implement arc/foo.md", 0, resolve);
    expect(plan).not.toBeNull();
    expect(plan!.segment).toEqual(atomFor("tugplug:implement"));
    expect(plan!.insert).toBe(`${TUG_ATOM_CHAR} arc/foo.md`);
  });

  it("inserts a separating space when the command stands alone", () => {
    const plan = planLeadingCommandPaste("/tugplug:implement", 0, resolve);
    expect(plan!.insert).toBe(`${TUG_ATOM_CHAR} `);
  });

  it("does not double the separator when the rest already opens with space", () => {
    const plan = planLeadingCommandPaste("/implement  two-spaces", 0, resolve);
    // The pasted run's own leading whitespace is preserved verbatim.
    expect(plan!.insert).toBe(`${TUG_ATOM_CHAR}  two-spaces`);
  });

  it("returns null when the paste does not land at offset 0", () => {
    expect(planLeadingCommandPaste("/implement x", 5, resolve)).toBeNull();
  });

  it("returns null when the leading token is not a known command", () => {
    expect(planLeadingCommandPaste("/unknown thing", 0, resolve)).toBeNull();
    expect(planLeadingCommandPaste("not a command", 0, resolve)).toBeNull();
    expect(planLeadingCommandPaste("/path/to/file.md", 0, resolve)).toBeNull();
  });

  // A copy from a Tug surface carries a sidecar even when it holds no atoms —
  // provenance alone mints one — so the sidecar route has to chip the command
  // too, or the same text behaves one way from another app and another from
  // Tug.
  describe("planLeadingCommandSidecar", () => {
    it("chips the command in an atomless provenance-only sidecar", () => {
      const plan = planLeadingCommandSidecar(
        {
          version: 1,
          text: "/tugplug:implement arc/foo.md",
          atoms: [],
          origins: ["/repo"],
        },
        0,
        resolve,
      );
      expect(plan).not.toBeNull();
      expect(plan!.insert).toBe(`${TUG_ATOM_CHAR} arc/foo.md`);
      expect(plan!.atoms).toEqual([
        { position: 0, segment: atomFor("tugplug:implement") },
      ]);
    });

    it("carries the sidecar's own atoms across at their shifted offsets", () => {
      const mention: AtomSegment = {
        kind: "atom",
        type: "file",
        label: "foo.md",
        value: "arc/foo.md",
      };
      // "/implement " is 11 chars; the chip + separator is 2, so the atom at
      // 11 lands at 2 and the trailing text keeps its distance from the end.
      const plan = planLeadingCommandSidecar(
        {
          version: 1,
          text: `/implement ${TUG_ATOM_CHAR} now`,
          atoms: [{ position: 11, segment: mention }],
        },
        0,
        resolve,
      );
      expect(plan!.insert).toBe(`${TUG_ATOM_CHAR} ${TUG_ATOM_CHAR} now`);
      expect(plan!.atoms).toEqual([
        { position: 0, segment: atomFor("tugplug:implement") },
        { position: 2, segment: mention },
      ]);
    });

    it("inserts verbatim when an atom sits inside the leading token", () => {
      const chip: AtomSegment = {
        kind: "atom",
        type: "command",
        label: "x",
        value: "x",
      };
      // U+FFFC is not whitespace, so `/⟦atom⟧` matches the token regex — the
      // token was never text and must not be chipped.
      expect(
        planLeadingCommandSidecar(
          {
            version: 1,
            text: `/${TUG_ATOM_CHAR}`,
            atoms: [{ position: 1, segment: chip }],
          },
          0,
          resolve,
        ),
      ).toBeNull();
    });

    it("returns null for a sidecar that does not land at offset 0", () => {
      expect(
        planLeadingCommandSidecar(
          { version: 1, text: "/implement x", atoms: [] },
          5,
          resolve,
        ),
      ).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Attachment interop fields — they have to survive their own parser
// ---------------------------------------------------------------------------

describe("sidecar attachment fields round-trip", () => {
  it("preserves assetPath, assetName, and bytes.path through parse", () => {
    // The parser does not pass objects through — it reconstructs every entry
    // from a named field list. A field the writer adds and the reader does not
    // name is stripped on every paste, silently, which is exactly what this
    // guards. `bytes.path` matters most: it names the ORIGINAL upload where
    // `content` is the downsample, so a destination that loses it can only
    // write a degraded copy of the image — and the degraded copy renders
    // convincingly enough that nobody notices.
    const payload = {
      version: 1 as const,
      text: `a${TUG_ATOM_CHAR}b`,
      atoms: [
        {
          position: 1,
          segment: {
            kind: "atom" as const,
            type: "image",
            label: "image-1",
            value: "image-1",
            id: "abc-123",
          },
          bytes: { ...SAMPLE_BYTES, path: "/u/docs/assets/photo.png" },
          assetPath: "/u/docs/assets/photo.png",
          assetName: "photo.png",
        },
      ],
    };

    const parsed = parseClipboardSidecar(JSON.stringify(payload));

    expect(parsed).not.toBeNull();
    expect(parsed!.atoms[0]).toEqual(payload.atoms[0]);
    expect(parsed!.atoms[0].bytes!.path).toBe("/u/docs/assets/photo.png");
  });

  it("preserves the non-atom asset range list", () => {
    // A non-image link is a range of literal text, not a U+FFFC position, so
    // it cannot ride as an atom entry — it rides here instead.
    const payload = {
      version: 1 as const,
      text: "see [notes](assets/notes.zip) for more",
      atoms: [],
      assets: [
        {
          from: 4,
          to: 28,
          assetPath: "/u/docs/assets/notes.zip",
          assetName: "notes.zip",
        },
      ],
    };

    const parsed = parseClipboardSidecar(JSON.stringify(payload));

    expect(parsed).not.toBeNull();
    expect(parsed!.assets).toEqual(payload.assets);
  });

  it("a payload with none of the new fields parses unchanged", () => {
    // Every sidecar written before this existed, and every copy of a
    // selection that has no attachments in it.
    const payload = {
      version: 1 as const,
      text: `a${TUG_ATOM_CHAR}b`,
      atoms: [{ position: 1, segment: SAMPLE_FILE.segment }],
    };

    const parsed = parseClipboardSidecar(JSON.stringify(payload));

    expect(parsed).toEqual(payload);
    expect(parsed!.assets).toBeUndefined();
  });

  it("drops a malformed asset range rather than the whole payload", () => {
    const parsed = parseClipboardSidecar(
      JSON.stringify({
        version: 1,
        text: "hello",
        atoms: [],
        assets: [{ from: "nope", to: 3, assetPath: "/x", assetName: "x" }],
      }),
    );

    // Degrading to reference-only is the correct behavior; refusing the paste
    // outright over one bad range is not.
    expect(parsed).not.toBeNull();
    expect(parsed!.text).toBe("hello");
    expect(parsed!.assets).toBeUndefined();
  });
});

describe("origins — the project a copied passage was written against", () => {
  // Prose cites files relative to a root the sentence never names. Carrying
  // that root is what lets `tugdeck/src/x.css:12` still name a file after the
  // text lands in a jot, a surface bound to no project at all.

  it("rides the sidecar and survives the round trip", () => {
    const payload = serializeClipboard("see lib/a.ts", [], 0, undefined, [
      "/repo",
    ]);
    expect(payload.sidecar?.origins).toEqual(["/repo"]);
    const parsed = parseClipboardSidecar(JSON.stringify(payload.sidecar));
    expect(parsed?.origins).toEqual(["/repo"]);
  });

  it("mints a sidecar for prose with no atoms at all", () => {
    // The ordinary case, and the one with nothing else to ride on: before
    // this, a selection without atoms wrote no sidecar and there was nowhere
    // for a root to go.
    const bare = serializeClipboard("see lib/a.ts", [], 0);
    expect(bare.sidecar).toBeNull();
    const carried = serializeClipboard("see lib/a.ts", [], 0, undefined, [
      "/repo",
    ]);
    expect(carried.sidecar).not.toBeNull();
    expect(carried.sidecar?.atoms).toEqual([]);
    expect(carried.sidecar?.text).toBe("see lib/a.ts");
  });

  it("keeps carrying atoms when it also carries a root", () => {
    const payload = serializeClipboard(
      `a${TUG_ATOM_CHAR}b`,
      [{ position: 1, segment: SAMPLE_FILE.segment }],
      0,
      undefined,
      ["/repo"],
    );
    expect(payload.sidecar?.atoms).toHaveLength(1);
    expect(payload.sidecar?.origins).toEqual(["/repo"]);
  });

  it("refuses a relative root, which would have to be resolved against the reader", () => {
    // Resolving it against the DESTINATION's project is exactly the assumption
    // the field exists to stop making, so a root that isn't absolute is no
    // root at all.
    const payload = serializeClipboard("see lib/a.ts", [], 0, undefined, [
      "repo",
    ]);
    expect(payload.sidecar).toBeNull();
    expect(
      parseClipboardSidecar(
        JSON.stringify({ version: 1, text: "t", atoms: [], origins: ["repo"] }),
      )?.origins,
    ).toBeUndefined();
  });

  it("dedupes and drops non-strings without failing the parse", () => {
    const parsed = parseClipboardSidecar(
      JSON.stringify({
        version: 1,
        text: "t",
        atoms: [],
        origins: ["/repo", "/repo", 7, "/other"],
      }),
    );
    expect(parsed?.origins).toEqual(["/repo", "/other"]);
  });

  it("a payload written before origins existed still parses", () => {
    const parsed = parseClipboardSidecar(
      JSON.stringify({ version: 1, text: "t", atoms: [] }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.origins).toBeUndefined();
  });
});
