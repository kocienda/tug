/**
 * Interactive-staging detection ([P13]) — a pure function over a command line,
 * so it tests as one.
 *
 * The two directions matter unequally. A missed detection runs `git add -p`
 * against a dead stdin: it stages nothing and exits 0, and the user believes
 * it worked. A false detection refuses a command that would have been fine —
 * annoying, and instantly visible. So the table below spends most of its
 * weight on commands that must NOT be steered.
 */

import { describe, expect, test } from "bun:test";

import { interactiveStagingSteer } from "../shell-interactive-staging";

describe("interactiveStagingSteer", () => {
  test("steers every patch-mode spelling across the prompting subcommands", () => {
    for (const command of [
      "git add -p",
      "git add --patch src/x.ts",
      "git add -i",
      "git add --interactive",
      "git commit -p -m 'partial'",
      "git stash -p",
      "git stash push --patch",
      "git checkout -p HEAD~1",
      "git restore --patch --staged src/",
      "git reset -p",
    ]) {
      const steer = interactiveStagingSteer(command);
      expect(steer, command).not.toBeNull();
      expect(steer, command).toContain("tugtool file stage");
    }
  });

  test("-i is interactive for add and --include for commit", () => {
    expect(interactiveStagingSteer("git add -i")).not.toBeNull();
    // `git commit -i -m …` stages the named paths alongside the index; it
    // prompts for nothing and must run.
    expect(interactiveStagingSteer("git commit -i -m 'subject' src/x.ts")).toBeNull();
  });

  test("steers a bare git commit, which would open an editor", () => {
    const steer = interactiveStagingSteer("git commit");
    expect(steer).not.toBeNull();
    expect(steer).toContain("no message");
    expect(interactiveStagingSteer("git commit --amend")).not.toBeNull();
  });

  test("leaves a commit that carries its own message alone", () => {
    for (const command of [
      "git commit -m 'a subject'",
      'git commit -m "a subject"',
      "git commit --message=subject",
      "git commit -F msg.txt",
      "git commit --file msg.txt",
      "git commit --amend --no-edit",
      "git commit --fixup HEAD",
      "git commit --squash HEAD",
      "git commit -C HEAD",
      "git commit --reuse-message=HEAD",
    ]) {
      expect(interactiveStagingSteer(command), command).toBeNull();
    }
  });

  test("a quoted -p inside a message is text, not a flag", () => {
    // The false positive that would matter most: refusing a perfectly ordinary
    // commit because its subject mentions the flag.
    expect(interactiveStagingSteer("git commit -m 'add -p support'")).toBeNull();
    expect(interactiveStagingSteer('git commit -m "teach add --patch"')).toBeNull();
    expect(interactiveStagingSteer("git commit -m '--interactive mode'")).toBeNull();
  });

  test("options end at a bare --, so a pathspec named -p is a path", () => {
    expect(interactiveStagingSteer("git add -- -p")).toBeNull();
    expect(interactiveStagingSteer("git checkout -- --patch")).toBeNull();
  });

  test("leaves everything that is not a prompting git subcommand alone", () => {
    for (const command of [
      "git status",
      "git add .",
      "git add -A",
      "git diff -p",
      "git log -p",
      "git show -p HEAD",
      "grep -p pattern file",
      "tugtool file stage --patch p.diff",
      "",
      "git",
    ]) {
      expect(interactiveStagingSteer(command), command).toBeNull();
    }
  });
});
