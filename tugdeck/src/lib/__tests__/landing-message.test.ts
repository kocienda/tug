import { describe, expect, test } from "bun:test";

import { landingMessageLayout, landingMessageParts } from "../landing-message";

describe("landingMessageParts", () => {
  test("subject, summary paragraph, body", () => {
    const parts = landingMessageParts(
      "tugarc(x): Answer one menu per entity\n\nThe registry owns the menu now.\nEvery surface mounts it.\n\n- useAnnotationMenu lifted\n- three predicates",
    );
    expect(parts).toEqual({
      subject: "tugarc(x): Answer one menu per entity",
      summary: "The registry owns the menu now. Every surface mounts it.",
      body: "- useAnnotationMenu lifted\n- three predicates",
    });
  });

  test("a message whose first paragraph is bullets has no summary", () => {
    const parts = landingMessageParts("Fix null lookup\n\n- Guard the record\n- Add a test");
    expect(parts).toEqual({
      subject: "Fix null lookup",
      summary: "",
      body: "- Guard the record\n- Add a test",
    });
  });

  test("a bare subject", () => {
    expect(landingMessageParts("Arc work")).toEqual({ subject: "Arc work", summary: "", body: "" });
    expect(landingMessageParts("")).toEqual({ subject: "", summary: "", body: "" });
  });

  test("a summary with nothing after it leaves an empty body", () => {
    expect(landingMessageParts("Subject\n\nAll of it in a sentence.\n")).toEqual({
      subject: "Subject",
      summary: "All of it in a sentence.",
      body: "",
    });
  });

  test("CRLF reads the same as LF", () => {
    expect(landingMessageParts("S\r\n\r\nP.\r\n\r\n- b")).toEqual({ subject: "S", summary: "P.", body: "- b" });
  });
});

describe("landingMessageLayout", () => {
  test("names the subject line and the summary's line span", () => {
    expect(landingMessageLayout("S\n\nOne.\nTwo.\n\n- b")).toEqual({
      subjectLine: 1,
      summaryLines: { from: 3, to: 5 },
    });
  });

  test("a bullet paragraph is not a summary", () => {
    expect(landingMessageLayout("S\n\n- a\n- b")).toEqual({ subjectLine: 1, summaryLines: null });
    expect(landingMessageLayout("S")).toEqual({ subjectLine: 1, summaryLines: null });
  });

  test("the two readings agree on where the summary is", () => {
    const message = "Subject\n\n\nA summary.\nStill it.\n\n- detail";
    const layout = landingMessageLayout(message);
    const lines = message.split("\n");
    const paragraph = lines.slice(layout.summaryLines!.from - 1, layout.summaryLines!.to - 1).join(" ");
    expect(paragraph).toBe(landingMessageParts(message).summary);
  });
});
