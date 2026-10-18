/**
 * arc-run-transcript-fixture.ts — the constants and the project directory the
 * at0474-arc-run-transcript-* files share.
 *
 * Split from `at0474-arc-run-transcript` to fit the 20 s file budget ([B07]
 * of the bodies migration brief). Each file launches its own app and drives
 * its own frames; what they share is the rows they read and the prompts the
 * arc sends.
 *
 * @module tests/app-test/arc-run-transcript-fixture
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

export const DIVIDER = '[data-boundary="stage"]';
export const USER_ROW = '[data-testid="session-card-transcript-user-body"]';
export const WHEEL_ROW = '.tug-transcript-entry[data-participant="wheel"]';
export const STAGE_PROMPT =
  "/tugplug:arc-devise a plan for .tug/arcs/foo/brief.md";
/** What the transcript paints as prose once the command becomes a chip. */
export const STAGE_PROMPT_ARGS = "a plan for .tug/arcs/foo/brief.md";
// Every stage after devise names the arc, never a path.
export const REVIEW_PROMPT = "/tugplug:arc-review foo";
/**
 * A prompt the arc sends MID-session — a continued implement range. It does
 * not rotate anything, so it arrives as a bare `tug_notice` rather than
 * behind a `session_segment`.
 */
export const CONTINUE_PROMPT =
  "/tugplug:arc-implement foo implement Step 4 and end your turn; Steps 4-13 remain on this run";
export const CONTINUE_PROMPT_ARGS = "implement Step 4 and end your turn; Steps 4-13 remain on this run";
/** The quiet-line row a nameless subsystem's notice gets. The wheel has a name. */
export const NOTICE_ROW = '[data-slot="tug-notice"]';
/** An arc gesture's quiet line, absorbed into the turn it narrated ([P12]). */
export const ARC_NOTE_IN_TURN = '[data-slot="arc-note"]';
/** The same line stranded between turns — the seat a row with no turn takes. */
export const ARC_NOTE_BETWEEN_TURNS = '[data-slot="session-arc-note-line"]';
export const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
export const TUG_SESSION_ID = "test-session-A"; // bindSession default
export const PROMPT = "write the brief";
export const INTERJECTION = "keep the spike. skip step 7 when you get to it.";
/** Every attributed transcript row, whoever spoke it. */
export const ENTRY = ".tug-transcript-entry[data-participant]";

/** A fresh project directory for a file's cards to bind into. */
export function mkProjectDir(): string {
  return mkdtempSync(join(tmpdir(), "at0474-arc-"));
}

/** Remove what {@link mkProjectDir} made, if anything. */
export function rmProjectDir(dir: string): void {
  if (dir !== "" && existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
