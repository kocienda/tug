/**
 * session-atom.test.ts — the session atom's payload composition.
 *
 * The end-to-end evidence that the sidecar was written correctly is the paste
 * round-trip in the app-test: if the sidecar were wrong the chip would come
 * back as plain text. What is testable here is the payload BUILDER — the
 * shape the sidecar parser reads, and the two flat-text forms.
 */

import { describe, expect, test } from "bun:test";

import { parseClipboardSidecar } from "@/components/tugways/tug-text-editor/clipboard-filters";
import { wrapAtomMention, parseAtomMentionSegments } from "@/lib/atom-mention-marker";
import { composeSessionIdentity } from "@/lib/session-identity";
import {
  SESSION_ATOM_TYPE,
  sessionAtomClipboardPayload,
  sessionAtomCallsign,
  sessionAtomProject,
  sessionAtomSegment,
  sessionVerdictAskKey,
} from "@/lib/session-atom";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-img";

const ID = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

function identity(over: Partial<Parameters<typeof composeSessionIdentity>[0]> = {}) {
  return composeSessionIdentity({
    sessionId: ID,
    name: null,
    synopsis: null,
    tag: "syrupy-beam",
    projectDir: "/Users/k/src/tugtool",
    ...over,
  });
}

describe("sessionAtomSegment", () => {
  test("is a real atom segment, typed `session`", () => {
    const seg = sessionAtomSegment(identity());
    expect(seg.kind).toBe("atom");
    expect(seg.type).toBe(SESSION_ATOM_TYPE);
  });

  test("label and value are both the callsign run — what the chip shows is what the wire carries", () => {
    const seg = sessionAtomSegment(identity());
    expect(seg.label).toBe("tugtool/syrupy-beam");
    expect(seg.value).toBe("tugtool/syrupy-beam");
    expect(seg.value).toBe(seg.label);
  });

  test("a lineage-bearing callsign rides whole", () => {
    expect(sessionAtomSegment(identity({ tag: "syrupy-beam-A1" })).value).toBe(
      "tugtool/syrupy-beam-A1",
    );
  });
});

describe("sessionAtomClipboardPayload", () => {
  test("round-trips through the production sidecar parser", () => {
    const payload = sessionAtomClipboardPayload(identity());
    const parsed = parseClipboardSidecar(JSON.stringify(payload));
    expect(parsed).not.toBeNull();
    expect(parsed?.atoms.length).toBe(1);
    expect(parsed?.atoms[0].position).toBe(0);
    expect(parsed?.atoms[0].segment.type).toBe(SESSION_ATOM_TYPE);
    expect(parsed?.atoms[0].segment.value).toBe("tugtool/syrupy-beam");
  });

  test("the text is one object-replacement char — the atom's own position", () => {
    const payload = sessionAtomClipboardPayload(identity());
    expect(payload.text).toBe(TUG_ATOM_CHAR);
    expect(payload.text.length).toBe(1);
  });
});

describe("the session identity the atom carries", () => {
  test("the minted segment carries the uuid and the project dir", () => {
    const seg = sessionAtomSegment(identity());
    expect(seg.session).toEqual({
      id: ID,
      projectDir: "/Users/k/src/tugtool",
    });
    // The two spellings the chip and the wire read are untouched by it: the
    // pair is carried BESIDE the name, never in place of it.
    expect(seg.label).toBe("tugtool/syrupy-beam");
    expect(seg.value).toBe("tugtool/syrupy-beam");
  });

  test("an identity resolved from a recorded reference carries no pair", () => {
    // `recordedProject` is a leaf-name a reference reported, not a dir this
    // instance resolved — so there is no project dir, and half a pair is not
    // a reference.
    const seg = sessionAtomSegment(
      identity({ projectDir: null, recordedProject: "tugtool" }),
    );
    expect(seg.value).toBe("tugtool/syrupy-beam");
    expect(seg.session).toBeUndefined();
  });

  test("it survives the sidecar round trip through the production parser", () => {
    const payload = sessionAtomClipboardPayload(identity());
    const parsed = parseClipboardSidecar(JSON.stringify(payload));
    expect(parsed?.atoms[0].segment.session).toEqual({
      id: ID,
      projectDir: "/Users/k/src/tugtool",
    });
  });

  test("a sidecar with no pair parses, and the atom comes back whole", () => {
    const payload = sessionAtomClipboardPayload(identity());
    delete payload.atoms[0].segment.session;
    const parsed = parseClipboardSidecar(JSON.stringify(payload));
    expect(parsed?.atoms[0].segment.value).toBe("tugtool/syrupy-beam");
    expect(parsed?.atoms[0].segment.session).toBeUndefined();
  });

  test("a malformed pair is dropped and never costs the payload", () => {
    // Each of these is a shape some older or foreign writer could put on the
    // clipboard. None of them may reject the atom: the pair is how a
    // reference is FOUND, not what makes it one.
    for (const bad of [
      "tugtool/syrupy-beam",
      { id: ID },
      { projectDir: "/Users/k/src/tugtool" },
      { id: ID, projectDir: "" },
      { id: 7, projectDir: "/Users/k/src/tugtool" },
      null,
    ]) {
      const payload = sessionAtomClipboardPayload(identity());
      (payload.atoms[0].segment as unknown as Record<string, unknown>).session = bad;
      const parsed = parseClipboardSidecar(JSON.stringify(payload));
      expect(parsed).not.toBeNull();
      expect(parsed?.atoms[0].segment.value).toBe("tugtool/syrupy-beam");
      expect(parsed?.atoms[0].segment.session).toBeUndefined();
    }
  });
});

describe("sessionVerdictAskKey", () => {
  test("an atom carrying an identity is asked about by its uuid", () => {
    expect(sessionVerdictAskKey(sessionAtomSegment(identity()))).toBe(ID);
  });

  test("an atom without one is asked about by its WHOLE value", () => {
    // Never the callsign half. The project half is a filter the resolver
    // applies for itself, and dropping it asks about every session on the
    // machine wearing that callsign.
    const seg = sessionAtomSegment(
      identity({ projectDir: null, recordedProject: "tugtool" }),
    );
    expect(sessionVerdictAskKey(seg)).toBe("tugtool/syrupy-beam");
    expect(sessionVerdictAskKey(seg)).not.toBe("syrupy-beam");
  });
});

describe("sessionAtomCallsign", () => {
  test("is what the chip resolves through — the display keeps the whole run", () => {
    // The atom carries no id: the callsign is the whole of what a chip — in the
    // composer, or replayed from a wire marker — has to reach the ledger with.
    expect(sessionAtomCallsign(sessionAtomSegment(identity()).value)).toBe(
      "syrupy-beam",
    );
    expect(sessionAtomCallsign("tugtool/syrupy-beam-A1-B2")).toBe(
      "syrupy-beam-A1-B2",
    );
  });

  test("a value that is already a callsign passes through", () => {
    expect(sessionAtomCallsign("syrupy-beam")).toBe("syrupy-beam");
  });
});

describe("sessionAtomProject", () => {
  test("is the value's recorded project head, for display", () => {
    expect(sessionAtomProject(sessionAtomSegment(identity()).value)).toBe(
      "tugtool",
    );
    expect(sessionAtomProject("tugtool/syrupy-beam-A1-B2")).toBe("tugtool");
  });

  test("a bare-callsign value records no project", () => {
    expect(sessionAtomProject("syrupy-beam")).toBeNull();
  });
});

describe("the wire marker round-trip", () => {
  test("a session mention wraps and parses back to its callsign", () => {
    const value = sessionAtomSegment(identity()).value;
    const wrapped = wrapAtomMention(value);
    expect(wrapped).toBe("`@tugtool/syrupy-beam`");
    const segments = parseAtomMentionSegments(`see ${wrapped} for context`);
    expect(segments).toEqual([
      { kind: "text", text: "see " },
      { kind: "mention", value: "tugtool/syrupy-beam" },
      { kind: "text", text: " for context" },
    ]);
  });

  test("a lineage callsign survives the marker — the `-A1` is not marker syntax", () => {
    const wrapped = wrapAtomMention("tugtool/syrupy-beam-A1-B2");
    const segments = parseAtomMentionSegments(wrapped);
    expect(segments).toEqual([
      { kind: "mention", value: "tugtool/syrupy-beam-A1-B2" },
    ]);
  });
});
