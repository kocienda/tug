import { describe, expect, test } from "bun:test";

import {
  sessionRenameCommit,
  sessionRenameModeStore,
} from "@/lib/session-rename-mode-store";

describe("what the inline editor's commit does with a draft", () => {
  test("an unchanged draft renames nothing", () => {
    expect(sessionRenameCommit("harbor light", "harbor light")).toEqual({ rename: false });
    expect(sessionRenameCommit("harbor light", "  harbor light ")).toEqual({ rename: false });
    // An unnamed session opens empty; leaving it empty is not a clear.
    expect(sessionRenameCommit(null, "")).toEqual({ rename: false });
    expect(sessionRenameCommit(null, "   ")).toEqual({ rename: false });
  });

  test("a changed draft renames to its trimmed text, and a blank one clears", () => {
    expect(sessionRenameCommit("harbor light", " low tide ")).toEqual({
      rename: true,
      name: "low tide",
    });
    expect(sessionRenameCommit(null, "low tide")).toEqual({ rename: true, name: "low tide" });
    expect(sessionRenameCommit("harbor light", "  ")).toEqual({ rename: true, name: "" });
  });
});

describe("the masthead's rename mode is one flag per card", () => {
  test("begin opens one card's editor and leaves the others closed", () => {
    sessionRenameModeStore.begin("card-a");
    try {
      expect(sessionRenameModeStore.isRenaming("card-a")).toBe(true);
      expect(sessionRenameModeStore.isRenaming("card-b")).toBe(false);
      expect(sessionRenameModeStore.isRenaming(undefined)).toBe(false);
    } finally {
      sessionRenameModeStore.end("card-a");
    }
    expect(sessionRenameModeStore.isRenaming("card-a")).toBe(false);
  });

  test("a second door onto an open editor, and a close of a closed one, notify nobody", () => {
    let notified = 0;
    const unsubscribe = sessionRenameModeStore.subscribe(() => {
      notified += 1;
    });
    try {
      sessionRenameModeStore.begin("card-a");
      sessionRenameModeStore.begin("card-a");
      expect(notified).toBe(1);
      sessionRenameModeStore.end("card-a");
      sessionRenameModeStore.end("card-a");
      expect(notified).toBe(2);
    } finally {
      unsubscribe();
    }
  });

  test("a commit goes to the card's committer, and says so when there is none", () => {
    const names: string[] = [];
    const first = (name: string): void => {
      names.push(`first:${name}`);
    };
    const second = (name: string): void => {
      names.push(`second:${name}`);
    };
    expect(sessionRenameModeStore.commit("card-a", "harbor")).toBe(false);
    const releaseFirst = sessionRenameModeStore.registerCommitter("card-a", first);
    expect(sessionRenameModeStore.commit("card-a", "harbor")).toBe(true);
    expect(sessionRenameModeStore.commit("card-b", "harbor")).toBe(false);
    // A later mount registers; the earlier mount's release must not drop it.
    const releaseSecond = sessionRenameModeStore.registerCommitter("card-a", second);
    releaseFirst();
    expect(sessionRenameModeStore.commit("card-a", "light")).toBe(true);
    releaseSecond();
    expect(sessionRenameModeStore.commit("card-a", "gone")).toBe(false);
    expect(names).toEqual(["first:harbor", "second:light"]);
  });
});
