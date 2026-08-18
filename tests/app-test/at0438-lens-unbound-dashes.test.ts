/**
 * at0438-lens-unbound-dashes.test.ts — a dash is in the Lens exactly once.
 *
 * The Lens has two surfaces that can talk about a dash, and the rule between
 * them is a partition rather than a preference: worked ⇒ the session's row in
 * the **Cards** section, which carries `#<dash>` in its identity run and the
 * stage line beneath it; unworked ⇒ the **Unbound Dashes** section. Membership
 * is exactly `bound_sessions.length === 0`, so the two are complements and no
 * dash can be in both or in neither.
 *
 * That is what this drives, as one round trip against the real app: bind, and
 * the Unbound section is *gone* — the band, not merely an empty body — while the
 * session's row grows its dash line; unbind, and the section is back with the
 * dash's row while the line goes away. Asserting the band's absence is the
 * point of [P03]: an inbox at zero costs zero rail height, and a body that
 * renders nothing inside a permanent band would pass a weaker assertion while
 * looking exactly like the thing this replaced.
 *
 * Then Bind is pressed for real. It sends the same `bind_dash` frame the
 * Changes shade sends, so the row leaves, the section unmounts, and the dash
 * line returns — the partition asserted a third time, from the other direction
 * and through the new control.
 *
 * Everything is real. `tugutil dash bind` / `unbind` run through the card's own
 * `$` shell route — the route that stamps `TUG_SESSION_ID` — and the surfaces
 * move because `bound_sessions` moved in the account-global aggregate, not
 * because a test poked a store.
 *
 * **Run this from the main checkout, not a dash worktree.** The harness refuses
 * there for a real reason: `tugutil`'s dash verbs resolve the main repo root,
 * so `createDash` below would cut its fixture against the base checkout while
 * the app under test has the worktree open — the dash could never appear, and
 * the run would dirty the base.
 *
 * @covers tugdeck/src/components/lens/sections/dashes-section.tsx
 * @covers tugdeck/src/components/lens/lens-content.tsx
 * @covers tugdeck/src/components/lens/lens-section-presence.ts
 * @covers tugdeck/src/components/lens/lens-section-presence-probe.tsx
 * @covers tugdeck/src/components/lens/lens-section-registry.ts
 * @covers tugdeck/src/components/tugways/dash-sigil.tsx
 * @covers tugdeck/src/components/lens/sections/dash-age.ts
 * @covers tugdeck/src/components/tugways/tug-meta-run.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import { createDash, discardDash, tugutilPath } from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "at0438-session";
const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;

const DASH_NAME = "at0438-unbound";

/** The band, not the body: [P03] says an empty section renders no DOM at all. */
const UNBOUND = '.lens-section[data-lens-section="dashes"]';
const UNBOUND_ROW = `${UNBOUND} [data-slot="lens-dashes-row"]`;
const UNBOUND_NAME = `${UNBOUND} [data-slot="lens-unbound-name"]`;
const BIND = `${UNBOUND} [data-slot="lens-bind"]`;

const CARDS = '.lens-section[data-lens-section="cards"]';
const SESSION_ROW = `${CARDS} [data-session-id="${SID}"]`;
const DASH_LINE = `${SESSION_ROW} [data-slot="tug-session-row-dashline"]`;

const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));

beforeAll(() => {
  if (!SHOULD_RUN) return;
  createDash(PROJECT_DIR, DASH_NAME, "at0438 fixture");
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  discardDash(PROJECT_DIR, DASH_NAME);
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

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

const count = (app: App, selector: string): Promise<number> =>
  app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  );

/** Run `command` through the card's `$` shell route and wait for its exit. */
async function shellAndSettle(
  app: App,
  command: string,
  expectedIndex = 0,
): Promise<void> {
  await app.nativeClickAtElement(PROMPT);
  await app.nativeType(`/shell ${command}`);
  await settle(150);
  await app.nativeKey("Enter", ["cmd"]);
  await app.waitForCondition<boolean>(
    `(function(){
       var rows = document.querySelectorAll(${JSON.stringify(SHELL_ROWS)});
       if (rows.length !== ${expectedIndex + 1}) return false;
       var foot = rows[${expectedIndex}].querySelector('[data-slot="session-z1b-end-state"]');
       return foot !== null && foot.textContent.indexOf("exit") !== -1;
     })()`,
    { timeoutMs: 30_000 },
  );
}

/**
 * Click `target` until `expected` reaches `want`, scrolling it into view each
 * time — the shape at0405 uses, for the same reason. The Lens list recomposes
 * on the aggregate's own schedule, so a click's coordinates can go stale
 * between the aim and the press. A missed click changes nothing, so re-aiming
 * is safe.
 */
async function clickUntil(
  app: App,
  target: string,
  expected: string,
  want: "present" | "absent" = "present",
  attempts = 4,
): Promise<void> {
  const predicate =
    want === "present"
      ? `document.querySelector(${JSON.stringify(expected)}) !== null`
      : `document.querySelector(${JSON.stringify(expected)}) === null`;
  for (let i = 0; i < attempts; i += 1) {
    await app.evalJS<null>(
      `(() => {
         const el = document.querySelector(${JSON.stringify(target)});
         if (el !== null) el.scrollIntoView({ block: "center" });
         return null;
       })()`,
    );
    await settle();
    await app.nativeClickAtElement(target);
    try {
      await app.waitForCondition<boolean>(predicate, { timeoutMs: 3000 });
      return;
    } catch {
      note(`at0438 click on ${target} did not land (attempt ${i + 1})`);
    }
  }
  throw new Error(
    `at0438: ${expected} never went ${want} after clicking ${target}`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0438: the partition law", () => {
  test(
    "a dash is in the Cards section or the Unbound section, never both",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0438-lens-unbound-dashes",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", {
          tugSessionId: SID,
          projectDir: PROJECT_DIR,
          workspaceKey: PROJECT_DIR,
        });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        app.seedLedger({
          sessions: [
            {
              session_id: SID,
              workspace_key: PROJECT_DIR,
              project_dir: PROJECT_DIR,
              card_id: "A",
              name: "at0438 work",
            },
          ],
        });

        await app.dispatchControlAction("toggle-lens");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SESSION_ROW)}) !== null`,
          { timeoutMs: 20000 },
        );

        // ── Unbound: the fixture dash has no session, so it is here ──────
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(UNBOUND_ROW)}) !== null`,
          { timeoutMs: 30000 },
        );
        const unbound = await app.evalJS<{
          name: string;
          rowText: string;
          rows: number;
          binds: number;
        }>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(UNBOUND_ROW)});
             const name = document.querySelector(${JSON.stringify(UNBOUND_NAME)});
             return {
               name: (name?.textContent ?? "").trim(),
               rowText: (row?.textContent ?? "").trim(),
               rows: document.querySelectorAll(${JSON.stringify(UNBOUND_ROW)}).length,
               binds: document.querySelectorAll(${JSON.stringify(BIND)}).length,
             };
           })()`,
        );
        note("at0438 unbound row", JSON.stringify(unbound));
        // The name wears its sigil here too — a dash is named one way
        // everywhere, and this row is the one place with no session to carry it.
        expect(unbound.name).toBe(`^${DASH_NAME}`);
        expect(unbound.rowText).toContain(DASH_NAME);
        // A dash created and never worked is `created`, and its birth record is
        // what gives it an age at all.
        expect(unbound.rowText).toContain("created");
        expect(unbound.binds).toBeGreaterThan(0);
        // And the session is NOT working it, so there is no dash line.
        expect(await count(app, DASH_LINE)).toBe(0);
        note("at0438 lens with the unbound section", (await app.screenshot()).path);

        // ── Bind: the section vanishes, band and all ──────────────────────
        await shellAndSettle(app, `${tugutilPath(PROJECT_DIR)} dash bind ${DASH_NAME}`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DASH_LINE)}) !== null`,
          { timeoutMs: 30000 },
        );
        // The whole point of [P03]: no band, no body, no DOM. A weaker
        // assertion — an empty body — would pass for the thing this replaced.
        expect(await count(app, UNBOUND)).toBe(0);
        note("at0438 lens with the section gone", (await app.screenshot()).path);

        // ── Unbind: it comes back, with its row ───────────────────────────
        await shellAndSettle(app, `${tugutilPath(PROJECT_DIR)} dash unbind`, 1);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(UNBOUND_ROW)}) !== null`,
          { timeoutMs: 30000 },
        );
        expect(await count(app, DASH_LINE)).toBe(0);
        expect(await count(app, UNBOUND_ROW)).toBe(1);

        // ── Bind: the same partition, driven through the new control ──────
        // The press sends `bind_dash`; the row leaves because `bound_sessions`
        // moved in the aggregate, not because the click did anything local.
        await clickUntil(app, BIND, UNBOUND, "absent");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DASH_LINE)}) !== null`,
          { timeoutMs: 30000 },
        );
        expect(await count(app, UNBOUND)).toBe(0);
        expect(await count(app, DASH_LINE)).toBe(1);

        // The section unmounted under whatever the movement cursor was on.
        // Focus must not be stranded on a detached node: an element removed
        // from the document still answers `document.activeElement` in WebKit
        // for a beat, and a ring on a node nobody can reach is how a "dead"
        // keyboard starts.
        const focus = await app.evalJS<{
          connected: boolean;
          inVanishedSection: boolean;
          slot: string | null;
        }>(
          `(() => {
             const el = document.activeElement;
             if (el === null) {
               return { connected: false, inVanishedSection: false, slot: null };
             }
             return {
               connected: el.isConnected,
               inVanishedSection:
                 el.closest(${JSON.stringify(UNBOUND)}) !== null,
               slot: el.getAttribute("data-slot"),
             };
           })()`,
        );
        note("at0438 focus after the section vanished", JSON.stringify(focus));
        expect(focus.connected).toBe(true);
        expect(focus.inVanishedSection).toBe(false);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
