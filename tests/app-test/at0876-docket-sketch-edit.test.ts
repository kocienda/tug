/**
 * at0876-docket-sketch-edit.test.ts — a sketch edited on the Docket card is
 * kept as the user's version, and the brief written from the older one goes
 * stale.
 *
 * ## What this gates
 *
 * The unit tests pin the editor's parts and the store pins the version
 * rules. What only the app can show is the round trip: the card's editor
 * reads the sketch through the real server, Save writes a version the CLI
 * reads back as the user's, and the feed's watch redraws the thread with the
 * brief marked stale.
 *
 *   A. **Edit Sketch opens the editor on the latest version.** A thread with
 *      an idea, a kept sketch (v1, the model's) and a brief written from v1
 *      offers Edit Sketch; pressing it shows the editor holding v1's text.
 *   B. **Save keeps the user's version.** The text changed and Save pressed,
 *      the card goes back to its threads, `tugtool sketch show --json` reads
 *      v2 written by the user, the sketch cell says it is the user's, and the
 *      brief cell carries `data-stale="true"`.
 *
 * @covers tugdeck/src/components/docket/docket-sketch-editor.tsx
 * @covers tugdeck/src/components/docket/docket-card.tsx
 * @covers tugdeck/src/components/docket/docket-card.css
 * @covers tugdeck/src/lib/docket-authoring.ts
 * @covers tugdeck/src/lib/docket-verbs.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  EDITOR,
  EDITOR_SAVE,
  EDITOR_TEXT,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  captureIdea,
  cli,
  focusDocket,
  ideaId,
  keepSketch,
  launchAuthoring,
  makeAuthoringScratch,
  newDocket,
  pressGesture,
  recordBrief,
  rmAuthoringScratch,
  rowFor,
  type AuthoringScratch,
} from "./docket-authoring-fixture";

const SID = "aa11bb22-0000-4000-8000-00000000a876";
const IDEA = "one door for every arc";
const WANT = "Want one door that opens every arc.";
const EDITED = "Want one door, and a way back through it.";

let s: AuthoringScratch | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  s = makeAuthoringScratch("at0876", SID);
});

afterAll(() => {
  rmAuthoringScratch(s);
});

interface Shown {
  data: { version: number; text: string; versions: Array<{ n: number; author: string }> };
}

describe.skipIf(!SHOULD_RUN)("at0876 — editing a sketch on the Docket card", () => {
  test(
    "Edit Sketch opens the latest version, and Save keeps it as the user's and stales the brief",
    async () => {
      const { app, close } = await launchAuthoring(s!, "at0876-docket-sketch-edit");
      try {
        await newDocket(app, "Doors");
        await captureIdea(app, IDEA);
        const sketch = keepSketch(s!, ideaId(s!, IDEA), WANT, "1–2");
        recordBrief(s!, sketch, "one-door", 1);
        await app.body("D").waitForCondition<boolean>(
          `(function(){ var r = ${rowFor(IDEA)}; return r !== null && r.querySelector('[data-slot="docket-brief-cell"]') !== null; })()`,
          { timeoutMs: 15_000 },
        );
        expect(
          await app.body("D").evalJS<string | null>(
            `${rowFor(IDEA)}.querySelector('[data-slot="docket-brief-cell"]').getAttribute("data-stale")`,
          ),
          "a brief written from the latest version is not stale",
        ).toBeNull();

        // ---- A. Edit Sketch opens the editor on the latest version. --------
        await pressGesture(app, IDEA, "edit-sketch");
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(EDITOR_TEXT)}) !== null
           && document.querySelector(${JSON.stringify(EDITOR_TEXT)}).value.indexOf(${JSON.stringify(WANT)}) !== -1`,
          { timeoutMs: 10_000 },
        );
        expect(
          await app.body("D").evalJS<string>(
            `(document.querySelector('[data-slot="docket-sketch-version"]').textContent || "").trim()`,
          ),
        ).toBe("v1 · written by the model");

        // ---- B. Save keeps the user's version. -----------------------------
        await focusDocket(app);
        await app.body("D").nativeClickAtElement(EDITOR_TEXT);
        await app.nativeKey("a", ["cmd"]);
        await app.nativeType(EDITED);
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(EDITOR_TEXT)}).value === ${JSON.stringify(EDITED)}
           && !document.querySelector(${JSON.stringify(EDITOR_SAVE)}).disabled`,
          { timeoutMs: 5_000 },
        );
        await app.body("D").nativeClickAtElement(EDITOR_SAVE);
        await app.body("D").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(EDITOR)}) === null && ${rowFor(IDEA)} !== null`,
          { timeoutMs: 10_000 },
        );
        const shown = JSON.parse(cli(s!, ["sketch", "show", sketch, "--json"])) as Shown;
        expect(shown.data.version).toBe(2);
        expect(shown.data.text.trim()).toBe(EDITED);
        expect(shown.data.versions.map((v) => v.author)).toEqual(["model", "user"]);

        await app.body("D").waitForCondition<boolean>(
          `(function(){
            var r = ${rowFor(IDEA)};
            if (r === null) return false;
            var brief = r.querySelector('[data-slot="docket-brief-cell"]');
            var mine = r.querySelector('[data-slot="docket-sketch-cell"][data-author="user"]');
            return brief !== null && brief.getAttribute("data-stale") === "true" && mine !== null;
          })()`,
          { timeoutMs: 15_000 },
        );
      } finally {
        await close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
