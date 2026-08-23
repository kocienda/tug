/**
 * session-identity.test.ts — the resolver's pure derivation.
 *
 * Precedence and the two flat-text forms. The reactivity
 * contract (`useSessionIdentity` repaints a live surface on `/rename`) is not
 * testable here by design — a render test would be the banned pattern — and is
 * covered by an app-test on the real app.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  callsignRunParts,
  composeSessionIdentity,
  projectLeafName,
  resolveCitedSession,
  resolveSessionIdentity,
  sessionCitation,
  sessionDisplayTitle,
  sessionIdentityLine,
  sessionTitleParts,
  shortSessionId,
  SESSION_SHORT_ID_LENGTH,
} from "@/lib/session-identity";
import { sessionNameStore } from "@/lib/session-name-store";
import { sessionTagStore } from "@/lib/session-tag-store";

const ID = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const SHORT = "f6e43925";

function identity(over: Partial<Parameters<typeof composeSessionIdentity>[0]> = {}) {
  return composeSessionIdentity({
    sessionId: ID,
    name: null,
    synopsis: null,
    tag: "stocky-pixie",
    projectDir: "/Users/k/src/tugtool",
    ...over,
  });
}

describe("shortSessionId", () => {
  test("is the first 8 chars, computed in exactly one place", () => {
    expect(shortSessionId(ID)).toBe(SHORT);
    expect(SESSION_SHORT_ID_LENGTH).toBe(8);
  });
});

describe("projectLeafName", () => {
  test("takes the basename and ignores trailing slashes", () => {
    expect(projectLeafName("/Users/k/src/tugtool")).toBe("tugtool");
    expect(projectLeafName("/Users/k/src/tugtool///")).toBe("tugtool");
  });

  test("degrades to the trimmed input for a slash-only path", () => {
    expect(projectLeafName("/")).toBe("");
  });
});

describe("customName and description", () => {
  test("both stand independently, with no fallback between them", () => {
    const both = identity({
      name: "Refactor the Lens",
      synopsis: "Reworking the pane chrome",
    });
    expect(both.customName).toBe("Refactor the Lens");
    expect(both.description).toBe("Reworking the pane chrome");
  });

  test("a name without a description leaves the description empty", () => {
    const named = identity({ name: "Refactor the Lens" });
    expect(named.customName).toBe("Refactor the Lens");
    expect(named.description).toBeNull();
  });

  test("a description without a name leaves the name empty", () => {
    const described = identity({ synopsis: "Reworking the pane chrome" });
    expect(described.customName).toBeNull();
    expect(described.description).toBe("Reworking the pane chrome");
  });

  test("a session with neither has both honestly empty", () => {
    expect(identity().customName).toBeNull();
    expect(identity().description).toBeNull();
  });

  test("blank strings are unset, not values", () => {
    const blank = identity({ name: "   ", synopsis: "  " });
    expect(blank.customName).toBeNull();
    expect(blank.description).toBeNull();
  });
});

describe("sessionTitleParts", () => {
  test("a custom name REMOVES the callsign — no run, no residue", () => {
    const parts = sessionTitleParts(
      identity({ name: "Refactor the Lens", tag: "stocky-pixie" }),
    );
    expect(parts).toEqual({
      name: "Refactor the Lens",
      callsign: null,
    });
  });

  test("a name collision brings the callsign back as the disambiguation", () => {
    const parts = sessionTitleParts(
      identity({
        name: "Refactor the Lens",
        tag: "stocky-pixie",
        nameShared: true,
      }),
    );
    expect(parts).toEqual({
      name: "Refactor the Lens",
      callsign: "tugtool/stocky-pixie",
    });
  });

  test("the collision fact is inert without a custom name to collide on", () => {
    const record = identity({ nameShared: true });
    expect(record.nameShared).toBe(false);
    expect(sessionTitleParts(record)).toEqual({
      name: "tugtool/stocky-pixie",
      callsign: null,
    });
  });

  test("an unnamed session's title IS the identity line, with no second run", () => {
    expect(sessionTitleParts(identity({ tag: "stocky-pixie" }))).toEqual({
      name: "tugtool/stocky-pixie",
      callsign: null,
    });
  });

  test("a session with no known project degrades to the bare callsign", () => {
    expect(
      sessionTitleParts(identity({ tag: "stocky-pixie", projectDir: null })),
    ).toEqual({ name: "stocky-pixie", callsign: null });
  });

  test("a legacy tagless session degrades to its short id, never the UUID", () => {
    expect(sessionTitleParts(identity({ tag: null }))).toEqual({
      name: `tugtool/${SHORT}`,
      callsign: null,
    });
    expect(
      sessionTitleParts(
        identity({ name: "The mint work", tag: null, nameShared: true }),
      ),
    ).toEqual({ name: "The mint work", callsign: `tugtool/${SHORT}` });
  });

  test("the description is not a title candidate — it is the line beneath", () => {
    expect(
      sessionTitleParts(identity({ synopsis: "Reworking the pane chrome" })),
    ).toEqual({ name: "tugtool/stocky-pixie", callsign: null });
  });

  test("the callsign run IS the Line channel — one spelling, two readers", () => {
    // Under a collision, so a callsign run exists to compare.
    const named = identity({ name: "Refactor the Lens", nameShared: true });
    expect(sessionTitleParts(named).name).not.toContain("/");
    expect(sessionTitleParts(named).callsign).toBe(sessionIdentityLine(named));
    expect(sessionIdentityLine(named)).toBe("tugtool/stocky-pixie");
  });

  test("a recorded project fills the prefix for display without resolving", () => {
    const cited = identity({
      projectDir: null,
      recordedProject: "broadsheet",
      ledgerKnown: false,
      tag: null,
      recordedTag: "kooky-taper",
    });
    expect(sessionTitleParts(cited)).toEqual({
      name: "broadsheet/kooky-taper",
      callsign: null,
    });
    expect(cited.resolved).toBe(false);
  });
});

describe("sessionDisplayTitle — the flat form of the same rule", () => {
  test("a custom name is the whole string", () => {
    expect(
      sessionDisplayTitle(identity({ name: "Refactor the Lens" })),
    ).toBe("Refactor the Lens");
  });

  test("a collision appends the callsign with the two-run separator", () => {
    expect(
      sessionDisplayTitle(
        identity({ name: "Refactor the Lens", nameShared: true }),
      ),
    ).toBe("Refactor the Lens:tugtool/stocky-pixie");
  });

  test("an unnamed session is its identity line, unchanged", () => {
    expect(sessionDisplayTitle(identity())).toBe("tugtool/stocky-pixie");
    expect(sessionDisplayTitle(identity())).toBe(
      sessionIdentityLine(identity()),
    );
  });

  test("it is the two runs joined — never a third spelling", () => {
    for (const record of [
      identity(),
      identity({ name: "The mint work" }),
      identity({ name: "The mint work", nameShared: true }),
      identity({ tag: null }),
    ]) {
      const { name, callsign } = sessionTitleParts(record);
      expect(sessionDisplayTitle(record)).toBe(
        callsign === null ? name : `${name}:${callsign}`,
      );
    }
  });
});

describe("callsignRunParts — where a middle truncation cuts", () => {
  test("the cut is the first hyphen after the project prefix", () => {
    expect(callsignRunParts("tugtool/frothy-nurse-2")).toEqual({
      head: "tugtool/frothy-",
      tail: "nurse-2",
    });
  });

  test("a hyphen in the project name is not the cut", () => {
    expect(callsignRunParts("my-repo/stocky-pixie")).toEqual({
      head: "my-repo/stocky-",
      tail: "pixie",
    });
  });

  test("a hyphenless callsign is all head — there is nothing to preserve", () => {
    expect(callsignRunParts("tugtool/deadbeef")).toEqual({
      head: "tugtool/deadbeef",
      tail: "",
    });
  });

  test("an unprefixed callsign splits the same way", () => {
    expect(callsignRunParts("stocky-pixie")).toEqual({
      head: "stocky-",
      tail: "pixie",
    });
  });

  test("the halves rejoin to the original, always", () => {
    for (const callsign of [
      "tugtool/frothy-nurse-2",
      "tugtool/deadbeef",
      "stocky-pixie",
      "a-b-c-d",
      "",
    ]) {
      const { head, tail } = callsignRunParts(callsign);
      expect(head + tail).toBe(callsign);
    }
  });
});

/**
 * The collision verdict, driven through the real store `resolveSessionIdentity`
 * reads — there is no seam to derive it without it, and inventing one would
 * be testing a copy of the rule rather than the rule. There is no kin
 * exemption: a rewind-fork inherits its parent's name with its callsign, so
 * kin never share a name and any peer spelling it the same way is a genuine
 * second thing to tell apart.
 */
describe("nameShared — who counts as a collision", () => {
  const SELF = "aaaaaaaa-0000-4000-8000-000000000001";
  const STRANGER = "aaaaaaaa-0000-4000-8000-000000000003";
  const NAME = "layout-imposer-xp";

  function seed(entries: { id: string; name: string | null; tag: string | null }[]) {
    for (const { id, name, tag } of entries) {
      sessionNameStore.setName(id, name);
      sessionTagStore.setTag(id, tag);
    }
  }

  afterEach(() => {
    for (const id of [SELF, STRANGER]) {
      sessionNameStore.setName(id, null);
      sessionTagStore.setTag(id, null);
    }
  });

  test("a name nobody else holds is no collision", () => {
    seed([{ id: SELF, name: NAME, tag: "nutty-gnat" }]);
    expect(resolveSessionIdentity(SELF).nameShared).toBe(false);
  });

  test("another session taking the same name IS a collision", () => {
    seed([
      { id: SELF, name: NAME, tag: "nutty-gnat" },
      { id: STRANGER, name: NAME, tag: "frothy-nurse" },
    ]);
    expect(resolveSessionIdentity(SELF).nameShared).toBe(true);
    expect(resolveSessionIdentity(STRANGER).nameShared).toBe(true);
  });

  test("a tagless session sharing the name still collides", () => {
    seed([
      { id: SELF, name: NAME, tag: null },
      { id: STRANGER, name: NAME, tag: "nutty-gnat" },
    ]);
    expect(resolveSessionIdentity(SELF).nameShared).toBe(true);
    expect(resolveSessionIdentity(STRANGER).nameShared).toBe(true);
  });

  test("a differently spelled name is not shared at all", () => {
    seed([
      { id: SELF, name: NAME, tag: "nutty-gnat" },
      { id: STRANGER, name: "some other name", tag: "frothy-nurse" },
    ]);
    expect(resolveSessionIdentity(SELF).nameShared).toBe(false);
  });
});

describe("sessionIdentityLine", () => {
  test("is project/callsign — no branch suffix, no name arm", () => {
    expect(sessionIdentityLine(identity({ branch: "feature/x" }))).toBe(
      "tugtool/stocky-pixie",
    );
    expect(sessionIdentityLine(identity({ name: "Refactor the Lens" }))).toBe(
      "tugtool/stocky-pixie",
    );
  });

  test("carries the lineage suffix the tag already composes", () => {
    expect(sessionIdentityLine(identity({ tag: "stocky-pixie-A1" }))).toBe(
      "tugtool/stocky-pixie-A1",
    );
  });

  test("a legacy tagless session degrades to its short id, never the UUID", () => {
    const line = sessionIdentityLine(identity({ tag: null }));
    expect(line).toBe(`tugtool/${SHORT}`);
    expect(line).not.toContain(ID);
  });

  test("drops the prefix when the project is unknown", () => {
    expect(sessionIdentityLine(identity({ projectDir: null }))).toBe(
      "stocky-pixie",
    );
  });
});

describe("sessionCitation", () => {
  test("is `<tag> (<shortId>)`", () => {
    expect(sessionCitation(identity())).toBe("stocky-pixie (f6e43925)");
  });

  test("prefixes the project when the context does not supply it", () => {
    expect(sessionCitation(identity(), { project: true })).toBe(
      "tugtool/stocky-pixie (f6e43925)",
    );
  });

  test("a tagless session degrades to the bare short id — no doubled hash", () => {
    expect(sessionCitation(identity({ tag: null }))).toBe(SHORT);
    expect(sessionCitation(identity({ tag: null }), { project: true })).toBe(
      `tugtool/${SHORT}`,
    );
  });

  test("never prints the full UUID", () => {
    expect(sessionCitation(identity(), { project: true })).not.toContain(ID);
  });
});

describe("what the record deliberately does not carry", () => {
  test("no phase or liveness field — that is a per-card subscription", () => {
    const record = identity() as unknown as Record<string, unknown>;
    expect(record.phase).toBeUndefined();
    expect(record.liveness).toBeUndefined();
  });

  test("the branch rides for telemetry and never reaches a rendered name", () => {
    const withBranch = identity({ branch: "feature/x" });
    expect(withBranch.branch).toBe("feature/x");
    expect(sessionIdentityLine(withBranch)).not.toContain("feature/x");
    expect(sessionCitation(withBranch)).not.toContain("feature/x");
  });

  test("`main` is a branch like any other — the suffix rule is gone entirely", () => {
    expect(identity({ branch: "main" }).branch).toBe("main");
  });
});

describe("resolveCitedSession — what a commit's trailers name (Spec S03)", () => {
  const FULL = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

  test("the machine field wins: an exact uuid join, whatever the citation says", () => {
    const cited = resolveCitedSession("stocky-pixie (f6e43925)", FULL);
    expect(cited).toEqual({ citedId: FULL, tag: "stocky-pixie" });
  });

  test("a short id is reported as asked — the ledger expands it, not this", () => {
    // A client-side prefix scan would answer differently depending on which
    // listings had run, and could not see an ambiguous prefix at all.
    const cited = resolveCitedSession("stocky-pixie (f6e43925)");
    expect(cited).toEqual({ citedId: "f6e43925", tag: "stocky-pixie" });
  });

  test("a legacy one-line trailer resolves exactly — its token IS a uuid", () => {
    // The head is a display name rather than a callsign, which is why it is
    // only ever a fallback for a ledger that has no tag of its own.
    const cited = resolveCitedSession(`list-filtering (${FULL})`);
    expect(cited).toEqual({ citedId: FULL, tag: "list-filtering" });
  });

  test("a tagless citation is the bare short id, with no callsign to report", () => {
    expect(resolveCitedSession("f6e43925")).toEqual({
      citedId: "f6e43925",
      tag: null,
    });
  });

  test("the token's case is normalized; the callsign's is the commit's own", () => {
    expect(resolveCitedSession("Stocky-Pixie (F6E43925)")).toEqual({
      citedId: "f6e43925",
      tag: "Stocky-Pixie",
    });
  });

  test("a commit with no session trailers names nothing", () => {
    expect(resolveCitedSession(undefined, undefined)).toBeNull();
    expect(resolveCitedSession("", "")).toBeNull();
    // Not a uuid, not 8 hex — nothing this grammar can honestly resolve.
    expect(resolveCitedSession("some free prose")).toBeNull();
    // Nearly a short id, which is not a short id.
    expect(resolveCitedSession("deadbee")).toBeNull();
    expect(resolveCitedSession("deadbeefe")).toBeNull();
  });
});

describe("resolvability is the ledger's word, never the citation's ([P13])", () => {
  const FULL = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

  test("a recorded callsign fills the label WITHOUT making it resolvable", () => {
    // The [D132] paragraph this pins: an unresolvable citation "still shows
    // whatever callsign the commit recorded". Both halves have to hold at once,
    // and folding `recordedTag` into `tag` was what made the second half
    // silently cancel the first — every foreign commit rendered as findable.
    const record = composeSessionIdentity({
      sessionId: FULL,
      name: null,
      synopsis: null,
      tag: null,
      recordedTag: "alien-tag",
    });
    expect(record.tag).toBe("alien-tag");
    expect(record.resolved).toBe(false);
  });

  test("the ledger's own callsign resolves it; so does a bound project", () => {
    const byTag = composeSessionIdentity({
      sessionId: FULL,
      name: null,
      synopsis: null,
      tag: "stocky-pixie",
    });
    expect(byTag.resolved).toBe(true);
    // A session whose card is open is findable even before any listing named
    // its callsign — the binding is a ledger-fed fact too.
    const byBinding = composeSessionIdentity({
      sessionId: FULL,
      name: null,
      synopsis: null,
      tag: null,
      projectDir: "/Users/dev/src/tugtool",
    });
    expect(byBinding.resolved).toBe(true);
  });

  test("`ledgerKnown` resolves a session no local signal covers", () => {
    // The `resolve_sessions` answer. A commit's session sits in no listing and
    // has no card, so without this arm a locally-held session would render
    // slashed purely because the picker had not been opened.
    const answered = composeSessionIdentity({
      sessionId: FULL,
      name: null,
      synopsis: null,
      tag: null,
      recordedTag: "alien-tag",
      ledgerKnown: true,
    });
    expect(answered.resolved).toBe(true);
  });

  test("the ledger's callsign outranks the commit's copy of it", () => {
    // A collided mint rerolls, so an old commit can carry a callsign this
    // session no longer wears. The ledger is authoritative.
    const record = composeSessionIdentity({
      sessionId: FULL,
      name: null,
      synopsis: null,
      tag: "rerolled-tag",
      recordedTag: "optimistic-tag",
    });
    expect(record.tag).toBe("rerolled-tag");
  });

  test("nothing at all: no callsign, unresolved, and the short id to show", () => {
    const record = composeSessionIdentity({
      sessionId: "deadbeef",
      name: null,
      synopsis: null,
      tag: null,
    });
    expect(record.tag).toBeNull();
    expect(record.resolved).toBe(false);
    expect(record.shortId).toBe("deadbeef");
  });
});
