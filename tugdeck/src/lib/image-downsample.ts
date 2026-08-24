/**
 * `image-downsample` — canvas-based image normalization pipeline for
 * inline image attachments (drop / paste).
 *
 * Every image the user drops or pastes runs through this module
 * *before* its bytes reach the per-card bytes-store. The output is
 * always API-compliant: ≤ 2576 px on the long edge (the Opus 4.7
 * Vision cap) and small enough that its **base64** encoding stays
 * under the per-image ceiling. The size ceiling is measured on the
 * base64 string, not the decoded bytes: the Anthropic API limits the
 * base64 payload (10 MB direct, 5 MB on Bedrock/Vertex), and the
 * bundled Claude Code bridge enforces the stricter 5 MB base64 cap
 * before a turn is sent. Base64 inflates the decoded size by ~4/3, so
 * a budget expressed in decoded bytes (the earlier shape of this
 * module) let a compliant-looking image ship an oversize payload —
 * `MAX_BYTE_SIZE` is now derived from the base64 ceiling. That
 * guarantee means neither tugcode nor the Claude Code bridge sees an
 * oversize payload — nothing downstream has cause to reject one of
 * our submissions on size grounds.
 *
 * ## Pipeline shape
 *
 * Source MIME drives the branch. The decision matrix lives in
 * [`dash/dev-atoms.md`](../../../dash/dev-atoms.md#t03-downsample-decisions)
 * Table T03; this implementation is its executable form. In summary:
 *
 *  - `image/png` / `image/jpeg` / `image/webp` → canvas resize +
 *    re-encode in source MIME; JPEG quality-ladder fallback (90, 80,
 *    70, 60) if the result still exceeds 5 MB.
 *  - `image/gif` (animated, > 1 frame) → passthrough with a size
 *    check only. Canvas resize would lose the animation; Anthropic
 *    Vision accepts native GIF bytes and analyzes all frames.
 *  - `image/gif` (static, ≤ 1 frame) → canvas resize like any other
 *    raster, with the GIF / JPEG fallback ladder above.
 *  - `image/svg+xml` → rasterize to PNG at long-edge ≤ 1024 px.
 *  - `image/heic` / `image/heif` / `image/avif` → flow through the
 *    raster branch unchanged. WebKit (the engine Tug.app uses)
 *    decodes all three natively via `createImageBitmap`. Verified
 *    empirically (see [Q02] in `dev-atoms.md`).
 *  - Anything else → `unsupported-format` discriminated error.
 *
 * ## Discriminated errors
 *
 * The function never throws. Every failure returns
 * `{ ok: false, error: DownsampleError }` so callers can surface
 * different errors with different copy. Three kinds:
 *
 *  - `unsupported-format` — source MIME not in the allowlist.
 *  - `too-large-after-fallback` — exhausted the JPEG quality ladder
 *    and the result still exceeds 5 MB. This is genuinely huge
 *    content (a 50 MP screenshot of a single hue gradient, say); the
 *    user should crop, downscale, or split the image.
 *  - `decode-failed` — the engine could not decode the source
 *    (corrupt bytes, or a format the engine genuinely can't read).
 *    The `reason` field carries a short engine-provided string for
 *    diagnostics.
 *
 * ## Off-main-thread preference
 *
 * The pipeline prefers `createImageBitmap(blob)` because WebKit
 * decodes off the main thread along that path. The fallback
 * (`HTMLImageElement` + `drawImage`) is main-thread blocking. For
 * images outside the typical-screenshot range, callers should expect
 * a short UI hitch on the fallback path (Risk R01 in
 * `dev-atoms.md`). The 100 ms processing-indicator threshold lives
 * in the caller (drop / paste handlers, Step 2).
 *
 * ## Pure parts
 *
 * `isAnimatedGif(bytes)` is the one fully-pure export — a frame-count
 * detector that walks the raw GIF byte stream looking for image
 * descriptor markers. Pure because the canvas can't tell us whether a
 * GIF is animated without decoding all of it; the byte-level parser
 * is fast (microseconds for a typical file) and gives us a stable
 * branch decision before we touch the canvas.
 *
 * Laws: [L19] file-structure / docstring discipline applies. No L01,
 *       L02, L03, L06 concerns — this is a pure-logic library, no
 *       React state, no DOM rendering, no responder participation.
 *
 * References:
 *  - [Spec S04] image-downsample contract — `dash/dev-atoms.md#s04-image-downsample`
 *  - [D05] client-side downsample at insert — `dash/dev-atoms.md#d05-client-downsample`
 *  - [Table T03] downsample decision matrix — `dash/dev-atoms.md#t03-downsample-decisions`
 *  - [Q02] HEIC / AVIF empirical findings — `dash/dev-atoms.md#q02-heic-avif`
 *  - [Q04] animated GIF policy — `dash/dev-atoms.md#q04-animated-gif`
 *  - [Risk R01] canvas blocking — `dash/dev-atoms.md#r01-canvas-blocking`
 *  - GIF89a specification (W3C). Image Descriptor sentinel `0x2C`,
 *    Extension Introducer `0x21`, Trailer `0x3B`.
 *  - Anthropic Vision docs: 5 MB per image, 2576 px Opus 4.7 long-edge.
 */

// ---------------------------------------------------------------------------
// Constants — exported for caller / test alignment.
// ---------------------------------------------------------------------------

/**
 * Long-edge ceiling at submit. Matches Opus 4.7's tokenization cap;
 * larger images get downsampled to this dimension maintaining aspect.
 */
export const MAX_LONG_EDGE_PX = 2576;

/**
 * Per-image ceiling on the **base64-encoded** payload. The Anthropic
 * Vision API measures its size limit on the base64 string (10 MB
 * direct, 5 MB on Bedrock/Vertex), and the bundled Claude Code bridge
 * enforces the stricter 5 MB base64 cap before a turn is sent — so we
 * target that. The decoded budget below is derived from this.
 */
export const MAX_BASE64_SIZE = 5 * 1024 * 1024;

/**
 * Max **decoded** byte size of a single image's encoded output (the
 * raw JPEG/PNG/WebP bytes, i.e. `Blob.size`). Derived from
 * {@link MAX_BASE64_SIZE}: base64 expands decoded bytes by ~4/3
 * (`ceil(n/3) * 4`), so the decoded budget is the base64 ceiling
 * scaled by 3/4, minus a 64 KiB margin so the encoded payload lands
 * comfortably under the limit (avoids a boundary rejection when the
 * downstream check is `>=` rather than `>`). The pipeline compares
 * `Blob.size` against this value; images that still exceed it after
 * the JPEG quality ladder return a `too-large-after-fallback` error.
 */
export const MAX_BYTE_SIZE =
  Math.floor((MAX_BASE64_SIZE * 3) / 4) - 64 * 1024;

/**
 * Long-edge ceiling for thumbnails. The transcript strip renders each
 * tile at a fixed 128 px logical width with the height following the
 * image's aspect ratio (no crop). At up to 3× device-pixel-ratio that
 * is ~384 physical px on the long edge; 512 gives headroom so the
 * downscale at display time stays a true downscale (never an upscale)
 * even for off-square images whose short edge would otherwise land
 * well below the tile's physical size. The old 256 px ceiling forced
 * the browser to upscale the thumbnail into the tile — the source of
 * the pixelated / blurred previews. Still bounded so we don't hold the
 * full payload in React state ([D04] no-bytes-on-snapshot).
 */
export const THUMBNAIL_MAX_EDGE_PX = 512;

/**
 * SVG rasterization target. Vector input has no intrinsic resolution,
 * so we pick a reasonable raster size; 1024 px is large enough to
 * read most diagrams clearly without ballooning the byte count.
 */
export const SVG_RASTER_MAX_EDGE_PX = 1024;

/**
 * JPEG quality ladder for the fallback transcode. Progressively
 * lower quality until the encoded result fits the 5 MB cap. Values
 * chosen empirically: 90 is visually indistinguishable from lossless
 * for most content; 60 is the floor where compression artifacts
 * start to bite. If even 60 doesn't fit, the source is unreasonably
 * large for chat use.
 */
export const JPEG_QUALITY_LADDER: ReadonlyArray<number> = [
  0.9, 0.8, 0.7, 0.6,
];

/**
 * Source MIME types the pipeline recognizes. Anything not in this
 * set (and not `image/heic`/`image/heif`/`image/avif`, which are
 * routed through canvas decode like raster sources) returns
 * `unsupported-format`.
 */
const SUPPORTED_RASTER_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  // HEIC / HEIF / AVIF flow through the canvas decode path; WebKit
  // decodes them natively (per Q02 empirical findings). A decode
  // failure on these still routes through the `decode-failed` error
  // class — the right class for "this file looked supported but the
  // engine can't read it" (corrupt bytes, exotic subformat).
  "image/heic",
  "image/heif",
  "image/avif",
]);

/**
 * MIME types that pass through unchanged (after a size check) when
 * animated. Currently just `image/gif`; PDFs and other animated
 * formats are out of scope per [Q03] / non-goals.
 */
const ANIMATABLE_MIMES: ReadonlySet<string> = new Set(["image/gif"]);

// ---------------------------------------------------------------------------
// Public types — mirror Spec S04 verbatim.
// ---------------------------------------------------------------------------

/**
 * Successful downsample result. The `content` and `mediaType` pair
 * is what flows to the bytes-store / wire; `thumbnailDataUrl` is the
 * snapshot-resident preview used by the transcript attachment strip.
 *
 * `mediaType` may differ from the source MIME when the JPEG quality
 * ladder kicked in — a 6 MB PNG that transcoded to JPEG comes back
 * as `image/jpeg`, not `image/png`. Callers should honor `mediaType`
 * when constructing the wire `Attachment`, not the original source's
 * type.
 */
export interface DownsampleResult {
  /** Base64-encoded image bytes. */
  content: string;
  /** Effective MIME type after any transcode. */
  mediaType: string;
  /** Inline thumbnail data URL — drop straight into `<img src>`. */
  thumbnailDataUrl: string;
  /** Output dimensions in pixels. */
  width: number;
  height: number;
  /** Decoded byte size — equals `Blob.size` of the encoded output. */
  byteSize: number;
}

/**
 * Discriminated downsample failure. The pipeline never throws;
 * callers branch on `kind`.
 */
export type DownsampleError =
  | { kind: "unsupported-format"; mediaType: string }
  | { kind: "too-large-after-fallback"; byteSize: number }
  | { kind: "decode-failed"; reason: string };

/**
 * Discriminated result. Callers branch on `ok`.
 */
export type DownsampleOutcome =
  | { ok: true; result: DownsampleResult }
  | { ok: false; error: DownsampleError };

// ---------------------------------------------------------------------------
// `isAnimatedGif` — pure GIF frame-count detector.
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the byte stream is a GIF containing more than one
 * frame (i.e., animated), `false` otherwise. Pure function; reads no
 * external state and produces no side effects.
 *
 * Why a real parser rather than a `0x2C` count: the Image Descriptor
 * sentinel `0x2C` can appear inside the global color table, inside
 * sub-block data of extension records, or inside LZW-compressed image
 * data. A naive byte-count would over-report and route static GIFs
 * (mistakenly classified as animated) through the passthrough branch,
 * where they'd skip the resize step and possibly exceed the 5 MB cap
 * for no reason. The structured walk costs microseconds even on
 * megabyte-class GIFs and rules out false positives.
 *
 * Algorithm:
 *  1. Verify the `GIF87a` or `GIF89a` magic.
 *  2. Read the Logical Screen Descriptor; if the Global Color Table
 *     flag is set, skip its bytes (`3 * 2^(gctSize + 1)`).
 *  3. Walk the data stream block-by-block until the Trailer (`0x3B`)
 *     or end-of-bytes:
 *      - `0x2C`: Image Descriptor. Count it; if count > 1 short-
 *        circuit `true`. Skip its 9 fixed-bytes, then conditionally
 *        skip the Local Color Table, then the LZW min code size byte,
 *        then the LZW data sub-blocks (length-prefixed; `0x00`
 *        terminates).
 *      - `0x21`: Extension Introducer. Skip the label byte, then walk
 *        sub-blocks (length-prefixed; `0x00` terminates).
 *      - `0x3B`: Trailer. End of file. Return `count > 1`.
 *      - Anything else: malformed — return `false`. Malformed GIFs
 *        flow into the canvas path where the engine produces a
 *        clean `decode-failed` if it can't read them.
 *
 * @example
 * ```ts
 * isAnimatedGif(new Uint8Array(staticGifBytes))    // → false
 * isAnimatedGif(new Uint8Array(animatedGifBytes))  // → true
 * isAnimatedGif(new Uint8Array(corruptBytes))      // → false
 * ```
 */
export function isAnimatedGif(bytes: Uint8Array): boolean {
  // GIF needs at least signature (6) + Logical Screen Descriptor (7)
  // = 13 bytes before any block data.
  if (bytes.length < 13) return false;

  // Signature: "GIF87a" (0x47 0x49 0x46 0x38 0x37 0x61) or
  //            "GIF89a" (0x47 0x49 0x46 0x38 0x39 0x61).
  if (
    bytes[0] !== 0x47 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x38 ||
    (bytes[4] !== 0x37 && bytes[4] !== 0x39) ||
    bytes[5] !== 0x61
  ) {
    return false;
  }

  // Logical Screen Descriptor layout (bytes 6-12, total 7 bytes):
  //  [6-7]   logical screen width  (u16 little-endian)
  //  [8-9]   logical screen height (u16 little-endian)
  //  [10]    packed: GCT-flag(1) | color-resolution(3) | sort-flag(1) | gct-size(3)
  //  [11]    background color index
  //  [12]    pixel aspect ratio
  const packed = bytes[10]!;
  const gctFlag = (packed & 0x80) !== 0;
  const gctSize = packed & 0x07;

  // Cursor: position in the byte stream we're about to read.
  let p = 13;

  // Skip the Global Color Table when present. Size in bytes is
  // 3 * 2^(gctSize + 1).
  if (gctFlag) {
    p += 3 * (1 << (gctSize + 1));
  }

  let imageDescriptorCount = 0;

  while (p < bytes.length) {
    const block = bytes[p]!;

    // Trailer — end of GIF.
    if (block === 0x3b) {
      return imageDescriptorCount > 1;
    }

    // Extension Introducer.
    if (block === 0x21) {
      p += 1; // consume introducer
      if (p >= bytes.length) return imageDescriptorCount > 1;
      p += 1; // consume label byte (GCE 0xF9, comment 0xFE, etc.)
      // Walk sub-blocks until the 0x00 terminator.
      while (p < bytes.length) {
        const subLen = bytes[p]!;
        p += 1;
        if (subLen === 0) break;
        p += subLen;
      }
      continue;
    }

    // Image Descriptor.
    if (block === 0x2c) {
      imageDescriptorCount += 1;
      if (imageDescriptorCount > 1) {
        // Short-circuit: as soon as we see a second image, we know
        // the GIF is animated and can stop walking.
        return true;
      }
      p += 1; // consume separator
      // Skip 8 bytes of fixed image-descriptor fields:
      //   left(u16le) + top(u16le) + width(u16le) + height(u16le)
      p += 8;
      if (p >= bytes.length) return false;
      const imagePacked = bytes[p]!;
      p += 1;
      const lctFlag = (imagePacked & 0x80) !== 0;
      const lctSize = imagePacked & 0x07;
      if (lctFlag) {
        p += 3 * (1 << (lctSize + 1));
      }
      // LZW Minimum Code Size byte.
      p += 1;
      // Image data sub-blocks.
      while (p < bytes.length) {
        const subLen = bytes[p]!;
        p += 1;
        if (subLen === 0) break;
        p += subLen;
      }
      continue;
    }

    // Unknown block byte — malformed GIF. Return false so the canvas
    // path produces a clean decode-failed error rather than us
    // pretending to know more than we do.
    return false;
  }

  return imageDescriptorCount > 1;
}

// ---------------------------------------------------------------------------
// MIME classification — pure helper for routing decisions.
// ---------------------------------------------------------------------------

/**
 * Classification of a source MIME type into a downsample branch.
 *
 *  - `raster`: standard canvas decode + resize + re-encode path.
 *  - `gif-animatable`: GIF input — `isAnimatedGif` branches further
 *    into passthrough (animated) vs. raster (static).
 *  - `svg`: rasterize via canvas.
 *  - `unsupported`: source is not in the allowlist.
 */
export type SourceMimeClass =
  | "raster"
  | "gif-animatable"
  | "svg"
  | "unsupported";

/**
 * Classify a source MIME type for the downsample pipeline. Pure
 * function — exported so callers can introspect supported MIMEs
 * without invoking the canvas pipeline (drop / paste handlers may
 * want to early-reject unsupported drops before the file is read).
 *
 * MIME types are compared case-insensitively; we lower-case before
 * lookup. `image/JPEG` and `image/jpeg` both resolve to `raster`.
 *
 * @example
 * ```ts
 * classifySourceMime("image/png")           // → "raster"
 * classifySourceMime("image/gif")           // → "gif-animatable"
 * classifySourceMime("image/svg+xml")       // → "svg"
 * classifySourceMime("application/pdf")     // → "unsupported"
 * ```
 */
export function classifySourceMime(mediaType: string): SourceMimeClass {
  const m = mediaType.toLowerCase();
  if (m === "image/svg+xml") return "svg";
  if (ANIMATABLE_MIMES.has(m)) return "gif-animatable";
  if (SUPPORTED_RASTER_MIMES.has(m)) return "raster";
  return "unsupported";
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

/**
 * Compute the resize target maintaining aspect ratio. Returns the
 * input dimensions unchanged when both fit under `maxLongEdge`;
 * otherwise scales the long edge to `maxLongEdge` and the short edge
 * proportionally (rounded to nearest integer).
 *
 * Exported for unit-test coverage — the math is pure and easy to
 * pin against expected values without dragging in the canvas.
 */
export function fitWithinLongEdge(
  width: number,
  height: number,
  maxLongEdge: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) {
    return { width: 0, height: 0 };
  }
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) {
    return { width, height };
  }
  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// ---------------------------------------------------------------------------
// `downsampleImage` / `bakeThumbnail` — Web Worker shims.
//
// The actual canvas pipeline (decode + resize + encode + thumbnail
// bake) lives in `./workers/image-downsample-worker.ts`. The main
// thread spawns one worker per attachment job, posts the Blob,
// awaits the structured response, and terminates. The worker owns
// its own `OffscreenCanvas`, so all the heavy paint / encode work
// runs off the main event loop — keystrokes, scrolls, and the
// pending-atom pulse continue normally even during a 25 MB image
// drop. See Step 3.5.3 in `dash/dev-atoms.md`.
//
// Pure helpers (`isAnimatedGif`, `classifySourceMime`,
// `fitWithinLongEdge`) and constants remain in this module because
// the worker imports them — and so do the unit tests, which exercise
// the pure surface only.
// ---------------------------------------------------------------------------

import type { WorkerRequest, WorkerResponse } from "./workers/image-downsample-worker";

/**
 * Spawn a one-shot worker, post a request, await the matching
 * response, and terminate. The worker also calls `close()` on
 * itself after responding, so `terminate()` here is defensive
 * cleanup — it ensures the worker dies promptly even if its
 * own self-close hits a race.
 *
 * On worker.onerror (a crash / load failure that doesn't reach the
 * worker's structured error handler), the promise resolves with a
 * fallback value supplied by the caller — for `downsampleImage`
 * that's a `decode-failed` outcome; for `bakeThumbnail` it's
 * `null`. The caller's existing error path handles either way.
 */
function runDownsampleWorker<TFallback>(
  request: WorkerRequest,
  fallback: TFallback,
): Promise<WorkerResponse | { kind: "fallback"; value: TFallback }> {
  return new Promise((resolve) => {
    const worker = new Worker(
      new URL("./workers/image-downsample-worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = () => {
      worker.terminate();
      resolve({ kind: "fallback", value: fallback });
    };
    worker.postMessage(request);
  });
}

/**
 * Normalize a dropped or pasted image for inline submission. Never
 * throws; every failure is a `{ ok: false, error }` outcome.
 *
 * Pipeline per [D05]:
 *  1. Spawn an `image-downsample-worker`.
 *  2. The worker's pipeline: classify MIME → GIF / SVG / raster
 *     branch → decode via `createImageBitmap` → resize to
 *     `MAX_LONG_EDGE_PX` → encode in source MIME → JPEG-ladder
 *     fallback if > `MAX_BYTE_SIZE` → bake thumbnail at
 *     `THUMBNAIL_MAX_EDGE_PX`.
 *  3. Worker posts the `DownsampleOutcome` and exits; main thread
 *     terminates and returns.
 *
 * The worker runs entirely off the main thread, so UI input
 * (typing, scrolling, button clicks) stays responsive during the
 * 1-2 s a large image takes to process.
 *
 * Source MIME is read from `source.type`; callers that have a more
 * reliable MIME signal (e.g., a `File.type` from a drop event)
 * should pass it through.
 */
export async function downsampleImage(
  source: Blob | File,
): Promise<DownsampleOutcome> {
  const decodeFailedFallback: DownsampleOutcome = {
    ok: false,
    error: { kind: "decode-failed", reason: "worker spawn or transport failed" },
  };
  const response = await runDownsampleWorker(
    { kind: "downsample", blob: source },
    decodeFailedFallback,
  );
  if (response.kind === "downsample-result") return response.outcome;
  if (response.kind === "fallback") return response.value;
  // Should not happen — defensive narrowing for the
  // thumbnail-result branch (worker should only respond with the
  // matching kind for our request).
  return decodeFailedFallback;
}

/**
 * Bake a thumbnail data URL for an already-API-compliant image
 * source. Returns a `data:image/<mime>;base64,…` URL whose decoded
 * image has a max edge of 256 px (the canvas worker's
 * `THUMBNAIL_MAX_EDGE_PX` constant). The output mediaType matches
 * the worker's bake — JPEG for opaque sources, PNG for transparent.
 *
 * Called by `synthesizeUserMessageFromBlocks` ([Step 5c](dash/dev-atoms.md#step-5c))
 * per image content block to populate the bytes-store entry's
 * `thumbnailDataUrl`. The synthesizer fires the bake fire-and-forget;
 * the per-message attachment strip ([Step 6](dash/dev-atoms.md#step-6))
 * re-renders when the bytes-store's subscriber pushes the update.
 *
 * Returns `null` on decode failure rather than the discriminated-
 * error shape — the caller has already committed to using the
 * bytes; a missing thumbnail is a soft degradation (Step 6's strip
 * renders a placeholder tile), not a submission-blocking failure.
 */
export async function bakeThumbnail(
  source: Blob | File,
): Promise<string | null> {
  const response = await runDownsampleWorker(
    { kind: "thumbnail", blob: source },
    null,
  );
  if (response.kind === "thumbnail-result") return response.thumbnailDataUrl;
  if (response.kind === "fallback") return response.value;
  return null;
}
