/**
 * at0492-tripwires-card.test.ts — the **Tripwires** card over the real
 * `/api/tripwires` surface.
 *
 * Nothing here is stubbed. A real `tugtool tripwire lay` writes rows into the
 * launch's own `tripwires.db` — the harness points `TUG_TRIPWIRES_DB` into the
 * per-instance data dir, so a test can arm a tripwire without arming one on the
 * developer's machine — and the card reads them back through the HTTP
 * surface the running tugcast is serving.
 *
 * What it pins:
 *   1. `toggle-tripwires` shows the rail, and the card lists the tripwires the
 *      ledger holds, in the order they were laid, under a band carrying the
 *      live counts ([B01]).
 *   2. A paused tripwire reads as paused. This is the projection the card
 *      exists to show: an armed tripwire and a paused one look identical
 *      unless something says so.
 *   3. **Pause is pressed on the card and read back from the ledger.** The
 *      control writes through the real HTTP surface, so what the roster shows
 *      afterwards and what `tugtool tripwire list` says are one fact.
 *   4. **The fold opens in place, by the cue and by Enter**, over the
 *      tripwire's definition and its trip log — the gesture that replaced the
 *      second level and its back control ([B02]).
 *   5. The model knob stands in the fold showing the ledger's own value, and
 *      offers the session default plus the three model names.
 *   6. The row says which branch the wire lands on, and shows no dot: a wire
 *      with no run in flight and no question outstanding is silent ([P08]).
 *   7. The brief stands whole behind a clamp rather than in a tooltip, and the
 *      retired knobs are absent — no tier, no cooldown, no post policy.
 *
 * ## What the real app cannot reach, and where it is pinned instead
 *
 * The live states — a running trip's session dot, an awaiting trip's register
 * band and its Seen act, an arc atom in a trip's meta line, a populated log
 * with a rolled-up run and an older-trips cue — all need a **trip row**, and
 * there is no CLI door that records one without running a tripwire for real:
 * `tugtool tripwire trip` goes past the guards by construction (`serve_manual`
 * feeds a synthetic landing to a real inspection tree and a real `claude`), and
 * the house rule against opening a live ledger with a foreign sqlite rules out
 * the other way in. at0568 states the same boundary for the same reason.
 *
 * So the log's rules are proved over rows, deterministically, in
 * `tugdeck/src/components/tripwires/__tests__/trip-log.test.ts` — which trips
 * fold, what a folded run says, and how the older cue walks a long log down to
 * nothing — and the dot's three meanings are proved as a decision in
 * `tripwire-presentation`'s unit tests. What this file proves is the half those
 * cannot reach: the controls, pressed on the real card, landing in the real
 * ledger.
 *
 * @covers tugdeck/src/components/tripwires/tripwires-card.tsx
 * @covers tugdeck/src/components/tripwires/tripwires-card-registration.tsx
 * @covers tugdeck/src/components/tripwires/tripwire-presentation.ts
 * @covers tugdeck/src/components/tripwires/tripwires-data-source.ts
 * @covers tugdeck/src/components/tripwires/trip-log.ts
 * @covers tugdeck/src/components/tugways/action-vocabulary.ts
 * @covers tugdeck/src/lib/tripwires-store.ts
 * @covers tugrust/crates/tugcast/src/tripwires_api.rs
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { launchTugApp, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import { tugtool } from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const CHECKOUT = process.env.TUG_REPO_UNIVERSE ?? process.cwd();

const CARD = `.tripwires-card`;

/** The ledger this launch writes to — the same path the harness hands the app. */
function instanceTripwiresDb(instanceId: string): string {
  return join(
    homedir(),
    "Library/Application Support/Tug/instances",
    instanceId,
    "tripwires.db",
  );
}

/** A brief a real tripwire carries: a first sentence saying what it is for,
 *  then several more saying how. The card shows the whole of it behind a
 *  two-line clamp — printed bare, this is the shape that crushed the rail, and
 *  put in a tooltip it was the wall of text that replaced it ([B05]). */
const LONG_BRIEF =
  "Diagnose the failure and say whether the tool or the caller was wrong. " +
  "The evidence carries the failure class, the rendered report, how many ops " +
  "resolved, the files named, and the program itself. Read the program " +
  "against the current bytes of the files it names before judging. If the " +
  "tool could have done better, implement it with tests and say what changed.";

function ledgerEnv(app: App): { TUG_TRIPWIRES_DB: string } {
  return { TUG_TRIPWIRES_DB: instanceTripwiresDb(app.instanceId) };
}

/** Lay a tripwire into this launch's ledger, through the real CLI. */
function layTripwire(
  app: App,
  name: string,
  extra: string[] = [],
  brief = `say whether ${name} saw anything worth reporting`,
): void {
  tugtool(
    [
      "tripwire",
      "lay",
      name,
      "--on",
      "fact:edit_failed",
      "--branch",
      "main",
      "--brief",
      // A real brief, because `tripwire lay` refuses a placeholder — the guard
      // that retired the tripwire whose every firing reported it had been told
      // nothing.
      brief,
      "--json",
      ...extra,
    ],
    { cwd: CHECKOUT, binaryRoot: CHECKOUT, env: ledgerEnv(app) },
  );
}

function pauseTripwire(app: App, name: string): void {
  tugtool(["tripwire", "pause", name, "--json"], {
    cwd: CHECKOUT,
    binaryRoot: CHECKOUT,
    env: ledgerEnv(app),
  });
}

/** One tripwire's row, straight out of the ledger the card just wrote to. */
function ledgerRow(
  app: App,
  name: string,
): { paused: boolean; model: string | null } {
  const out = tugtool(["tripwire", "list", "--json"], {
    cwd: CHECKOUT,
    binaryRoot: CHECKOUT,
    env: ledgerEnv(app),
  });
  const parsed = JSON.parse(out) as {
    data: { name: string; paused: boolean; model: string | null }[];
  };
  const row = parsed.data.find((r) => r.name === name);
  if (row === undefined) throw new Error(`at0492: no tripwire named ${name} in the ledger`);
  return row;
}

async function tripwireNames(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.from(document.querySelectorAll("[data-tripwire]")).map((el) => el.getAttribute("data-tripwire"))`,
  );
}

/** Is this tripwire's fold open? The fold is the card's one second surface. */
async function foldOpen(app: App, name: string): Promise<boolean> {
  return app.evalJS<boolean>(
    `document.querySelector("[data-tripwire='${name}'] [data-slot='tripwire-fold']") !== null`,
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0492 — the Tripwires card over the real ledger",
  () => {
    test(
      "every control on the card writes to the ledger, and the fold opens both ways",
      async () => {
        const tugbankPath = mkTempTugbank();
        try {
          seedTugbankForLaunch(tugbankPath);
          const app = await launchTugApp({
            testName: "at0492-tripwires-card",
            env: { TUGBANK_PATH: tugbankPath },
            persistInTestMode: true,
          });
          try {
            await app.waitForCondition<boolean>(`typeof window.__tug !== "undefined"`, {
              timeoutMs: 5_000,
            });

            // Seeded before the card opens, so its first read already
            // has them and the assertion is not waiting out a poll interval.
            layTripwire(app, "alpha", [], LONG_BRIEF);
            // A probe is the field that survived the knob cull ([P10]), and
            // the fold is where it has to be readable.
            layTripwire(app, "alpha-probed", ["--probe", "just ci", "--model", "opus"]);
            layTripwire(app, "beta");
            pauseTripwire(app, "beta");

            await app.dispatchControlAction("toggle-tripwires");
            // The card stands whether or not anything is laid: nothing hides it
            // on emptiness, and a watch facility that vanished when empty would
            // be undiscoverable.
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(CARD)}) !== null`,
              { timeoutMs: 8_000 },
            );
            await app.waitForCondition<boolean>(
              `document.querySelectorAll("[data-tripwire]").length === 3`,
              { timeoutMs: 8_000 },
            );

            expect(await tripwireNames(app)).toEqual(["alpha", "alpha-probed", "beta"]);
            expect(
              await app.evalJS<string | null>(
                `document.querySelector("[data-tripwire='beta']").getAttribute("data-tripwire-paused")`,
              ),
            ).toBe("true");
            expect(
              await app.evalJS<string | null>(
                `document.querySelector("[data-tripwire='alpha']").getAttribute("data-tripwire-paused")`,
              ),
            ).toBe("false");

            // ---- The band: what the roster amounts to, on the card's first
            // line. Three laid and one of them paused, so two are armed — and
            // the band says both numbers rather than making the reader count
            // rows ([B01]).
            const band = await app.evalJS<string>(
              `document.querySelector("[data-slot='tripwire-band']").textContent`,
            );
            expect(band).toContain("2 armed");
            expect(band).toContain("1 paused");
            // Nothing is running and nothing is awaiting, so the band says
            // nothing about either: a zero count is a row the reader has to
            // read to learn there is nothing to read.
            expect(band).not.toContain("running");
            expect(band).not.toContain("awaiting");

            // The wire's other half. The same trigger onto two branches is two
            // different watches, and the roster has to tell them apart.
            expect(
              await app.evalJS<string>(
                `document.querySelector("[data-tripwire='alpha'] [data-tripwire-branch]").textContent`,
              ),
            ).toBe("main");

            // Nothing is running and nothing is awaiting, so nothing moves.
            // The dot is the interest signal, and silence is what it says
            // about a wire with nothing to report ([P08]).
            expect(
              await app.evalJS<number>(
                `document.querySelectorAll(".tripwires-dot-button, [data-slot='tripwire-register']").length`,
              ),
            ).toBe(0);
            expect(
              await app.evalJS<string | null>(
                `document.querySelector("[data-tripwire='alpha']").getAttribute("data-tripwire-awaiting")`,
              ),
            ).toBe("false");

            // ---- The fold, by Enter. First, because the card seeds its first
            // row as the key view and registers `kbfAtRest`, so the cursor is
            // on `alpha` before anything else on the card has been pressed —
            // and Enter is the activation the list view turns into a fold
            // ([B02], [B08]).
            expect(await foldOpen(app, "alpha")).toBe(false);
            // A click on the row's own line puts the cursor there and makes the
            // card key — selection, not activation, so the fold is still shut.
            await app.click(`[data-tripwire='alpha'] [data-slot='tripwire-line']`);
            expect(await foldOpen(app, "alpha")).toBe(false);
            await app.nativeKey("Return");
            await app.waitForCondition<boolean>(
              `document.querySelector("[data-tripwire='alpha'] [data-slot='tripwire-fold']") !== null`,
              { timeoutMs: 5_000 },
            );
            await app.nativeKey("Return");
            await app.waitForCondition<boolean>(
              `document.querySelector("[data-tripwire='alpha'] [data-slot='tripwire-fold']") === null`,
              { timeoutMs: 5_000 },
            );

            // ---- Pause, pressed on the card. The control writes through the
            // real HTTP surface, so the row's own attribute and the ledger's
            // answer are one fact rather than two that happen to agree.
            expect(ledgerRow(app, "alpha").paused).toBe(false);
            await app.click(`[data-tripwires-pause='alpha']`);
            await app.waitForCondition<boolean>(
              `document.querySelector("[data-tripwire='alpha']").getAttribute("data-tripwire-paused") === "true"`,
              { timeoutMs: 5_000 },
            );
            expect(ledgerRow(app, "alpha").paused).toBe(true);
            // And back, so the control is a toggle rather than a one-way trip.
            await app.click(`[data-tripwires-pause='alpha']`);
            await app.waitForCondition<boolean>(
              `document.querySelector("[data-tripwire='alpha']").getAttribute("data-tripwire-paused") === "false"`,
              { timeoutMs: 5_000 },
            );
            expect(ledgerRow(app, "alpha").paused).toBe(false);

            // ---- The fold, by the cue. It opens in place, under the row it
            // belongs to, rather than pushing the card to a second level: the
            // other rows are still on screen. Neither door is the other's
            // fallback — a rail is walked both ways ([B02]).
            expect(await foldOpen(app, "alpha")).toBe(false);
            await app.click(`[data-tripwires-open='alpha'] button`);
            await app.waitForCondition<boolean>(
              `document.querySelector("[data-tripwire='alpha'] [data-slot='tripwire-fold']") !== null`,
              { timeoutMs: 5_000 },
            );
            expect(await tripwireNames(app)).toEqual(["alpha", "alpha-probed", "beta"]);

            // A tripwire that has never fired has a log, and the card shows the
            // log rather than nothing.
            expect(
              await app.evalJS<number>(
                `document.querySelectorAll("[data-slot='tripwire-trip'], [data-slot='tripwire-rollup']").length`,
              ),
            ).toBe(0);
            expect(
              await app.evalJS<string>(
                `document.querySelector("[data-tripwire='alpha'] [data-slot='tripwire-fold']").textContent`,
              ),
            ).toContain("Trip log");
            // Nothing to page to, so no cue asking the reader to try.
            expect(
              await app.evalJS<number>(
                `document.querySelectorAll("[data-tripwires-older]").length`,
              ),
            ).toBe(0);

            // What the tripwire IS, before what it has done, and in English:
            // the stored trigger is `{"fact":{"kind":"edit_failed"}}` and no
            // reader should ever meet it in that form.
            const definition = await app.evalJS<string>(
              `document.querySelector("[data-tripwire='alpha'] [data-slot='tripwire-definition']").textContent`,
            );
            expect(definition).toContain("Any edit_failed fact");
            // And the branch it lands on, which is a column on the wire rather
            // than a clause in its trigger.
            expect(definition).toContain("Lands on");

            // ---- The brief, whole, behind a clamp — and nowhere near a
            // tooltip. Both halves matter: the last sentence proves nothing was
            // abbreviated away, and the absent tooltip proves the wall of text
            // has no door back onto the rail ([B05]).
            expect(definition).toContain(
              "If the tool could have done better, implement it with tests and say what changed.",
            );
            expect(
              await app.evalJS<number>(
                `document.querySelectorAll(${JSON.stringify(CARD)} + " [data-radix-popper-content-wrapper], " + ${JSON.stringify(CARD)} + " [role='tooltip']").length`,
              ),
            ).toBe(0);

            // ---- The model knob. The session default until somebody says
            // otherwise, and the ledger's own value when there is one.
            expect(ledgerRow(app, "alpha").model).toBeNull();
            expect(
              await app.evalJS<string>(
                `document.querySelector("[data-tripwires-model='alpha']").textContent`,
              ),
            ).toContain("The session default");
            await app.nativeClickAtElement(`[data-tripwires-model='alpha'] button`);
            await app.waitForCondition<boolean>(
              `document.querySelector(".tug-menu-content [data-item-id='1']") !== null`,
              { timeoutMs: 5_000 },
            );
            // The four the knob offers, in order — the session default first,
            // because a tripwire that names no model is the ordinary case and
            // the one a reader undoes a choice back to.
            expect(
              await app.evalJS<string[]>(
                `Array.from(document.querySelectorAll(".tug-menu-content .tug-menu-item-label")).map((el) => el.textContent)`,
              ),
            ).toEqual(["The session default", "opus", "sonnet", "haiku"]);
            // Picking one is not driven here, and that is the shared menu
            // rather than this card: `TugPopupMenu` fires `onSelect` on a
            // 350ms blink's `finished`, which is the frame clock's, and the
            // harness window has no frame clock to finish it on. So what the
            // choice writes — a name as itself, the session default as `null`
            // — is pinned as a decision in `tripwire-presentation`'s tests,
            // and that the write posts exactly that knob is pinned in
            // `tripwires-store`'s.
            await app.nativeKey("Escape");
            await app.waitForCondition<boolean>(
              `document.querySelectorAll(".tug-menu-content").length === 0`,
              { timeoutMs: 5_000 },
            );

            // ---- And the cue shuts what the cue opened.
            await app.click(`[data-tripwires-open='alpha'] button`);
            await app.waitForCondition<boolean>(
              `document.querySelector("[data-tripwire='alpha'] [data-slot='tripwire-fold']") === null`,
              { timeoutMs: 5_000 },
            );

            // ---- The CARD carries the overflow. Whatever an open fold grows
            // to, the card hands the rail a scroller instead of a column that
            // pushes its siblings off the bottom — and the content element
            // stands at its full natural height inside that scroller, which is
            // what makes the card's height measurable ([B01]/[B02]) rather than
            // a reading of the run it was given.
            expect(
              await app.evalJS<boolean>(
                `(() => { const content = document.querySelector("[data-testid='tripwires-card-content']");
                    const card = document.querySelector(${JSON.stringify(CARD)});
                    return getComputedStyle(card).overflowY === "scroll"
                      && content.getBoundingClientRect().height
                         <= card.scrollHeight + 1; })()`,
              ),
            ).toBe(true);

            // ---- The probe survived the cull, and the knobs it outlived are
            // gone from the whole card — not merely from the row that used to
            // carry them.
            await app.click(`[data-tripwires-open='alpha-probed'] button`);
            await app.waitForCondition<boolean>(
              `document.querySelector("[data-tripwire='alpha-probed'] [data-slot='tripwire-definition']") !== null`,
              { timeoutMs: 5_000 },
            );
            const probed = await app.evalJS<string>(
              `document.querySelector("[data-tripwire='alpha-probed'] [data-slot='tripwire-definition']").textContent`,
            );
            expect(probed).toContain("Runs first");
            expect(probed).toContain("just ci");
            // A tripwire that names its own model shows that name on the knob,
            // rather than the default it is overriding.
            expect(
              await app.evalJS<string>(
                `document.querySelector("[data-tripwires-model='alpha-probed']").textContent`,
              ),
            ).toContain("opus");
            const card = await app.evalJS<string>(
              `document.querySelector(${JSON.stringify(CARD)}).textContent.toLowerCase()`,
            );
            for (const retired of ["tier", "cooldown", "post policy", "post when"]) {
              expect(card).not.toContain(retired);
            }
          } finally {
            await app.close();
          }
        } finally {
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
