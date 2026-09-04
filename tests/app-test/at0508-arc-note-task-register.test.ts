/**
 * at0508-arc-note-task-register.test.ts — an arc gesture's quiet line wears
 * the Task step's register, and wears it identically in both seats.
 *
 * The rows this exercises used to be one `ShipWheel` over one flat grey
 * sentence, packed with no air between them: nine different gestures told
 * apart only by a run of muted words in the middle of each line. They now
 * read as the Task marker beside them does — the arc's name as a quiet run,
 * the gesture as a bold verb, the detail muted after it, the gesture's own
 * shape in the icon slot, and room around the row.
 *
 * Where at0507 pins which *container* a note lands in, this file pins what
 * the row *is*. That split matters because the row has five moving parts and
 * two seats: the between-turns `$`-route row and the mid-turn system note.
 * Both mount one `ArcNoteLine`, and the assertions below are written so that
 * a second spelling reappearing in either seat fails here rather than drifting
 * unseen — the seats are compared to each other, not each to a constant.
 *
 * Assertions:
 *
 *  1. **The register, in the between-turns seat.** A `step … start` row
 *     carries the arc's name in its own quiet span, the bold verb `Step 1/3`
 *     in the label slot, the step's title as the muted subject, and the
 *     Task step's own *Started* glyph (`lucide-wrench`) — not the wheel.
 *  2. **The register, in the mid-turn seat.** A `commit` row seated inside a
 *     streaming turn carries the same three weights and its own shape
 *     (`lucide-git-commit-horizontal`), so the gestures are told apart by
 *     something readable from across the room. It also carries the hover
 *     title the seat lacked entirely before.
 *  3. **The two seats are one column.** The rows' icons land at the same x —
 *     the between-turns row stands at the transcript's edge and reaches the
 *     body column by arithmetic, the mid-turn row is already inside it — and
 *     both take the same non-zero vertical rhythm, so a run of gestures reads
 *     as discrete events rather than one welded block.
 *
 * (3) is the assertion that earned its keep. The two seats came out a pixel
 * apart, because the session card narrows the transcript's gutter on the
 * ENTRY while `--tugx-transcript-body-inset` — the arithmetic an edge surface
 * reads to reach the body column — was declared on `body`, where a custom
 * property's `var()`s resolve and the narrowing is not in scope. The override
 * now sits on the transcript root with the inset re-derived beside it
 * (`session-card.css`), so every edge surface tracks the real column.
 *
 * `session-card-transcript.tsx` is deliberately not among the `@covers`
 * lines below. This file's subject is the row itself, which lives entirely in
 * `ArcNoteLine` and the mapping behind it; the transcript only mounts that
 * component in the mid-turn branch, and at0507 already covers that mount. A
 * `@covers` line there would widen an already-wide fan-out for a claim this
 * file does not really make.
 *
 * @covers tugdeck/src/components/tugways/cards/session-arc-note-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-arc-note-block.css
 * @covers tugdeck/src/lib/arc-note-command.ts
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "test-session-A";
const CARD = `[data-card-id="A"]`;

/** A `step-start` line, exactly as `note_for_line` composes it. */
const START_SENTENCE = "demo: step 1/3 started — carve the first slice";
/** A round's line — a different gesture, so a different shape and verb. */
const ROUND_SENTENCE = "demo: round 0ae618a02 — remove the wiring";

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0508-arc-register-"));
});
afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 640 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/**
 * One row's parts, read from the DOM the way a reader reads them. Returns the
 * same shape for either seat, so the two can be compared to each other.
 */
const READ_ROW = `function(root){
  if (root === null) return null;
  var name = root.querySelector('.session-arc-note-name');
  var label = root.querySelector('.tug-quiet-line-label');
  var subject = root.querySelector('.tug-quiet-line-subject');
  var icon = root.querySelector('.tug-quiet-line-icon');
  var svg = icon === null ? null : icon.querySelector('svg');
  var glyph = svg === null ? null : (svg.getAttribute('class') || '')
    .split(/\\s+/)
    .filter(function(c){ return c.indexOf('lucide-') === 0; })[0] || null;
  var style = window.getComputedStyle(root);
  return {
    name: name === null ? null : (name.textContent || '').trim(),
    label: label === null ? null : (label.textContent || '').trim(),
    subject: subject === null ? null : (subject.textContent || '').trim(),
    glyph: glyph,
    title: root.getAttribute('title'),
    iconLeft: icon === null ? null : Math.round(icon.getBoundingClientRect().left),
    marginTop: style.marginBlockStart,
    marginBottom: style.marginBlockEnd,
    // The name must be its own element rather than a run of the label's
    // text, or it cannot be quieter than the verb beside it.
    nameInsideLabel: name !== null && label !== null && label.contains(name),
  };
}`;

describe.skipIf(!SHOULD_RUN)("AT0508: an arc quiet line reads as a Task step", () => {
  test(
    "both seats carry name + verb + subject over the gesture's own shape",
    async () => {
      const app = await launchTugApp({ testName: "at0508-arc-note-task-register" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", {
          tugSessionId: SID,
          sessionMode: "resume",
          projectDir,
          workspaceKey: projectDir,
        });

        // ---- the between-turns seat: a step start, arriving with no turn ----
        await app.driveSession("A", {
          op: "shellExchange",
          exchangeId: "note-1",
          command: "arc step demo start",
          output: START_SENTENCE,
          cwd: projectDir,
          exitCode: 0,
          startedAtMs: 1_700_000_001_000,
        });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('${CARD} [data-slot="session-arc-note-line"]').length === 1`,
          { timeoutMs: 20_000 },
        );

        // ---- the mid-turn seat: a round, arriving while a turn streams ----
        await app.driveSession("A", { op: "send", text: "work the step" });
        await app.driveSession("A", {
          op: "arcNote",
          exchangeId: "live-note-1",
          command: "arc commit demo",
          text: ROUND_SENTENCE,
          cwd: projectDir,
        });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('${CARD} [data-slot="arc-note"]').length === 1`,
          { timeoutMs: 20_000 },
        );

        const rows = await app.evalJS<{
          between: Record<string, unknown> | null;
          mid: Record<string, unknown> | null;
        }>(`(function(){
          var read = ${READ_ROW};
          return {
            between: read(document.querySelector('${CARD} [data-slot="session-arc-note-line"]')),
            mid: read(document.querySelector('${CARD} [data-slot="arc-note"]')),
          };
        })()`);

        note(`at0508 between-turns row: ${JSON.stringify(rows.between)}`);
        note(`at0508 mid-turn row: ${JSON.stringify(rows.mid)}`);

        const between = rows.between as Record<string, unknown>;
        const mid = rows.mid as Record<string, unknown>;
        expect(between).not.toBeNull();
        expect(mid).not.toBeNull();

        // 1. The register, between turns. The name is its own quiet run at the
        //    head of the label, the verb is bold, the title is the subject,
        //    and the shape is the Task step's own *Started* glyph.
        expect(between.name).toBe("demo");
        expect(between.nameInsideLabel).toBe(true);
        expect(between.label).toBe("demo Step 1/3");
        expect(between.subject).toBe("carve the first slice");
        expect(between.glyph).toBe("lucide-wrench");

        // 2. The register, mid-turn — the same three weights, a different
        //    shape, and the hover title this seat had none of before.
        expect(mid.name).toBe("demo");
        expect(mid.nameInsideLabel).toBe(true);
        expect(mid.label).toBe("demo Round 0ae618a02");
        expect(mid.subject).toBe("remove the wiring");
        expect(mid.glyph).toBe("lucide-git-commit-horizontal");
        expect(typeof mid.title).toBe("string");
        expect(String(mid.title)).toContain("arc commit demo");

        // The whole point of the shapes: two gestures, two glyphs. One wheel
        // for all nine is the wall this arc was opened to take down.
        expect(between.glyph).not.toBe(mid.glyph);

        // 3. One column, one rhythm. The seats are compared to each other
        //    rather than to a constant — the failure worth catching is drift
        //    between them, not a change to the shared inset's value.
        expect(between.iconLeft).toBe(mid.iconLeft);
        expect(between.marginTop).toBe(mid.marginTop);
        expect(between.marginBottom).toBe(mid.marginBottom);
        expect(String(between.marginTop)).not.toBe("0px");

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0508] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
