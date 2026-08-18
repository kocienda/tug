/**
 * Pure-logic coverage for the assistant-rendering gallery cards.
 *
 * The cards themselves are static composition over module-scope mock
 * data — there is no branching logic to pin. What *is* a pure-logic
 * concern, and what this file guards, is the **registry wiring**: each
 * card must be registered in the global card registry with a
 * `contentFactory` and sane `defaultMeta`, so it is reachable from the
 * gallery's [+] type picker. A card file that exists but is never
 * wired into `gallery-registrations.tsx` is the bug this catches.
 *
 * Whether each card actually mounts without throwing under both themes
 * needs a real render surface, so it is not attempted here.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import {
  _resetForTest,
  getRegistration,
} from "@/card-registry";
import { registerGalleryCards } from "../gallery-registrations";

// ---------------------------------------------------------------------------
// The block-renderer demo cards.
// ---------------------------------------------------------------------------

/** Each card and the title its registration must carry. */
const BLOCK_RENDERER_CARDS: ReadonlyArray<{ componentId: string; title: string }> = [
  { componentId: "gallery-session-thinking", title: "SessionThinkingBlock" },
  { componentId: "gallery-json-tree-block", title: "JsonTreeBlock" },
  { componentId: "gallery-tool-block-file", title: "File Tool Blocks" },
  { componentId: "gallery-tool-block-default", title: "DefaultToolBlock" },
];

/** Neighbouring cards that must stay registered alongside them. */
const EXTENDED_CARDS: ReadonlyArray<string> = [
  "gallery-bash-tool-block",
  "gallery-markdown-view",
];

// ---------------------------------------------------------------------------
// Hermetic registry — bun shares module state across test files, so
// reset and re-register from scratch.
// ---------------------------------------------------------------------------

beforeAll(() => {
  _resetForTest();
  registerGalleryCards();
});

describe("gallery block-renderer cards — registry wiring", () => {
  for (const { componentId, title } of BLOCK_RENDERER_CARDS) {
    test(`${componentId} is registered with a contentFactory and defaultMeta`, () => {
      const registration = getRegistration(componentId);
      expect(registration, `${componentId} must be registered`).toBeDefined();
      // `contentFactory` is what `DeckCanvas` calls to mount the card —
      // a registration without one is unreachable.
      expect(typeof registration?.contentFactory).toBe("function");
      expect(registration?.defaultMeta.title).toBe(title);
      // Gallery cards are maker-family and closable.
      expect(registration?.family).toBe("maker");
      expect(registration?.defaultMeta.closable).toBe(true);
    });
  }

  test("the verified/extended cards remain registered", () => {
    for (const componentId of EXTENDED_CARDS) {
      expect(
        getRegistration(componentId),
        `${componentId} must still be registered`,
      ).toBeDefined();
    }
  });

  test("each contentFactory is a distinct registration", () => {
    const factories = BLOCK_RENDERER_CARDS.map(
      ({ componentId }) => getRegistration(componentId)?.contentFactory,
    );
    const unique = new Set(factories);
    expect(unique.size).toBe(BLOCK_RENDERER_CARDS.length);
  });
});
