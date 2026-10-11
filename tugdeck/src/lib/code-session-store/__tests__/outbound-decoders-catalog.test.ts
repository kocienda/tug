/**
 * The outbound decoders against the golden stream-json catalog.
 *
 * Every frame in every catalog version whose tag has a decoder runs through
 * that decoder, and none may fail: the catalog is what tugcode actually
 * emitted on capture, so a failure here is a decoder stricter than the wire.
 * The failures are collected and reported together, each with its version,
 * probe, frame index and the decode error's line.
 *
 * The `task_*` frames go one step further, through the store's camelCase
 * mapping, which refuses an empty id: no captured frame may be refused there
 * either.
 */

import { describe, expect, it } from "bun:test";

import { decodeOutbound, hasDecoder, OUTBOUND_DECODERS } from "@tugproto/outbound-decoders";
import { isDecodeError } from "@tugproto/decode";
import {
  listGoldenProbes,
  listGoldenVersions,
  loadGoldenProbe,
  type GoldenEvent,
} from "@/lib/code-session-store/testing/golden-catalog";
import {
  taskProgressEvent,
  taskStartedEvent,
  taskUpdatedEvent,
} from "@/lib/code-session-store/select-jobs";

interface CatalogFrame {
  where: string;
  event: GoldenEvent;
}

const FRAMES: CatalogFrame[] = listGoldenVersions().flatMap((version) =>
  listGoldenProbes(version).flatMap((probe) =>
    loadGoldenProbe(version, probe).events.map((event, i) => ({
      where: `${version}/${probe}#${i}`,
      event,
    })),
  ),
);

/** Tags with a decoder and no frame anywhere in the catalog, sorted. */
const UNCAPTURED = [
  "add_user_message",
  "api_retry",
  "assistant_opener",
  "compact_boundary",
  "compact_summary",
  "error",
  "goal_feedback",
  "interrupt_noop",
  "model_refusal_fallback",
  "output_truncated",
  "replay_batch",
  "replay_complete",
  "replay_relocation",
  "replay_stage",
  "replay_started",
  "resume_failed",
  "run_progress",
  "stop_all_work_done",
  "tool_progress",
  "tug_notice",
  "turn_cancelled",
  "unknown_event",
];

describe("outbound decoders × golden catalog", () => {
  it("walks a non-empty catalog", () => {
    expect(listGoldenVersions().length).toBeGreaterThan(0);
    expect(FRAMES.length).toBeGreaterThan(0);
  });

  it("names the decoders the catalog has no frames for", () => {
    // These answer to their unit tests in tugproto alone. A decoder that
    // joins this list, or a capture that takes one off it, changes it here.
    const seen = new Set(FRAMES.map((f) => f.event.type));
    const uncaptured = Object.keys(OUTBOUND_DECODERS).filter((tag) => !seen.has(tag));
    expect(uncaptured.sort()).toEqual(UNCAPTURED);
  });

  it("decodes every captured frame that has a decoder", () => {
    const failures: string[] = [];
    for (const { where, event } of FRAMES) {
      if (!hasDecoder(event.type)) continue;
      const r = decodeOutbound(event.type, event);
      if (isDecodeError(r)) failures.push(`${where}: ${r.toString()}`);
    }
    expect(failures).toEqual([]);
  });
});

describe("task_* frames map to job events on the catalog", () => {
  const MAPPINGS = {
    task_started: (event: unknown) => {
      const frame = decodeOutbound("task_started", event);
      return isDecodeError(frame) ? undefined : taskStartedEvent(frame);
    },
    task_updated: (event: unknown) => {
      const frame = decodeOutbound("task_updated", event);
      return isDecodeError(frame) ? undefined : taskUpdatedEvent(frame);
    },
    task_progress: (event: unknown) => {
      const frame = decodeOutbound("task_progress", event);
      return isDecodeError(frame) ? undefined : taskProgressEvent(frame);
    },
  } as const;

  for (const [tag, map] of Object.entries(MAPPINGS)) {
    it(tag, () => {
      const frames = FRAMES.filter((f) => f.event.type === tag);
      expect(frames.length).toBeGreaterThan(0);
      const refused = frames.filter(({ event }) => map(event) === undefined).map((f) => f.where);
      expect(refused).toEqual([]);
    });
  }
});
