/**
 * `RENDERED` / `RENDER_INPUT` payloads against the fixture the Rust half is
 * held to.
 *
 * tugcast serializes its render frames and parses the deck's controls with
 * serde types in `tugrust/crates/tugcast/src/feeds/render_bridge.rs`; its
 * tests compare one of each with `fixtures/rendered-parity.json`. Here the
 * same fixture must equal values written against `rendered.ts`'s types, so a
 * field renamed or retyped on either side fails one half or the other.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RenderedFrame, RenderInput } from "../rendered";

const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "rendered-parity.json"), "utf8"),
) as { frames: unknown[]; inputs: unknown[] };

const FRAMES: RenderedFrame[] = [
  {
    kind: "render-batch",
    sessions: [
      {
        tugSessionId: "s1",
        messages: [
          {
            messageKey: "m1:0",
            channel: "text",
            blocks: [
              { hash: "12638187200555641996", kind: "heading", startChar: 0, endChar: 9, depth: 2, itemCount: 0, rowCount: 0 },
              { hash: "9113197264227342466", kind: "paragraph", startChar: 9, endChar: 21, depth: 0, itemCount: 0, rowCount: 0 },
            ],
            html: { "9113197264227342466": "<p>Body text.</p>\n" },
            textLength: 21,
            textHash: "18446744073709551557",
          },
        ],
      },
    ],
  },
  {
    kind: "find-result",
    requestId: "r1",
    tugSessionId: "s1",
    matches: [{ unit: "u1", start: 3, end: 7 }],
    texts: { u1: "the text" },
    missing: ["u2"],
  },
  { kind: "find-result", requestId: "r2", tugSessionId: "s1", invalid: true, missing: [] },
];

const INPUTS: RenderInput[] = [
  { kind: "motion", holder: "h1", held: true, capMs: 600 },
  { kind: "display-period", periodMs: 8.33 },
  { kind: "resync", tugSessionId: "s1" },
  {
    kind: "find",
    requestId: "r1",
    tugSessionId: "s1",
    query: "text",
    options: { caseSensitive: false, wholeWord: true, grep: false },
    limit: 500,
    units: ["u1", "u2"],
    mountedUnits: ["u1"],
  },
];

describe("rendered payload parity", () => {
  test("RENDERED frames match the fixture", () => {
    expect(FIXTURE.frames).toEqual(FRAMES);
  });

  test("RENDER_INPUT controls match the fixture", () => {
    expect(FIXTURE.inputs).toEqual(INPUTS);
  });

  test("hashes travel as decimal strings past 2^53", () => {
    const batch = FRAMES[0];
    if (batch.kind !== "render-batch") throw new Error("first frame is a batch");
    const hash = batch.sessions[0].messages[0].blocks[0].hash;
    expect(BigInt(hash) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(BigInt(hash).toString()).toBe(hash);
  });
});
