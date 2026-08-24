/// <reference lib="webworker" />

/**
 * `image-downsample-worker` — Web Worker that owns the canvas
 * image-processing pipeline.
 *
 * ## Why this exists as a worker
 *
 * Step 3 shipped the canvas pipeline on the main thread. Live testing
 * (Step 3.5) revealed that a 25 MB image drop locked the UI for
 * ~2 seconds during decode + resize + encode — keystrokes,
 * scrolls, and button clicks were unresponsive throughout. The cause
 * was straightforward: even when the pipeline used `OffscreenCanvas`,
 * the canvas was constructed on the main thread and never transferred
 * to a worker, so all the heavy paint / encode operations ran on the
 * main event loop.
 *
 * `OffscreenCanvas` only goes off-thread when *owned* by a Worker —
 * either by constructing it inside the worker, or by transferring it
 * via `transferControlToOffscreen`. This module takes the first
 * route: the worker constructs its own canvas, runs the full
 * decode-resize-encode pipeline, and posts the resulting base64 +
 * thumbnail data URL back to the main thread.
 *
 * Net effect: keystrokes, cursor scrolls, button clicks, and the
 * pending-atom pulse animation all continue normally while a 25 MB
 * image processes in the background. The user sees a pulsing
 * skeleton chip at the drop point during the work; UI input is
 * never blocked.
 *
 * ## Wire protocol
 *
 * The main thread spawns one worker per attachment job (`new Worker
 * (new URL(...), { type: 'module' })`), posts a single
 * `WorkerRequest`, awaits the matching `WorkerResponse`, and
 * terminates the worker. A pooled / long-lived worker would be a
 * possible optimization for repeated drops, but per-job workers
 * give us natural cancellation (terminate when the user deletes the
 * skeleton atom mid-work) and avoid sharing-state subtleties.
 *
 * `WorkerRequest.kind` discriminates between full downsample (drop /
 * paste pipeline) and thumbnail-only bakes (replay path, reducer
 * commit). The two share most of the underlying pipeline; the
 * thumbnail path skips the size-cap + JPEG quality ladder.
 *
 * Errors flow through the same discriminated `DownsampleOutcome`
 * shape the main-thread API returns. The worker never throws across
 * the message boundary — uncaught errors are wrapped into a
 * `decode-failed` outcome.
 *
 * ## Pure helpers
 *
 * `classifySourceMime`, `isAnimatedGif`, `fitWithinLongEdge`, and
 * the size constants are pure and stay imported from the main
 * `image-downsample.ts` module. The worker is the canvas heavy
 * lifter; the main module is the pure-logic anchor + API surface.
 *
 * Laws: [L02] external state — the worker is an isolated state
 *       container; nothing reaches main-thread React state from
 *       here. [L06] no DOM mutation in the worker — there's no
 *       DOM. [L19] file structure / docstring discipline.
 *
 * References:
 *  - [D05](../../../dash/dev-atoms.md#d05-client-downsample)
 *  - [Risk R01](../../../dash/dev-atoms.md#r01-canvas-blocking)
 *  - Step 3.5.3 in `dash/dev-atoms.md`
 */

import {
  MAX_LONG_EDGE_PX,
  MAX_BYTE_SIZE,
  THUMBNAIL_MAX_EDGE_PX,
  SVG_RASTER_MAX_EDGE_PX,
  JPEG_QUALITY_LADDER,
  classifySourceMime,
  fitWithinLongEdge,
  isAnimatedGif,
  type DownsampleOutcome,
} from "../image-downsample";

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

/**
 * Request from main thread to worker. Discriminated by `kind`:
 *  - `downsample`: full pipeline (decode + resize + encode +
 *    thumbnail). Used by the drop / paste pipeline at insert time.
 *  - `thumbnail`: lightweight thumbnail-only bake. Used by the
 *    reducer's commit path for replayed attachments where the bytes
 *    are already API-compliant; only the preview is missing.
 */
export type WorkerRequest =
  | { kind: "downsample"; blob: Blob }
  | { kind: "thumbnail"; blob: Blob };

/**
 * Response back to the main thread. Discriminated by `kind`:
 *  - `downsample-result` carries the full `DownsampleOutcome`
 *    (either ok-with-result or one of the discriminated errors).
 *  - `thumbnail-result` carries just the thumbnail data URL, or
 *    `null` on decode failure (thumbnail is a soft degradation;
 *    callers fall back to a generic icon).
 */
export type WorkerResponse =
  | { kind: "downsample-result"; outcome: DownsampleOutcome }
  | { kind: "thumbnail-result"; thumbnailDataUrl: string | null };

// ---------------------------------------------------------------------------
// Decoded source — opaque to callers; matches the canvas pipeline's
// internal needs.
// ---------------------------------------------------------------------------

interface DecodedSource {
  readonly width: number;
  readonly height: number;
  draw(
    ctx: OffscreenCanvasRenderingContext2D,
    dw: number,
    dh: number,
  ): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Blob / data-URL plumbing
// ---------------------------------------------------------------------------

/**
 * Read a Blob as a base64 string (no `data:` prefix). In a Worker
 * we can't use `FileReader` for binary → base64 directly (FileReader
 * is main-thread only in some engines); instead we read the blob as
 * an ArrayBuffer and base64-encode via a small chunked btoa loop.
 *
 * The chunking matters: `btoa` accepts a binary string, but
 * `String.fromCharCode(...largeArray)` blows the argument stack.
 * 0x8000-byte chunks keep us well below the recursion / stack limit
 * across engines.
 */
async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(binary);
}

/**
 * Read a Blob as a data URL (`data:<mime>;base64,<payload>`).
 * Combines `blobToBase64` with the blob's MIME so the result is
 * directly assignable to an `<img src>` on the main thread.
 */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const b64 = await blobToBase64(blob);
  const mime = blob.type !== "" ? blob.type : "application/octet-stream";
  return `data:${mime};base64,${b64}`;
}

// ---------------------------------------------------------------------------
// Decode pipeline
// ---------------------------------------------------------------------------

/**
 * Decode a Blob to an ImageBitmap. The worker has access to
 * `createImageBitmap` (the API is exposed in the worker scope on
 * every engine that supports OffscreenCanvas), so this is the only
 * decode path we need — no `HTMLImageElement` fallback because no
 * DOM exists here. Failures bubble up as thrown errors that the
 * caller wraps into a `decode-failed` outcome.
 */
async function decodeSource(blob: Blob): Promise<DecodedSource> {
  const bmp = await createImageBitmap(blob);
  return {
    width: bmp.width,
    height: bmp.height,
    draw(ctx, dw, dh) {
      ctx.drawImage(bmp, 0, 0, dw, dh);
    },
    close() {
      bmp.close();
    },
  };
}

/**
 * Paint a decoded source onto a fresh `OffscreenCanvas` at the
 * requested dimensions and return the canvas. The worker owns the
 * canvas — no transfer back to the main thread; we encode to a Blob
 * before posting the result.
 */
function paintTo(
  source: DecodedSource,
  width: number,
  height: number,
): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("2D canvas context unavailable in worker");
  }
  // Enable high-quality resampling. Without this, a canvas downscale
  // can fall back to nearest-neighbor sampling on some engines,
  // dropping source pixels and producing the aliased / pixelated
  // thumbnails the strip was showing. `"high"` requests the engine's
  // best (bi-/tri-linear or better) filter so a downscale reads the
  // whole neighborhood instead of a single nearest texel.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  source.draw(ctx, width, height);
  return canvas;
}

/**
 * Encode the canvas to a Blob via `convertToBlob`. `OffscreenCanvas`
 * is the only canvas kind in this worker — no need for the dual
 * `toBlob` / `convertToBlob` shape the main-thread version had.
 */
async function canvasToBlob(
  canvas: OffscreenCanvas,
  mimeType: string,
  quality?: number,
): Promise<Blob> {
  return canvas.convertToBlob(
    quality !== undefined ? { type: mimeType, quality } : { type: mimeType },
  );
}

/**
 * Encode-with-fallback. Tries the source MIME first; if the result
 * exceeds `MAX_BYTE_SIZE`, walks the JPEG quality ladder. Returns
 * the first encoded form that fits, or `null` if every step
 * exceeded the cap.
 */
async function encodeWithFallback(
  canvas: OffscreenCanvas,
  sourceMime: string,
): Promise<{ blob: Blob; mediaType: string } | null> {
  const tryNative = await canvasToBlob(canvas, sourceMime);
  if (tryNative.size <= MAX_BYTE_SIZE) {
    return { blob: tryNative, mediaType: sourceMime };
  }

  for (const q of JPEG_QUALITY_LADDER) {
    const jpeg = await canvasToBlob(canvas, "image/jpeg", q);
    if (jpeg.size <= MAX_BYTE_SIZE) {
      return { blob: jpeg, mediaType: "image/jpeg" };
    }
  }

  return null;
}

/**
 * Build a thumbnail data URL from a decoded source. Always PNG so
 * the snapshot-side `<img src>` doesn't care about the source
 * format.
 */
async function bakeThumbnailFromSource(
  source: DecodedSource,
): Promise<string> {
  const { width, height } = fitWithinLongEdge(
    source.width,
    source.height,
    THUMBNAIL_MAX_EDGE_PX,
  );
  const canvas = paintTo(source, width, height);
  const blob = await canvasToBlob(canvas, "image/png");
  return blobToDataUrl(blob);
}

// ---------------------------------------------------------------------------
// Branch implementations — mirror the main-thread structure
// ---------------------------------------------------------------------------

async function downsampleGif(
  source: Blob,
  mediaType: string,
): Promise<DownsampleOutcome> {
  const buffer = await source.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (isAnimatedGif(bytes)) {
    // Animated: passthrough — canvas resize would collapse the
    // animation to a single frame.
    if (source.size > MAX_BYTE_SIZE) {
      return {
        ok: false,
        error: { kind: "too-large-after-fallback", byteSize: source.size },
      };
    }
    const content = await blobToBase64(source);
    let thumbnailDataUrl: string;
    let width: number;
    let height: number;
    try {
      const decoded = await decodeSource(source);
      try {
        thumbnailDataUrl = await bakeThumbnailFromSource(decoded);
        width = decoded.width;
        height = decoded.height;
      } finally {
        decoded.close();
      }
    } catch (err) {
      void err;
      // Decode failed but the passthrough bytes are good; ship
      // without a thumbnail rather than rejecting.
      thumbnailDataUrl = "";
      width = 0;
      height = 0;
    }
    return {
      ok: true,
      result: {
        content,
        mediaType,
        thumbnailDataUrl,
        width,
        height,
        byteSize: source.size,
      },
    };
  }

  // Static GIF — flow through the raster pipeline.
  return downsampleRaster(source, mediaType);
}

async function downsampleSvg(source: Blob): Promise<DownsampleOutcome> {
  // Note: SVG decoding via `createImageBitmap` works in WebKit; in
  // some engines SVG is restricted from `createImageBitmap`. If the
  // decode fails we surface a `decode-failed` error rather than
  // attempting an `<img>` fallback (no DOM here).
  let decoded: DecodedSource;
  try {
    decoded = await decodeSource(source);
  } catch (err) {
    return {
      ok: false,
      error: { kind: "decode-failed", reason: errorReason(err) },
    };
  }
  try {
    const { width, height } = fitWithinLongEdge(
      decoded.width > 0 ? decoded.width : SVG_RASTER_MAX_EDGE_PX,
      decoded.height > 0 ? decoded.height : SVG_RASTER_MAX_EDGE_PX,
      SVG_RASTER_MAX_EDGE_PX,
    );
    const canvas = paintTo(decoded, width, height);
    const png = await canvasToBlob(canvas, "image/png");
    if (png.size > MAX_BYTE_SIZE) {
      return {
        ok: false,
        error: { kind: "too-large-after-fallback", byteSize: png.size },
      };
    }
    const content = await blobToBase64(png);
    const thumbnailDataUrl = await bakeThumbnailFromSource(decoded);
    return {
      ok: true,
      result: {
        content,
        mediaType: "image/png",
        thumbnailDataUrl,
        width,
        height,
        byteSize: png.size,
      },
    };
  } finally {
    decoded.close();
  }
}

async function downsampleRaster(
  source: Blob,
  mediaType: string,
): Promise<DownsampleOutcome> {
  let decoded: DecodedSource;
  try {
    decoded = await decodeSource(source);
  } catch (err) {
    return {
      ok: false,
      error: { kind: "decode-failed", reason: errorReason(err) },
    };
  }
  try {
    const { width, height } = fitWithinLongEdge(
      decoded.width,
      decoded.height,
      MAX_LONG_EDGE_PX,
    );
    if (width === 0 || height === 0) {
      return {
        ok: false,
        error: { kind: "decode-failed", reason: "zero-dimension source" },
      };
    }
    const canvas = paintTo(decoded, width, height);
    const encoded = await encodeWithFallback(canvas, mediaType);
    if (encoded === null) {
      const lastResort = await canvasToBlob(
        canvas,
        "image/jpeg",
        JPEG_QUALITY_LADDER[JPEG_QUALITY_LADDER.length - 1],
      );
      return {
        ok: false,
        error: {
          kind: "too-large-after-fallback",
          byteSize: lastResort.size,
        },
      };
    }
    const content = await blobToBase64(encoded.blob);
    const thumbnailDataUrl = await bakeThumbnailFromSource(decoded);
    return {
      ok: true,
      result: {
        content,
        mediaType: encoded.mediaType,
        thumbnailDataUrl,
        width,
        height,
        byteSize: encoded.blob.size,
      },
    };
  } finally {
    decoded.close();
  }
}

// ---------------------------------------------------------------------------
// Top-level entry points
// ---------------------------------------------------------------------------

async function downsampleImage(blob: Blob): Promise<DownsampleOutcome> {
  const mediaType = blob.type;
  const cls = classifySourceMime(mediaType);

  if (cls === "unsupported") {
    return { ok: false, error: { kind: "unsupported-format", mediaType } };
  }
  if (cls === "gif-animatable") {
    return downsampleGif(blob, mediaType);
  }
  if (cls === "svg") {
    return downsampleSvg(blob);
  }
  return downsampleRaster(blob, mediaType);
}

async function bakeThumbnailOnly(blob: Blob): Promise<string | null> {
  try {
    const decoded = await decodeSource(blob);
    try {
      return await bakeThumbnailFromSource(decoded);
    } finally {
      decoded.close();
    }
  } catch (err) {
    void err;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function errorReason(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown decode error";
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

/**
 * The worker's single message handler. Dispatches by request kind,
 * runs the matching pipeline, posts the result, and exits via
 * `close()` so the runtime tears down promptly. The main thread
 * also calls `worker.terminate()` defensively in case the worker
 * hangs.
 *
 * Uncaught errors at this level become `decode-failed` outcomes —
 * the worker should never throw across the message boundary because
 * that would surface as a generic `worker.onerror` event with no
 * structured data on the main thread.
 */
self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { data } = e;
  try {
    if (data.kind === "downsample") {
      const outcome = await downsampleImage(data.blob);
      const response: WorkerResponse = {
        kind: "downsample-result",
        outcome,
      };
      (self as DedicatedWorkerGlobalScope).postMessage(response);
    } else if (data.kind === "thumbnail") {
      const thumbnailDataUrl = await bakeThumbnailOnly(data.blob);
      const response: WorkerResponse = {
        kind: "thumbnail-result",
        thumbnailDataUrl,
      };
      (self as DedicatedWorkerGlobalScope).postMessage(response);
    }
  } catch (err) {
    // Bubble unexpected throws back as discriminated errors so the
    // main thread's catch path doesn't have to translate.
    const response: WorkerResponse =
      data.kind === "downsample"
        ? {
            kind: "downsample-result",
            outcome: {
              ok: false,
              error: { kind: "decode-failed", reason: errorReason(err) },
            },
          }
        : { kind: "thumbnail-result", thumbnailDataUrl: null };
    (self as DedicatedWorkerGlobalScope).postMessage(response);
  } finally {
    // One-shot worker — exit after responding. The main thread also
    // calls `terminate()` defensively.
    (self as DedicatedWorkerGlobalScope).close();
  }
};
