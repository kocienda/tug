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
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeProjectDir } from "./_harness/claude-home";

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
  const fixtureDir = claudeProjectDir(projectDir);
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

/**
 * The picker's other-folder row — the last row of its list, and the door to the
 * path field.
 */
export const PICKER_OTHER_ROW = '[data-testid="session-card-picker-other"]';
/**
 * The picker's path field, shown while the other-folder row is chosen — the
 * stop between the Sessions list and Move-all-to-Trash in its keyboard cycle.
 */
export const PICKER_PATH_FIELD = '[data-tug-focus-key="session-picker-cycle:2.5"]';

/**
 * In-page script: choose the other-folder row, so the path field mounts. A
 * click on the row is the pick, as a reader's would be. `true` once the field
 * stands.
 */
export const CHOOSE_OTHER_FOLDER = `(function(){
  var row = document.querySelector(${JSON.stringify(PICKER_OTHER_ROW)});
  if (row === null) return false;
  row.scrollIntoView({ block: "nearest" });
  row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return true;
})()`;
/** One `session-resume` row in the Sessions list. */
export const PICKER_RESUME_ROW =
  '[data-testid="session-card-picker-session-resume"]';
/** How many `session-resume` rows the list is showing. */
export const PICKER_RESUME_COUNT = `document.querySelectorAll(${JSON.stringify(PICKER_RESUME_ROW)}).length`;

/**
 * The slice of the harness `App` / `BodyApp` this module drives: the page
 * holding the picker, which is the Session card's own sheet — pass its body
 * (`app.body(id)`, or `kindBody(app, "session")` for a card opened rather
 * than seeded), not the shell.
 */
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
 * The fixture's project is none of the picker's groups, so the helper takes
 * the door a reader would: it chooses the other-folder row, and types the path
 * into the field that row shows, through the prototype value setter so
 * React's input tracker sees the change the way a keystroke lands it. The
 * typed folder becomes a group of its own, unfolded, and its listing is what
 * the path drives; the JSONL scan is that listing's second phase, so the wait
 * is on the rows rather than on the field.
 */
export async function pointPickerAt(
  app: PickerDriver,
  fixture: PickerSessionsFixture,
): Promise<void> {
  if (!(await app.evalJS<boolean>(CHOOSE_OTHER_FOLDER))) {
    throw new Error("picker other-folder row not found");
  }
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PICKER_PATH_FIELD)}) !== null`,
    { timeoutMs: 5_000 },
  );
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
 * the deck itself measures and bids before it commits a Session card's pane, by
 * the identical formula, so a geometry test prints it and compares against it.
 * There is no declared constant it resolves to any more, and that is the point.
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
      var scrollHeight;
      if (el.dataset.bodyScroll === "true") {
        var cap = el.style.maxHeight;
        el.style.maxHeight = "none";
        scrollHeight = el.scrollHeight;
        el.style.maxHeight = cap;
      } else {
        scrollHeight = el.scrollHeight;
      }
      return (
        scrollHeight +
        px(cs.borderTopWidth) +
        px(cs.borderBottomWidth) +
        px(cs.marginTop) +
        px(cs.marginBottom)
      );
    })()`,
  );
}

/** A box's vertical extent, in the picker's own page. */
export interface PickerSpan {
  top: number;
  bottom: number;
}

/**
 * Where every part of an open picker stands against the card frame around it,
 * read in the card's OWN page — the frame, its title bar and the sheet are all
 * in that page, so no screen mapping stands between them and a part hanging
 * past the frame is a reading rather than a coordinate error.
 *
 * `list` and `body` carry scroll extents: on a card too short for the picker
 * the Sessions list is the part that gives way, so it is the one whose content
 * outruns its box, and the sheet's body is not. `panelMaxHeight` is the cap the
 * sheet wrote on the panel (`""` when it wrote none), carried for the note.
 */
export interface PickerFit {
  viewportHeight: number;
  frame: PickerSpan;
  titleBarBottom: number;
  header: PickerSpan;
  filter: PickerSpan;
  trash: PickerSpan;
  actions: PickerSpan;
  panel: PickerSpan;
  panelMaxHeight: string;
  /** The panel's content height with its cap lifted, and the height it has. */
  panelWants: number;
  panelHas: number;
  list: { clientHeight: number; scrollHeight: number };
  body: { clientHeight: number; scrollHeight: number };
  /**
   * Open's ring — its border box grown by the outline's reach (width plus
   * offset, `0` when it draws no outline) — and the sheet body's clip box,
   * which is its padding box: a body that scrolls clips everything inside it
   * there, the action row included.
   */
  openRing: PickerBox;
  ringReach: number;
  bodyClip: PickerBox;
}

/** A box on all four sides, in the picker's own page. */
export interface PickerBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Read {@link PickerFit} off the picker's page, or `null` when a part is missing. */
export async function pickerFit(app: PickerDriver): Promise<PickerFit | null> {
  return app.evalJS<PickerFit | null>(
    `(function () {
      var panel = document.querySelector('[data-slot="tug-sheet"].tug-sheet-content');
      if (panel === null) return null;
      var frame = panel.closest(".tug-pane");
      var bar = document.querySelector('[data-testid="tug-pane-title-bar"]');
      var parts = {
        header: panel.querySelector(".tug-sheet-header"),
        filter: panel.querySelector('[data-testid="session-card-picker-filter"]'),
        trash: panel.querySelector(".session-card-picker-trash-all"),
        actions: panel.querySelector(".tug-sheet-actions"),
      };
      var list = panel.querySelector(".session-card-picker-list-view");
      var body = panel.querySelector(".tug-sheet-body");
      var open = panel.querySelector('[data-testid="session-card-picker-open"]');
      if (open === null) return null;
      if (frame === null || bar === null || list === null || body === null) return null;
      var span = function (el) {
        var r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      };
      var cap = panel.style.maxHeight;
      panel.style.maxHeight = "none";
      var wants = panel.scrollHeight;
      panel.style.maxHeight = cap;
      var out = {
        viewportHeight: window.innerHeight,
        frame: span(frame),
        titleBarBottom: bar.getBoundingClientRect().bottom,
        panel: span(panel),
        panelMaxHeight: panel.style.maxHeight,
        panelWants: wants,
        panelHas: panel.clientHeight,
        list: { clientHeight: list.clientHeight, scrollHeight: list.scrollHeight },
        body: { clientHeight: body.clientHeight, scrollHeight: body.scrollHeight },
        ringReach: 0,
        openRing: null,
        bodyClip: null,
      };
      for (var k in parts) {
        if (parts[k] === null) return null;
        out[k] = span(parts[k]);
      }
      var ocs = getComputedStyle(open);
      var reach =
        ocs.outlineStyle === "none"
          ? 0
          : (parseFloat(ocs.outlineWidth) || 0) + (parseFloat(ocs.outlineOffset) || 0);
      var o = open.getBoundingClientRect();
      out.ringReach = reach;
      out.openRing = { top: o.top - reach, bottom: o.bottom + reach, left: o.left - reach, right: o.right + reach };
      var b = body.getBoundingClientRect();
      out.bodyClip = { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
      return out;
    })()`,
  );
}

/**
 * Every way `fit` breaks the picker's short-card contract, as sentences; empty
 * when it holds. The header, the filter, the trash row and the actions each
 * stand wholly inside the frame, below its title bar; and when the panel is
 * shorter than it wants to be, the Sessions list is the element that scrolled
 * — its content outruns its box — while the sheet's body holds still.
 *
 * `tol` absorbs sub-pixel layout rounding.
 */
export function pickerFitProblems(fit: PickerFit, tol: number): string[] {
  const problems: string[] = [];
  const inside = (name: string, s: PickerSpan): void => {
    if (s.top < fit.titleBarBottom - tol) {
      problems.push(`${name} top ${s.top.toFixed(1)} is above the title bar's bottom ${fit.titleBarBottom.toFixed(1)}`);
    }
    if (s.bottom > fit.frame.bottom + tol) {
      problems.push(`${name} bottom ${s.bottom.toFixed(1)} is below the frame's bottom ${fit.frame.bottom.toFixed(1)}`);
    }
  };
  inside("the header", fit.header);
  inside("the filter", fit.filter);
  inside("the trash row", fit.trash);
  inside("the actions", fit.actions);
  // Open's ring is drawn outside its border, and the body that holds it is a
  // scroll box: a ring past the body's padding edge is cut there.
  const ring = fit.openRing;
  const clip = fit.bodyClip;
  if (
    ring.top < clip.top - tol ||
    ring.bottom > clip.bottom + tol ||
    ring.left < clip.left - tol ||
    ring.right > clip.right + tol
  ) {
    problems.push(
      `Open's ring (${ring.left.toFixed(1)},${ring.top.toFixed(1)})–(${ring.right.toFixed(1)},${ring.bottom.toFixed(1)}) crosses the sheet body's clip (${clip.left.toFixed(1)},${clip.top.toFixed(1)})–(${clip.right.toFixed(1)},${clip.bottom.toFixed(1)})`,
    );
  }
  if (fit.body.scrollHeight - fit.body.clientHeight > tol) {
    problems.push(`the sheet's body scrolls (${fit.body.scrollHeight} over ${fit.body.clientHeight}) — the list should give way instead`);
  }
  return problems;
}

/** Whether the Sessions list is holding more than it shows — the list scrolled. */
export function pickerListScrolls(fit: PickerFit, tol: number): boolean {
  return fit.list.scrollHeight - fit.list.clientHeight > tol;
}

/** `fit` as one line for a note. */
export function describePickerFit(fit: PickerFit | null): string {
  if (fit === null) return "picker not on screen";
  const s = (p: PickerSpan) => `${p.top.toFixed(0)}–${p.bottom.toFixed(0)}`;
  return `frame ${s(fit.frame)} (viewport ${fit.viewportHeight}), title bar to ${fit.titleBarBottom.toFixed(0)}, panel ${s(fit.panel)} max-height "${fit.panelMaxHeight}" (wants ${fit.panelWants}, has ${fit.panelHas}), header ${s(fit.header)}, filter ${s(fit.filter)}, trash ${s(fit.trash)}, actions ${s(fit.actions)}, list ${fit.list.clientHeight}/${fit.list.scrollHeight}, body ${fit.body.clientHeight}/${fit.body.scrollHeight}, Open ring reach ${fit.ringReach}px, right ${fit.openRing.right.toFixed(1)} of clip ${fit.bodyClip.right.toFixed(1)}`;
}
