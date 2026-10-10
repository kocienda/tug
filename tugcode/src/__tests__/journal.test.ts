import { describe, test, expect } from "bun:test";
import { buildContentBlocksFromLegacyJournal } from "../journal.ts";
import type { ContentBlockText } from "../types.ts";

describe("buildContentBlocksFromLegacyJournal", () => {
  // tugcast's `tug:landings` block, as it appends it to a user message.
  const LANDINGS_BLOCK =
    "<!-- tug:landings -->\n" +
    "Since your last turn (the user's acts; your view of the tree may be stale):\n" +
    "- committed 302d43b5d1 · 0 file(s) · +0 −0 — these changes are committed and no longer uncommitted in the working tree";

  const texts = (blocks: ReturnType<typeof buildContentBlocksFromLegacyJournal>) =>
    blocks.map((b) => (b as ContentBlockText).text);

  test("a landings block is split out after the user's text", () => {
    const blocks = buildContentBlocksFromLegacyJournal("hello" + LANDINGS_BLOCK, []);
    expect(texts(blocks)).toEqual(["hello", LANDINGS_BLOCK]);
  });

  test("a text that is only the landings block is one block", () => {
    const blocks = buildContentBlocksFromLegacyJournal(LANDINGS_BLOCK, []);
    expect(texts(blocks)).toEqual([LANDINGS_BLOCK]);
  });

  test("the bare marker mid-sentence, without the heading, is not cut", () => {
    const text = "what does <!-- tug:landings --> mean here?";
    const blocks = buildContentBlocksFromLegacyJournal(text, []);
    expect(texts(blocks)).toEqual([text]);
  });

  test("a text with no marker is one block, as before", () => {
    const blocks = buildContentBlocksFromLegacyJournal("plain words", []);
    expect(texts(blocks)).toEqual(["plain words"]);
  });

  test("text-only message produces single text block", () => {
    const blocks = buildContentBlocksFromLegacyJournal("hello world", []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect((blocks[0] as ContentBlockText).text).toBe("hello world");
  });

  test("non-image attachment is silently dropped (images-only contract)", () => {
    // Inline attachments are images-only per the Claude Agent SDK's
    // user-message input pipeline. A legacy journal row carrying a
    // text-typed attachment (an artifact of an older drop pipeline
    // that briefly supported text-file attachments) is skipped — the
    // text block of the prompt itself still rides.
    const blocks = buildContentBlocksFromLegacyJournal("intro", [
      { filename: "file.txt", content: "file contents", media_type: "text/plain" },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect((blocks[0] as ContentBlockText).text).toBe("intro");
  });

  test("image attachment produces image content block with base64 source", () => {
    // ~10 bytes of fake base64 (well under 5MB)
    const fakeBase64 = "aGVsbG8=";
    const blocks = buildContentBlocksFromLegacyJournal("see image", [
      { filename: "photo.png", content: fakeBase64, media_type: "image/png" },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("text");
    const imgBlock = blocks[1] as any;
    expect(imgBlock.type).toBe("image");
    expect(imgBlock.source.type).toBe("base64");
    expect(imgBlock.source.media_type).toBe("image/png");
    expect(imgBlock.source.data).toBe(fakeBase64);
  });

  test("unsupported image media type is rejected per PN-12", () => {
    expect(() =>
      buildContentBlocksFromLegacyJournal("img", [
        { filename: "photo.bmp", content: "abc", media_type: "image/bmp" },
      ])
    ).toThrow("Unsupported image type: image/bmp");
  });

  test("image exceeding ~5MB is rejected per PN-12", () => {
    // ~5MB base64 = 5*1024*1024 * 4/3 ≈ 7MB of base64 chars; use slightly more
    const oversizedContent = "A".repeat(7 * 1024 * 1024 + 1);
    expect(() =>
      buildContentBlocksFromLegacyJournal("big", [
        { filename: "huge.png", content: oversizedContent, media_type: "image/png" },
      ])
    ).toThrow("~5MB limit");
  });

  test("mixed text and image produces correct ordered content array", () => {
    const blocks = buildContentBlocksFromLegacyJournal("caption", [
      { filename: "img.jpg", content: "aGVsbG8=", media_type: "image/jpeg" },
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("text");
    expect(blocks[1].type).toBe("image");
    expect((blocks[1] as any).source.media_type).toBe("image/jpeg");
  });

  test("empty text with no attachments produces fallback empty text block", () => {
    const blocks = buildContentBlocksFromLegacyJournal("", []);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("text");
    expect((blocks[0] as ContentBlockText).text).toBe("");
  });

  test("all four supported image types are accepted", () => {
    const types = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    for (const mediaType of types) {
      expect(() =>
        buildContentBlocksFromLegacyJournal("img", [
          { filename: "img", content: "aGVsbG8=", media_type: mediaType },
        ])
      ).not.toThrow();
    }
  });
});
