/**
 * Every tugcode outbound tag has a written-down place in the deck.
 *
 * `OUTBOUND_TAGS` (`@tugproto/outbound`) is the whole set of frames tugcode
 * emits. Each one is either admitted by the Session card's store
 * (`KNOWN_CODE_OUTPUT_TYPES`), taken apart by the store before admission,
 * handled by another store that subscribes to CODE_OUTPUT, or dropped on
 * purpose, with the reason beside it. A new tugcode tag fails here until it is
 * placed, so a frame the deck silently ignores is a decision somebody wrote
 * down rather than one nobody noticed.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OUTBOUND_TAGS } from "@tugproto/outbound";
import { KNOWN_CODE_OUTPUT_TYPES } from "../../code-session-store";

/** Taken apart in `CodeSessionStore.routeFrame` before the admission check. */
const UNWRAPPED_BEFORE_ADMISSION: Record<string, string> = {
  replay_batch: "unwrapped; each inner frame is routed on its own",
  tool_progress: "diverted to RunProgressStore as a heartbeat",
};

/** Handled by a store other than the Session card's, named by its file under `src/lib/`. */
const HANDLED_ELSEWHERE: Record<string, string> = {
  hooks_inventory: "hooks-inventory-store.ts",
  skills_inventory: "skills-inventory-store.ts",
  side_question_answer: "side-question-store.ts",
  rate_limit_event: "rate-limit-store.ts",
  session_capabilities: "session-metadata-store.ts",
};

/** Never read by the deck, and why. */
const DROPPED_ON_PURPOSE: Record<string, string> = {
  protocol_ack: "the handshake's reply to protocol_init, which tugcast sends and the deck never does",
  activity_delta: "consumed by tugcast's session-metadata feed and supervisor",
  background_tasks_changed: "consumed by tugcast's supervisor",
  control_request_cancel: "consumed by tugcast's session digest",
  session_rewound: "consumed by tugcast's supervisor",
  session_title: "consumed by tugcast's agent bridge, which carries titles on its own feeds",
  tool_input_progress: "consumed by tugcast's digest and observer feeds",
  tool_approval_request: "declared but emitted nowhere; approvals travel as control_request_forward",
  question: "declared but emitted nowhere; AskUserQuestion travels as control_request_forward",
};

const LIB_DIR = join(import.meta.dir, "..", "..");
const SRC_DIR = join(LIB_DIR, "..");

/** The deck's non-test source files, as text. */
function deckSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(readFileSync(path, "utf8"));
      }
    }
  };
  walk(SRC_DIR);
  return out;
}

function placesOf(tag: string): string[] {
  const places: string[] = [];
  if (KNOWN_CODE_OUTPUT_TYPES.has(tag)) places.push("KNOWN_CODE_OUTPUT_TYPES");
  if (tag in UNWRAPPED_BEFORE_ADMISSION) places.push("UNWRAPPED_BEFORE_ADMISSION");
  if (tag in HANDLED_ELSEWHERE) places.push("HANDLED_ELSEWHERE");
  if (tag in DROPPED_ON_PURPOSE) places.push("DROPPED_ON_PURPOSE");
  return places;
}

describe("outbound tag placement", () => {
  test("every outbound tag has exactly one place in the deck", () => {
    const misplaced = OUTBOUND_TAGS.map((tag) => ({ tag, places: placesOf(tag) })).filter(
      ({ places }) => places.length !== 1,
    );
    expect(misplaced).toEqual([]);
  });

  test("the lists name only real outbound tags", () => {
    const outbound = new Set<string>(OUTBOUND_TAGS);
    const stale = [
      ...Object.keys(UNWRAPPED_BEFORE_ADMISSION),
      ...Object.keys(HANDLED_ELSEWHERE),
      ...Object.keys(DROPPED_ON_PURPOSE),
    ].filter((tag) => !outbound.has(tag));
    expect(stale).toEqual([]);
  });

  test("each handled-elsewhere store names its tag", () => {
    const missing = Object.entries(HANDLED_ELSEWHERE)
      .filter(([tag, file]) => !readFileSync(join(LIB_DIR, file), "utf8").includes(`"${tag}"`))
      .map(([tag, file]) => `${tag} in ${file}`);
    expect(missing).toEqual([]);
  });

  test("each dropped tag is named nowhere in the deck's source", () => {
    // A dropped tag that a store starts reading belongs in another list.
    // `question` is skipped: the bare word is a literal for unrelated things
    // (block kinds, join-board rows), so its absence cannot be asserted.
    const sources = deckSources();
    const named = Object.keys(DROPPED_ON_PURPOSE).filter(
      (tag) => tag !== "question" && sources.some((text) => text.includes(`"${tag}"`)),
    );
    expect(named).toEqual([]);
  });
});
