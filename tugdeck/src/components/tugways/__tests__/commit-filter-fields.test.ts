/**
 * `commitFilterFields` — what the History filter matches a commit on.
 *
 * The contract these pin: a commit is reachable by its hash (pasted at any
 * length, though rows show eight characters), by anything in its message, by
 * who wrote it and when, and by the paths it touched — and by nothing else,
 * so a term found only in a diff does not keep a row.
 *
 * Multi-term queries AND across the union of fields, which is what makes
 * "a path plus a word" a usable way to find one commit.
 *
 * The scope block pins the aiming contract: Hash / Message / Detail / Files
 * each contribute only their own surface, and the persisted form keeps
 * "set to nothing" distinct from "never set".
 */

import { describe, test, expect } from "bun:test";

import { commitFilterFields } from "../tug-history-list";
import { formatCommitStamp } from "../commit-presentation";
import { filterAndRank, filterQueryMatch } from "@/lib/text-match";
import type { GitLogCommit } from "@/lib/git-log-store";
import {
  DEFAULT_COMMIT_FILTER_SCOPE,
  parseCommitFilterScope,
  type CommitFilterScope,
} from "@/lib/commit-filter-scope";

const COMMIT: GitLogCommit = {
  sha: "eec07b495ede18478b70e293a6f8df320b6a30c1",
  subject: "tugways(session-history): swap metadata toggle to default emphasis",
  body: "The filled emphasis read as a selection state.\n\nTug-Dash: none",
  author: "Ken Kocienda",
  date: "2026-07-24",
  committer: "Ken Kocienda",
  committer_email: "kocienda@mac.com",
  committer_date: "2026-07-24T12:51:25-07:00",
  files: ["tugdeck/src/components/tugways/cards/session-history/view.tsx"],
};

function matches(query: string, commit: GitLogCommit = COMMIT): boolean {
  return filterQueryMatch(query, commitFilterFields(commit));
}

function matchesIn(scope: CommitFilterScope[], query: string): boolean {
  return filterQueryMatch(query, commitFilterFields(COMMIT, scope));
}

describe("commitFilterFields", () => {
  test("the hash matches at any prefix length, short or full", () => {
    expect(matches("eec07")).toBe(true);
    expect(matches("eec07b49")).toBe(true);
    expect(matches(COMMIT.sha)).toBe(true);
    expect(matches("ffff99")).toBe(false);
  });

  test("the subject and the body both match", () => {
    expect(matches("metadata toggle")).toBe(true);
    expect(matches("selection state")).toBe(true);
  });

  test("the details match — who committed, and when", () => {
    expect(matches("Kocienda")).toBe(true);
    expect(matches("kocienda@mac.com")).toBe(true);
    expect(matches("2026-07-24")).toBe(true);
  });

  test("the stamp matches AS DISPLAYED, not only as raw ISO", () => {
    // What the row shows is what the filter must judge — otherwise a reader
    // types the date they can see and gets nothing, and a match that did land
    // would have no visible characters to mark.
    // Taken from the formatter, not hardcoded: the stamp renders in the local
    // zone, so a literal clock time would only pass in one timezone.
    const full = formatCommitStamp(COMMIT.committer_date!, "full");
    const clock = formatCommitStamp(COMMIT.committer_date!, "time");
    expect(full).toContain("July");
    expect(matches("July")).toBe(true);
    expect(matches(clock)).toBe(true);
    // The raw ISO's `T` separator is NOT what a reader sees, and the displayed
    // forms don't contain it — so this is a genuine "displayed strings" check.
    expect(full).not.toContain("T");
  });

  test("a changed path matches, even when the message never names it", () => {
    expect(matches("session-history/view.tsx")).toBe(true);
    // The subject says nothing about `.tsx`; the file roster does.
    expect(matches("tsx")).toBe(true);
  });

  test("a commit with no file roster still matches on its message", () => {
    const merge: GitLogCommit = { ...COMMIT, files: [] };
    expect(matches("emphasis", merge)).toBe(true);
    expect(matches("view.tsx", merge)).toBe(false);
  });

  test("terms AND across fields — one in the path, one in the message", () => {
    expect(matches("view.tsx emphasis")).toBe(true);
    // The second term is nowhere in the commit, so the row is dropped even
    // though the first term hit.
    expect(matches("view.tsx bogusterm")).toBe(false);
  });

  test("an empty query keeps every commit, in its native order", () => {
    const older: GitLogCommit = { ...COMMIT, sha: "aaa111", subject: "older" };
    const commits = [COMMIT, older];
    expect(filterAndRank(commits, "", commitFilterFields)).toBe(commits);
  });

  test("filtering trims a list to the commits that match", () => {
    const rustish: GitLogCommit = {
      ...COMMIT,
      sha: "aaa111",
      subject: "tugcast(git): page the log route",
      body: "",
      files: ["tugrust/crates/tugcast/src/feeds/git.rs"],
    };
    const kept = filterAndRank([COMMIT, rustish], "git.rs", commitFilterFields);
    expect(kept.map((c) => c.sha)).toEqual(["aaa111"]);
  });
});

describe("commitFilterFields scope", () => {
  test("the default scope reads every surface", () => {
    expect(DEFAULT_COMMIT_FILTER_SCOPE).toEqual([
      "hash",
      "message",
      "detail",
      "files",
    ]);
    // The no-argument form IS the default scope — the callers that don't aim
    // (the transcript's receipt rows) keep matching everything.
    expect(matchesIn([...DEFAULT_COMMIT_FILTER_SCOPE], "view.tsx")).toBe(
      matches("view.tsx"),
    );
  });

  test("message alone reads the subject and body, not the paths or the author", () => {
    expect(matchesIn(["message"], "metadata toggle")).toBe(true);
    expect(matchesIn(["message"], "selection state")).toBe(true);
    expect(matchesIn(["message"], "view.tsx")).toBe(false);
    expect(matchesIn(["message"], "kocienda@mac.com")).toBe(false);
  });

  test("detail alone reads who and when, not the message", () => {
    expect(matchesIn(["detail"], "kocienda@mac.com")).toBe(true);
    expect(matchesIn(["detail"], "July")).toBe(true);
    expect(matchesIn(["detail"], "metadata toggle")).toBe(false);
  });

  test("the dash attribution rides with the message", () => {
    // `Tug-Dash:` is a trailer ON the message, and the row states it as the
    // dash atom `^<name>` — so the name, and the sigil spelling the atom
    // shows, both find the commit under Message and neither does under any
    // other target.
    const joined: GitLogCommit = { ...COMMIT, tug_dash: "tugdash/lens-routes" };
    expect(filterQueryMatch("lens-routes", commitFilterFields(joined, ["message"]))).toBe(true);
    expect(filterQueryMatch("^lens-routes", commitFilterFields(joined, ["message"]))).toBe(true);
    expect(filterQueryMatch("lens-routes", commitFilterFields(joined, ["detail", "files"]))).toBe(false);
    // A hand commit has no attribution to match — and the trailer's own
    // `tugdash/` ref prefix is plumbing, not something the row ever shows.
    expect(filterQueryMatch("lens-routes", commitFilterFields(COMMIT, ["message"]))).toBe(false);
    expect(filterQueryMatch("tugdash/lens-routes", commitFilterFields(joined, ["message"]))).toBe(false);
  });

  test("files alone reads the paths, not the message", () => {
    expect(matchesIn(["files"], "session-history/view.tsx")).toBe(true);
    expect(matchesIn(["files"], "metadata toggle")).toBe(false);
  });

  test("hash alone reads the sha, at any prefix length, and nothing else", () => {
    expect(matchesIn(["hash"], "eec07b49")).toBe(true);
    expect(matchesIn(["hash"], COMMIT.sha)).toBe(true);
    expect(matchesIn(["hash"], "metadata toggle")).toBe(false);
    // With Hash off, a pasted sha stops finding its commit — that IS the
    // control, and the reason it leads the group.
    expect(matchesIn(["message", "detail", "files"], COMMIT.sha)).toBe(false);
  });

  test("every target off matches nothing at all", () => {
    expect(matchesIn([], COMMIT.sha)).toBe(false);
    expect(matchesIn([], "metadata toggle")).toBe(false);
    expect(matchesIn([], "view.tsx")).toBe(false);
  });

  test("a narrowed scope drops rows a wide one would keep", () => {
    const pathOnly: GitLogCommit = {
      ...COMMIT,
      sha: "aaa111",
      subject: "tugcast(git): page the log route",
      body: "",
      files: ["tugdeck/src/components/tugways/cards/session-history/view.tsx"],
    };
    const commits = [COMMIT, pathOnly];
    const wide = filterAndRank(commits, "session-history", (c) =>
      commitFilterFields(c, ["message", "detail", "files"]),
    );
    const narrow = filterAndRank(commits, "session-history", (c) =>
      commitFilterFields(c, ["message"]),
    );
    expect(wide.map((c) => c.sha)).toEqual([COMMIT.sha, "aaa111"]);
    // Only the commit whose SUBJECT says `session-history` survives — the one
    // that merely touched a file under that directory is gone. This is the
    // whole point of the control.
    expect(narrow.map((c) => c.sha)).toEqual([COMMIT.sha]);
  });

  test("a persisted scope round-trips, and an empty one stays empty", () => {
    expect(parseCommitFilterScope({ kind: "string", value: "message,files" })).toEqual([
      "message",
      "files",
    ]);
    // Stored order does not matter — the canonical order is the group's.
    expect(parseCommitFilterScope({ kind: "string", value: "files,message" })).toEqual([
      "message",
      "files",
    ]);
    // Set-to-nothing and never-set must stay distinguishable: the first is a
    // choice the reader made, the second falls back to the default.
    expect(parseCommitFilterScope({ kind: "string", value: "" })).toEqual([]);
    expect(parseCommitFilterScope(undefined)).toBeNull();
    // A value from a future (or drifted) build contributes nothing.
    expect(parseCommitFilterScope({ kind: "string", value: "diffs" })).toEqual([]);
  });
});
