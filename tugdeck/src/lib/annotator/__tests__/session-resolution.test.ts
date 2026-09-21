/**
 * The session verdict adapter: which spelling is asked, and what the answer
 * means.
 *
 * Three claims, and each is a correction of the obvious implementation:
 *
 *  - The WHOLE reference is asked, pair and all. The server splits it and
 *    filters by the project half itself, and answers are filed under the
 *    spelling that was asked — so a scan asking by the callsign half while a
 *    chip asks by the whole value would give one session two half-answers
 *    under two keys, each seeing the other's as pending forever.
 *  - The project half is then evidence rather than decoration: a callsign that
 *    resolves under a different project is REFUTED, not confirmed. Without
 *    that check the prefix would add characters and nothing else, and the
 *    bare-callsign shape the detector rejects would be just as good.
 *  - A session on this machine in ANOTHER ledger is confirmed, with
 *    `provenance: "elsewhere"`. It is a real session a reader can open;
 *    refuting it would put "no such session" over one that plainly exists.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { resolveSessionRef } from "@/lib/annotator/session-resolution";
import { sessionCitationStore } from "@/lib/session-citation-store";
import { normalizeSessionRow, type SessionRow } from "@/protocol";

const FULL = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";

function row(over: Partial<SessionRow> = {}): SessionRow {
  return normalizeSessionRow({
    session_id: FULL,
    workspace_key: "ws-1",
    project_dir: "/Users/dev/src/tugtool",
    created_at: 1,
    last_used_at: 2,
    turn_count: 3,
    last_user_prompt: null,
    state: "closed",
    card_id: null,
    name: null,
    tag: "kind-floor",
    ...over,
  } as Parameters<typeof normalizeSessionRow>[0]);
}

/** A `resolve_sessions_ok` carrying only what a test names. */
function resolved(over: {
  found?: { queried: string; session: SessionRow }[];
  elsewhere?: Parameters<typeof sessionCitationStore.applyResolved>[0]["elsewhere"];
  unknown?: string[];
}): Parameters<typeof sessionCitationStore.applyResolved>[0] {
  return {
    found: over.found ?? [],
    elsewhere: over.elsewhere ?? [],
    unknown: over.unknown ?? [],
  };
}

beforeEach(() => {
  sessionCitationStore.forgetAll();
});

describe("the verdict for a scanned candidate", () => {
  test("an unasked candidate is pending, and the WHOLE pair is what was asked", () => {
    // Pending is what reserves the run — the pass marks nothing and comes
    // back when the answer lands.
    expect(resolveSessionRef("tugtool/kind-floor")).toEqual({
      state: "pending",
    });
    // Asked once by the resolver itself, under the whole spelling. The
    // callsign half is NOT a key anybody fills.
    expect(sessionCitationStore.getAnswer("tugtool/kind-floor")).toEqual({
      status: "pending",
    });
    expect(sessionCitationStore.getAnswer("kind-floor")).toEqual({
      status: "pending",
    });
  });

  test("a pair resolves under the whole string", () => {
    sessionCitationStore.applyResolved(
      resolved({ found: [{ queried: "tugtool/kind-floor", session: row() }] }),
    );
    expect(resolveSessionRef("tugtool/kind-floor")).toEqual({
      state: "confirmed",
      // The FULL id, whatever the prose spelled — what a chip and a raise
      // both need.
      sessionId: FULL,
      provenance: "here",
    });
  });

  test("a project half that disagrees with the answer refutes it", () => {
    // The same callsign, resolving under a different repository. Nothing is
    // marked: this sentence is not talking about that session.
    sessionCitationStore.applyResolved(
      resolved({
        found: [
          {
            queried: "tugtool/kind-floor",
            session: row({ project_dir: "/src/other" }),
          },
        ],
      }),
    );
    expect(resolveSessionRef("tugtool/kind-floor")).toEqual({
      state: "refuted",
    });
  });

  test("a project half is compared by basename, not by the whole path", () => {
    // What the prose can spell is the repo's leaf name; the ledger holds an
    // absolute path.
    sessionCitationStore.applyResolved(
      resolved({
        found: [
          {
            queried: "tugtool/kind-floor",
            session: row({ project_dir: "/Users/dev/src/tugtool/" }),
          },
        ],
      }),
    );
    expect(resolveSessionRef("tugtool/kind-floor")).toEqual({
      state: "confirmed",
      sessionId: FULL,
      provenance: "here",
    });
  });

  test("a session nothing on this machine holds is refuted", () => {
    sessionCitationStore.applyResolved(
      resolved({ unknown: ["tugtool/kind-floor"] }),
    );
    expect(resolveSessionRef("tugtool/kind-floor")).toEqual({
      state: "refuted",
    });
  });

  test("a session in another ledger on this machine is confirmed as elsewhere", () => {
    sessionCitationStore.applyResolved(
      resolved({
        elsewhere: [
          {
            queried: "tugtool/kind-floor",
            sessionId: FULL,
            projectDir: "/Users/dev/src/tugtool",
            callsign: "kind-floor",
            title: null,
            instance: "other",
          },
        ],
      }),
    );
    expect(resolveSessionRef("tugtool/kind-floor")).toEqual({
      state: "confirmed",
      sessionId: FULL,
      provenance: "elsewhere",
    });
  });

  test("an elsewhere under the wrong project is refuted like any other", () => {
    // The basename check is about the reference, not about which ledger
    // answered — a foreign session under a different project is still not the
    // one this sentence named.
    sessionCitationStore.applyResolved(
      resolved({
        elsewhere: [
          {
            queried: "tugtool/kind-floor",
            sessionId: FULL,
            projectDir: "/src/other",
            callsign: "kind-floor",
            title: null,
            instance: "other",
          },
        ],
      }),
    );
    expect(resolveSessionRef("tugtool/kind-floor")).toEqual({
      state: "refuted",
    });
  });

  test("a bare uuid has no project half to check, and needs none", () => {
    sessionCitationStore.applyResolved(
      resolved({
        found: [{ queried: FULL, session: row({ project_dir: "/src/other" }) }],
      }),
    );
    expect(resolveSessionRef(FULL)).toEqual({
      state: "confirmed",
      sessionId: FULL,
      provenance: "here",
    });
  });
});
