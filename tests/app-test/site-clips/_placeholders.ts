/**
 * _placeholders.ts — the cards a site clip stands on its deck when the clip
 * is about the deck rather than about any one card: a few short files of a
 * small project, and Session cards carrying a real conversation.
 *
 * A clip about stacks, splits, moves or workspaces needs cards that read as
 * work and that the eye can tell apart, so each placeholder has its own
 * title. The files are `files/`, a tide-table service called Harbor, copied
 * to `~/harbor` per run — so a Text card's masthead reads `~/harbor/tides.ts`
 * — and opened in `text` cards; each is
 * short enough to stand in the smallest card a clip stages. A Session card
 * resumes a committed transcript (`fixtures/sessions/`) through the
 * production resume, settles, and is given a name and synopsis on its
 * masthead, so it rests the way a session a user has worked in rests.
 *
 * A driver builds its deck from `fileCard` and `sessionCard`, launches with
 * `placeholderStates(...)` as its `cardStates`, and calls
 * `standUpPlaceholders` before it records.
 */

import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { App } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { standUpKind } from "../body-grounding/_kind-bodies";
import { cardKind } from "../body-grounding/_kinds";
import { settleFor } from "../body-grounding/_bodies";
import { seedFixtureSession } from "../fixtures/resolve";

/** The project's files, by name. */
export type PlaceholderFile = "README.md" | "notes.md" | "tides.ts" | "fetch_tides.py";

/**
 * A Session placeholder: the committed transcript it resumes, the identity
 * its masthead shows, and the ledger facts its rest line reads — the turns
 * and size of the transcript, and a fixed last use so both modes match.
 */
interface SessionPlaceholder {
  readonly fixture: string;
  readonly identity: { name: string; name_user_set: boolean; tag: string; synopsis: string };
  readonly facts: { turn_count: number; file_size: number; last_used_at: number };
}

/** The Session placeholders, by the name a driver asks for. */
export const SESSIONS = {
  pickerKeys: {
    fixture: "session-transcript-basic",
    identity: {
      name: "picker-keys",
      name_user_set: true,
      tag: "amber-heron",
      synopsis: "Make the session picker's arrow keys walk the tree",
    },
    facts: { turn_count: 4, file_size: 149_606, last_used_at: Date.UTC(2026, 9, 24, 23, 12) },
  },
} as const satisfies Record<string, SessionPlaceholder>;

export type PlaceholderSession = keyof typeof SESSIONS;

/** One placeholder on a deck: a file in a `text` card, or a Session card. */
export type Placeholder =
  | { readonly id: string; readonly file: PlaceholderFile }
  | { readonly id: string; readonly session: PlaceholderSession };

/** How long a resumed transcript may take to bind, and then to hold still. */
const BOUND_MS = 60_000;
const SETTLED_MS = 60_000;
const SETTLED_HOLD_MS = 500;

let project: string | null = null;

/** Marks a `~/harbor` as the clips' own, so a run never writes over or removes one that is not. */
const MARKER = ".tug-site-clips";

/** The run's copy of the project at `~/harbor`, made on first use and removed when the run ends. */
function projectDir(): string {
  if (project !== null) return project;
  const dir = join(homedir(), "harbor");
  if (existsSync(dir) && !existsSync(join(dir, MARKER))) {
    throw new Error(`site clips: ${dir} exists and is not the clips' own; move it aside to record`);
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  writeFileSync(join(dir, MARKER), "");
  const source = join(import.meta.dir, "files");
  for (const name of readdirSync(source)) copyFileSync(join(source, name), join(dir, name));
  onTestRunEnd(() => rmSync(dir, { recursive: true, force: true }));
  project = dir;
  return dir;
}

/** A placeholder's card record, for a deck's `cards`. */
export function placeholderCard(p: Placeholder): Record<string, unknown> {
  return "file" in p
    ? { id: p.id, componentId: "text", title: p.file, closable: true }
    : { id: p.id, componentId: "session", title: SESSIONS[p.session].identity.name, closable: true };
}

/**
 * The settings a deck of placeholders launches with: mastheads write a
 * file's path relative to its project, and Harbor is the default project,
 * so a Text card's masthead reads `harbor/tides.ts`.
 */
export function placeholderSettings(): readonly (readonly [string, string, string])[] {
  return [
    ["dev.tugapp.app", "masthead-paths", "project"],
    ["dev.tugapp.app", "default-project-path", projectDir()],
  ];
}

/** The saved state each file placeholder restores with: the file it opens, at its top. */
export function placeholderStates(placeholders: readonly Placeholder[]): Record<string, unknown> {
  const states: Record<string, unknown> = {};
  for (const p of placeholders) {
    if ("file" in p) states[p.id] = { content: { path: join(projectDir(), p.file), anchor: { line: 1, ch: 0 }, scrollTop: 0 } };
  }
  return states;
}

/**
 * Stand every placeholder up: each file card's body ready with its editor
 * mounted, each Session card bound to its transcript, settled, and named.
 * Only cards the deck shows can stand up, so a driver passes the ones in view.
 */
export async function standUpPlaceholders(app: App, placeholders: readonly Placeholder[]): Promise<void> {
  for (const p of placeholders) {
    if ("file" in p) {
      await standUpKind(app, cardKind("text"), p.id);
    } else {
      await bindSession(app, p.id, SESSIONS[p.session]);
    }
  }
}

/** Resume `session`'s transcript into `cardId`, wait for it to settle, and publish its identity. */
async function bindSession(app: App, cardId: string, session: SessionPlaceholder): Promise<void> {
  const tugSessionId = randomUUID();
  const seeded = await seedFixtureSession(session.fixture, `site-${cardId}`, { sessionId: tugSessionId });
  const body = await readyBody(app, cardId);
  await app.spawnSessionResume(cardId, { tugSessionId, projectDir: seeded.projectDir });
  const host = `[data-card-id="${cardId}"] [data-testid="session-card-transcript"]`;
  const scroller = `[data-card-id="${cardId}"] [data-tug-scroll-key="session-card-transcript"]`;
  await body.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(host)}) !== null && ` +
      `document.querySelector('[data-card-id="${cardId}"] .session-card-picker-form') === null`,
    { timeoutMs: BOUND_MS },
  );
  // Settled: the replay done and the transcript's height holding still.
  await body.waitForCondition<boolean>(
    `(function(){
      var host = document.querySelector(${JSON.stringify(host)});
      var el = document.querySelector(${JSON.stringify(scroller)});
      if (host === null || el === null || host.hasAttribute("data-replaying")) return false;
      var seen = window.__tugSiteSettle || (window.__tugSiteSettle = {});
      var now = performance.now(), last = seen[${JSON.stringify(cardId)}];
      if (last === undefined || last.height !== el.scrollHeight) {
        seen[${JSON.stringify(cardId)}] = { height: el.scrollHeight, at: now };
        return false;
      }
      return now - last.at >= ${SETTLED_HOLD_MS};
    })()`,
    { timeoutMs: SETTLED_MS },
  );
  // The identity and the rest line's facts, delivered the way the wire does
  // (at0570): in every page that keeps a ledger — the card's own, for its
  // masthead, the shell's, and each rail card's, the Workspaces card among
  // them. A push stands for the session's whole row, so
  // it carries the row's id and project with the facts: a push of the
  // identity alone would replace the listed row and leave it at no turns.
  const row = { session_id: tugSessionId, project_dir: seeded.projectDir, ...session.identity, ...session.facts };
  const push = `window.__tug.publishSessionUpdated(${JSON.stringify(JSON.stringify({ session_id: tugSessionId, fields: row }))})`;
  await app.evalJS<boolean>(push);
  for (const b of await app.bodies()) {
    if (b.state === "ready" && b.cardId !== null) await app.body(b.cardId).evalJS<boolean>(push);
  }
  const masthead = `(document.querySelector('[data-slot="session-masthead"]') || { textContent: "" }).textContent || ""`;
  const turns = `${session.facts.turn_count} turns`;
  const read = await settleFor(() => body.evalJS<string>(masthead), (t) => t.includes(turns), 5_000);
  expect(read, `${cardId}: the masthead's rest line reads ${turns}`).toContain(turns);
}

/** A card's body page, once it stands ready. */
async function readyBody(app: App, cardId: string) {
  const deadline = Date.now() + BOUND_MS;
  while (Date.now() < deadline) {
    const body = (await app.bodies()).find((b) => b.cardId === cardId);
    if (body !== undefined && body.state === "ready") return app.body(cardId);
    await Bun.sleep(100);
  }
  throw new Error(`${cardId}: no ready body within ${BOUND_MS} ms`);
}
