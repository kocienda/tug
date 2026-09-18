/**
 * at0595-commit-card-masthead.test.ts — a commit gets a card of its own.
 *
 * ## What this gates
 *
 * The Commit card, mounted on a real commit in this repo and read end to end:
 *
 *   1. The `commit` componentId is registered, so a deck carrying one restores
 *      it rather than dropping the pane — the cold-boot rule that quietly
 *      deletes any card whose component nobody registered.
 *   2. The card seeds its target from the restore bag and fetches through the
 *      real `GIT_COMMIT_FILES` route, so what the card shows is the record the
 *      server read out of git rather than anything the seed carried.
 *   3. The pane wears the **commit masthead**: three lines, and the lead one
 *      is a `TugCommitAtom` PILL rather than a title string, which is the whole
 *      reason that payload kind exists. The subject is the commit's own, and
 *      the third line carries author, date and time together.
 *   4. The tier stands at the document masthead's 72px, not the session card's
 *      taller one — a pane fact published from `data-masthead-kind`.
 *   5. The body is the History shade's expanded record, WITHOUT its trailing
 *      attribution line: the masthead's third line says who and when, so the
 *      record ends at the file roster.
 *
 * The commit under test is this checkout's own HEAD, read from git here and
 * asserted against what the card displays — so the test cannot pass by
 * agreeing with itself.
 *
 * @covers tugdeck/src/components/tugways/cards/commit-card.tsx
 * @covers tugdeck/src/components/tugways/cards/commit-card.css
 * @covers tugdeck/src/components/tugways/commit-masthead.tsx
 * @covers tugdeck/src/components/tugways/commit-masthead.css
 * @covers tugdeck/src/lib/commit-card-open-registry.ts
 * @covers tugdeck/src/lib/open-commit-in-card.ts
 * @covers tugdeck/src/lib/card-title-store.ts
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/tugways/commit-presentation.tsx
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** The worktree root — the real repo tugcast serves as its bootstrap tree. */
const REPO = resolve(import.meta.dir, "..", "..");

const CARD = '[data-slot="commit-card"]';
const MASTHEAD = '[data-testid="commit-masthead"]';
const ATOM = MASTHEAD + " .tug-commit-atom";
const SUBJECT = MASTHEAD + ' [data-testid="commit-masthead-subject"]';
const META_CELL = MASTHEAD + " .tugx-commit-meta";
const META_STAMP = MASTHEAD + ' [data-slot="commit-stamp"]';

/** One field of this repo's HEAD commit, straight from git. */
function headField(format: string): string {
  return Bun.spawnSync(["git", "-C", REPO, "show", "-s", `--format=${format}`, "HEAD"])
    .stdout.toString()
    .trim();
}

/** A masthead run on the pane hosting the Commit card. */
async function mastheadText(app: App, selector: string): Promise<string | null> {
  return app.evalJS<string | null>(
    `(() => {
       const card = document.querySelector(${JSON.stringify(CARD)});
       const pane = card === null ? null : card.closest(".tug-pane");
       const el = pane === null ? null : pane.querySelector(${JSON.stringify(selector)});
       return el === null ? null : el.innerText.replace(/\\s+/g, " ").trim();
     })()`,
  );
}

function deckShape() {
  return {
    cards: [{ id: "C", componentId: "commit", title: "Commit", closable: true }],
    panes: [
      {
        id: "pC",
        position: { x: 40, y: 40 },
        size: { width: 720, height: 640 },
        cardIds: ["C"],
        activeCardId: "C",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pC",
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)("at0595 — a commit in its own card", () => {
  test(
    "the card mounts on a real commit and its pane wears the commit masthead",
    async () => {
      const sha = headField("%H");
      const subject = headField("%s");
      const author = headField("%an");

      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath, { sourceTreePath: REPO });
        const app = await launchTugApp({
          testName: "at0595-commit-card-masthead",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `typeof window.__tug !== "undefined"`,
            { timeoutMs: 15_000 },
          );

          // ---- A deck carrying a `commit` card restores it.
          //
          // Seeded with the SHORT sha, which is what a prose atom knows: the
          // card resolves it through the same `git show` the History shade
          // makes, so eight characters are enough to raise a whole record.
          await app.seedDeckState({
            state: deckShape(),
            cardStates: {
              // A card's bag has axes; the seed a card's own `onRestore`
              // reads is the `content` one.
              C: { content: { target: { root: REPO, sha: sha.slice(0, 8) } } },
            },
            focusCardId: "C",
          });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CARD)}) !== null`,
            { timeoutMs: 15_000 },
          );

          // ---- The record arrives from git, not from the seed.
          //
          // The seed carried a sha and nothing else, so a subject on screen
          // can only have come through the GIT_COMMIT_FILES route.
          const mounted = await app.evalJS<unknown>(
            `(() => {
               const card = document.querySelector(${JSON.stringify(CARD)});
               const pane = card === null ? null : card.closest(".tug-pane");
               const head = pane === null ? null : pane.querySelector(${JSON.stringify(MASTHEAD)});
               return {
                 card: card === null ? null : card.innerText.slice(0, 200),
                 mastheadKind: pane === null ? null : pane.getAttribute("data-masthead-kind"),
                 masthead: head === null ? null : head.innerText.slice(0, 200),
               };
             })()`,
          );
          note("at0595 after mount", JSON.stringify(mounted));
          await app.waitForCondition<boolean>(
            `(function () {
               const el = document.querySelector(
                 ${JSON.stringify(SUBJECT)},
               );
               return el !== null && el.innerText.trim().length > 0;
             })()`,
            { timeoutMs: 20_000 },
          );

          // ---- The three lines.
          const lead = await app.evalJS<{
            pill: string | null;
            isAtom: boolean;
          }>(`(() => {
             const card = document.querySelector(${JSON.stringify(CARD)});
             const pane = card.closest(".tug-pane");
             const atom = pane.querySelector(
               ${JSON.stringify(ATOM)},
             );
             return {
               // The pill's word and its hash are two inline runs, so
               // innerText breaks between them; the reader sees one label.
               pill:
                 atom === null
                   ? null
                   : atom.innerText.replace(/\\s+/g, "").trim(),
               // The lead line is a PILL, not a title string — the document
               // masthead's card-masthead-title testid must NOT be what renders.
               isAtom:
                 atom !== null &&
                 pane.querySelector('[data-testid="card-masthead-title"]') === null,
             };
           })()`);
          const subjectLine = await mastheadText(app, SUBJECT);
          const metaLine = await mastheadText(app, META_STAMP);
          const metaCell = await mastheadText(app, META_CELL);
          note(
            "at0595 masthead",
            JSON.stringify({ lead, subjectLine, metaCell, metaLine }),
          );

          expect(lead.isAtom, "the lead line is the commit's pill").toBe(true);
          expect(lead.pill).toBe(`commit:${sha.slice(0, 8)}`);
          expect(subjectLine).toBe(subject);
          // Author AND the full stamp, which is the line the card's body gave
          // up its attribution run for.
          expect(metaCell).toContain(author);
          expect(metaLine).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);

          // ---- The tier is the document tier's height, not the session's.
          const tier = await app.evalJS<{ height: number; kind: string | null }>(
            `(() => {
               const card = document.querySelector(${JSON.stringify(CARD)});
               const pane = card.closest(".tug-pane");
               const bar = pane.querySelector(".tug-pane-title-bar");
               const border = parseFloat(getComputedStyle(bar).borderBottomWidth) || 0;
               return {
                 height: bar.getBoundingClientRect().height - border,
                 kind: pane.getAttribute("data-masthead-kind"),
               };
             })()`,
          );
          note("at0595 tier", JSON.stringify(tier));
          expect(tier.kind).toBe("card");
          expect(tier.height).toBeCloseTo(72, 0);

          // ---- The body is the shade's record, minus its attribution line.
          const body = await app.evalJS<{
            files: number;
            attribution: boolean;
            message: boolean;
          }>(`(() => {
             const card = document.querySelector(${JSON.stringify(CARD)});
             return {
               files: (() => {
                 const list = card.querySelector(
                   '[data-slot="tug-commit-changes-list"]',
                 );
                 return list === null ? 0 : list.children.length;
               })(),
               // The card's masthead says who and when, so the body must not
               // say it a second time.
               attribution:
                 card.querySelector(".tugx-commit-attribution") !== null,
               message:
                 card.querySelector('[data-slot="commit-card-message"]') !== null,
             };
           })()`);
          note("at0595 body", JSON.stringify(body));
          expect(body.attribution, "the card drops the attribution line").toBe(false);
          expect(body.files, "the commit's changed files are listed").toBeGreaterThan(
            0,
          );
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
