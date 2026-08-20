/**
 * at0423-session-atom-dash-mark.test.ts — the session ATOM marks a dash-bound
 * session, and marks it in the citation register.
 *
 * at0406 pins the same grammar on the line tier. The atom wears it IDENTICALLY,
 * and that identity is what this file exists to hold: a session that spelled
 * itself one way in a masthead and another way in a citation would be two
 * sessions to a reader who met it in both places.
 *
 * The surface is the masthead's telemetry panel, and it is the right one for
 * exactly one reason: the chip-tier ATOM and the flat CITATION string sit two
 * rows apart in it, for the same real session, so both halves of the claim can
 * be read off one open panel — and the two halves pull in opposite directions,
 * which is why they are pinned together:
 *
 *   A. **The citation does not move.** The CITATION row is byte-identical
 *      bound and unbound. That string is the durable form a reader pastes
 *      elsewhere, and one carrying a dash would rot the moment the dash landed.
 *   B. **The displayed atom does.** Binding appends exactly `#<dash-name>` to
 *      the atom's own text and changes nothing else in it — the same run, the
 *      same sigil, the same ink as the line tier.
 *
 * The loop is real throughout: `tugutil dash bind` through the card's own `$`
 * shell route, which is what stamps `TUG_SESSION_ID` on the child, against a
 * real session resumed on a scratch repository this file owns. The mark appears
 * because the dash's `bound_sessions` moved in the account-global changeset
 * aggregate and the atom reads it session-first — no card, no reload, no prop.
 *
 * @covers tugdeck/src/components/tugways/tug-session-identity.tsx
 * @covers tugdeck/src/lib/dash-session-index.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  createDash,
  makeDashScratchRepo,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  shellAndSettle,
  tugutilPath,
  type DashScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000423";
const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;
/** The telemetry widget lives in the pane's control cluster, not in the card. */
const WIDGET = '[data-slot="session-masthead-widget"]';
const PANEL = '[data-slot="session-masthead-telemetry"]';
/** The panel's chip-tier atom, and the flat citation two rows below it. */
const ATOM = `${PANEL} .session-masthead-telemetry-atom`;
const ATOM_DASH = `${ATOM} [data-slot="session-identity-dash"]`;

/** This checkout — the build under test, and never the tree a dash is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: DashScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";
const DASH_NAME = "at0423-atom";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({ prefix: "at0423", checkout: CHECKOUT });
  createDash(projectDir(), DASH_NAME, "at0423 fixture", scratch.cli);
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmDashScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 680 },
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

/** Open the telemetry panel and read the atom's text and the citation row's. */
async function readPanel(
  app: App,
): Promise<{ atom: string; citation: string; marks: number }> {
  await app.nativeClickAtElement(WIDGET);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PANEL)}) !== null`,
    { timeoutMs: 10_000 },
  );
  const read = await app.evalJS<{
    atom: string;
    citation: string;
    marks: number;
  }>(
    `(() => {
       const rows = Array.from(document.querySelectorAll(
         ${JSON.stringify(PANEL)} + " .session-masthead-telemetry-row"));
       const row = rows.find((r) => (r.querySelector(
         ".session-masthead-telemetry-label")?.textContent ?? "").trim() === "CITATION");
       if (row === undefined) throw new Error("no CITATION row in the panel");
       return {
         atom: (document.querySelector(${JSON.stringify(ATOM)})?.textContent ?? "").trim(),
         citation: (row.querySelector(
           ".session-masthead-telemetry-value")?.textContent ?? "").trim(),
         marks: document.querySelectorAll(${JSON.stringify(ATOM_DASH)}).length,
       };
     })()`,
  );
  await app.nativeKey("Escape");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(PANEL)}) === null`,
    { timeoutMs: 10_000 },
  );
  return read;
}

describe.skipIf(!SHOULD_RUN)("AT0423: the atom's dash mark", () => {
  test(
    "a bound session's atom wears the line tier's grammar, and the citation never moves",
    async () => {
      const app = await launchTugApp({
        testName: "at0423-session-atom-dash-mark",
        env: { TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // A *spawned* session, not a bound one: spawning is what registers the
        // scratch repo as a workspace, and its live ledger row is what the
        // bind verb resolves the owning instance through.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(WIDGET)}) !== null`,
          { timeoutMs: 15_000 },
        );

        const bare = await readPanel(app);
        note("at0423 unbound panel", JSON.stringify(bare));
        expect(bare.marks).toBe(0);
        expect(bare.citation.length).toBeGreaterThan(0);

        // ── Bind, for real ────────────────────────────────────────────────
        await shellAndSettle(app, `${tugutilPath(CHECKOUT)} dash bind ${DASH_NAME}`, 0);
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-slot="session-masthead"] [data-slot="session-identity-dash"]') !== null`,
          { timeoutMs: 15000 },
        );

        await app.nativeClickAtElement(WIDGET);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ATOM_DASH)}) !== null`,
          { timeoutMs: 10_000 },
        );
        const mark = await app.evalJS<{
          hasGlyph: boolean;
          hasName: boolean;
          title: string | null;
          label: string | null;
          text: string;
        }>(
          `(() => {
             const m = document.querySelector(${JSON.stringify(ATOM_DASH)});
             return {
               hasGlyph: m.querySelector("svg") !== null,
               hasName:
                 m.querySelector(".tug-session-identity-dash-name") !== null,
               title: m.getAttribute("title"),
               label: m.getAttribute("aria-label"),
               text: (m.textContent ?? "").trim(),
             };
           })()`,
        );
        note("at0423 atom mark", JSON.stringify(mark));
        note("at0423 bound panel", (await app.screenshot()).path);
        await app.nativeKey("Escape");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PANEL)}) === null`,
          { timeoutMs: 10_000 },
        );

        // B. The atom names the dash in its own ink, in the line tier's
        // spelling — the glyph left the grammar when the sigil replaced it.
        expect(mark.hasGlyph).toBe(false);
        expect(mark.hasName).toBe(true);
        expect(mark.text).toBe(`^${DASH_NAME}`);
        expect(mark.title).toBe(`Working on dash ${DASH_NAME}`);
        expect(mark.label).toBe(`On dash ${DASH_NAME}`);

        // The atom grew by the run and by nothing else: same name, same
        // callsign, same punctuation, with `#<dash>` appended. Asserting the
        // concatenation rather than a substring is what makes this a pin on
        // the FORMAT — a treatment that respelled the atom would fail here
        // even if the dash name were somewhere in the string.
        const bound = await readPanel(app);
        expect(bound.marks).toBe(1);
        expect(bound.atom).toBe(`${bare.atom}^${DASH_NAME}`);
        // A. And the citation did not move.
        expect(bound.citation).toBe(bare.citation);
        expect(bound.citation).not.toContain(DASH_NAME);

        // ── Unbind, for real ──────────────────────────────────────────────
        await shellAndSettle(app, `${tugutilPath(CHECKOUT)} dash unbind`, 1);
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-slot="session-masthead"] [data-slot="session-identity-dash"]') === null`,
          { timeoutMs: 15000 },
        );
        const after = await readPanel(app);
        expect(after.marks).toBe(0);
        expect(after.atom).toBe(bare.atom);
        expect(after.citation).toBe(bare.citation);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
