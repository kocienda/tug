/**
 * landing-draft-fixture.ts — shared set-up for the landing pieces of the
 * `at0024-prompt-state-roundtrip` family: a Session card on a real scratch repository, a prompt typed, the
 * Changes tab opened over it, and a commit message typed there.
 *
 * The Prompt tab and the Changes tab share one editor and one document, and
 * the composer stashes the prompt while the commit message is on screen. The
 * family pins that the prompt draft has one owner: whatever save, restore or
 * relaunch happens while Changes is up, the card's saved prompt is the prompt
 * the user typed, never the commit message on screen, and the message itself
 * is kept where commit mode keeps it.
 *
 * The session is a real resume on a real git repository, so the commit
 * message is persisted through the changeset draft engine exactly as a user's
 * is — a fake binding has no workspace to persist it into.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import type { App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import { restoreSettled } from "./overlay-fixture";
import {
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type ArcScratchRepo,
} from "./arc-fixture";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 180_000;

export const PROMPT = "the prompt I was writing before Changes";
export const MESSAGE = "Land the message that belongs to Changes";

const CARD = '[data-card-id="A"]';
export const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
export const COMMIT_BUTTON = `${CARD} [data-testid="tug-prompt-entry-commit-button"]`;
export const CHANGES_SEGMENT = `${CARD} .tug-prompt-entry-route-group [data-choice-value="changes"]`;

/** This checkout — the build under test, never the tree the fixture dirties. */
export const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

export const settle = (ms = 400): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A scratch repository and a resumable session in it. */
export interface LandingDraftScratch {
  scratch: ArcScratchRepo;
  fixtureDir: string;
  sid: string;
}

export function makeLandingDraftScratch(prefix: string, sid: string): LandingDraftScratch {
  const scratch = makeArcScratchRepo({ prefix, checkout: CHECKOUT });
  const fixtureDir = seedScratchSession(scratch.repo, sid);
  return { scratch, fixtureDir, sid };
}

export function rmLandingDraftScratch(s: LandingDraftScratch | null): void {
  if (s === null) return;
  rmArcScratchRepo(s.scratch);
  rmScratchSession(s.fixtureDir);
}

/**
 * Stand the Session card up on the scratch session. `cardStates` re-injects a
 * bag read off disk, which is how a relaunch hands the card its saved state.
 */
export async function standUpCard(
  app: App,
  s: LandingDraftScratch,
  cardStates?: Record<string, unknown>,
): Promise<void> {
  await app.seedDeckState({
    state: sessionCardShape({ width: 980, height: 720 }),
    ...(cardStates !== undefined ? { cardStates } : {}),
    focusCardId: "A",
  });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
  await app.spawnSessionResume("A", { tugSessionId: s.sid, projectDir: s.scratch.repo });
  await app.awaitEngineReady("A", { timeoutMs: 30_000 });
  await restoreSettled(app, "A");
}

/**
 * The composer's document as text, or null when no composer is mounted. Read
 * line by line with the placeholder removed, so an empty document reads as ""
 * rather than as its placeholder's words.
 */
const READ_DOC = `function(cm){
  if (cm === null) return null;
  var clone = cm.cloneNode(true);
  clone.querySelectorAll(".cm-placeholder").forEach(function(p){ p.remove(); });
  return Array.from(clone.querySelectorAll(".cm-line")).map(function(l){ return l.textContent || ""; }).join("\\n");
}`;

export function composerText(app: App): Promise<string | null> {
  return app.body("A").evalJS<string | null>(
    `(${READ_DOC})(document.querySelector(${JSON.stringify(PROMPT_INPUT)}))`,
  );
}

/** Wait until the composer shows exactly `text`. */
export async function waitForComposer(app: App, text: string, timeoutMs = 15_000): Promise<void> {
  await app.body("A").waitForCondition<boolean>(
    `(${READ_DOC})(document.querySelector(${JSON.stringify(PROMPT_INPUT)})) === ${JSON.stringify(text)}`,
    { timeoutMs },
  );
}

/** Whether a commit landing is up — Z5 wears the commit button only then. */
export function landingUp(app: App): Promise<boolean> {
  return app.body("A").evalJS<boolean>(
    `document.querySelector(${JSON.stringify(COMMIT_BUTTON)}) !== null`,
  );
}

/** Press the composer's Changes tab and wait for the commit landing. */
export async function openChanges(app: App): Promise<void> {
  await app.body("A").nativeClickAtElement(CHANGES_SEGMENT);
  await app.body("A").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(COMMIT_BUTTON)}) !== null`,
    { timeoutMs: 20_000 },
  );
}

/**
 * Type the prompt, open Changes over it, and type the commit message there —
 * then wait out the message's debounced save so it reaches the draft engine.
 */
export async function typePromptThenMessage(app: App): Promise<void> {
  await app.body("A").nativeClickAtElement(PROMPT_INPUT);
  await app.nativeType(PROMPT);
  await waitForComposer(app, PROMPT);
  await openChanges(app);
  // Entering the mode swaps the document to the message and focuses it. Select
  // whatever it was seeded with, so the typed message is the whole message.
  await app.body("A").waitForCondition<boolean>(
    `(${READ_DOC})(document.querySelector(${JSON.stringify(PROMPT_INPUT)})) !== ${JSON.stringify(PROMPT)}`,
    { timeoutMs: 10_000 },
  );
  await app.nativeKey("a", ["cmd"]);
  await app.nativeType(MESSAGE);
  await waitForComposer(app, MESSAGE);
  await settle(1_500);
}

/** What the card's save would file as the prompt draft, read live. */
export async function savedPromptText(app: App): Promise<string | null> {
  const state = await app.getEmCardState("A");
  return state === null ? null : state.text;
}
