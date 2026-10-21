/**
 * row-11-draft-tiers.test.ts — a draft typed in a card whose workspace is
 * parked is on disk while its body is dormant, and back in its composer
 * after the body is evicted and the card is shown again.
 *
 * Row 11's draft reading against the two tiers a hidden body passes
 * through. The app launches on two workspaces: a Session card's, shown, and
 * a Text card's, parked. A draft is typed in the Session card and its
 * workspace parked, with the body's `dormantAfterMs` and the reader's
 * `evictAfterMs` shortened. Once the body is dormant the card's bag on the
 * run's tugbank file carries the draft — the body writes it as it sleeps,
 * so a crash while it sleeps loses nothing. Past the reader's delay the body
 * is evicted, and the card shown again comes back with the draft in its
 * composer.
 *
 * @foreground activation
 * @covers tugdeck/src/body/body-dormancy.ts
 * @covers tugdeck/src/body/body-main.ts
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankRead, tugbankWrite } from "../_harness/tugbank-helpers";
import { bodyOf, composerText, focusBody, pollFor, sessionPane } from "./_bodies";
import { activate, textDeck } from "./_row-44";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "r11t-a";
const T = "r11t-text";
const SESSION_SPACE = "r11t-session";
const TEXT_SPACE = "r11t-text-space";
/** The body's delay before dormancy and the reader's before eviction, shortened for the row. */
const DORMANT_AFTER_MS = 800;
const EVICT_AFTER_MS = 2_500;
const DRAFT = "row11 draft across the tiers";
const CARDSTATE = "dev.tugapp.deck.cardstate";

const LAYOUT = {
  version: 5,
  activeSpaceId: SESSION_SPACE,
  spaces: [
    {
      id: SESSION_SPACE,
      name: "Session",
      deck: {
        cards: [{ id: A, componentId: "session", title: "A", closable: true }],
        panes: [sessionPane(A, 0)],
        activePaneId: `${A}-pane`,
        imposition: { kind: "one-up", layout: "fit", sidebars: {} },
        hasFocus: true,
      },
    },
    { id: TEXT_SPACE, name: "Text", deck: textDeck([T]) },
  ],
};

/** The card's bag on tugbank disk, as one string to search. */
function bagOnDisk(tugbankPath: string): string {
  return JSON.stringify(tugbankRead<unknown>(tugbankPath, CARDSTATE, A)?.value ?? null);
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 11: a draft across the dormant and evicted tiers", () => {
  test(
    "a parked card's draft is on disk while its body is dormant, and in its composer after eviction",
    async () => {
      const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-r11t-project-")));
      onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(LAYOUT));
      tugbankWrite(tugbankPath, "dev.tugapp.body-dormancy", "dormantAfterMs", "int", String(DORMANT_AFTER_MS));
      tugbankWrite(tugbankPath, "dev.tugapp.body-dormancy", "evictAfterMs", "int", String(EVICT_AFTER_MS));
      const app = await launchTugApp({
        testName: "body-grounding-row-11-draft-tiers",
        foreground: true,
        persistInTestMode: true,
        restoreInTestMode: true,
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.visible, 30_000);
        await app.spawnSessionNew(A, { tugSessionId: randomUUID(), projectDir });

        // ---- A draft, typed, and the workspace parked ----
        await focusBody(app, A, { composer: true });
        await app.nativeType(DRAFT);
        const typed = await pollFor(() => app.body(A).evalJS<string | null>(composerText), (t) => t?.includes(DRAFT) === true, 5_000);
        expect(typed, "the composer holds the draft").toContain(DRAFT);
        await activate(app, TEXT_SPACE);
        const parkedAt = Date.now();

        // ---- Dormant: the body sleeps, and its bag on disk holds the draft ----
        const asleep = await pollFor(() => app.body(A).evalJS<boolean>("window.__tug.bodyDormancy().dormant"), (d) => d, 5_000);
        expect(asleep, "the parked body is dormant past its delay").toBe(true);
        const dormantBag = await pollFor(async () => bagOnDisk(tugbankPath), (bag) => bag.includes(DRAFT), 2_000);
        note(`dormant ${Date.now() - parkedAt} ms after the park; the bag on disk ${dormantBag.includes(DRAFT) ? "holds" : "lacks"} the draft`);
        expect(dormantBag, "the dormant card's bag on disk carries the draft").toContain(DRAFT);

        // ---- Evicted: no body at all ----
        const gone = await pollFor(() => app.bodies(), (all) => !all.some((b) => b.cardId === A), EVICT_AFTER_MS + 6_000);
        expect(gone.some((b) => b.cardId === A), "the parked body is evicted past the reader's delay").toBe(false);
        note(`evicted ${Date.now() - parkedAt} ms after the park`);

        // ---- Shown again: the card is back with its draft ----
        await activate(app, SESSION_SPACE);
        const back = await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.painted && b.visible && !b.covered, 10_000);
        expect(back, "the card's new body is ready, painted and shown").toMatchObject({ state: "ready", painted: true, visible: true });
        const draft = await pollFor(() => app.body(A).evalJS<string | null>(composerText), (t) => t?.includes(DRAFT) === true, 5_000);
        expect(draft, "the new body's composer holds the draft").toContain(DRAFT);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
