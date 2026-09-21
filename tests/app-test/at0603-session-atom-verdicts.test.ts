/**
 * at0603-session-atom-verdicts.test.ts — a session reference says which of
 * three things it is, and changes its mind when the machine does.
 *
 * ## What this gates
 *
 * The verdict a session reference wears is the end of a chain no unit test
 * holds more than one link of: a chip asks the server, the server reads two
 * ledgers and a directory tree, a watch on the machine-wide index pushes when
 * any of it changes, and the answer lands as ink in two different renderers —
 * a Canvas bake in the composer that can neither subscribe nor cascade, and a
 * live component in the transcript that does both.
 *
 *   A. **The composer bakes it dashed.** A pasted atom naming a session
 *      nothing on this machine holds goes to the `missing` face before
 *      anything is sent. The ask, the server's `unknown`, and the widget
 *      regeneration that repaints a baked bitmap are all real here; there is
 *      no in-process canvas to run any of it in.
 *
 *   B. **The transcript says the same thing in its own register.** The row's
 *      pill is `data-missing="true"` and its tooltip is the sentence — not a
 *      chip that merely failed to resolve, which is the reading a reference
 *      to a session on ANOTHER machine has to be distinguishable from.
 *
 *   C. **And it heals, with no reload.** Write one row into the machine-wide
 *      index the way another instance would, and the pill becomes
 *      `data-elsewhere="true"` on its own: the watch sees the file move, the
 *      deck drops its unsettled answers, the surfaces re-ask, and the server
 *      answers out of the index this time. That is the whole of [P08], and
 *      every link of it is a different process.
 *
 *   D. **A healed pill is not a link.** A session another instance holds has
 *      nowhere on this deck to send a click, so the pill offers none —
 *      `data-interactive` is absent. Dashing it would have said the opposite
 *      of the truth; making it clickable says a different wrong thing.
 *
 * The fixture is written and removed by this file; nothing it touches
 * outlives the run, and both ledgers are the harness's per-instance ones.
 *
 * @covers tugdeck/src/lib/session-citation-store.ts
 * @covers tugdeck/src/lib/session-chip-verdict.ts
 * @covers tugdeck/src/components/tugways/tug-session-identity.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor/atom-decoration.ts
 * @covers tugdeck/src/lib/tug-atom-img.ts
 * @covers tugrust/crates/tugcast/src/feeds/session_index_watch.rs
 * @covers tugrust/crates/tugcore/src/session_finder.rs
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT

/**
 * This checkout's own `tugtool`, not the one on `PATH` — that one is the
 * installed app's Release binary, which knows nothing of a verb added on this
 * branch. `just app-test-build` builds it.
 */
const TUGTOOL = resolve(import.meta.dir, "../../tugrust/target/debug/tugtool");

const SESSION_A = "cc33dd44-0000-4000-8000-00000000c603";
const PROJECT_DIR = "/Users/tester/src/tugtool";

/** A uuid nothing on this machine has ever minted — until (C). */
const GHOST_ID = "dd44ee55-0000-4000-8000-00000000d603";
const GHOST_DIR = "/Users/tester/src/ghosttown";
const GHOST_TAG = "pale-ember";
const GHOST_TITLE = "the ember branch";
const REFERENCE = `ghosttown/${GHOST_TAG}`;

const CARD = '[data-card-id="A"]';
const COMPOSER = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const CHIP = `${COMPOSER} img[data-atom-type="session"]`;
const USER_BODY = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const PILL = `${USER_BODY} [data-slot="tug-session-identity"]`;

/** The atom, exactly as a copy of that session would have written it. */
const SESSION_ATOM = {
  kind: "atom",
  type: "session",
  label: REFERENCE,
  value: REFERENCE,
  session: { id: GHOST_ID, projectDir: GHOST_DIR },
};

/**
 * The sidecar a Tug copy puts on the clipboard for that one atom — the
 * `{position, segment}` entry shape `serializeClipboard` writes, at the
 * `U+FFFC` the text carries.
 */
const SIDECAR = JSON.stringify({
  version: 1,
  text: "￼",
  atoms: [{ position: 0, segment: SESSION_ATOM }],
  origins: [GHOST_DIR],
});

const encodeProjectDir = (absDir: string): string =>
  absDir.replace(/[^A-Za-z0-9-]/g, "-");

const FIXTURE_DIR = join(
  homedir(),
  ".claude",
  "projects",
  encodeProjectDir(GHOST_DIR),
);
const FIXTURE_PATH = join(FIXTURE_DIR, `${GHOST_ID}.jsonl`);

function writeFixture(): void {
  const base = {
    isSidechain: false,
    userType: "external",
    cwd: GHOST_DIR,
    sessionId: GHOST_ID,
    version: "2.1.105",
    gitBranch: "main",
  };
  const lines = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: "00000000-0000-4000-8000-0000000006031",
      timestamp: "2026-09-20T09:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "start the ember branch" }] },
    },
  ];
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(FIXTURE_PATH, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 20, y: 20 },
        size: { width: 820, height: 560 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)("at0603 — the three verdicts, in the real app", () => {
  test(
    "an unfindable reference bakes dashed, reads missing, and heals to elsewhere when the index learns of it",
    async () => {
      const app = await launchTugApp({ testName: "at0603-session-atom-verdicts" });
      const ingest = (decoded: unknown) =>
        app.driveSession("A", { op: "ingestFrame", feedId: CODE_OUTPUT_FEED, decoded });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", {
          tugSessionId: SESSION_A,
          projectDir: PROJECT_DIR,
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(COMPOSER)}) !== null`,
          { timeoutMs: 20_000 },
        );
        await app.focusElement(COMPOSER);

        // ---- A. The composer bakes it dashed. ------------------------------
        //
        // Pasted through the in-event sidecar branch, which is the same insert
        // a Tug copy makes and needs no key window. Nothing about the paste
        // says anything about findability; the chip asks for itself.
        await app.evalJS<null>(`(function(){
          var cm = document.querySelector(${JSON.stringify(COMPOSER)});
          var dt = new DataTransfer();
          dt.setData("text/plain", ${JSON.stringify(REFERENCE)});
          dt.setData("application/x-tug-atoms", ${JSON.stringify(SIDECAR)});
          cm.dispatchEvent(new ClipboardEvent("paste", {
            bubbles: true, cancelable: true, clipboardData: dt,
          }));
          return null;
        })()`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP)}) !== null`,
          { timeoutMs: 10_000 },
        );
        // The ask goes to the server and the answer comes back a round trip
        // later; the bake that follows is the widget regeneration, which is
        // the only door a baked bitmap has.
        await app.waitForCondition<boolean>(
          `(function(){
            var img = document.querySelector(${JSON.stringify(CHIP)});
            return img !== null && img.dataset.chipVariant === "missing";
          })()`,
          { timeoutMs: 20_000 },
        );
        const chip = await app.evalJS<{ variant: string; sessionId: string }>(
          `(function(){
            var img = document.querySelector(${JSON.stringify(CHIP)});
            return {
              variant: img.dataset.chipVariant || "",
              sessionId: img.dataset.atomSessionId || "",
            };
          })()`,
        );
        note("at0603 composer chip", JSON.stringify(chip));
        expect(chip.variant).toBe("missing");
        // Under the uuid, which is the key the pill asks under too — one
        // session, one answer.
        expect(chip.sessionId).toBe(GHOST_ID);

        // ---- B. The transcript says the same thing. ------------------------
        await ingest({ type: "replay_started", tug_session_id: SESSION_A });
        await ingest({
          type: "replay_complete",
          tug_session_id: SESSION_A,
          count: 0,
          firstLoadedTurnIndex: 0,
          totalTurns: 0,
          hasOlder: false,
        });
        await app.driveSession("A", {
          op: "send",
          text: "￼ is the one I mean",
          atoms: [SESSION_ATOM],
        });
        await app.waitForCondition<boolean>(
          `(function(){
            var p = document.querySelector(${JSON.stringify(PILL)});
            return p !== null && p.getAttribute("data-missing") === "true";
          })()`,
          { timeoutMs: 20_000 },
        );
        const missing = await app.evalJS<{
          missing: string;
          elsewhere: string;
          interactive: string;
        }>(
          `(function(){
            var p = document.querySelector(${JSON.stringify(PILL)});
            return {
              missing: p.getAttribute("data-missing") || "",
              elsewhere: p.getAttribute("data-elsewhere") || "",
              interactive: p.getAttribute("data-interactive") || "",
            };
          })()`,
        );
        note("at0603 pill before", JSON.stringify(missing));
        expect(missing.missing).toBe("true");
        expect(missing.elsewhere).toBe("");
        // Not a link either: there is nothing to open.
        expect(missing.interactive).toBe("");

        // The sentence itself is the app's own bubble rather than a native
        // `title`, so it is hovered for. It is the half that makes the dash
        // readable — a border alone says "something is wrong", and which
        // wrong thing is what the reader needs.
        await app.evalJS<null>(
          `(function(){
            var p = document.querySelector(${JSON.stringify(PILL)});
            p.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
            p.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
            return null;
          })()`,
        );
        const TIP = '[data-slot="tug-tooltip"]';
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(TIP)})?.textContent || "")
             .indexOf("Not on this machine") !== -1`,
          { timeoutMs: 10_000 },
        );

        // ---- C. And it heals, with no reload. ------------------------------
        //
        // One index row, written the way another instance's tugcast writes
        // one. Nothing here touches the app: the watch on the index's
        // directory is what tells it, and the re-ask that follows is the
        // deck's own.
        writeFixture();
        const dataDir = join(
          homedir(),
          "Library",
          "Application Support",
          "Tug",
          "instances",
          app.instanceId,
        );
        const put = Bun.spawnSync(
          [
            TUGTOOL,
            "session",
            "index-put",
            "--uuid",
            GHOST_ID,
            "--callsign",
            GHOST_TAG,
            "--project-dir",
            GHOST_DIR,
            "--instance",
            "other-instance",
            "--title",
            GHOST_TITLE,
          ],
          {
            env: {
              ...process.env,
              TUG_SESSION_INDEX_DB: join(dataDir, "session_index.db"),
            },
          },
        );
        note(
          "at0603 index-put",
          `exit ${put.exitCode} ${put.stdout.toString().slice(0, 200)}${put.stderr.toString().slice(0, 200)}`,
        );
        expect(put.exitCode).toBe(0);

        // The heal is waited for on the attribute, not slept for: the push,
        // the re-ask and the repaint are three hops and none of them has a
        // duration worth guessing at.
        await app.waitForCondition<boolean>(
          `(function(){
            var p = document.querySelector(${JSON.stringify(PILL)});
            return p !== null && p.getAttribute("data-elsewhere") === "true";
          })()`,
          { timeoutMs: 30_000 },
        );
        const healed = await app.evalJS<{
          missing: string;
          elsewhere: string;
          interactive: string;
          text: string;
        }>(
          `(function(){
            var p = document.querySelector(${JSON.stringify(PILL)});
            return {
              missing: p.getAttribute("data-missing") || "",
              elsewhere: p.getAttribute("data-elsewhere") || "",
              interactive: p.getAttribute("data-interactive") || "",
              text: (p.textContent || "").replace(/\\s+/g, " ").trim(),
            };
          })()`,
        );
        note("at0603 pill healed", JSON.stringify(healed));
        expect(healed.elsewhere).toBe("true");
        // The dash is GONE: the session exists, and a border is what says so.
        expect(healed.missing).toBe("");
        // And the run it shows is the REFERENCE's own spelling, not the
        // session's title. The pill's run is what `sessionIdentityLine`
        // composes and what `sessionCitation` spends, so a title standing in
        // the callsign's place renders a pair that is not one and writes a
        // citation no reader of one can resolve. The title reaches the reader
        // through the tooltip instead.
        expect(healed.text).toContain(GHOST_TAG);
        expect(healed.text).not.toContain(GHOST_TITLE);

        // ---- D. A healed pill is not a link. -------------------------------
        //
        // There is nowhere on this deck to send a click for a session another
        // instance holds; a pill that offered one would be a dead affordance
        // over a real reference.
        expect(healed.interactive).toBe("");
      } finally {
        await app.close();
        rmSync(FIXTURE_DIR, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
