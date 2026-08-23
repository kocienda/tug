/**
 * Pin the cache in front of `resolve_sessions` — whether the ledger holds the
 * session a citation names ([D132]).
 *
 * The rules under test are the ones that decide between the session atom and
 * [P13]'s slashed one, so each is a rendering: ask once per id, cache the miss
 * as firmly as the hit, drop a *failure* rather than cache it as a miss, and
 * seed the identity stores from a resolved row so the chip can say a callsign
 * for a session no card is bound to.
 *
 * The `useCitedSession` half is a hook and is exercised on the real app
 * (at0378) rather than in a render test.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  ConnectionLifecycle,
  getConnectionLifecycle,
  registerConnectionLifecycle,
} from "@/lib/connection-lifecycle";
import { sessionCitationStore } from "@/lib/session-citation-store";
import { sessionNameStore } from "@/lib/session-name-store";
import { sessionSynopsisStore } from "@/lib/session-synopsis-store";
import { sessionTagStore } from "@/lib/session-tag-store";
import { normalizeSessionRow, type SessionRow } from "@/protocol";

const FULL = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const SHORT = "f6e43925";

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
    ...over,
  } as Parameters<typeof normalizeSessionRow>[0]);
}

beforeEach(() => {
  sessionCitationStore.forgetAll();
});

describe("what the ledger said", () => {
  test("an id nobody asked about is pending, not unknown", () => {
    // The two are different claims: one is "we have not looked", the other is
    // "there is no such session". Only the second may slash a chip.
    expect(sessionCitationStore.getAnswer(FULL)).toEqual({ status: "pending" });
  });

  test("a hit carries the FULL id, even when a short one was asked", () => {
    sessionCitationStore.applyResolved({
      found: [{ queried: SHORT, session: row({ tag: "stocky-pixie" }) }],
      unknown: [],
    });
    const answer = sessionCitationStore.getAnswer(SHORT);
    expect(answer).toEqual({
      status: "found",
      sessionId: FULL,
      projectDir: "/Users/dev/src/tugtool",
      state: "closed",
    });
  });

  test("a resolved row seeds the identity stores — the chip's whole label", () => {
    sessionCitationStore.applyResolved({
      found: [
        {
          queried: FULL,
          session: row({
            tag: "syrupy-beam",
            name: "the mint work",
            name_user_set: true,
            synopsis: "Repair tag minting",
          }),
        },
      ],
      unknown: [],
    });
    // A citation has no card binding and may sit in no listing, so this answer
    // is the only path by which the resolver learns the session's name.
    expect(sessionTagStore.getTag(FULL)).toBe("syrupy-beam");
    expect(sessionNameStore.getName(FULL)).toBe("the mint work");
    expect(sessionSynopsisStore.getSynopsis(FULL)).toBe("Repair tag minting");
  });

  test("an auto title does not seed as a rename", () => {
    // Same rule the listings and the spawn ack follow: only a user `/rename`
    // fronts the description line.
    sessionCitationStore.applyResolved({
      found: [
        {
          queried: "aabbccdd",
          session: row({
            session_id: "aabbccdd-1111-2222-3333-444455556666",
            name: "an aiTitle",
            name_user_set: false,
          }),
        },
      ],
      unknown: [],
    });
    expect(
      sessionNameStore.getName("aabbccdd-1111-2222-3333-444455556666"),
    ).toBeNull();
  });

  test("a miss is an answer, and it sticks", () => {
    sessionCitationStore.applyResolved({ found: [], unknown: ["0badf00d"] });
    expect(sessionCitationStore.getAnswer("0badf00d")).toEqual({
      status: "unknown",
    });
    // And it is not re-asked: `request` on an answered id is a no-op, which is
    // what keeps a hundred-row History card from re-asking on every repaint.
    let notified = 0;
    const off = sessionCitationStore.subscribe(() => {
      notified += 1;
    });
    sessionCitationStore.request("0badf00d");
    expect(notified).toBe(0);
    off();
  });

  test("a failed read is dropped rather than cached as a miss", () => {
    sessionCitationStore.applyResolved({ found: [], unknown: [] });
    sessionCitationStore.request(FULL);
    expect(sessionCitationStore.getAnswer(FULL)).toEqual({ status: "pending" });
    sessionCitationStore.applyFailed([FULL]);
    // Back to "nobody has looked" — a ledger error says nothing about the
    // session, and caching it as `unknown` would slash a resolvable citation
    // until the next reconnect.
    expect(sessionCitationStore.getAnswer(FULL)).toEqual({ status: "pending" });
  });

  test("forgetAll drops every answer — what a reconnect does", () => {
    sessionCitationStore.applyResolved({
      found: [{ queried: FULL, session: row() }],
      unknown: ["0badf00d"],
    });
    sessionCitationStore.forgetAll();
    // A bounce may have crossed a spawn or a trash, and a cached miss outliving
    // the session it missed is the one answer this store could hold wrongly for
    // a long time.
    expect(sessionCitationStore.getAnswer(FULL)).toEqual({ status: "pending" });
    expect(sessionCitationStore.getAnswer("0badf00d")).toEqual({
      status: "pending",
    });
  });

  test("surrounding whitespace is the caller's, not the answer's", () => {
    sessionCitationStore.applyResolved({
      found: [{ queried: ` ${SHORT} `, session: row() }],
      unknown: [],
    });
    expect(sessionCitationStore.getAnswer(SHORT).status).toBe("found");
  });

  test("the same answer object comes back each read", () => {
    // `useSyncExternalStore` re-renders on identity, so a getter that minted a
    // fresh object per call would spin React forever.
    sessionCitationStore.applyResolved({
      found: [{ queried: FULL, session: row() }],
      unknown: ["0badf00d"],
    });
    expect(sessionCitationStore.getAnswer(FULL)).toBe(
      sessionCitationStore.getAnswer(FULL),
    );
    expect(sessionCitationStore.getAnswer("0badf00d")).toBe(
      sessionCitationStore.getAnswer("0badf00d"),
    );
    expect(sessionCitationStore.getAnswer("never-asked")).toBe(
      sessionCitationStore.getAnswer("also-never-asked"),
    );
  });

  test("a trash drops every answer that speaks for the session", () => {
    sessionCitationStore.applyResolved({
      found: [
        { queried: FULL, session: row() },
        { queried: SHORT, session: row() },
        {
          queried: "aabbccdd",
          session: row({ session_id: "aabbccdd-1111-2222-3333-444455556666" }),
        },
      ],
      unknown: ["0badf00d"],
    });
    sessionCitationStore.forgetSession(FULL);
    // Both spellings of the trashed session drop back to "nobody has looked",
    // so the next repaint re-asks and gets the ledger's post-trash answer.
    expect(sessionCitationStore.getAnswer(FULL)).toEqual({ status: "pending" });
    expect(sessionCitationStore.getAnswer(SHORT)).toEqual({
      status: "pending",
    });
    // Other sessions' answers — hits and misses alike — are untouched.
    expect(sessionCitationStore.getAnswer("aabbccdd").status).toBe("found");
    expect(sessionCitationStore.getAnswer("0badf00d")).toEqual({
      status: "unknown",
    });
  });

  test("a reconnect drops the cache even when the lifecycle registered late", () => {
    // The store singleton is constructed during static-import evaluation,
    // before `main.tsx`'s module body registers the lifecycle — so the
    // reconnect hook must attach lazily on the first ask, not in the
    // constructor. A constructor-time hook would leave every cached miss
    // standing across a wire bounce for the rest of the app run.
    // Another test file in the same process may have hooked the singleton to
    // its own lifecycle already; release that registration so the first ask
    // below attaches fresh. And another file's `mock.module` on the lifecycle
    // module may leak into this run (bun mocks are process-global), pinning
    // `getConnectionLifecycle` to its own instance and no-op'ing the register
    // — so drive whichever lifecycle the store will actually see.
    sessionCitationStore.dispose();
    const own = new ConnectionLifecycle();
    registerConnectionLifecycle(own);
    const lifecycle = getConnectionLifecycle() ?? own;
    try {
      sessionCitationStore.applyResolved({
        found: [{ queried: FULL, session: row() }],
        unknown: ["0badf00d"],
      });
      // The first ask after registration attaches the hook.
      sessionCitationStore.request("11112222");
      lifecycle.notifyConnectionDidOpen();
      lifecycle.notifyConnectionDidClose();
      lifecycle.notifyConnectionDidOpen(); // fires connectionDidReconnect
      expect(sessionCitationStore.getAnswer(FULL)).toEqual({
        status: "pending",
      });
      expect(sessionCitationStore.getAnswer("0badf00d")).toEqual({
        status: "pending",
      });
    } finally {
      sessionCitationStore.dispose();
      registerConnectionLifecycle(null);
    }
  });
});
