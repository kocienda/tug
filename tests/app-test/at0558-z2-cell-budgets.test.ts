/**
 * at0558-z2-cell-budgets.test.ts — the Z2 row's five cells share one value-row
 * height, and the budgets leave room for the control that seats beside them.
 *
 * ## What this gates
 *
 * **One value-row height.** The five cells hold their readings in two
 * different constructions: STATE, TIME and CONTEXT put a
 * `.session-telemetry-status-value` span inside the value wrap, while TASKS
 * and JOBS put one `.tug-progress-indicator`, stretched to the cell, carrying
 * its two glyphs and its count inside itself. The row centres its cells
 * vertically, so a value row whose box is a different height from the span's
 * line box moves the label rule above it by half the difference — which is
 * exactly what was visible on the user's screenshot, TASKS and JOBS a smidge
 * high. The fix is a declared height both constructions fill, and this test is
 * what makes it hold: a `translateY` nudge on the two work cells would pass a
 * screenshot and be wrong again at the next face change.
 *
 * **The budgets spend the row, and now leave 32px in it.** The cells are
 * budgeted in `ch` against the row's 10px sans, and the stylesheet's own
 * argument is that the surplus over each cell's content need IS the endcap
 * wings. A control at the row's leading edge needs ~32px it does not have, so
 * the width comes out of the wings rather than out of TIME: CONTEXT gives back
 * two characters, the work pair one each, and the row's own inset halves. What
 * is asserted is the group's FIT rather than the individual numbers, because
 * the fit is the promise — the row holds its five cells at the width Z2 was
 * sized to show everything at, in the plain reading and in the ARC one, and a
 * `ch` sum that balances says nothing about either.
 *
 * **Every budget still clears its own content.** A cell's width is a
 * `min-width` on two stretched rows, so a reading wider than its budget grows
 * the cell — which is the jitter the fixed widths exist to prevent, and the
 * one real risk in taking characters away. So each cell is measured against
 * what it actually renders, in both readings, including JOBS's `None` between
 * two dots in the narrower ARC box.
 *
 * The ARC reading is driven by writing `data-arc` on the row rather than by
 * binding a real arc. This file's subject is the stylesheet: `data-arc` is the
 * CSS input, and the attribute is the whole of what the cascade reads.
 * at0484 owns the other half — that a real arc puts the attribute there and
 * what the cell then says.
 *
 * @covers tugdeck/src/components/tugways/tug-status-cell.css
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.css
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SESSION_ID = "d5e6f7a8-3c4d-4e5f-a071-7c8d9e0f1a24";
const PROJECT_DIR = "/Users/tester/src/tugtool";

const CARD = '[data-card-id="A"]';
const ROW = `${CARD} [data-slot="session-telemetry-status-row"]`;
const PRIORITIES = ["state", "time", "context", "tasks", "jobs"] as const;

/**
 * The slim preset. Load-bearing: it is the width the budgets are sized to
 * spend, and the width the first `@container` rung sits just under.
 */
const SLIM_PX = 675;

/** The row's whole width in `ch`, the same number in every reading. */
const ROW_WIDTH_CH = 76;
/**
 * What the control takes at the row's leading edge: a 28px `sm` icon button
 * and the strip's own 4px gap beside it. The budgets were cut to clear this
 * and the control now sits in what they cleared, so the number is checked
 * against the seat's measured box rather than against a slack the control has
 * already spent.
 */
const CONTROL_PX = 32;

/**
 * The three `@container` rungs, and the set each leaves standing. Read from
 * `tug-status-cell.css`; asserted by driving the card's width across each one,
 * which is the only way to know the numbers are the row's own rather than a
 * comment's.
 */
const RUNGS = [
  { at: 653, hides: "time", standing: ["state", "context", "tasks", "jobs"] },
  { at: 527, hides: "tasks", standing: ["state", "context", "jobs"] },
  { at: 411, hides: "jobs", standing: ["state", "context"] },
] as const;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 20, y: 20 },
        size: { width: SLIM_PX, height: 680 },
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

interface CellRead {
  priority: string;
  /** The authored budget, e.g. `"18ch"`. */
  budget: string;
  display: string;
  /** The cell's rendered box. */
  width: number;
  /** The value row's box — the [B10] subject. */
  valueHeight: number;
  /** The value row's top, relative to the row. Equal tops mean one baseline. */
  valueTop: number;
  /** The endcap rule's top — the label rule the offset was visible on. */
  ruleTop: number;
  /** What the value row actually renders, at its intrinsic width. */
  contentWidth: number;
  text: string;
}

interface RowRead {
  arc: string | null;
  /** The strip's content box — what the `@container` rungs are asked against. */
  container: number;
  /** The row's own content box, inside its inline padding. */
  rowContent: number;
  /**
   * What the minimize control takes out of the strip at the row's leading
   * edge — its own box plus the strip's column gap ([B03]).
   */
  controlSeat: number;
  padInline: number;
  gap: number;
  cells: CellRead[];
}

const readRow = (app: App): Promise<RowRead> =>
  app.evalJS<RowRead>(
    `(function () {
      var row = document.querySelector(${JSON.stringify(ROW)});
      var rowRect = row.getBoundingClientRect();
      var rowStyle = getComputedStyle(row);
      var strip = row.closest(".session-card-status-bar");
      var stripStyle = getComputedStyle(strip);
      var control = strip.querySelector('[data-slot="session-minimize-control"]');
      var cells = ${JSON.stringify(PRIORITIES)}.map(function (p) {
        var el = row.querySelector('[data-slot="tug-status-cell"][data-priority="' + p + '"]');
        if (el === null) {
          return { priority: p, budget: "", display: "none", width: -1,
                   valueHeight: -1, valueTop: -1, ruleTop: -1, contentWidth: -1, text: "" };
        }
        var cs = getComputedStyle(el);
        var wrap = el.querySelector(".session-telemetry-status-value-wrap");
        var rule = el.querySelector(".session-telemetry-endcap-rule");
        // The value row's INTRINSIC width: the budget is a min-width, so the
        // rendered box is the max of the two and says nothing on its own. A
        // clone measured out of flow with the floor lifted is what the cell
        // would be if the budget were not holding it open.
        var probe = wrap === null ? null : wrap.cloneNode(true);
        var intrinsic = -1;
        if (probe !== null) {
          probe.style.position = "absolute";
          probe.style.visibility = "hidden";
          probe.style.minWidth = "0";
          probe.style.width = "auto";
          probe.style.left = "-10000px";
          el.appendChild(probe);
          intrinsic = probe.getBoundingClientRect().width;
          el.removeChild(probe);
        }
        return {
          priority: p,
          budget: cs.getPropertyValue("--tugx-session-status-cell-width").trim(),
          display: cs.display,
          width: el.getBoundingClientRect().width,
          valueHeight: wrap === null ? -1 : wrap.getBoundingClientRect().height,
          valueTop: wrap === null ? -1 : wrap.getBoundingClientRect().top - rowRect.top,
          ruleTop: rule === null ? -1 : rule.getBoundingClientRect().top - rowRect.top,
          contentWidth: intrinsic,
          text: (wrap === null ? "" : wrap.textContent || "").trim(),
        };
      });
      return {
        arc: row.getAttribute("data-arc"),
        container: strip.clientWidth -
          parseFloat(stripStyle.paddingLeft) - parseFloat(stripStyle.paddingRight),
        rowContent: rowRect.width -
          parseFloat(rowStyle.paddingLeft) - parseFloat(rowStyle.paddingRight),
        controlSeat: control === null
          ? -1
          : control.getBoundingClientRect().width + parseFloat(stripStyle.columnGap || "0"),
        padInline: parseFloat(rowStyle.paddingLeft),
        gap: parseFloat(rowStyle.gap),
        cells: cells,
      };
    })()`,
  );

/** The `session_updated` frame the supervisor pushes after a ledger write. */
function publishSession(): string {
  return `window.__tug.publishSessionUpdated(${JSON.stringify(
    JSON.stringify({
      session_id: SESSION_ID,
      fields: {
        session_id: SESSION_ID,
        project_dir: PROJECT_DIR,
        tag: "z2-budgets",
        name: null,
        name_user_set: false,
        turn_count: 9,
        file_size: 20_480,
        last_user_prompt: "Give the Z2 row back the width the control needs",
        last_used_at: 1_754_600_000_000,
      },
    }),
  )})`;
}

const setArc = (app: App, on: boolean): Promise<null> =>
  app.evalJS<null>(
    `(function () {
      var row = document.querySelector(${JSON.stringify(ROW)});
      if (${on}) row.setAttribute("data-arc", "true");
      else row.removeAttribute("data-arc");
      return null;
    })()`,
  );

/**
 * Drive the container the rungs are asked against to an exact content width.
 *
 * The strip is the `container-type: inline-size` element, so an inline width
 * on it IS the query width once its own 8px-a-side padding is added back. That
 * is a truer probe than resizing the card: the card's width reaches the query
 * through the strip's padding, and a test that drove the card would be
 * asserting the rungs and that arithmetic at once, then reporting a failure in
 * either as a failure of the rungs.
 */
const setContainerWidth = async (app: App, contentPx: number): Promise<void> => {
  await app.evalJS<null>(
    `(function () {
      var row = document.querySelector(${JSON.stringify(ROW)});
      var strip = row.closest(".session-card-status-bar");
      var cs = getComputedStyle(strip);
      var pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      // Both, because the strip is a stretched flex item: a width alone is
      // overridden by the cross-axis stretch, and max-width is what actually
      // narrows the box the container query is asked against.
      //
      // The value is the CONTENT width under content-box and the border box
      // under border-box, which is the same content width either way — the
      // query is asked against the content box, and a probe that guessed the
      // sizing would be off by the strip's 16px of padding.
      var target =
        cs.boxSizing === "border-box" ? ${contentPx} + pad : ${contentPx};
      strip.style.width = target + "px";
      strip.style.maxWidth = target + "px";
      return null;
    })()`,
  );
  await wait(120);
};

/** The sum of the five authored budgets, in `ch`. */
function sumCh(read: RowRead): number {
  return read.cells.reduce(
    (total, c) => total + (parseFloat(c.budget.replace("ch", "")) || 0),
    0,
  );
}

/**
 * What a cell's value row would need if the budget were not holding it open,
 * with `word` swapped into its text. STATE's construction is the one the ARC
 * reading borrows — two 12px dots pinned to the wrap's edges with a minimum
 * channel and the word centred between them — so STATE is where the ARC face's
 * need is measured, at the same type and against the same apparatus.
 */
const needFor = (app: App, priority: string, word: string): Promise<number> =>
  app.evalJS<number>(
    `(function () {
      var cell = document.querySelector(
        ${JSON.stringify(CARD)} +
          ' [data-slot="tug-status-cell"][data-priority="' +
          ${JSON.stringify(priority)} +
          '"]',
      );
      var wrap = cell.querySelector(".session-telemetry-status-value-wrap");
      var probe = wrap.cloneNode(true);
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      probe.style.minWidth = "0";
      probe.style.width = "auto";
      probe.style.left = "-10000px";
      var target = probe.querySelector(".session-telemetry-status-value");
      if (target !== null) target.textContent = ${JSON.stringify(word)};
      cell.appendChild(probe);
      var w = probe.getBoundingClientRect().width;
      cell.removeChild(probe);
      return w;
    })()`,
  );

function report(label: string, read: RowRead): void {
  note(
    `${label} budgets`,
    read.cells.map((c) => `${c.priority}=${c.budget}`).join(" ") +
      ` sum=${sumCh(read)}ch`,
  );
  note(
    `${label} geometry`,
    `container=${Math.round(read.container)} rowContent=${Math.round(read.rowContent)} pad=${read.padInline} gap=${read.gap} cells=${read.cells.map((c) => Math.round(c.width)).join("+")}`,
  );
  note(
    `${label} value rows`,
    read.cells
      .map(
        (c) =>
          `${c.priority}: h=${c.valueHeight.toFixed(2)} top=${c.valueTop.toFixed(2)} rule=${c.ruleTop.toFixed(2)} content=${Math.round(c.contentWidth)} "${c.text}"`,
      )
      .join(" | "),
  );
}

describe.skipIf(!SHOULD_RUN)("AT0558: the Z2 row's budgets", () => {
  test(
    "one value-row height across the five cells, and a sum that leaves the control its width",
    async () => {
      const app = await launchTugApp({ testName: "at0558-z2-cell-budgets" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.bindSession("A", {
          tugSessionId: SESSION_ID,
          projectDir: PROJECT_DIR,
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null`,
          { timeoutMs: 15_000 },
        );
        await app.evalJS<boolean>(publishSession());
        await wait(600);

        const plain = await readRow(app);
        report("plain", plain);

        // ── [B10] One value-row height, so the label rules line up ──
        //
        // Both halves, because either alone can be satisfied the wrong way: a
        // shared height with the rules still offset would mean something else
        // moved them, and aligned rules over unequal value rows would mean the
        // alignment is a coincidence of this pair of faces.
        const heights = plain.cells.map((c) => c.valueHeight);
        const rules = plain.cells.map((c) => c.ruleTop);
        expect(
          Math.max(...heights) - Math.min(...heights),
          "the five value rows are one height",
        ).toBeLessThan(0.5);
        expect(
          Math.max(...rules) - Math.min(...rules),
          "the five label rules sit on one line",
        ).toBeLessThan(0.5);

        // ── [B09] The budgets spend the row and leave the control its seat ──
        expect(sumCh(plain), "the five budgets sum to the row's width").toBe(
          ROW_WIDTH_CH,
        );
        // Every cell still on screen at slim: a budget that had quietly tripped
        // a rung would sum correctly over a row that had plainly moved.
        for (const c of plain.cells) {
          expect(c.display, `${c.priority} is on screen at slim`).not.toBe("none");
        }
        // The seat, measured rather than computed — on both sides. What the
        // control takes out of the strip is its own box plus the strip's gap;
        // what the row has left after the five cells and their four gaps is
        // what that cut bought. The row must still hold its group at slim, and
        // the seat must still be the 32px the budgets were cut for.
        const group =
          plain.cells.reduce((t, c) => t + c.width, 0) + 4 * plain.gap;
        const slack = plain.rowContent - group;
        note(
          "the control's seat",
          `seat=${Math.round(plain.controlSeat)} rowContent=${Math.round(plain.rowContent)} group=${Math.round(group)} slack=${Math.round(slack)} budgeted=${CONTROL_PX}`,
        );
        expect(
          plain.controlSeat,
          "the control's seat is the width the budgets were cut for",
        ).toBeLessThanOrEqual(CONTROL_PX);
        expect(
          slack,
          "and the five cells still fit the row the seat left them",
        ).toBeGreaterThanOrEqual(0);

        // ── Every budget still clears its own content ──
        //
        // The budget is a `min-width` on two stretched rows, so a reading wider
        // than its budget grows the cell — the jitter the fixed widths exist to
        // prevent, and the one real risk in taking characters away.
        for (const c of plain.cells) {
          expect(
            c.width,
            `${c.priority} holds its reading "${c.text}" without growing`,
          ).toBeGreaterThanOrEqual(c.contentWidth);
        }

        await setArc(app, true);
        await wait(300);
        const arc = await readRow(app);
        report("arc", arc);
        // The ARC reading spends the same ROW: picking an arc up moves
        // boundaries inside it and neither of its outer edges.
        // Measured in PIXELS, which the `ch` sum cannot stand in for: JOBS's
        // declared box is below what `None` between two dots needs, so the
        // cell sizes to its reading and spends more than it declares. That is
        // why the give-back comes from CONTEXT as well — the fourth cell takes
        // its four characters in full and JOBS can only give as far as its own
        // floor, so a `ch`-balanced exchange put the row 16px over the box
        // holding it. The row has to hold its group at slim, which is the
        // promise the slim preset carries ([B05]): the budgets were cut so
        // nothing collapses at the width Z2 was sized to show everything at,
        // and a row that overflows there has broken it whether or not a rung
        // fired.
        const arcGroup =
          arc.cells.reduce((t, c) => t + c.width, 0) + 4 * arc.gap;
        note(
          "the ARC reading's group",
          `group=${Math.round(arcGroup)} rowContent=${Math.round(arc.rowContent)} slack=${Math.round(arc.rowContent - arcGroup)}`,
        );
        expect(
          arcGroup,
          "the ARC reading still fits the row the seat left it",
        ).toBeLessThanOrEqual(arc.rowContent);
        // What the ARC face would need, measured on STATE's own apparatus —
        // the construction the ARC reading borrows.
        for (const word of ["Implement", "Disconnected", "Awaiting review"]) {
          note(
            `need "${word}"`,
            `${Math.round(await needFor(app, "state", word))}px on STATE's apparatus`,
          );
        }
        await setArc(app, false);
        await wait(300);

        // ── The three rungs, re-measured against the new total ──
        //
        // Driven by resizing the card rather than read off the stylesheet: a
        // rung is only correct if it fires where the set it leaves standing
        // stops fitting, and that is a fact about the built row.
        for (const rung of RUNGS) {
          await setContainerWidth(app, rung.at + 4);
          const above = await readRow(app);
          await setContainerWidth(app, rung.at - 4);
          const below = await readRow(app);
          note(
            `rung ${rung.at}`,
            `above: container=${Math.round(above.container)} ${above.cells.map((c) => `${c.priority}=${c.display}`).join(" ")} | below: container=${Math.round(below.container)} ${below.cells.map((c) => `${c.priority}=${c.display}`).join(" ")}`,
          );
          const shown = (r: RowRead, p: string): string =>
            r.cells.find((c) => c.priority === p)?.display ?? "missing";
          // Above the rung the standing set must also FIT. A rung that sits
          // even a few pixels late leaves a band where every cell is on
          // screen and the row is wider than the box holding it — which is
          // what the first rung did before it was re-placed here.
          const standingGroup =
            above.cells
              .filter((c) => c.display !== "none")
              .reduce((t, c) => t + c.width, 0) +
            (above.cells.filter((c) => c.display !== "none").length - 1) *
              above.gap;
          expect(
            standingGroup,
            `above the ${rung.at}px rung, the standing set fits the row`,
          ).toBeLessThanOrEqual(above.rowContent);
          for (const p of rung.standing) {
            expect(
              shown(above, p),
              `above the ${rung.at}px rung, ${p} stands`,
            ).not.toBe("none");
          }
          expect(
            shown(above, rung.hides),
            `above the ${rung.at}px rung, ${rung.hides} still stands`,
          ).not.toBe("none");
          expect(
            shown(below, rung.hides),
            `below the ${rung.at}px rung, ${rung.hides} is gone`,
          ).toBe("none");
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
