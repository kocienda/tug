/**
 * `image-downsample` — unit tests for pure-logic exports.
 *
 * Covers `isAnimatedGif` (the GIF frame-count parser),
 * `classifySourceMime` (the MIME decision matrix), and
 * `fitWithinLongEdge` (the aspect-preserving resize math). These are
 * the parts that can be tested by reasoning about byte arrays and
 * primitives, with no canvas, no FileReader, no DOM.
 *
 * The canvas-execution surface of `downsampleImage` (resize, encode,
 * JPEG quality ladder, real PNG / JPEG / HEIC decode) is verified in
 * the real-app harness — those branches inherently require a browser
 * engine. See Step 1 manual checkpoints in `dash/dev-atoms.md`
 * and the drop / paste integration tests that arrive with Step 2.
 */

import { describe, expect, test } from "bun:test";

import {
  classifySourceMime,
  fitWithinLongEdge,
  isAnimatedGif,
  JPEG_QUALITY_LADDER,
  MAX_BASE64_SIZE,
  MAX_BYTE_SIZE,
  MAX_LONG_EDGE_PX,
  SVG_RASTER_MAX_EDGE_PX,
  THUMBNAIL_MAX_EDGE_PX,
} from "../image-downsample";

// ---------------------------------------------------------------------------
// GIF byte fixtures — hand-crafted minimal valid GIFs.
//
// Format reference (GIF89a, W3C):
//  - 6-byte signature: "GIF89a"
//  - 7-byte Logical Screen Descriptor:
//      width (u16le), height (u16le), packed, bg color, pixel aspect
//  - Optional Global Color Table (3 * 2^(gctSize+1) bytes)
//  - Block stream:
//      0x21 = Extension Introducer (label byte then length-prefixed
//             sub-blocks terminated by 0x00)
//      0x2C = Image Descriptor (9 fixed bytes then optional LCT then
//             LZW min code byte then length-prefixed sub-blocks
//             terminated by 0x00)
//      0x3B = Trailer
//
// We construct fixtures inline rather than embedding pre-baked
// base64 — keeping the byte layout visible in the test source means
// a reader can verify what the parser is being asked to interpret
// without leaving the file.
// ---------------------------------------------------------------------------

/** GIF89a 6-byte signature. */
const GIF89A_SIG: ReadonlyArray<number> = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

/** GIF87a 6-byte signature. */
const GIF87A_SIG: ReadonlyArray<number> = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];

/**
 * Logical Screen Descriptor: 1×1 with a 2-color GCT (gctSize=0 means
 * 2^(0+1) = 2 entries, 3 bytes each = 6 bytes of GCT to follow).
 *
 * Packed byte breakdown:
 *   0b1_000_0_000 = 0x80
 *     bit 7    : GCT present
 *     bits 6-4 : color resolution (0)
 *     bit 3    : sort flag (0)
 *     bits 2-0 : gctSize (0 → 2 entries)
 */
const LSD_1x1_WITH_GCT: ReadonlyArray<number> = [
  0x01,
  0x00, // width = 1
  0x01,
  0x00, // height = 1
  0x80, // packed: GCT present, gctSize=0
  0x00, // background color index
  0x00, // pixel aspect ratio
];

/** 2-entry GCT: black + white. */
const GCT_2_ENTRIES: ReadonlyArray<number> = [
  0x00,
  0x00,
  0x00, // entry 0: black
  0xff,
  0xff,
  0xff, // entry 1: white
];

/**
 * One image descriptor + minimal LZW data for a 1×1 image:
 *  - 0x2C separator
 *  - left=0, top=0, width=1, height=1 (4 × u16le)
 *  - packed=0x00 (no LCT, no interlace, no sort, lctSize=0)
 *  - LZW min code size = 2 (the minimum for a 2-color image)
 *  - sub-block: length=2, bytes=0x44 0x01 (Lempel-Ziv encoded pixel)
 *  - sub-block terminator = 0x00
 */
const IMAGE_DESCRIPTOR_1x1: ReadonlyArray<number> = [
  0x2c,
  0x00,
  0x00, // left
  0x00,
  0x00, // top
  0x01,
  0x00, // width
  0x01,
  0x00, // height
  0x00, // packed
  0x02, // LZW min code size
  0x02, // sub-block length
  0x44, // sub-block data byte 1
  0x01, // sub-block data byte 2
  0x00, // sub-block terminator
];

/**
 * Graphic Control Extension prefacing the next image descriptor.
 *  - 0x21 introducer
 *  - 0xF9 label (GCE)
 *  - 0x04 block size (always 4 for GCE)
 *  - 0x00 packed (disposal=0, no user input, no transparency)
 *  - 0x0A 0x00 delay = 10 (u16le)
 *  - 0x00 transparent color index (unused)
 *  - 0x00 terminator
 */
const GCE: ReadonlyArray<number> = [
  0x21,
  0xf9,
  0x04,
  0x00,
  0x0a,
  0x00,
  0x00,
  0x00,
];

/**
 * Comment Extension containing a single sub-block whose payload
 * is the byte `0x2C` (Image Descriptor sentinel). Used to verify
 * the parser does NOT count this byte as an Image Descriptor —
 * a naive `0x2C` byte count would over-report.
 *
 *  - 0x21 introducer
 *  - 0xFE label (comment)
 *  - 0x01 sub-block length
 *  - 0x2C sub-block payload (looks like a sentinel but is data)
 *  - 0x00 terminator
 */
const COMMENT_WITH_0x2C: ReadonlyArray<number> = [
  0x21,
  0xfe,
  0x01,
  0x2c,
  0x00,
];

/** Trailer: end-of-GIF marker. */
const TRAILER = 0x3b;

/** Build a GIF byte array from segment arrays. */
function gif(...segments: ReadonlyArray<ReadonlyArray<number>>): Uint8Array {
  let total = 0;
  for (const s of segments) total += s.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const s of segments) {
    out.set(s, offset);
    offset += s.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// isAnimatedGif — signature and trivial inputs
// ---------------------------------------------------------------------------

describe("isAnimatedGif — signature handling", () => {
  test("empty input returns false", () => {
    expect(isAnimatedGif(new Uint8Array(0))).toBe(false);
  });

  test("too-short input returns false", () => {
    // Need at least 13 bytes (6 sig + 7 LSD); 12 is not enough.
    expect(isAnimatedGif(new Uint8Array(12))).toBe(false);
  });

  test("non-GIF bytes return false (PNG signature)", () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0,
    ]);
    expect(isAnimatedGif(png)).toBe(false);
  });

  test("wrong magic version byte returns false (GIF38 instead of GIF87/89)", () => {
    const bogus = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x38, 0x61, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(isAnimatedGif(bogus)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAnimatedGif — single-frame (static) GIFs
// ---------------------------------------------------------------------------

describe("isAnimatedGif — static GIFs", () => {
  test("GIF89a with one image descriptor → false", () => {
    const bytes = gif(
      GIF89A_SIG,
      LSD_1x1_WITH_GCT,
      GCT_2_ENTRIES,
      IMAGE_DESCRIPTOR_1x1,
      [TRAILER],
    );
    expect(isAnimatedGif(bytes)).toBe(false);
  });

  test("GIF87a with one image descriptor → false", () => {
    const bytes = gif(
      GIF87A_SIG,
      LSD_1x1_WITH_GCT,
      GCT_2_ENTRIES,
      IMAGE_DESCRIPTOR_1x1,
      [TRAILER],
    );
    expect(isAnimatedGif(bytes)).toBe(false);
  });

  test("static GIF without a Global Color Table → false", () => {
    // LSD with GCT flag cleared (0x00 instead of 0x80). Some
    // single-frame GIFs ship this way; the parser must skip the
    // (zero-byte) GCT and find the lone image descriptor.
    const lsdNoGct: ReadonlyArray<number> = [
      0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
    ];
    const bytes = gif(GIF89A_SIG, lsdNoGct, IMAGE_DESCRIPTOR_1x1, [TRAILER]);
    expect(isAnimatedGif(bytes)).toBe(false);
  });

  test("static GIF preceded by Comment Extension → false", () => {
    // The comment extension is a single non-Image-Descriptor block;
    // its presence must not be counted as a frame.
    const bytes = gif(
      GIF89A_SIG,
      LSD_1x1_WITH_GCT,
      GCT_2_ENTRIES,
      COMMENT_WITH_0x2C, // contains 0x2C as data — must NOT count
      IMAGE_DESCRIPTOR_1x1,
      [TRAILER],
    );
    expect(isAnimatedGif(bytes)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAnimatedGif — animated (multi-frame) GIFs
// ---------------------------------------------------------------------------

describe("isAnimatedGif — animated GIFs", () => {
  test("two consecutive image descriptors → true", () => {
    const bytes = gif(
      GIF89A_SIG,
      LSD_1x1_WITH_GCT,
      GCT_2_ENTRIES,
      IMAGE_DESCRIPTOR_1x1,
      IMAGE_DESCRIPTOR_1x1,
      [TRAILER],
    );
    expect(isAnimatedGif(bytes)).toBe(true);
  });

  test("two image descriptors with intervening GCE → true", () => {
    // Canonical animated-GIF structure: GCE precedes each frame so
    // the decoder knows the delay.
    const bytes = gif(
      GIF89A_SIG,
      LSD_1x1_WITH_GCT,
      GCT_2_ENTRIES,
      GCE,
      IMAGE_DESCRIPTOR_1x1,
      GCE,
      IMAGE_DESCRIPTOR_1x1,
      [TRAILER],
    );
    expect(isAnimatedGif(bytes)).toBe(true);
  });

  test("three image descriptors → true", () => {
    const bytes = gif(
      GIF89A_SIG,
      LSD_1x1_WITH_GCT,
      GCT_2_ENTRIES,
      IMAGE_DESCRIPTOR_1x1,
      IMAGE_DESCRIPTOR_1x1,
      IMAGE_DESCRIPTOR_1x1,
      [TRAILER],
    );
    expect(isAnimatedGif(bytes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isAnimatedGif — adversarial 0x2C placements
// ---------------------------------------------------------------------------

describe("isAnimatedGif — false-positive resistance", () => {
  test("0x2C inside a Global Color Table is NOT counted as a frame", () => {
    // 2-entry GCT where one of the color bytes happens to be 0x2C.
    // A naive byte-count would see two 0x2C markers and call it
    // animated; the structured parser sees one image descriptor.
    const gctWith2C: ReadonlyArray<number> = [
      0x2c, 0x2c, 0x2c, // entry 0: rgb (44, 44, 44) — has 0x2C
      0xff, 0xff, 0xff, // entry 1: white
    ];
    const bytes = gif(
      GIF89A_SIG,
      LSD_1x1_WITH_GCT,
      gctWith2C,
      IMAGE_DESCRIPTOR_1x1,
      [TRAILER],
    );
    expect(isAnimatedGif(bytes)).toBe(false);
  });

  test("0x2C inside an Application Extension sub-block is NOT counted", () => {
    // NETSCAPE2.0 loop extension carries the literal bytes
    // "NETSCAPE2.0" — none of which are 0x2C — followed by a
    // sub-block whose payload includes the loop count. We'll
    // construct a synthetic Application Extension whose sub-block
    // data deliberately contains 0x2C bytes.
    const appExtWith2C: ReadonlyArray<number> = [
      0x21,
      0xff,
      0x0b,
      // 11 bytes of "application ID + auth code" — pick any bytes;
      // 0x2C among them tests that the parser doesn't mis-count.
      0x2c,
      0x2c,
      0x2c,
      0x2c,
      0x2c,
      0x2c,
      0x2c,
      0x2c,
      0x2c,
      0x2c,
      0x2c,
      // sub-block: length=3, payload contains 0x2C
      0x03,
      0x01,
      0x2c,
      0x01,
      // terminator
      0x00,
    ];
    const bytes = gif(
      GIF89A_SIG,
      LSD_1x1_WITH_GCT,
      GCT_2_ENTRIES,
      appExtWith2C,
      IMAGE_DESCRIPTOR_1x1,
      [TRAILER],
    );
    expect(isAnimatedGif(bytes)).toBe(false);
  });

  test("0x2C inside LZW image data is NOT counted as a second frame", () => {
    // An image descriptor whose LZW data sub-block payload contains
    // a 0x2C byte. Walking the sub-block lengths correctly steps
    // OVER that data byte without re-examining it as a block sentinel.
    const lzwBytes: ReadonlyArray<number> = [
      0x2c, // image-descriptor separator
      0x00,
      0x00, // left
      0x00,
      0x00, // top
      0x01,
      0x00, // width
      0x01,
      0x00, // height
      0x00, // packed
      0x02, // LZW min code size
      0x04, // sub-block length = 4
      0x44,
      0x2c, // ← 0x2C inside compressed data
      0x01,
      0x2c, // ← another 0x2C inside compressed data
      0x00, // sub-block terminator
    ];
    const bytes = gif(
      GIF89A_SIG,
      LSD_1x1_WITH_GCT,
      GCT_2_ENTRIES,
      lzwBytes,
      [TRAILER],
    );
    expect(isAnimatedGif(bytes)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAnimatedGif — malformed inputs
// ---------------------------------------------------------------------------

describe("isAnimatedGif — malformed inputs return false (graceful)", () => {
  test("signature only, no LSD → false", () => {
    const bytes = new Uint8Array(GIF89A_SIG);
    expect(isAnimatedGif(bytes)).toBe(false);
  });

  test("truncated mid-image-descriptor → false", () => {
    // Image descriptor cut off before the packed byte.
    const truncatedID: ReadonlyArray<number> = [
      0x2c, 0, 0, 0, 0, 0x01, 0, 0x01, 0, // missing packed byte
    ];
    const bytes = gif(
      GIF89A_SIG,
      LSD_1x1_WITH_GCT,
      GCT_2_ENTRIES,
      truncatedID,
    );
    expect(isAnimatedGif(bytes)).toBe(false);
  });

  test("unknown block byte (not 0x21 / 0x2C / 0x3B) → false", () => {
    // After GCT, a stray 0x77 byte where a block sentinel should be.
    const bytes = gif(
      GIF89A_SIG,
      LSD_1x1_WITH_GCT,
      GCT_2_ENTRIES,
      [0x77, 0x00],
    );
    expect(isAnimatedGif(bytes)).toBe(false);
  });

  test("no trailer, end-of-stream after a single image descriptor → false", () => {
    // The parser must still return a sensible value when bytes end
    // mid-stream (no 0x3B trailer).
    const bytes = gif(
      GIF89A_SIG,
      LSD_1x1_WITH_GCT,
      GCT_2_ENTRIES,
      IMAGE_DESCRIPTOR_1x1,
      // no trailer
    );
    expect(isAnimatedGif(bytes)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifySourceMime — MIME decision matrix
// ---------------------------------------------------------------------------

describe("classifySourceMime — supported raster types", () => {
  test.each([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/heic",
    "image/heif",
    "image/avif",
  ])("%s → raster", (mime) => {
    expect(classifySourceMime(mime)).toBe("raster");
  });

  test("uppercase variants are accepted", () => {
    expect(classifySourceMime("IMAGE/PNG")).toBe("raster");
    expect(classifySourceMime("Image/Jpeg")).toBe("raster");
  });
});

describe("classifySourceMime — GIF and SVG", () => {
  test("image/gif → gif-animatable", () => {
    expect(classifySourceMime("image/gif")).toBe("gif-animatable");
  });

  test("image/svg+xml → svg", () => {
    expect(classifySourceMime("image/svg+xml")).toBe("svg");
  });
});

describe("classifySourceMime — unsupported", () => {
  test.each([
    "application/pdf",
    "image/tiff",
    "image/bmp",
    "text/plain",
    "video/mp4",
    "",
  ])("%s → unsupported", (mime) => {
    expect(classifySourceMime(mime)).toBe("unsupported");
  });
});

// ---------------------------------------------------------------------------
// fitWithinLongEdge — aspect-preserving resize math
// ---------------------------------------------------------------------------

describe("fitWithinLongEdge — inputs already under the cap pass through", () => {
  test("equal-dimensions under cap", () => {
    expect(fitWithinLongEdge(800, 800, MAX_LONG_EDGE_PX)).toEqual({
      width: 800,
      height: 800,
    });
  });

  test("landscape under cap", () => {
    expect(fitWithinLongEdge(2000, 1000, MAX_LONG_EDGE_PX)).toEqual({
      width: 2000,
      height: 1000,
    });
  });

  test("portrait under cap", () => {
    expect(fitWithinLongEdge(1000, 2000, MAX_LONG_EDGE_PX)).toEqual({
      width: 1000,
      height: 2000,
    });
  });

  test("exactly at the cap is unchanged", () => {
    expect(
      fitWithinLongEdge(MAX_LONG_EDGE_PX, 1000, MAX_LONG_EDGE_PX),
    ).toEqual({ width: MAX_LONG_EDGE_PX, height: 1000 });
  });
});

describe("fitWithinLongEdge — oversize inputs scale aspect-preserving", () => {
  test("landscape 4K → 2576 long edge, short edge scaled proportionally", () => {
    // 3840 × 2160 → factor 2576/3840 = ~0.6708
    // short edge: 2160 * 0.6708 ≈ 1448.93 → 1449 rounded.
    const result = fitWithinLongEdge(3840, 2160, MAX_LONG_EDGE_PX);
    expect(result.width).toBe(MAX_LONG_EDGE_PX);
    expect(result.height).toBe(Math.round(2160 * (MAX_LONG_EDGE_PX / 3840)));
  });

  test("portrait → height clamped, width scaled proportionally", () => {
    // 2000 × 5000 → factor 2576/5000 = 0.5152
    // width: 2000 * 0.5152 = 1030.4 → 1030 rounded.
    const result = fitWithinLongEdge(2000, 5000, MAX_LONG_EDGE_PX);
    expect(result.height).toBe(MAX_LONG_EDGE_PX);
    expect(result.width).toBe(Math.round(2000 * (MAX_LONG_EDGE_PX / 5000)));
  });

  test("square oversize → uniform scale to cap on both edges", () => {
    expect(fitWithinLongEdge(5000, 5000, MAX_LONG_EDGE_PX)).toEqual({
      width: MAX_LONG_EDGE_PX,
      height: MAX_LONG_EDGE_PX,
    });
  });

  test("very small target (thumbnail) preserves aspect", () => {
    const result = fitWithinLongEdge(1000, 500, THUMBNAIL_MAX_EDGE_PX);
    expect(result.width).toBe(THUMBNAIL_MAX_EDGE_PX);
    expect(result.height).toBe(
      Math.round(500 * (THUMBNAIL_MAX_EDGE_PX / 1000)),
    );
  });

  test("SVG raster target works the same way", () => {
    const result = fitWithinLongEdge(4096, 2048, SVG_RASTER_MAX_EDGE_PX);
    expect(result.width).toBe(SVG_RASTER_MAX_EDGE_PX);
    expect(result.height).toBe(
      Math.round(2048 * (SVG_RASTER_MAX_EDGE_PX / 4096)),
    );
  });
});

describe("fitWithinLongEdge — degenerate inputs", () => {
  test("zero width returns zero dimensions", () => {
    expect(fitWithinLongEdge(0, 100, MAX_LONG_EDGE_PX)).toEqual({
      width: 0,
      height: 0,
    });
  });

  test("zero height returns zero dimensions", () => {
    expect(fitWithinLongEdge(100, 0, MAX_LONG_EDGE_PX)).toEqual({
      width: 0,
      height: 0,
    });
  });

  test("negative width returns zero dimensions", () => {
    expect(fitWithinLongEdge(-100, 100, MAX_LONG_EDGE_PX)).toEqual({
      width: 0,
      height: 0,
    });
  });

  test("scaled-down to sub-pixel result clamps to 1", () => {
    // A 10000×1 input scaled to long-edge 256 would produce a
    // short edge of 0.0256, which rounds to 0. The implementation
    // clamps to 1 to avoid invalid zero-dimension canvases.
    const result = fitWithinLongEdge(10000, 1, 256);
    expect(result.width).toBe(256);
    expect(result.height).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Exported constants — pin the values so changing them is intentional
// ---------------------------------------------------------------------------

describe("exported constants", () => {
  test("MAX_LONG_EDGE_PX matches Opus 4.7 Vision cap", () => {
    expect(MAX_LONG_EDGE_PX).toBe(2576);
  });

  test("MAX_BASE64_SIZE matches the enforced per-image base64 cap (5 MB)", () => {
    // The Anthropic Vision limit is measured on the base64 string, and
    // the Claude Code bridge enforces 5 MB base64 before send.
    expect(MAX_BASE64_SIZE).toBe(5 * 1024 * 1024);
  });

  test("MAX_BYTE_SIZE keeps the base64 payload under the cap, with margin", () => {
    // Decoded budget is derived from the base64 ceiling (×3/4) less a
    // 64 KiB margin, so the encoded output's base64 lands under 5 MB.
    expect(MAX_BYTE_SIZE).toBe(Math.floor((MAX_BASE64_SIZE * 3) / 4) - 64 * 1024);
    // The whole point: base64 of a max-size output stays under the cap.
    const base64OfMax = Math.ceil(MAX_BYTE_SIZE / 3) * 4;
    expect(base64OfMax).toBeLessThan(MAX_BASE64_SIZE);
  });

  test("THUMBNAIL_MAX_EDGE_PX gives a crisp, Retina-sized strip tile", () => {
    // 512 px so the fixed-width strip tile (128 px logical) downscales
    // rather than upscales even at 3× DPR. Still bounded for snapshot
    // residence. Test surfaces an intentional change.
    expect(THUMBNAIL_MAX_EDGE_PX).toBe(512);
  });

  test("SVG_RASTER_MAX_EDGE_PX is the picked SVG raster target", () => {
    expect(SVG_RASTER_MAX_EDGE_PX).toBe(1024);
  });

  test("JPEG_QUALITY_LADDER descends from 0.9 to 0.6 in 0.1 steps", () => {
    expect(JPEG_QUALITY_LADDER).toEqual([0.9, 0.8, 0.7, 0.6]);
  });

  test("JPEG quality ladder is strictly decreasing (fallback semantics)", () => {
    for (let i = 1; i < JPEG_QUALITY_LADDER.length; i += 1) {
      expect(JPEG_QUALITY_LADDER[i]!).toBeLessThan(JPEG_QUALITY_LADDER[i - 1]!);
    }
  });
});
