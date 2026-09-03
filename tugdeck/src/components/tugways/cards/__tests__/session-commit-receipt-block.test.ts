import { describe, expect, it } from "bun:test";

import {
  matchesCommitReceipt,
  parseCommitReceipt,
} from "@/components/tugways/cards/session-commit-receipt-block";

describe("matchesCommitReceipt", () => {
  it("claims /commit and /commit <message>, not /commitx or a bare git", () => {
    expect(matchesCommitReceipt("/commit")).toBe(true);
    expect(matchesCommitReceipt("/commit tidy up")).toBe(true);
    expect(matchesCommitReceipt("/commitx")).toBe(false);
    expect(matchesCommitReceipt("git commit")).toBe(false);
    expect(matchesCommitReceipt("commit")).toBe(false);
  });
});

describe("parseCommitReceipt", () => {
  it("parses a well-formed S02 summary with a files line", () => {
    const out =
      'committed 0123456789 · 2 file(s) · +14 −2\n' +
      'files: [{"path":"src/a.rs","status":"modified","added":10,"removed":2},' +
      '{"path":"src/b.rs","status":"created","added":4,"removed":0}]\n' +
      "Fix the thing";
    expect(parseCommitReceipt(out)).toEqual({
      sha: "0123456789",
      message: "Fix the thing",
      fileCount: 2,
      added: 14,
      removed: 2,
      files: [
        { path: "src/a.rs", status: "modified", added: 10, removed: 2 },
        { path: "src/b.rs", status: "created", added: 4, removed: 0 },
      ],
    });
  });

  it("keeps the full multi-line message for the 3-line clamp", () => {
    const out =
      'committed abcdef0123 · 1 file(s) · +9 −0\n' +
      'files: [{"path":"a.md","status":"modified","added":9,"removed":0}]\n' +
      "Subject line\n\nBody paragraph one.";
    const parsed = parseCommitReceipt(out);
    expect(parsed?.message).toBe("Subject line\n\nBody paragraph one.");
    expect(parsed?.files).toEqual([
      { path: "a.md", status: "modified", added: 9, removed: 0 },
    ]);
  });

  it("parses a legacy record with no files line (empty files)", () => {
    const out = "committed abcdef0123 · 1 file(s) · +9 −0\nSubject only";
    expect(parseCommitReceipt(out)).toEqual({
      sha: "abcdef0123",
      message: "Subject only",
      fileCount: 1,
      added: 9,
      removed: 0,
      files: [],
    });
  });

  it("returns null for a non-S02 output (older or truncated)", () => {
    expect(parseCommitReceipt("committed abc")).toBeNull();
    expect(parseCommitReceipt("some shell output\nmore lines")).toBeNull();
    // The retired em-arc header shape (subject on line 0) no longer parses.
    expect(parseCommitReceipt("committed abc — subj\n1 file(s) · +1 −0")).toBeNull();
  });
});
