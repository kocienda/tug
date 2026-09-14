/**
 * picker-sessions-fixture.ts — a project with real sessions in it, for tests
 * that need the Choose Session sheet to list something.
 *
 * ## Why a test cannot leave the picker's list to chance
 *
 * Every app-test launches on a fresh per-instance `sessions.db`, so the picker
 * a fixture opens lists exactly one row — "New session" — unless the test
 * puts sessions somewhere the picker looks. Two kinds of test need it to:
 *
 *   - A test about the LIST — filtering, cursoring, trashing — needs rows
 *     whose text it chose, so its assertions do not depend on whatever the
 *     host happens to hold.
 *   - A test about the picker's GEOMETRY needs the list at the height a real
 *     project gives it. The Sessions list is capped at 14.5rem (232px at the
 *     16px root) and every row has a 3.5rem floor, so on a project with more
 *     than three sessions the list stands at its cap and the panel is some
 *     180px taller than the one-row picker. A height constant measured
 *     against the empty picker is wrong on every real project, and a test
 *     that measures the empty picker cannot say so.
 *
 * ## How the rows get there
 *
 * The picker's rows come from tugcast's ledger plus a JSONL scan of the real
 * claude project directory (`~/.claude/projects/<encoded cwd>/`), so the
 * fixture writes real transcript files there for a fresh scratch project and
 * lets the real scan find them. No mocks, nothing injected into the app.
 *
 * Which LINE of a row carries the seeded title is the callsign's doing: the
 * callsign leads every session row, so the title line is the minted callsign
 * — a different string every run — and the seeded `ai-title` lands on the
 * row's description line. Every seeded row is therefore the two-line kind,
 * which is what makes {@link FULL_LIST} fill the cap.
 *
 * The scratch project and its transcripts are the fixture's own and go away
 * with {@link removePickerSessions}; a test killed mid-file leaves a
 * `~/.claude/projects/-…-<prefix>-…` directory behind, which the next run's
 * fresh scratch path never collides with.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** One seeded session: its transcript id and the text its row carries. */
export interface SeededSession {
  id: string;
  prompt: string;
  title: string;
}

/**
 * Enough sessions to stand the Sessions list at its 14.5rem cap with margin:
 * five two-line rows at the 3.5rem floor are 280px against a 232px cap. Each
 * title's leading word appears in exactly one row, so a list test can filter
 * on it.
 */
export const FULL_LIST: readonly SeededSession[] = [
  {
    id: "a7c02650-0000-4000-8000-0000000000c1",
    prompt: "heron manifest audit",
    title: "heron manifest audit",
  },
  {
    id: "a7c02650-0000-4000-8000-0000000000c2",
    prompt: "ibex cache warming",
    title: "ibex cache warming",
  },
  {
    id: "a7c02650-0000-4000-8000-0000000000c3",
    prompt: "jackal retry budget",
    title: "jackal retry budget",
  },
  {
    id: "a7c02650-0000-4000-8000-0000000000c4",
    prompt: "kestrel socket teardown",
    title: "kestrel socket teardown",
  },
  {
    id: "a7c02650-0000-4000-8000-0000000000c5",
    prompt: "lemur palette contrast",
    title: "lemur palette contrast",
  },
];

/**
 * Encode an absolute project dir the way claude names its per-project subdir
 * under `~/.claude/projects/` (every character outside `[A-Za-z0-9-]` → `-`).
 * Kept inline so the app-test graph does not import tugcode.
 */
export const encodeProjectDir = (absDir: string): string =>
  absDir.replace(/[^A-Za-z0-9-]/g, "-");

/** A minimal one-turn session JSONL in claude's own shape. */
export function buildFixtureJsonl(
  cwd: string,
  sessionId: string,
  prompt: string,
  title: string,
): string {
  const base = {
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId,
    version: "2.1.105",
    gitBranch: "main",
  };
  const suffix = sessionId.slice(-2);
  const lines = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: `00000000-0000-4000-8000-0000000${suffix}d01`,
      timestamp: "2026-07-20T10:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    },
    {
      ...base,
      parentUuid: `00000000-0000-4000-8000-0000000${suffix}d01`,
      type: "assistant",
      uuid: `00000000-0000-4000-8000-0000000${suffix}d02`,
      timestamp: "2026-07-20T10:00:01.000Z",
      message: {
        id: `msg-fixture-${suffix}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
    { type: "ai-title", aiTitle: title, sessionId },
  ];
  return lines.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/** A scratch project with seeded sessions, and where they were written. */
export interface PickerSessionsFixture {
  /** The scratch project's absolute, realpath'd directory. */
  projectDir: string;
  /** The claude project directory the transcripts were written to. */
  fixtureDir: string;
  /** The sessions written, in the order they were written. */
  sessions: readonly SeededSession[];
}

/**
 * Make a scratch project and write one transcript per session into the
 * claude project directory the picker's scan reads for it.
 *
 * `prefix` names the scratch path after the test (`at0569`), so a leftover
 * from a killed run says whose it was.
 */
export function seedPickerSessions(
  prefix: string,
  sessions: readonly SeededSession[] = FULL_LIST,
): PickerSessionsFixture {
  // realpath: macOS `mkdtemp` returns `/var/folders/…` but the scan resolves
  // `/var` → `/private/var` before encoding — encode the SAME resolved string.
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-proj-`)));
  const fixtureDir = join(
    homedir(),
    ".claude",
    "projects",
    encodeProjectDir(projectDir),
  );
  mkdirSync(fixtureDir, { recursive: true });
  for (const session of sessions) {
    writeFileSync(
      join(fixtureDir, `${session.id}.jsonl`),
      buildFixtureJsonl(projectDir, session.id, session.prompt, session.title),
    );
  }
  return { projectDir, fixtureDir, sessions };
}

/** Remove the scratch project and its transcripts. Safe on a partial fixture. */
export function removePickerSessions(
  fixture: PickerSessionsFixture | null | undefined,
): void {
  if (!fixture) return;
  if (fixture.projectDir !== "" && existsSync(fixture.projectDir)) {
    rmSync(fixture.projectDir, { recursive: true, force: true });
  }
  if (fixture.fixtureDir !== "" && existsSync(fixture.fixtureDir)) {
    rmSync(fixture.fixtureDir, { recursive: true, force: true });
  }
}

/** The picker's path field — stop 0 of the picker's keyboard cycle. */
export const PICKER_PATH_FIELD = '[data-tug-focus-key="session-picker-cycle:0"]';
/** One `session-resume` row in the Sessions list. */
export const PICKER_RESUME_ROW =
  '[data-testid="session-card-picker-session-resume"]';
/** How many `session-resume` rows the list is showing. */
export const PICKER_RESUME_COUNT = `document.querySelectorAll(${JSON.stringify(PICKER_RESUME_ROW)}).length`;

/** The slice of the harness `App` this module drives. */
export interface PickerDriver {
  evalJS<T>(script: string): Promise<T>;
  waitForCondition<T>(
    script: string,
    opts?: { timeoutMs?: number },
  ): Promise<T>;
}

/**
 * Point an OPEN picker at the fixture's project and wait until every seeded
 * session is a row in its list.
 *
 * The picker seeds its own path on open — from recents, then the default
 * project, then the host's hint — so the fixture types over it, through the
 * prototype value setter so React's input tracker sees the change the way a
 * keystroke lands it. The path drives the ledger fetch; the JSONL scan is its
 * second phase, so the wait is on the rows rather than on the field.
 */
export async function pointPickerAt(
  app: PickerDriver,
  fixture: PickerSessionsFixture,
): Promise<void> {
  await app.evalJS<null>(`(function(){
    var el = document.querySelector(${JSON.stringify(PICKER_PATH_FIELD)});
    if (!el) throw new Error("picker path field not found");
    el.focus();
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(fixture.projectDir)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return null;
  })()`);
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(PICKER_PATH_FIELD)});
      return el !== null && el.value === ${JSON.stringify(fixture.projectDir)};
    })()`,
    { timeoutMs: 10_000 },
  );
  await app.waitForCondition<boolean>(
    `${PICKER_RESUME_COUNT} >= ${fixture.sessions.length}`,
    { timeoutMs: 20_000 },
  );
}

/**
 * The picker panel's natural height as the sheet computes it — `scrollHeight`
 * plus borders and margins — or `null` when no panel is up. This is the number
 * `SESSION_UNBOUND_HEIGHT_PX` is resolved from, so a geometry test prints it.
 */
export async function pickerPanelNaturalHeight(
  app: PickerDriver,
): Promise<number | null> {
  return app.evalJS<number | null>(
    `(function () {
      var el = document.querySelector('[data-slot="tug-sheet"].tug-sheet-content');
      if (el === null) return null;
      var cs = getComputedStyle(el);
      var px = function (v) { return parseFloat(v) || 0; };
      return (
        el.scrollHeight +
        px(cs.borderTopWidth) +
        px(cs.borderBottomWidth) +
        px(cs.marginTop) +
        px(cs.marginBottom)
      );
    })()`,
  );
}
