/**
 * at0512-commit-atom-surfaces.test.ts — a commit wears one mark on every
 * surface that names it, takes each surface's face, and sits on the line.
 *
 * ## What this gates
 *
 * A commit used to be drawn by the generic read-only atom skin — the skin a
 * `file_path` in a tool header wears — so a paragraph naming an arc, a file
 * and four commits came out as a row of undifferentiated runs. It is now the
 * identity pill (`tuglaws/entity-presentation.md`, [D174]): `TugCommitAtom`,
 * wearing `tug-session-identity` at `data-tier="chip"`, with a static node and
 * the label `commit:<8>`.
 *
 * Six surfaces name a commit and five of them are driven here — a transcript
 * mention, an Overview post's trailing ref, a `/commit` receipt's header, a
 * History shade row, and a **sent user row**, the surface a commit atom lands
 * on the moment the prompt carrying it is submitted. (The sixth is the
 * composer's baked chip, which `at0490-atom-register-parity` measures against
 * the live pill.) Each is pinned by the one slot, because a surface that
 * quietly kept the old skin would still render *something* and no text
 * assertion would notice.
 *
 * The sent row earns its place by having been the one surface that did keep an
 * old skin. The transcript's body renderers hand every atom but a session to
 * the generic chip, so a commit came back through the atom family's washed box
 * wearing the *file* glyph — the reader placed a pill in the composer and
 * watched it turn into a file the instant they pressed send. The three
 * `data-atom-*` attributes are read with it, because that is what a transcript
 * selection is serialized through: a mark without them copies as its
 * characters rather than as the atom it draws.
 *
 * ## The two claims a slot check cannot make
 *
 * **The face follows the surface.** The identity pill pins sans, and the
 * commit mount is the one place that declaration is reversed — a *name* has a
 * face, a hash does not. So the assertion is not "this surface is mono" but
 * the rule itself: the hash's resolved family equals the family its own host
 * was already setting, at every surface. A guard follows it so the check
 * cannot pass vacuously — at least one of the four must resolve to a mono
 * family and at least one must not, which is exactly the History-row versus
 * transcript-paragraph split the rule exists for.
 *
 * **The baseline is the label's.** A flex container has no baseline of its own
 * and borrows its first item's; for this pill that item would be the node, a
 * box with no text, whose baseline the browser synthesizes from its bottom
 * edge — which is how a pill came to hang off the underside of its own mark in
 * running text. The zero-width `U+200B` strut is what fixes it, and the number
 * is pinned in the surface where it is hardest to hold: a real transcript
 * sentence, where the pill's label baseline and the neighbouring word's must
 * differ by no more than a pixel.
 *
 * Baselines are measured, not inferred. A zero-height `inline-block` seats its
 * bottom margin edge on the baseline of the inline context it is in, so one
 * probe in the paragraph reads the sentence's baseline and one inside the
 * hash's own span reads the label's. Comparing the two boxes' bottom edges
 * would not do: the pill's type size comes from the register rather than from
 * the surrounding text, so the two runs have different descents and their
 * bottoms are allowed to disagree.
 *
 * Driven against this worktree, the real repo tugcast serves as its bootstrap
 * `--source-tree` (at0239's rationale: a synthetic temp repo hangs the app's
 * boot), so every sha here is one the app's own git feed can confirm.
 *
 * @covers tugdeck/src/components/tugways/tug-commit-atom.tsx
 * @covers tugdeck/src/components/tugways/tug-commit-atom.css
 * @covers tugdeck/src/components/tugways/commit-sha-text.tsx
 * @covers tugdeck/src/components/tugways/commit-sha-text.css
 * @covers tugdeck/src/components/tugways/commit-tip-portals.tsx
 * @covers tugdeck/src/components/tugways/commit-presentation.tsx
 * @covers tugdeck/src/components/tugways/cards/session-commit-receipt-block.tsx
 * @covers tugdeck/src/components/tugways/tug-history-list.tsx
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/components/tugways/cards/tug-atom-markdown-body.tsx
 * @covers tugdeck/src/components/tugways/cards/tug-atom-text-body.tsx
 * @covers tugdeck/src/lib/synthesize-user-message.ts
 * @covers tugdeck/src/components/tugways/tug-session-identity.css
 */

import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-S";

/** The worktree root — the real repo tugcast serves as its bootstrap tree. */
const REPO = resolve(import.meta.dir, "..", "..");

const HEAD_SHA = execSync("git rev-parse HEAD", { cwd: REPO }).toString().trim();
/** The short form prose uses — deliberately NOT the label's eight. */
const WRITTEN_SHA = HEAD_SHA.slice(0, 9);
/** What the reader must end up seeing, whatever the prose spelled. */
const LABEL = `commit:${HEAD_SHA.slice(0, 8)}`;

/** The one selector every surface's copy of the mark answers to. */
const PILL = '[data-slot="tug-commit-atom"]';

const CARD = '[data-card-id="S"]';
const TRANSCRIPT = `${CARD} .session-card-transcript-code-body`;
const MENTION_PILL = `${TRANSCRIPT} [data-tug-annotation="commit-sha"] ${PILL}`;
const RECEIPT_PILL = `${CARD} .commit-receipt-header ${PILL}`;
const HISTORY_ROW = `[data-slot="session-history-view"] [data-testid="session-history-commit"]`;
const HISTORY_PILL = `${HISTORY_ROW} ${PILL}`;
const USER_BODY = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const SENT_PILL = `${USER_BODY} ${PILL}`;
const OVERVIEW_CARD = '[data-testid="overview-card"]';
const OVERVIEW_PILL = `${OVERVIEW_CARD} .overview-post-refs ${PILL}`;

const SENTENCE = `Step 9 landed as \`${WRITTEN_SHA}\`.`;

/** U+FFFC — the object-replacement char an atom occupies in the substrate. */
const FFFC = "￼";

/**
 * A `/commit` receipt's output — the server-formatted S02 summary the
 * transcript's bespoke renderer parses. The sha is this repo's HEAD, so the
 * header's pill stands on a commit the git feed can confirm.
 */
const COMMIT_SUMMARY =
  `committed ${HEAD_SHA} · 1 file(s) · +3 −1\n` +
  `files: [{"path":"tugdeck/src/lib/commit-format.ts","status":"modified","added":3,"removed":1}]\n` +
  "Land the commit atom";

function deckShape() {
  return {
    cards: [{ id: "S", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "pS",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 700 },
        cardIds: ["S"],
        activeCardId: "S",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pS",
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

/**
 * Seed the deck, bind the card to this repo, and get past the restore veil —
 * a bound card stands behind it until a replay bracket closes, and one
 * committed turn is the cheapest way to raise it.
 */
async function openBoundCard(app: App): Promise<void> {
  const ingest = (decoded: unknown) =>
    app.driveSession("S", { op: "ingestFrame", feedId: CODE_OUTPUT_FEED, decoded });
  await app.waitForCondition<boolean>(`typeof window.__tug !== "undefined"`, {
    timeoutMs: 20_000,
  });
  await app.seedDeckState({ state: deckShape(), focusCardId: "S" });
  await app.waitForCondition<boolean>(
    `window.__tug.assertHostRootRegistered("S")`,
    { timeoutMs: 20_000 },
  );
  // The binding is what gives the annotator a commit root: this repository,
  // where the sha resolves.
  await app.bindSession("S", {
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

/** Put the sentence carrying the sha into the live transcript. */
async function writeMention(app: App): Promise<void> {
  await app.driveSession("S", { op: "send", text: "how did step 9 go" });
  await app.driveSession("S", {
    op: "ingestFrame",
    feedId: CODE_OUTPUT_FEED,
    decoded: asstText("m1", SENTENCE),
  });
  // The prose paints first; the label is a round trip to the git feed, so it
  // is waited for rather than read.
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(MENTION_PILL)}) !== null`,
    { timeoutMs: 20_000 },
  );
}

/** Append the settled `/commit` exchange whose output is the S02 summary. */
async function writeReceipt(app: App): Promise<void> {
  await app.driveSession("S", {
    op: "shellExchange",
    exchangeId: "at0512-commit",
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

/**
 * Submit a prompt whose one atom IS a commit, through the production send —
 * the same substrate the composer posts: a `U+FFFC` where the mark stands and
 * the atom that stands there. The row paints the instant the send posts.
 */
async function writeSentAtom(app: App): Promise<void> {
  await app.driveSession("S", {
    op: "send",
    text: `look at ${FFFC} again`,
    atoms: [{ kind: "atom", type: "commit", label: LABEL, value: HEAD_SHA }],
  });
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SENT_PILL)}) !== null`,
    { timeoutMs: 20_000 },
  );
}

/** The three attributes a transcript selection reads a chip through. */
const SENT_ATOM_JS = `JSON.stringify((function(){
  var pill = document.querySelector(${JSON.stringify(SENT_PILL)});
  if (pill === null) return null;
  return {
    type: pill.getAttribute("data-atom-type"),
    label: pill.getAttribute("data-atom-label"),
    value: pill.getAttribute("data-atom-value"),
  };
})())`;

/**
 * What one mount of the mark says and what face it came out in — read beside
 * the face its own host was already setting, because "inherits" is the claim
 * and a family named in this file would only be a second copy of it.
 */
function mountJs(selector: string): string {
  return `JSON.stringify((function(){
    var pill = document.querySelector(${JSON.stringify(selector)});
    if (pill === null) return { found: false };
    var hash = pill.querySelector(".tug-commit-atom-hash");
    var host = pill.parentElement;
    return {
      found: true,
      label: (pill.textContent || "").trim(),
      face: hash === null ? "" : getComputedStyle(hash).fontFamily,
      hostFace: host === null ? "" : getComputedStyle(host).fontFamily,
      node: pill.querySelector(".tug-commit-atom-node") !== null,
      tier: pill.getAttribute("data-tier"),
    };
  })())`;
}

interface Mount {
  found: boolean;
  label?: string;
  face?: string;
  hostFace?: string;
  node?: boolean;
  tier?: string | null;
}

/**
 * The sentence's baseline and the label's, read with zero-height
 * `inline-block` probes: such a box seats its bottom margin edge on the
 * baseline of the inline context holding it, which is the one measurement the
 * DOM will give up. The word probe goes in the paragraph beside the run before
 * the pill; the label probe goes inside the hash's own span, whose inline
 * context is the label. Both are removed before the read returns.
 */
const BASELINES_JS = `JSON.stringify((function(){
  var pill = document.querySelector(${JSON.stringify(MENTION_PILL)});
  if (pill === null) return { found: false, why: "no pill" };
  var hash = pill.querySelector(".tug-commit-atom-hash");
  if (hash === null) return { found: false, why: "no hash" };
  var para = pill.closest("p") || pill.parentElement;
  if (para === null) return { found: false, why: "no paragraph" };

  function probeIn(parent, before) {
    var s = document.createElement("span");
    s.style.cssText =
      "display:inline-block;width:0;height:0;vertical-align:baseline;padding:0;margin:0;border:0;";
    parent.insertBefore(s, before || null);
    var y = s.getBoundingClientRect().bottom;
    s.remove();
    return y;
  }

  // The last non-blank text node before the pill — the neighbouring word,
  // whichever run the markdown happened to split the sentence into.
  var walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT, null);
  var prev = null;
  var n = walker.nextNode();
  while (n !== null) {
    var precedes =
      (pill.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
    if (precedes && (n.textContent || "").trim() !== "") prev = n;
    n = walker.nextNode();
  }
  if (prev === null) return { found: false, why: "no preceding word" };

  var word = probeIn(prev.parentNode, prev.nextSibling);
  var label = probeIn(hash, hash.firstChild);
  var pillBox = pill.getBoundingClientRect();
  return {
    found: true,
    word: word,
    label: label,
    delta: Math.abs(word - label),
    pillHeight: Math.round(pillBox.height),
    labelFontSize: getComputedStyle(hash).fontSize,
  };
})())`;

interface Baselines {
  found: boolean;
  why?: string;
  word?: number;
  label?: number;
  delta?: number;
  pillHeight?: number;
  labelFontSize?: string;
}

describe.skipIf(!SHOULD_RUN)("AT0512: the commit atom across its surfaces", () => {
  test(
    "all five surfaces draw the pill, and each takes the face its host was setting",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath, { sourceTreePath: REPO });
        const app = await launchTugApp({
          testName: "at0512-commit-atom-surfaces",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        const read = async (selector: string): Promise<Mount> =>
          JSON.parse(await app.evalJS<string>(mountJs(selector))) as Mount;

        try {
          await openBoundCard(app);

          // ---- 1. A sha in transcript prose ------------------------------
          await writeMention(app);
          const mention = await read(MENTION_PILL);
          note("at0512 transcript mention", JSON.stringify(mention));
          expect(mention.label).toBe(LABEL);

          // ---- 2. A `/commit` receipt's header ---------------------------
          await writeReceipt(app);
          const receipt = await read(RECEIPT_PILL);
          note("at0512 commit receipt", JSON.stringify(receipt));
          expect(receipt.label).toBe(LABEL);

          // ---- 3. A sent user row ----------------------------------------
          // The prompt the user submitted, replayed by the transcript's own
          // body renderer rather than by the composer's baker. The mark must
          // not change kind on the way through.
          await writeSentAtom(app);
          const sent = await read(SENT_PILL);
          note("at0512 sent user row", JSON.stringify(sent));
          expect(sent.label).toBe(LABEL);
          const sentAtom = JSON.parse(
            await app.evalJS<string>(SENT_ATOM_JS),
          ) as { type: string; label: string; value: string } | null;
          note("at0512 sent atom attrs", JSON.stringify(sentAtom));
          // Without these a copy across the row loses the atom and pastes the
          // label as characters — the pill would be a picture of one.
          expect(sentAtom).toEqual({
            type: "commit",
            label: LABEL,
            value: HEAD_SHA,
          });

          // ---- 4. A History shade row ------------------------------------
          // Before the Overview: raising the rail moves focus off this card,
          // and `toggle-history-view` acts on whichever card holds it.
          await app.dispatchControlAction("toggle-history-view");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(HISTORY_PILL)}) !== null`,
            { timeoutMs: 20_000 },
          );
          const history = await read(HISTORY_PILL);
          note("at0512 history row", JSON.stringify(history));
          // The top row is this repo's HEAD, so it wears the same label.
          expect(history.label).toBe(LABEL);

          // ---- 5. An Overview post's trailing ref ------------------------
          // A post whose prose never names the sha, so the ref survives
          // `unmentionedRefs` and rides the trailing strip as a placed atom.
          await app.nativeKey("o", ["cmd", "ctrl"]);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OVERVIEW_CARD)}) !== null`,
            { timeoutMs: 15_000 },
          );
          const post = {
            id: 9512,
            at_ms: 1_754_600_000_000,
            author: "observer",
            body: "Landed the commit atom.",
            refs: [{ kind: "commit", target: HEAD_SHA }],
            project_dir: REPO,
          };
          expect(
            await app.evalJS<boolean>(
              `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(post))})`,
            ),
          ).toBe(true);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OVERVIEW_PILL)}) !== null`,
            { timeoutMs: 15_000 },
          );
          const overview = await read(OVERVIEW_PILL);
          note("at0512 overview ref", JSON.stringify(overview));
          expect(overview.label).toBe(LABEL);

          const mounts = { mention, receipt, sent, overview, history };
          for (const [where, m] of Object.entries(mounts)) {
            // The mark itself: the borrowed enclosure at the chip tier, with
            // the commit's own node inside it.
            expect(m.found, `${where} draws the pill`).toBe(true);
            expect(m.tier, `${where}'s pill wears the chip tier`).toBe("chip");
            expect(m.node, `${where}'s pill carries the node`).toBe(true);
            // The rule, stated as itself: the hash resolves to the family its
            // own host was already setting, because the mount authors none.
            expect(m.face, `${where}'s hash takes its host's face`).toBe(
              m.hostFace as string,
            );
          }

          // And the check is not vacuous: the four surfaces really do split on
          // face, which is the whole reason the pin was reversed here.
          const faces = Object.values(mounts).map((m) => m.face ?? "");
          expect(
            faces.some((f) => /mono/i.test(f)),
            "a mono surface renders the pill in mono",
          ).toBe(true);
          expect(
            faces.some((f) => !/mono/i.test(f)),
            "a proportional surface renders the pill proportionally",
          ).toBe(true);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0512] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the pill's label sits on the sentence's baseline",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath, { sourceTreePath: REPO });
        const app = await launchTugApp({
          testName: "at0512-commit-atom-baseline",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        const readBaselines = async (): Promise<Baselines> =>
          JSON.parse(await app.evalJS<string>(BASELINES_JS)) as Baselines;

        try {
          await app.waitForCondition<boolean>(
            `typeof window.__tug !== "undefined"`,
            { timeoutMs: 20_000 },
          );

          await openBoundCard(app);
          await writeMention(app);

          const seated = await readBaselines();
          note("at0512 baseline", JSON.stringify(seated));
          expect(seated.found, seated.why ?? "").toBe(true);
          expect(
            seated.delta as number,
            "the label's baseline is the sentence's",
          ).toBeLessThanOrEqual(1);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0512] log tail:\n${tail}\n`);
          throw err;
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
