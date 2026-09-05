/**
 * at0520-whole-entity-press.test.ts — every menu about an entity selects the
 * entity whole, on every surface that opens one.
 *
 * ## What this gates
 *
 * A right-click on the commit atom in a `/commit` receipt used to open the
 * commit's four-item menu over a highlight that said `56c4820f`, while the
 * atom said `commit:56c4820f`. The same pill, drawn by the same component
 * under a menu built from the same registry entry, selected itself whole in
 * transcript prose and selected eight hex characters in a receipt header.
 * The press that settles the selection had been written once, as an option
 * on one menu-opening hook, and three other hooks opened their menus without
 * it.
 *
 * The rule is now one primitive every menu-opening hook composes
 * (`lib/whole-entity-press`): a secondary press that opens a menu about an
 * entity selects that entity — whole — and marks it
 * `data-tug-entity-selected` so a box-shaped mark can paint itself selected.
 * This test is the rule read from every side at once: ONE table over the
 * surfaces, asserting the same two facts on each, because a per-surface test
 * file is how the next copy drifts.
 *
 *   1. **Transcript ink** — a sha in prose, under the transcript's own menu
 *      (`useTextSurfaceContextMenu`). The path that already worked.
 *   2. **A `/commit` receipt's atom** — under `useCommitIdentityMenu`, claimed
 *      by the atom's wrapper. The surface the fault was found on.
 *   3. **A session chip in a sent row** — under `useSessionIdentityMenu`,
 *      which the chip claims for itself.
 *   4. **A History row pressed OFF the atom** — under `useCommitIdentityMenu`
 *      claimed by the whole row: the press lands on the stamp and the row's
 *      commit atom is what lights, because the atom is the commit's visible
 *      name and the commit is what every item acts on.
 *
 * The same two facts on every surface, with one reading that depends on the
 * surface: the DOM selection stands on the entity (a range that intersects
 * it) and the entity wears the mark. Where the surface is selectable text —
 * the transcript — the selection's text is also the entity's whole text. The
 * History shade is `user-select: none` chrome, and WebKit gives a range in
 * unselectable content no text at all; the range is there and the mark is
 * what paints the pill, which is the whole of what a reader sees.
 *
 * The receipt case is also the proof of a claim the primitive rests on: the
 * atom stops React propagation of every pointer gesture on itself, so the
 * press has to reach the claiming ancestor as a NATIVE listener, which sees
 * the event before React's root-delegated handler can stop it.
 *
 * Driven against this worktree — the real repo tugcast serves as its
 * bootstrap tree, so the sha in every surface is one the git feed confirms.
 *
 * @covers tugdeck/src/lib/whole-entity-press.ts
 * @covers tugdeck/src/lib/entity-selection-paint.ts
 * @covers tugdeck/src/components/tugways/use-text-surface-context-menu.tsx
 * @covers tugdeck/src/components/tugways/commit-identity-menu.tsx
 * @covers tugdeck/src/components/tugways/session-identity-menu.tsx
 * @covers tugdeck/src/components/tugways/use-copyable-text.tsx
 * @covers tugdeck/src/components/tugways/commit-sha-text.tsx
 * @covers tugdeck/src/components/tugways/tug-commit-atom.tsx
 * @covers tugdeck/src/components/tugways/tug-session-identity.tsx
 * @covers tugdeck/src/components/tugways/tug-history-list.tsx
 * @covers tugdeck/src/components/tugways/cards/session-commit-receipt-block.tsx
 * @covers tugdeck/src/components/tugways/cards/transcript-host-helpers.ts
 * @covers tugdeck/src/components/tugways/use-annotation-menu.tsx
 * @covers tugdeck/styles/tug-annotation.css
 */

import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { basename, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-W";

/** The worktree root — the real repo tugcast serves as its bootstrap tree. */
const REPO = resolve(import.meta.dir, "..", "..");
const HEAD_SHA = execSync("git rev-parse HEAD", { cwd: REPO }).toString().trim();
/** The short form prose uses — deliberately longer than the label's eight. */
const WRITTEN_SHA = HEAD_SHA.slice(0, 9);
/** What every commit surface spells. */
const LABEL = `commit:${HEAD_SHA.slice(0, 8)}`;

/**
 * A session atom's value and label are both `<project>/<callsign>` — the
 * unbound atom text a real copy writes. The send re-derives its atoms from
 * the wire and keeps a session marker only for a callsign this client has
 * seen, so the card's own session is published to the ledger under this
 * callsign before the atom is sent.
 */
const CALLSIGN = "quiet-harbor";
const SESSION_ATOM = `${basename(REPO)}/${CALLSIGN}`;

const PILL = '[data-slot="tug-commit-atom"]';
const CARD = '[data-card-id="W"]';
const TRANSCRIPT = `${CARD} .session-card-transcript-code-body`;
const MENTION_SPAN = `${TRANSCRIPT} [data-tug-annotation="commit-sha"]`;
const MENTION_PILL = `${MENTION_SPAN} ${PILL}`;
const RECEIPT_PILL = `${CARD} .commit-receipt-header ${PILL}`;
const USER_BODY = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const SENT_CHIP = `${USER_BODY} [data-slot="tug-session-identity"]`;
const HISTORY_ROW = `[data-slot="session-history-view"] [data-testid="session-history-commit"]`;
const HISTORY_STAMP = `${HISTORY_ROW} .tugx-commit-stamp`;
const HISTORY_PILL = `${HISTORY_ROW} ${PILL}`;
const MENU = '[data-slot="tug-editor-context-menu"]';

/** U+FFFC — the object-replacement char an atom occupies in the substrate. */
const FFFC = "￼";

/** A `/commit` receipt's output — the server-formatted summary the receipt parses. */
const COMMIT_SUMMARY =
  `committed ${HEAD_SHA} · 1 file(s) · +3 −1\n` +
  `files: [{"path":"tugdeck/src/lib/commit-format.ts","status":"modified","added":3,"removed":1}]\n` +
  "Land the commit atom";

function deckShape() {
  return {
    cards: [{ id: "W", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "pW",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 700 },
        cardIds: ["W"],
        activeCardId: "W",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pW",
    hasFocus: true,
  };
}

const userMsg = (text: string) => ({
  type: "add_user_message",
  tug_session_id: SID,
  content: [{ type: "text", text }],
});
const asstText = (msgId: string, text: string) => ({
  type: "assistant_text",
  tug_session_id: SID,
  msg_id: msgId,
  text,
  is_partial: false,
  rev: 0,
  seq: 1,
});
const turnDone = (msgId: string) => ({
  type: "turn_complete",
  tug_session_id: SID,
  msg_id: msgId,
  result: "success",
});
const replayStarted = () => ({ type: "replay_started", tug_session_id: SID });
const replayComplete = () => ({
  type: "replay_complete",
  tug_session_id: SID,
  count: 1,
  firstLoadedTurnIndex: 0,
  totalTurns: 1,
  hasOlder: false,
});

/** Seed the deck, bind the card to this repo, and get past the restore veil. */
async function openBoundCard(app: App): Promise<void> {
  const ingest = (decoded: unknown) =>
    app.driveSession("W", { op: "ingestFrame", feedId: CODE_OUTPUT_FEED, decoded });
  await app.waitForCondition<boolean>(`typeof window.__tug !== "undefined"`, {
    timeoutMs: 20_000,
  });
  await app.seedDeckState({ state: deckShape(), focusCardId: "W" });
  await app.waitForCondition<boolean>(
    `window.__tug.assertHostRootRegistered("W")`,
    { timeoutMs: 20_000 },
  );
  await app.bindSession("W", {
    tugSessionId: SID,
    projectDir: REPO,
    sessionMode: "resume",
  });
  await ingest(replayStarted());
  await ingest(userMsg("hello"));
  await ingest(asstText("m0", "Ready."));
  await ingest(turnDone("m0"));
  await ingest(replayComplete());
}

/** A sha in transcript prose, confirmed by the git feed into a pill. */
async function writeMention(app: App): Promise<void> {
  await app.driveSession("W", { op: "send", text: "which commit" });
  await app.driveSession("W", {
    op: "ingestFrame",
    feedId: CODE_OUTPUT_FEED,
    decoded: asstText("m1", `It landed as \`${WRITTEN_SHA}\`.`),
  });
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(MENTION_PILL)}) !== null`,
    { timeoutMs: 20_000 },
  );
}

/** The settled `/commit` exchange whose receipt leads with the atom. */
async function writeReceipt(app: App): Promise<void> {
  await app.driveSession("W", {
    op: "shellExchange",
    exchangeId: "at0520-commit",
    command: "/commit",
    output: COMMIT_SUMMARY,
    cwd: REPO,
    exitCode: 0,
    startedAtMs: 1_700_000_000_000,
  });
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(RECEIPT_PILL)}) !== null`,
    { timeoutMs: 20_000 },
  );
}

/** A prompt whose one atom is a session, sent through the production send. */
async function writeSentSession(app: App): Promise<void> {
  // The `session_updated` frame the supervisor pushes after a ledger write —
  // what teaches this client the callsign the atom names.
  expect(
    await app.evalJS<boolean>(
      `window.__tug.publishSessionUpdated(${JSON.stringify(
        JSON.stringify({
          session_id: SID,
          fields: {
            session_id: SID,
            project_dir: REPO,
            tag: CALLSIGN,
            name: null,
            name_user_set: false,
            turn_count: 2,
            file_size: 4_096,
            last_user_prompt: "hello",
            last_used_at: 1_754_600_000_000,
          },
        }),
      )})`,
    ),
  ).toBe(true);
  await app.driveSession("W", {
    op: "send",
    text: `ask ${FFFC} about it`,
    atoms: [{ kind: "atom", type: "session", label: SESSION_ATOM, value: SESSION_ATOM }],
  });
  // The row paints optimistically and settles as the store and the citation
  // resolver catch up, remounting the chip on the way; the press waits for a
  // chip that has stayed put across several polls rather than the first one.
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(SENT_CHIP)});
      if (el === null || el !== window.__at0520chip) {
        window.__at0520chip = el;
        window.__at0520seen = 0;
        return false;
      }
      window.__at0520seen = (window.__at0520seen || 0) + 1;
      return window.__at0520seen >= 5;
    })()`,
    { timeoutMs: 20_000 },
  );
  note(
    "at0520 sent row",
    await app.evalJS<string>(
      `JSON.stringify((function(){
        var bodies = document.querySelectorAll(${JSON.stringify(USER_BODY)});
        var chip = document.querySelector(${JSON.stringify(SENT_CHIP)});
        return {
          bodies: bodies.length,
          chip: chip === null ? null : (chip.textContent || "").trim(),
          missing: chip === null ? null : chip.getAttribute("data-missing"),
          ghost:
            chip !== null &&
            chip.closest('[data-slot="session-transcript-ghost-row"]') !== null,
        };
      })())`,
    ),
  );
}

const revealJS = (selector: string) =>
  `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) return false;
    el.scrollIntoView({ block: "center" });
    return true;
  })()`;

/**
 * The two facts the rule states, read in one frame while the menu is open:
 * what the DOM selection says, and whether the entity wears the mark. The
 * entity's own text rides along so the comparison is against what the
 * surface actually drew rather than a string this file guessed. Zero-width
 * struts and whitespace are dropped from both sides: a pill carries a
 * `U+200B` for its baseline, and `Selection.toString()` and `textContent`
 * disagree about whitespace between runs.
 */
function settledJS(entity: string): string {
  return `JSON.stringify((function(){
    var el = document.querySelector(${JSON.stringify(entity)});
    if (el === null) return { found: false };
    var sel = window.getSelection();
    var tidy = function (s) { return (s || "").replace(/[\\s\\u200B\\uFEFF]+/g, ""); };
    var covers = false;
    if (sel !== null && !sel.isCollapsed) {
      for (var i = 0; i < sel.rangeCount; i += 1) {
        if (sel.getRangeAt(i).intersectsNode(el)) covers = true;
      }
    }
    var style = getComputedStyle(el);
    return {
      found: true,
      selected: tidy(sel === null ? "" : sel.toString()),
      text: tidy(el.textContent),
      covers: covers,
      selectable: (style.userSelect || style.webkitUserSelect) !== "none",
      marked: el.hasAttribute("data-tug-entity-selected"),
      menus: document.querySelectorAll(".tug-menu-content").length,
    };
  })())`;
}

interface Settled {
  found: boolean;
  selected?: string;
  text?: string;
  covers?: boolean;
  selectable?: boolean;
  marked?: boolean;
  menus?: number;
}

/** One row of the table: where the press lands, and what it is about. */
interface Surface {
  where: string;
  /** Put the surface on screen. Runs right before the press, because an
   * optimistic row retires on its own and a shade covers the transcript. */
  prepare: (app: App) => Promise<void>;
  /** The element the trusted right-click is aimed at. */
  press: string;
  /** The element the menu is about — the one that must be selected whole. */
  entity: string;
  /** What the entity spells, when this file can say. */
  label?: string;
}

async function pressAndRead(app: App, s: Surface): Promise<Settled> {
  await app.evalJS<boolean>(revealJS(s.press));
  await app.nativeRightClickAtElement(s.press);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(MENU)}) !== null`,
    { timeoutMs: 8_000 },
  );
  const settled = JSON.parse(await app.evalJS<string>(settledJS(s.entity))) as Settled;
  note(`at0520 ${s.where}`, JSON.stringify(settled));
  await app.nativeKey("Escape");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(MENU)}) === null`,
    { timeoutMs: 8_000 },
  );
  return settled;
}

describe.skipIf(!SHOULD_RUN)("at0520 — the whole-entity press", () => {
  test(
    "every surface's menu opens over the whole entity, marked",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath, { sourceTreePath: REPO });
        const app = await launchTugApp({
          testName: "at0520-whole-entity-press",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await openBoundCard(app);

          // The transcript's three surfaces first, while the transcript is on
          // screen; the History shade comes up over it last.
          const surfaces: Surface[] = [
            {
              where: "transcript ink",
              prepare: writeMention,
              press: MENTION_PILL,
              entity: MENTION_SPAN,
              label: LABEL,
            },
            {
              where: "/commit receipt atom",
              prepare: writeReceipt,
              press: RECEIPT_PILL,
              entity: RECEIPT_PILL,
              label: LABEL,
            },
            {
              where: "session chip in a sent row",
              prepare: writeSentSession,
              press: SENT_CHIP,
              entity: SENT_CHIP,
            },
            {
              // A History row, pressed OFF the atom: the stamp. The row
              // claims the press; the atom is what the menu is about.
              where: "History row pressed off the atom",
              prepare: async (a) => {
                await a.dispatchControlAction("toggle-history-view");
                await a.waitForCondition<boolean>(
                  `document.querySelector(${JSON.stringify(HISTORY_PILL)}) !== null`,
                  { timeoutMs: 20_000 },
                );
              },
              press: HISTORY_STAMP,
              entity: HISTORY_PILL,
              label: LABEL,
            },
          ];
          const results: Array<[Surface, Settled]> = [];
          for (const s of surfaces) {
            await s.prepare(app);
            results.push([s, await pressAndRead(app, s)]);
          }

          for (const [s, r] of results) {
            expect(r.found, `${s.where}: the entity is on screen`).toBe(true);
            // One menu answered the press — the entity's, not a stack.
            expect(r.menus, `${s.where}: one menu`).toBe(1);
            // The selection stands on the entity — and where the surface is
            // selectable text, it is the entity's whole text: not a word
            // inside it, not the row around it.
            expect(r.covers, `${s.where}: the selection stands on the entity`).toBe(
              true,
            );
            if (r.selectable === true) {
              expect(r.selected, `${s.where}: the whole entity is selected`).toBe(
                r.text,
              );
            }
            if (s.label !== undefined) {
              expect(r.text, `${s.where}: the entity spells its label`).toBe(
                s.label,
              );
            }
            // And the entity wears the mark a box-shaped pill paints from.
            expect(r.marked, `${s.where}: the entity is marked selected`).toBe(
              true,
            );
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
});
