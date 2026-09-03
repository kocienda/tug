/**
 * Pure-logic coverage for the no-git notice's copy. Every machine that runs
 * this corpus has git, so none of these readings can be produced by probing the
 * host — they are pinned here instead.
 */

import { describe, expect, test } from "bun:test";

import {
  noGitNoticeCopy,
  COMMAND_LINE_TOOLS_SIZE,
} from "../tug-no-git-notice-copy";

const NO_GIT = {
  gitVersion: null as string | null,
  gitPath: null as string | null,
  developerDir: null as string | null,
  gitFloor: "2.23",
  offering: false,
  offerError: null as string | null,
};

describe("noGitNoticeCopy", () => {
  test("an absent git gets the offer, and the offer says what it costs", () => {
    const copy = noGitNoticeCopy(NO_GIT);
    expect(copy.title).toBe("git isn't installed.");
    expect(copy.detail).toContain(COMMAND_LINE_TOOLS_SIZE);
    expect(copy.action).toBe("Install");
  });

  test("an in-flight offer waits rather than inviting a second press", () => {
    const copy = noGitNoticeCopy({ ...NO_GIT, offering: true });
    expect(copy.title).toBe("Installing git…");
    expect(copy.action).toBeUndefined();
  });

  test("a failed offer says what failed and offers a retry", () => {
    const copy = noGitNoticeCopy({ ...NO_GIT, offerError: "no network" });
    expect(copy.detail).toBe("no network");
    expect(copy.action).toBe("Retry");
  });

  test("an old Apple git is offered the same install and named the floor", () => {
    const copy = noGitNoticeCopy({
      ...NO_GIT,
      gitVersion: "2.19.1",
      gitPath: "/usr/bin/git",
      developerDir: "/Library/Developer/CommandLineTools",
    });
    expect(copy.title).toBe("git 2.19.1 is too old.");
    expect(copy.detail).toContain("2.23");
    expect(copy.action).toBe("Install");
  });

  test("an old third-party git is named, not offered a button that cannot work", () => {
    const copy = noGitNoticeCopy({
      ...NO_GIT,
      gitVersion: "2.19.1",
      gitPath: "/opt/homebrew/bin/git",
    });
    expect(copy.detail).toContain("/opt/homebrew/bin/git");
    expect(copy.action).toBeUndefined();
  });

  test("the floor named is the one the wire carried", () => {
    const copy = noGitNoticeCopy({
      ...NO_GIT,
      gitVersion: "2.25.0",
      gitPath: "/usr/bin/git",
      developerDir: "/Library/Developer/CommandLineTools",
      gitFloor: "2.30",
    });
    expect(copy.detail).toContain("2.30");
  });
});
