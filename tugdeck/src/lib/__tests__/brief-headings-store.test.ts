import { beforeEach, describe, it, expect } from "bun:test";

import {
  briefHeadingsSnapshot,
  loadBriefHeadings,
  resetBriefHeadingsForTest,
} from "@/lib/brief-headings-store";
import type { FileReadOutcome } from "@/lib/file-io";

const file = (content: string): FileReadOutcome => ({
  ok: true,
  file: { path: "/p/brief.md", content, sha256: "", size: content.length, mtimeMs: 0, readOnly: false },
});

describe("brief headings store", () => {
  beforeEach(() => resetBriefHeadingsForTest());

  it("is loading until a brief has been read", () => {
    expect(briefHeadingsSnapshot("/p/brief.md")).toEqual({ status: "loading" });
  });

  it("keeps the headings of a brief it read", async () => {
    await loadBriefHeadings("/p/brief.md", async () => file("**[B01] Keep the term.** x"));
    expect(briefHeadingsSnapshot("/p/brief.md")).toEqual({
      status: "ready",
      headings: [{ tag: "B01", kind: "decision", title: "Keep the term" }],
    });
    expect(briefHeadingsSnapshot("/p/other.md")).toEqual({ status: "loading" });
  });

  it("says so when the brief cannot be read", async () => {
    await loadBriefHeadings("/p/brief.md", async () => ({ ok: false, error: "not_found" }));
    expect(briefHeadingsSnapshot("/p/brief.md")).toEqual({ status: "unreadable" });
  });

  it("keeps the later of two reads, whichever lands first", async () => {
    let releaseFirst: (outcome: FileReadOutcome) => void = () => {};
    const first = loadBriefHeadings(
      "/p/brief.md",
      () => new Promise<FileReadOutcome>((resolve) => (releaseFirst = resolve)),
    );
    await loadBriefHeadings("/p/brief.md", async () => file("**[F02] The later text.** x"));
    releaseFirst(file("**[F01] The earlier text.** x"));
    await first;
    const reading = briefHeadingsSnapshot("/p/brief.md");
    expect(reading.status === "ready" ? reading.headings.map((h) => h.tag) : null).toEqual(["F02"]);
  });
});
