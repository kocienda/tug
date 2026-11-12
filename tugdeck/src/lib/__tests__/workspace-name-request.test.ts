/**
 * The workspace-name question: one open at a time, answered by number, and
 * never closed by an empty name.
 *
 * @covers tugdeck/src/lib/workspace-name-request.ts
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  adoptWorkspaceNameRequest,
  answerWorkspaceName,
  askWorkspaceName,
  getWorkspaceNameRequest,
  resetWorkspaceNameRequestForTests,
  subscribeWorkspaceNameRequest,
} from "../workspace-name-request";

afterEach(() => resetWorkspaceNameRequestForTests());

describe("askWorkspaceName", () => {
  test("opens the question with the verb and the proposed name", () => {
    void askWorkspaceName("duplicate", "Duplicate of Home");
    const request = getWorkspaceNameRequest();
    expect(request.open).toBe(true);
    expect(request.verb).toBe("duplicate");
    expect(request.proposed).toBe("Duplicate of Home");
  });

  test("resolves with the trimmed name its answer commits, and closes", async () => {
    const asked = askWorkspaceName("new", "Workspace 2");
    const { seq } = getWorkspaceNameRequest();
    expect(answerWorkspaceName(seq, "  Notes  ")).toBe(true);
    expect(await asked).toBe("Notes");
    expect(getWorkspaceNameRequest().open).toBe(false);
  });

  test("resolves null on a cancel", async () => {
    const asked = askWorkspaceName("duplicate", "Duplicate of Home");
    expect(answerWorkspaceName(getWorkspaceNameRequest().seq, null)).toBe(true);
    expect(await asked).toBeNull();
    expect(getWorkspaceNameRequest().open).toBe(false);
  });

  test("an empty name answers nothing and leaves the question open", async () => {
    let settled = false;
    const asked = askWorkspaceName("new", "Workspace 2").then((name) => {
      settled = true;
      return name;
    });
    const { seq } = getWorkspaceNameRequest();
    expect(answerWorkspaceName(seq, "   ")).toBe(false);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(getWorkspaceNameRequest().open).toBe(true);
    answerWorkspaceName(seq, "Kept");
    expect(await asked).toBe("Kept");
  });

  test("a second ask cancels the first and takes a new number", async () => {
    const first = askWorkspaceName("new", "Workspace 2");
    const firstSeq = getWorkspaceNameRequest().seq;
    const second = askWorkspaceName("duplicate", "Duplicate of Home");
    expect(await first).toBeNull();
    const { seq, verb } = getWorkspaceNameRequest();
    expect(seq).toBe(firstSeq + 1);
    expect(verb).toBe("duplicate");
    // The first question's answer, arriving late, is dropped.
    expect(answerWorkspaceName(firstSeq, "Late")).toBe(false);
    expect(getWorkspaceNameRequest().open).toBe(true);
    answerWorkspaceName(seq, "Copy");
    expect(await second).toBe("Copy");
  });

  test("an answer with no question open does nothing", () => {
    expect(answerWorkspaceName(1, "Anything")).toBe(false);
  });

  test("notifies its subscribers on open and on close", () => {
    let calls = 0;
    const release = subscribeWorkspaceNameRequest(() => {
      calls += 1;
    });
    void askWorkspaceName("new", "Workspace 2");
    answerWorkspaceName(getWorkspaceNameRequest().seq, null);
    release();
    expect(calls).toBe(2);
  });
});

describe("a settle", () => {
  test("that returns nothing runs before the question closes", async () => {
    const seen: string[] = [];
    const asked = askWorkspaceName("new", "Workspace 2", (name) => {
      seen.push(`settle ${name} open=${getWorkspaceNameRequest().open}`);
    });
    answerWorkspaceName(getWorkspaceNameRequest().seq, " Notes ");
    expect(seen).toEqual(["settle Notes open=true"]);
    expect(getWorkspaceNameRequest().open).toBe(false);
    expect(await asked).toBe("Notes");
  });

  test("that returns a promise holds the question open and waiting, answering nothing more", async () => {
    let finish: () => void = () => {};
    const asked = askWorkspaceName("new", "Workspace 2", () => new Promise<void>((resolve) => (finish = resolve)));
    const { seq } = getWorkspaceNameRequest();
    expect(answerWorkspaceName(seq, "Notes")).toBe(true);
    expect(getWorkspaceNameRequest()).toMatchObject({ open: true, waiting: true });
    expect(answerWorkspaceName(seq, null)).toBe(false);
    expect(answerWorkspaceName(seq, "Other")).toBe(false);
    finish();
    expect(await asked).toBe("Notes");
    expect(getWorkspaceNameRequest()).toMatchObject({ open: false, waiting: false });
  });

  test("is not run on a cancel", async () => {
    let ran = false;
    const asked = askWorkspaceName("new", "Workspace 2", () => {
      ran = true;
    });
    answerWorkspaceName(getWorkspaceNameRequest().seq, null);
    expect(await asked).toBeNull();
    expect(ran).toBe(false);
  });
});

describe("adoptWorkspaceNameRequest", () => {
  test("takes the shell's question in the drawing page, and notifies only on a change", () => {
    let calls = 0;
    const release = subscribeWorkspaceNameRequest(() => {
      calls += 1;
    });
    const asked = { open: true, seq: 3, verb: "duplicate" as const, proposed: "Duplicate of Home", waiting: false };
    adoptWorkspaceNameRequest(asked);
    adoptWorkspaceNameRequest({ ...asked });
    release();
    expect(getWorkspaceNameRequest()).toEqual(asked);
    expect(calls).toBe(1);
  });
});
