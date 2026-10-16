/**
 * at0527-jot-keeps-its-chips-survives.test.ts — a chip pasted into a Jot is
 * still a chip after the editor, the card and the app have all forgotten it.
 *
 * One piece of the at0527 split; the decks, selectors and gestures are
 * `jot-keeps-its-chips-fixture.ts`.
 *
 * The Jots card is the one editing surface in Tug that outlives the app: a
 * jot is written to `jots.json` and read back tomorrow, so it is the surface
 * where losing the atoms is permanent. The report came through it: a file
 * chip pasted into a jot drew correctly, and came back after a reopen as a
 * bare `U+FFFC`. This is [B11](b): copy a verified file path out of a
 * transcript as an atom, paste it into an open jot, and follow it through
 * three levels of forgetting — the editor closes (the store), the card closes
 * and reopens (the mount), and the app quits and is relaunched against the
 * same isolated `jots.json` (the file). The chip has to be there at each
 * one, with the same value.
 *
 * The file is written and read through the Rust model in `tugcast/src/jots.rs`
 * as well as the TypeScript one: the two models have to agree about a field
 * or it is dropped on the next save with no sign. Runs against an isolated
 * `TUG_JOTS_PATH` so the user's machine-global `jots.json` is never touched.
 *
 * @covers tugdeck/src/components/jots/jots-card.tsx
 * @covers tugdeck/src/lib/jots-doc.ts
 * @covers tugdeck/src/lib/jots-store.ts
 * @covers tugdeck/src/components/tugways/tug-message-editor.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor/keymap.ts
 * @covers tugdeck/src/lib/atom-text.ts
 * @covers tugdeck/src/lib/atom-plain-text.ts
 * @covers tugrust/crates/tugcast/src/jots.rs
 * @family at0527-jot-keeps-its-chips
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  CODE_OUTPUT_FEED,
  COPY_SENTINEL,
  EDITOR,
  FILE_BODY,
  FILE_NAME,
  JOT_CHIP,
  JOT_CONTENT,
  OBJ,
  SHOULD_RUN,
  SID,
  TEST_TIMEOUT_MS,
  chipsJS,
  enterFirstJotEditor,
  flatTextJS,
  menuItemPointJS,
  openFirstJotEditor,
  openJotsCard,
  pasteInto,
  plainDeck,
  readJotsFile,
  readSidecar,
  revealJS,
  sessionDeck,
} from "./jot-keeps-its-chips-fixture";

describe.skipIf(!SHOULD_RUN)("at0527 — a Jot keeps its chips, and hands them on", () => {
  test(
    "a file chip pasted into a jot survives the store, the card and a relaunch",
    async () => {
      const tugbankPath = mkTempTugbank();
      const projectDir = mkdtempSync(join(tmpdir(), "at0527-project-"));
      const jotsDir = mkdtempSync(join(tmpdir(), "at0527-jots-"));
      const realPath = join(projectDir, FILE_NAME);
      const jotsPath = join(jotsDir, "jots.json");
      writeFileSync(realPath, FILE_BODY, "utf8");
      writeFileSync(
        jotsPath,
        `${JSON.stringify({ version: 1, jots: [{ id: "s1", text: "" }] }, null, 2)}\n`,
      );

      let stampedPath = "";

      try {
        seedTugbankForLaunch(tugbankPath);

        // ── Phase A: copy an atom, paste it into a jot, close and reopen. ──
        {
          const app = await launchTugApp({
            testName: "at0527-jot-keeps-its-chips",
            env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
            persistInTestMode: true,
          });
          try {
            await app.seedDeckState({ state: sessionDeck(), focusCardId: "A" });
            await app.waitForCondition<boolean>(
              `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
              { timeoutMs: 30_000 },
            );
            await app.bindSession("A", {
              tugSessionId: SID,
              projectDir,
              sessionMode: "resume",
            });

            // A transcript citing a file that exists — the annotator only
            // offers an atom for a path the filesystem confirms.
            const ingest = (decoded: unknown) =>
              app.driveSession("A", {
                op: "ingestFrame",
                feedId: CODE_OUTPUT_FEED,
                decoded,
              });
            await ingest({ type: "replay_started", tug_session_id: SID });
            await ingest({
              type: "add_user_message",
              tug_session_id: SID,
              content: [{ type: "text", text: "where is the knob" }],
            });
            await ingest({
              type: "assistant_text",
              status: "complete",
              tug_session_id: SID,
              msg_id: "m1",
              text: `Tune it in \`${realPath}\`.`,
              is_partial: false,
              rev: 0,
              seq: 1,
            });
            await ingest({
              type: "turn_complete",
              seq: 0,
              tug_session_id: SID,
              msg_id: "m1",
              result: "success",
            });
            await ingest({
              type: "replay_complete",
              tug_session_id: SID,
              count: 1,
              firstLoadedTurnIndex: 0,
              totalTurns: 1,
              hasOlder: false,
            });

            const SPAN = `[data-card-id="A"] code[data-tug-annotation="file-path"]`;
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(SPAN)}) !== null`,
              { timeoutMs: 15_000 },
            );
            stampedPath =
              (await app.evalJS<string | null>(
                `(function(){
                  var el = document.querySelector(${JSON.stringify(SPAN)});
                  return el === null ? null : el.getAttribute('data-path');
                })()`,
              )) ?? "";
            expect(stampedPath.endsWith(`/${FILE_NAME}`)).toBe(true);

            // The Jots card is mounted BEFORE the copy on purpose. The system
            // pasteboard is machine-wide and the app-test corpus runs several
            // files at once, so every wall-clock second between this test's
            // write and its read is a second another test can overwrite it in.
            // Mounting the card first takes the card's own mount out of that
            // window, and the re-read below closes what is left of it.
            await openJotsCard(app);

            // ---- Copy as Atom: the object, not the characters. -----------
            Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(COPY_SENTINEL) });
            await app.evalJS<boolean>(revealJS(SPAN));
            await app.nativeRightClickAtElement(SPAN);
            await app.waitForCondition<boolean>(
              `document.querySelector('[data-item-action="copy-annotation-atom"]') !== null`,
              { timeoutMs: 5_000 },
            );
            const copyPoint = await app.evalJS<{ x: number; y: number } | null>(
              menuItemPointJS("copy-annotation-atom"),
            );
            expect(copyPoint).not.toBeNull();
            await app.nativeClick(copyPoint as { x: number; y: number });

            const sidecar = await readSidecar(app);
            note("at0527 sidecar", JSON.stringify(sidecar));
            expect(sidecar).toEqual({
              text: OBJ,
              atoms: [{ type: "file", label: FILE_NAME, value: stampedPath }],
            });

            // ---- Paste it into a jot, after some prose. ------------------
            await enterFirstJotEditor(app);
            await app.waitForCondition<boolean>(
              `document.activeElement !== null &&
               document.activeElement.closest(${JSON.stringify(EDITOR)}) !== null`,
              { timeoutMs: 5_000 },
            );
            // Words first, so the atom lands INSIDE prose rather than alone —
            // a position the substrate has to carry, not just a lone chip.
            await app.nativeType("see ");
            await app.waitForCondition<boolean>(
              `(${flatTextJS(JOT_CONTENT)}).indexOf("see ") !== -1`,
              { timeoutMs: 5_000 },
            );
            // Read the pasteboard again, in the instant before the paste. A
            // foreign sidecar here is contention on a shared machine resource
            // rather than a defect, and this is where it says so — the
            // alternative is a chip mismatch three assertions later that reads
            // like the feature broke.
            expect(await readSidecar(app)).toEqual({
              text: OBJ,
              atoms: [{ type: "file", label: FILE_NAME, value: stampedPath }],
            });
            await pasteInto(app, JOT_CONTENT);
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(JOT_CHIP)}) !== null`,
              { timeoutMs: 8_000 },
            );
            expect(
              JSON.parse(await app.evalJS<string>(chipsJS(JOT_CONTENT))) as string[],
            ).toEqual([`file:${stampedPath}`]);
            // The path never landed as characters — a chip, not a spelling.
            expect(await app.evalJS<string>(flatTextJS(JOT_CONTENT))).not.toContain(
              FILE_NAME,
            );

            // ---- Level one: the editor closes. --------------------------
            await app.nativeKey("Escape");
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(EDITOR)}) === null`,
              { timeoutMs: 5_000 },
            );

            // ---- The file agrees, which is the Rust model agreeing. -----
            const saved = await readJotsFile(jotsPath, 10_000);
            note("at0527 jots.json", JSON.stringify(saved));
            const jot = saved?.jots[0];
            expect(jot?.text).toBe(`see ${OBJ}`);
            expect(jot?.atoms).toEqual([
              { position: 4, type: "file", label: FILE_NAME, value: stampedPath },
            ]);
            // The placeholder is paired: one `U+FFFC`, one atom standing at it.
            expect((jot?.text.match(/￼/g) ?? []).length).toBe(
              (jot?.atoms ?? []).length,
            );

            // ---- Level two: the card closes and reopens. ----------------
            await app.dispatchControlAction("toggle-jots");
            await app.waitForCondition<boolean>(
              `document.querySelector('.jots-card') === null`,
              { timeoutMs: 5_000 },
            );
            await openFirstJotEditor(app);
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(JOT_CHIP)}) !== null`,
              { timeoutMs: 8_000 },
            );
            expect(
              JSON.parse(await app.evalJS<string>(chipsJS(JOT_CONTENT))) as string[],
            ).toEqual([`file:${stampedPath}`]);
          } catch (err) {
            const tail = app.tailLog(200);
            if (tail !== "") process.stderr.write(`\n[at0527 A] log tail:\n${tail}\n`);
            throw err;
          } finally {
            await app.close();
          }
        }

        // ── Phase B: level three — a new app, reading the same file. ──────
        {
          const app = await launchTugApp({
            testName: "at0527-jot-keeps-its-chips-relaunch",
            env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
            persistInTestMode: true,
          });
          try {
            await app.seedDeckState({ state: plainDeck(), focusCardId: "A" });
            await app.waitForCondition<boolean>(
              `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
              { timeoutMs: 30_000 },
            );
            await openFirstJotEditor(app);
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(JOT_CHIP)}) !== null`,
              { timeoutMs: 10_000 },
            );
            const chips = JSON.parse(
              await app.evalJS<string>(chipsJS(JOT_CONTENT)),
            ) as string[];
            note("at0527 chips after relaunch", chips.join(" / "));
            // The same chip, in a process that never saw the copy — read off
            // `jots.json` through the Rust model and the TypeScript one.
            expect(chips).toEqual([`file:${stampedPath}`]);
            expect(await app.evalJS<string>(flatTextJS(JOT_CONTENT))).not.toContain(
              FILE_NAME,
            );
          } catch (err) {
            const tail = app.tailLog(200);
            if (tail !== "") process.stderr.write(`\n[at0527 B] log tail:\n${tail}\n`);
            throw err;
          } finally {
            await app.close();
          }
        }
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(jotsDir, { recursive: true, force: true });
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
