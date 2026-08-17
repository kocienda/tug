/**
 * at0413-attachment-durability.test.ts — an image dropped on the Session
 * card's prompt entry survives a quit and relaunch as resubmittable bytes.
 *
 * ## The loss this pins
 *
 * A dropped image used to be two things: a chip in the draft and megabytes of
 * base64 in a per-card in-memory store. The store's snapshot rode the card
 * state bag, `capDurableCardState` deleted it before the tugbank write (the
 * base64 once stalled boot at ~18 MB), and the restore path spliced the
 * now-payload-less chips out of the draft. Quitting with an image in the
 * composer lost it — visibly, and with no way to get it back.
 *
 * Now the original file goes up to `POST /api/attachments` in the background
 * at drop time, and what the durable bag carries is a **reference**: an empty
 * `content`, the media type, and the path tugcast rested the original at. On
 * restore the chip stays, its path is read back through `/api/fs/blob`, and
 * the downsample pipeline reproduces both the submittable bytes and the
 * thumbnail.
 *
 * ## Shape
 *
 *   **Phase A** (first Tug.app process) — boot a Session card, bind a
 *   session, drop a real PNG `File` via a synthesized `drop` DragEvent (the
 *   production `processAttachmentFiles` pipeline, downsample and all), wait
 *   for the background upload to land a `path` on the store entry, then quit
 *   gracefully so the save chain flushes the bag to the temp tugbank.
 *
 *   **Disk assertion** (between processes) — the on-disk bag's
 *   `attachmentBytes` entry carries an absolute `path`, an EMPTY `content`,
 *   and no image data of any kind. This is the Success Criterion's "three
 *   short path strings" in its one-image form; a thumbnail here would re-grow
 *   the surface the original strip existed to prevent.
 *
 *   **Phase B** (second Tug.app process, same tugbank) — test-mode boot
 *   ignores tugbank reads, so the on-disk bag is re-fed through
 *   `seedDeckState`, exactly as at0024 does. The chip must survive the prune
 *   (it has a path, so it is not an orphan) and its bytes must arrive: the
 *   store entry ends up with a non-empty `content` again, which is precisely
 *   what `buildWirePayload` gates a real image block on.
 *
 * ## The second test
 *
 * Prompt history had the same shape of loss in a milder form: a recalled
 * prompt kept its baked thumbnail, so it *looked* right, but the thumbnail is
 * preview-only — `buildWirePayload` skips an entry with empty `content`, so
 * resubmitting a recalled prompt silently shipped a mention marker instead of
 * the image. History entries now carry the stored path alongside the
 * thumbnail, and the recall re-seed rehydrates through it.
 *
 * That test copies a real PNG from the tree into a temp dir, seeds one history
 * entry naming it — with no thumbnail, the trimmed-past-the-cutoff case, so
 * the path alone has to carry it — and launches: the session's history
 * hydrates, the re-seed fires, and the atom's bytes come back through the
 * real `/api/fs/blob` read and the real downsample. Non-empty `content` is
 * exactly the condition a real image block on the wire is gated on. The
 * upload half of the round trip is the first test's job.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/attachment-upload.ts
 * @covers tugdeck/src/lib/prompt-history-store.ts
 * @covers tugdeck/src/lib/atom-bytes-store.ts
 * @covers tugdeck/src/settings-api.ts
 * @covers tugdeck/src/components/tugways/tug-prompt-entry.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor/drop-extension.ts
 * @covers tugrust/crates/tugcast/src/attachments.rs
 */

import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchTugApp, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankRead,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 120_000;

/**
 * A real PNG already in the tree, copied per-test into a temp dir. Real bytes
 * a real decoder has to handle — no synthesized fixture.
 * `tests/app-test/at0409-….test.ts` sits two directories below the repo root.
 */
const REPO_PNG_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "resources",
  "AppIcon-1024b.png",
);

const EDITOR_HOST_SELECTOR =
  '[data-card-id="A"] [data-slot="tug-text-editor"]';

const ATOM_IMG_SELECTOR = `${EDITOR_HOST_SELECTOR} .cm-content img[data-atom-label]`;

const SESSION_DECK_STATE = {
  cards: [
    { id: "A", componentId: "session", title: "Session A", closable: true },
  ],
  panes: [
    {
      id: "p1",
      position: { x: 40, y: 40 },
      size: { width: 720, height: 540 },
      cardIds: ["A"],
      activeCardId: "A",
      title: "",
      acceptsFamilies: ["maker"],
    },
  ],
  activePaneId: "p1",
  hasFocus: true,
};

/** One `attachmentBytes` entry as it rests on tugbank disk. */
interface DiskEntry {
  content?: unknown;
  mediaType?: unknown;
  path?: unknown;
  thumbnailDataUrl?: unknown;
}

/** The card-state bag shape this test reads. */
interface RawBag {
  content?: { attachmentBytes?: Record<string, DiskEntry> };
}

/**
 * Synthesize a real PNG `File` in-page (canvas → blob) and dispatch a `drop`
 * DragEvent carrying it on the prompt editor host — the same event the OS
 * delivers for a Finder drag. `evalJS` cannot await, so completion is
 * signalled through a window flag and polled.
 */
async function dropPngOnEditor(app: App): Promise<void> {
  await app.evalJS<void>(
    `(function(){
      window.__at0409Dropped = false;
      var host = document.querySelector(${JSON.stringify(EDITOR_HOST_SELECTOR)});
      var canvas = document.createElement("canvas");
      canvas.width = 96; canvas.height = 72;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#2b3a55"; ctx.fillRect(0, 0, 96, 72);
      ctx.fillStyle = "#e8c07d"; ctx.fillRect(12, 12, 40, 40);
      canvas.toBlob(function(blob){
        var file = new File([blob], "durable.png", { type: "image/png" });
        var dt = new DataTransfer();
        dt.items.add(file);
        var r = host.getBoundingClientRect();
        var ev = new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          clientX: r.left + r.width / 2,
          clientY: r.top + 12,
        });
        Object.defineProperty(ev, "dataTransfer", { value: dt });
        host.dispatchEvent(ev);
        window.__at0409Dropped = true;
      }, "image/png");
    })()`,
  );
  await app.waitForCondition<boolean>(`window.__at0409Dropped === true`, {
    timeoutMs: 5_000,
  });
}

/** Boot a Session card with a bound session and a live editor. */
async function bootSessionCard(app: App): Promise<void> {
  await app.seedDeckState({ state: SESSION_DECK_STATE, focusCardId: "A" });
  await new Promise<void>((r) => setTimeout(r, 1500));
  await app.bindSession("A");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(`${EDITOR_HOST_SELECTOR} .cm-content`)}) !== null`,
    { timeoutMs: 10_000 },
  );
}

/**
 * The live in-memory bag's single `attachmentBytes` entry, or `null` when
 * there is not exactly one. Forces a save first so the bag reflects the
 * store's current contents (the same `saveState` at0024 leans on).
 */
const READ_LIVE_ENTRY = `(function(){
  window.tugdeck && window.tugdeck.saveState && window.tugdeck.saveState();
  var bag = window.__tug.getCardStateBag("A");
  var bytes = bag && bag.content ? bag.content.attachmentBytes : null;
  if (!bytes) return null;
  var ids = Object.keys(bytes);
  if (ids.length !== 1) return null;
  var e = bytes[ids[0]];
  return {
    hasPath: typeof e.path === "string" && e.path.length > 0,
    contentLength: typeof e.content === "string" ? e.content.length : -1,
  };
})()`;

describe.skipIf(!SHOULD_RUN)(
  "at0409: prompt-entry attachments survive a relaunch",
  () => {
    test(
      "a dropped image persists as a reference and rehydrates to real bytes",
      async () => {
        const tugbankPath = mkTempTugbank();
        try {
          seedTugbankForLaunch(tugbankPath);

          // ── Phase A: drop, upload, quit ──────────────────────────────
          {
            const appA = await launchTugApp({
              testName: "at0409-attachment-durability-A",
              env: { TUGBANK_PATH: tugbankPath },
              persistInTestMode: true,
            });
            await bootSessionCard(appA);
            await dropPngOnEditor(appA);

            // The chip lands synchronously with its downsampled bytes.
            await appA.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(ATOM_IMG_SELECTOR)}) !== null`,
              { timeoutMs: 10_000 },
            );

            // The upload runs in the background; the path arrives when it
            // arrives. This is the one wait the durability story needs.
            await appA.waitForCondition<boolean>(
              `(function(){ var e = ${READ_LIVE_ENTRY}; return e !== null && e.hasPath; })()`,
              { timeoutMs: 20_000 },
            );

            await appA.quitGracefully();
          }

          // ── Disk assertion: a reference, and nothing that is an image ──
          const onDisk = tugbankRead<RawBag>(
            tugbankPath,
            "dev.tugtool.deck.cardstate",
            "A",
          );
          expect(
            onDisk,
            "expected a bag for card A on tugbank disk",
          ).not.toBeNull();
          const bytes = (onDisk?.value as RawBag | undefined)?.content
            ?.attachmentBytes;
          expect(
            bytes,
            "expected the durable bag to carry attachmentBytes",
          ).toBeDefined();
          const ids = Object.keys(bytes ?? {});
          expect(ids).toHaveLength(1);
          const entry = bytes![ids[0]!]!;
          expect(
            typeof entry.path === "string" && (entry.path as string).startsWith("/"),
            `expected an absolute stored path, got ${JSON.stringify(entry.path)}`,
          ).toBe(true);
          expect(
            entry.content,
            "the durable entry must carry no bytes — only a reference",
          ).toBe("");
          expect(
            entry.thumbnailDataUrl,
            "the durable entry must carry no thumbnail either",
          ).toBeUndefined();
          expect(entry.mediaType).toBe("image/png");

          // ── Phase B: relaunch, re-seed the disk bag, rehydrate ────────
          {
            const appB = await launchTugApp({
              testName: "at0409-attachment-durability-B",
              env: { TUGBANK_PATH: tugbankPath },
              persistInTestMode: true,
            });
            try {
              await appB.seedDeckState({
                state: SESSION_DECK_STATE,
                cardStates: { A: onDisk!.value as Record<string, unknown> },
                focusCardId: "A",
              });
              await new Promise<void>((r) => setTimeout(r, 1500));
              await appB.bindSession("A");

              // The chip survived the prune: a path-bearing entry is not an
              // orphan, even though its content arrived empty.
              await appB.waitForCondition<boolean>(
                `document.querySelector(${JSON.stringify(ATOM_IMG_SELECTOR)}) !== null`,
                { timeoutMs: 15_000 },
              );

              // And the bytes came back. A non-empty `content` is exactly
              // what `buildWirePayload` requires to ship a real image block
              // rather than a mention marker.
              await appB.waitForCondition<boolean>(
                `(function(){ var e = ${READ_LIVE_ENTRY}; return e !== null && e.contentLength > 0; })()`,
                { timeoutMs: 20_000 },
              );
            } finally {
              await appB.close();
            }
          }
        } finally {
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );


    test(
      "a recalled prompt-history image rehydrates to resubmittable bytes",
      async () => {
        const tugbankPath = mkTempTugbank();
        const fixtureDir = mkdtempSync(join(tmpdir(), "at0409-history-"));
        const sessionId = "at0409-history-session";
        const atomId = "at0409-history-atom";
        try {
          seedTugbankForLaunch(tugbankPath);

          // A real image on disk standing in for a stored original. The
          // upload route that normally puts one there is covered by the test
          // above; what this one exercises is the read back out.
          const storedPath = join(fixtureDir, "recalled.png");
          copyFileSync(REPO_PNG_FIXTURE, storedPath);

          const app = await launchTugApp({
            testName: "at0409-attachment-history",
            env: { TUGBANK_PATH: tugbankPath },
            persistInTestMode: true,
          });
          try {
            // The history entry is appended through the RUNNING app's ledger
            // route rather than written into the db beforehand: the routes are
            // only registered once tugcast has opened the ledger at startup.
            //
            // The atom carries a path and nothing else. That is the whole
            // persisted shape now — history stores references, never pixels —
            // so the path alone has to be enough to get real bytes back.
            const historyEntry = {
              session_id: sessionId,
              route: "❯",
              text: "look at this ￼",
              atoms: [
                {
                  position: 13,
                  type: "image",
                  label: "image-1",
                  value: "image-1",
                  id: atomId,
                  path: storedPath,
                },
              ],
              project_path: "",
              submitted_at_ms: Date.now(),
              client_entry_id: `${sessionId}-1`,
            };
            await app.evalJS<null>(
              `(function(){
                window.__at0409History = "pending";
                fetch("/api/prompt-history", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: ${JSON.stringify(JSON.stringify(historyEntry))},
                }).then(function(r){ window.__at0409History = r.ok ? "ok" : "http-" + r.status; },
                        function(e){ window.__at0409History = "err:" + e.message; });
                return null;
              })()`,
            );
            await app.waitForCondition<boolean>(
              `window.__at0409History === "ok"`,
              { timeoutMs: 10_000 },
            );

            await app.seedDeckState({
              state: SESSION_DECK_STATE,
              focusCardId: "A",
            });
            await new Promise<void>((r) => setTimeout(r, 1500));
            await app.bindSession("A", {
              tugSessionId: sessionId,
              projectDir: fixtureDir,
            });

            // The session's history hydrates, the re-seed puts a marker
            // carrying the path, and rehydration reads the original through
            // /api/fs/blob and downsamples it. Preview-only would leave
            // `content` empty forever; real bytes are what make a recalled
            // prompt resubmittable, since `buildWirePayload` gates a real
            // image block on exactly `content.length > 0`.
            const contentLength = await app.waitForCondition<number>(
              `(function(){
                window.tugdeck && window.tugdeck.saveState && window.tugdeck.saveState();
                var bag = window.__tug.getCardStateBag("A");
                var bytes = bag && bag.content ? bag.content.attachmentBytes : null;
                var e = bytes ? bytes[${JSON.stringify(atomId)}] : null;
                if (!e || typeof e.content !== "string" || e.content.length === 0) return false;
                return e.content.length;
              })()`,
              { timeoutMs: 30_000 },
            );
            expect(contentLength).toBeGreaterThan(0);
          } finally {
            await app.close();
          }
        } finally {
          rmSync(fixtureDir, { recursive: true, force: true });
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
