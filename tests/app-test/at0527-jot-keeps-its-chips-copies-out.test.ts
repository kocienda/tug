/**
 * at0527-jot-keeps-its-chips-copies-out.test.ts — a chip taken out of a Jot
 * arrives in the prompt as a chip.
 *
 * One piece of the at0527 split; the decks, selectors and gestures are
 * `jot-keeps-its-chips-fixture.ts`.
 *
 * This is [B11](d): a jot seeded with a file atom is copied with the row's
 * Copy, and the paste into the prompt entry produces a chip rather than the
 * words the path would have flattened into — while the `text/plain` flavor
 * beside it IS those words, in the one [B03] spelling, because that is the
 * flavor that leaves Tug. Every assertion reads the atom's
 * `data-atom-value` off a live chip or off the sidecar, and the placeholder
 * character never appears anywhere a reader would see it as a character.
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
import { kindBody } from "./_harness/card-reach";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  COPY_SENTINEL,
  FILE_BODY,
  FILE_NAME,
  JOT_CHIP,
  OBJ,
  PROMPT_INPUT,
  SHOULD_RUN,
  SID,
  TEST_TIMEOUT_MS,
  chipsJS,
  flatTextJS,
  openFirstJotEditor,
  pasteInto,
  readSidecar,
  sessionDeck,
} from "./jot-keeps-its-chips-fixture";

describe.skipIf(!SHOULD_RUN)("at0527 — a Jot keeps its chips, and hands them on", () => {
  test(
    "a chip copied out of a jot arrives in the prompt as a chip, not as words",
    async () => {
      const tugbankPath = mkTempTugbank();
      const projectDir = mkdtempSync(join(tmpdir(), "at0527d-project-"));
      const jotsDir = mkdtempSync(join(tmpdir(), "at0527d-jots-"));
      const realPath = join(projectDir, FILE_NAME);
      const jotsPath = join(jotsDir, "jots.json");
      writeFileSync(realPath, FILE_BODY, "utf8");
      // Seeded with the substrate a Phase-A paste would have left behind, so
      // this half stands on the record rather than on the other test's run.
      writeFileSync(
        jotsPath,
        `${JSON.stringify(
          {
            version: 1,
            jots: [
              {
                id: "s1",
                text: `see ${OBJ} for the table`,
                atoms: [
                  { position: 4, type: "file", label: FILE_NAME, value: realPath },
                ],
              },
            ],
          },
          null,
          2,
        )}\n`,
      );

      /** The [B03] spelling of a file — what leaves Tug as `text/plain`. */
      const PLAIN = `see [${FILE_NAME}](<${realPath}>) for the table`;

      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0527-jot-copies-out-as-a-chip",
          env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
          persistInTestMode: true,
        });
        try {
          const jots = kindBody(app, "jots");
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

          // The seeded jot draws its chip before anything is copied — the copy
          // reads the record, and this is that record having survived the read.
          await openFirstJotEditor(app, jots);
          await jots.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(JOT_CHIP)}) !== null`,
            { timeoutMs: 10_000 },
          );

          // ---- The row's own Copy — a click, no chord. ------------------
          // The resumed session raises the app-modal restore gate ("Restoring
          // 1 session") while its replay reveals, and a click under it lands
          // on the gate's overlay rather than the row's Copy — which is the
          // gate doing its job. Reach for the button once the gate has let go.
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector('[data-slot="tug-restore-gate"]') === null`,
            { timeoutMs: 15_000 },
          );
          Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(COPY_SENTINEL) });
          await jots.nativeClickAtElement(
            `.jot-editor-header [aria-label="Copy jot"]`,
          );

          // The plain flavor is the words, in the one spelling — the flatten
          // happens HERE, at the exit, and only here.
          const deadline = Date.now() + 5_000;
          let plain = COPY_SENTINEL;
          while (plain === COPY_SENTINEL && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
            plain = Bun.spawnSync(["pbpaste"]).stdout.toString();
          }
          note("at0527d pasteboard text", JSON.stringify(plain));
          expect(plain.trim()).toBe(PLAIN);
          // Whatever a foreign app gets, it is not a naked placeholder.
          expect(plain).not.toContain(OBJ);

          // And the sidecar rode along, carrying the object rather than the
          // words — the half that makes the paste below a chip.
          const sidecar = await readSidecar(app);
          note("at0527d sidecar", JSON.stringify(sidecar));
          expect(sidecar).toEqual({
            text: `see ${OBJ} for the table`,
            atoms: [{ type: "file", label: FILE_NAME, value: realPath }],
          });

          // ---- Paste into the prompt entry. ----------------------------
          await pasteInto(app.body("A"), PROMPT_INPUT);
          await app.body("A").waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(PROMPT_INPUT)} + ' img:not(.cm-widgetBuffer)').length === 1`,
            { timeoutMs: 10_000 },
          );
          const chips = JSON.parse(
            await app.body("A").evalJS<string>(chipsJS(PROMPT_INPUT)),
          ) as string[];
          note("at0527d prompt chips", chips.join(" / "));
          expect(chips).toEqual([`file:${realPath}`]);

          // A chip, not the words it would have flattened into — the prose
          // around it survives, the path does not appear as characters, and no
          // placeholder is left standing on its own.
          const flat = await app.body("A").evalJS<string>(flatTextJS(PROMPT_INPUT));
          note("at0527d prompt text", JSON.stringify(flat));
          expect(flat).toContain("see ");
          expect(flat).toContain(" for the table");
          expect(flat).not.toContain(FILE_NAME);
          expect(flat).not.toContain("](<");
        } catch (err) {
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0527d] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
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
