/**
 * `latestPostForSession` — the selector rung (1) of the masthead's ladder
 * rests on ([D187]).
 *
 * Over plain arrays, with no store and no connection: the selector is pure and
 * total, and what is pinned here is the three answers a caller can get — the
 * newest Observer post about this session, nothing when the channel holds only
 * other authors or other sessions, and nothing for an empty list.
 */

import { describe, expect, it } from "bun:test";

import {
  latestPostForSession,
  type OverviewPostEntry,
} from "@/lib/overview-store";

function post(
  key: string,
  author: OverviewPostEntry["author"],
  sessionId: string | null,
  body: string,
): OverviewPostEntry {
  return {
    key,
    id: Number(key),
    atMs: Number(key),
    author,
    sessionId,
    wakeReason: null,
    body,
    refs: [],
    elapsedMs: null,
    projectDir: null,
    attachments: [],
    requestId: null,
    transient: false,
  };
}

describe("latestPostForSession", () => {
  it("answers with the newest post about this session", () => {
    const posts = [
      post("1", "observer", "s1", "Reading the allowlists."),
      post("2", "observer", "s1", "Writing the digester."),
    ];
    expect(latestPostForSession(posts, "s1")?.body).toBe(
      "Writing the digester.",
    );
  });

  it("never answers with another session's post", () => {
    const posts = [
      post("1", "observer", "s1", "Mine."),
      post("2", "observer", "s2", "Theirs."),
    ];
    expect(latestPostForSession(posts, "s1")?.body).toBe("Mine.");
    expect(latestPostForSession(posts, "s3")).toBeNull();
  });

  it("never answers with a post the Observer did not write", () => {
    // The channel carries the user's own questions, the Operator's answers and
    // the tripwire's notices. None of those is an account of what the session
    // is doing, and a masthead showing the reader their own question back says
    // less than the blank it replaced.
    const posts = [
      post("1", "observer", "s1", "Writing the digester."),
      post("2", "user", "s1", "What is it doing?"),
      post("3", "operator", "s1", "It is writing the digester."),
      post("4", "tripwire", "s1", "A tripwire fired."),
    ];
    expect(latestPostForSession(posts, "s1")?.body).toBe(
      "Writing the digester.",
    );
  });

  it("never answers with an app-wide post", () => {
    const posts = [post("1", "observer", null, "App-wide ambience.")];
    expect(latestPostForSession(posts, "s1")).toBeNull();
  });

  it("answers null for an empty channel and an empty session id", () => {
    expect(latestPostForSession([], "s1")).toBeNull();
    expect(
      latestPostForSession([post("1", "observer", "s1", "Something.")], ""),
    ).toBeNull();
  });
});
