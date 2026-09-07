/**
 * at0535-overview-draft-preservation.test.ts — the Overview composer keeps the
 * user's unsent words.
 *
 * ## What was being lost
 *
 * The Overview's composer passed `preserveState={false}` to its substrate and
 * mounted nothing in its place, so a half-written question lived only as long
 * as the field it was typed in. Two ordinary gestures ended it: putting the
 * rail away, and quitting.
 *
 * The two are not the same loss and are not fixed by one mechanism, which is
 * what this test's shape is about. **Hiding the rail destroys the card** —
 * `hideSidebarPane` closes the pane, and showing it again mints a fresh
 * `crypto.randomUUID()` card id — so the framework's per-card bag, keyed by
 * card id, is written under an id nothing will ever ask for again. That is the
 * arc's open question answered by measurement rather than inference ([F07]),
 * and it is why the draft has two homes: an app-scoped holder that survives
 * the unmount, and the `useCardStatePreservation` bag that survives the
 * process. Test 1 pins the first, test 2 the second.
 *
 * Both carry a picture as well as words, because the picture is the harder
 * half: the atom is a chip in the document, its bytes are in the composer's
 * store, and across a relaunch what persists is neither — only the path
 * tugcast rested the original at, which rehydration reads back.
 *
 * ## Shape
 *
 *  1. **Hide and show.** Open the rail, type, drop a real PNG on the field,
 *     then ⌃⌘O twice. The card id must CHANGE across the round trip (the
 *     [F07] claim — a passing test where the id held would be proving
 *     something else), and the words, the chip, and a thumbnail with real
 *     pixels must all come back.
 *  2. **Quit and relaunch.** The same draft, a graceful quit onto a temp
 *     tugbank, and a second process seeded from the deck state and the bag
 *     that landed on disk. The chip has to survive the orphan prune — it does
 *     because its entry carries a path — and its bytes have to arrive back
 *     through the real `/api/fs/blob` read, which is what makes the recalled
 *     picture sendable rather than a reserved slot.
 *
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/components/overview/overview-composer-draft.ts
 * @covers tugdeck/src/lib/composer-draft-payload.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankRead,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-testid="overview-card"]';
const FIELD = '[data-testid="overview-composer-field"]';
const CONTENT = `${FIELD} .cm-content`;
const FIELD_ATOM = `${CONTENT} img[data-atom-label]`;
const STRIP = '[data-testid="overview-composer-attachment-strip"]';

/** What the user types and must get back, both times. */
const DRAFT = "half a question about ";

/**
 * The field's text with the placeholder taken out. CM6 renders the
 * placeholder inside `.cm-content`, so a bare `textContent` on an empty field
 * reads as the prompt rather than as emptiness.
 */
const FIELD_TEXT = `(function(){
  var c = document.querySelector(${JSON.stringify(CONTENT)});
  if (c === null) return "";
  var clone = c.cloneNode(true);
  Array.prototype.forEach.call(
    clone.querySelectorAll(".cm-placeholder"),
    function (p) { p.remove(); },
  );
  return clone.textContent || "";
})()`;

/** The deck's id for the card the Overview rail is currently standing in. */
const CARD_ID = `(function(){
  var el = document.querySelector(${JSON.stringify(CARD)});
  if (el === null) return "";
  var host = el.closest("[data-card-id]");
  return host === null ? "" : (host.getAttribute("data-card-id") || "");
})()`;

/** Open the rail and wait for the composer to be there to type in. */
async function openRail(app: App): Promise<void> {
  await app.nativeKey("o", ["cmd", "ctrl"]);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(CONTENT)}) !== null`,
    { timeoutMs: 15_000 },
  );
}

/**
 * Drop a real PNG on the composer's field — canvas → blob → a `drop`
 * DragEvent carrying a `File`, which is the event the OS delivers for a
 * Finder drag and the entry the substrate's whole attachment pipeline
 * (downsample, mint, stage, upload the original) is reached through.
 * `evalJS` cannot await, so the blob callback signals through a flag.
 */
async function dropPngOnComposer(app: App): Promise<void> {
  await app.evalJS<void>(
    `(function(){
      window.__at0535Dropped = false;
      var host = document.querySelector(${JSON.stringify(FIELD)});
      var canvas = document.createElement("canvas");
      canvas.width = 96; canvas.height = 72;
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#2b3a55"; ctx.fillRect(0, 0, 96, 72);
      ctx.fillStyle = "#e8c07d"; ctx.fillRect(12, 12, 40, 40);
      canvas.toBlob(function(blob){
        var file = new File([blob], "overview-draft.png", { type: "image/png" });
        var dt = new DataTransfer();
        dt.items.add(file);
        var r = host.getBoundingClientRect();
        var ev = new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          clientX: r.left + r.width / 2,
          clientY: r.top + 8,
        });
        Object.defineProperty(ev, "dataTransfer", { value: dt });
        host.dispatchEvent(ev);
        window.__at0535Dropped = true;
      }, "image/png");
    })()`,
  );
  await app.waitForCondition<boolean>(`window.__at0535Dropped === true`, {
    timeoutMs: 8_000,
  });
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(FIELD_ATOM)}) !== null`,
    { timeoutMs: 15_000 },
  );
}

/** A thumbnail in the strip that has actually decoded — real pixels, not a slot. */
const STRIP_TILE_DECODED = `(function(){
  var img = document.querySelector(${JSON.stringify(`${STRIP} img`)});
  return img !== null && img.naturalWidth > 0;
})()`;

/** Type the words and the picture into a composer that is standing open. */
async function composeDraft(app: App): Promise<void> {
  await app.nativeClickAtElement(FIELD);
  await app.nativeType(DRAFT);
  await app.waitForCondition<boolean>(
    `${FIELD_TEXT}.indexOf(${JSON.stringify(DRAFT.trim())}) !== -1`,
    { timeoutMs: 8_000 },
  );
  await dropPngOnComposer(app);
  await app.waitForCondition<boolean>(STRIP_TILE_DECODED, { timeoutMs: 15_000 });
}

/** One `attachmentBytes` entry as it rests on tugbank disk. */
interface DiskEntry {
  content?: unknown;
  mediaType?: unknown;
  path?: unknown;
}

/** The card-state bag this test reads. */
interface RawBag {
  content?: {
    draft?: { text?: unknown; atoms?: unknown[] };
    attachmentBytes?: Record<string, DiskEntry>;
  };
}

describe.skipIf(!SHOULD_RUN)(
  "at0535 — the Overview composer keeps its draft",
  () => {
    test(
      "a draft with a picture survives the rail being hidden and shown",
      async () => {
        const app = await launchTugApp({
          testName: "at0535-overview-draft-hide-show",
        });
        try {
          await openRail(app);
          await composeDraft(app);
          const before = await app.evalJS<string>(CARD_ID);
          note("card id with the draft in it", before);
          expect(before).not.toBe("");

          // Put the rail away. The same chord that opened it.
          await app.nativeKey("o", ["cmd", "ctrl"]);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CARD)}) === null`,
            { timeoutMs: 10_000 },
          );

          await openRail(app);
          const after = await app.evalJS<string>(CARD_ID);
          note("card id after showing it again", after);
          // [F07], measured: hiding the rail destroys the card and showing it
          // mints a new one. Everything below is therefore proving that a
          // draft crossed an unmount, not that a hidden card kept its state.
          expect(after).not.toBe("");
          expect(after).not.toBe(before);

          // The words.
          await app.waitForCondition<boolean>(
            `${FIELD_TEXT}.indexOf(${JSON.stringify(DRAFT.trim())}) !== -1`,
            { timeoutMs: 10_000 },
          );
          note("restored field text", await app.evalJS<string>(FIELD_TEXT));

          // The chip, and a thumbnail with pixels in it. A chip whose tile
          // never decodes is the reserved slot a lost attachment leaves
          // behind — it looks like a restore and submits as nothing.
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(FIELD_ATOM)}) !== null`,
            ),
          ).toBe(true);
          await app.waitForCondition<boolean>(STRIP_TILE_DECODED, {
            timeoutMs: 10_000,
          });
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a draft with a picture survives a quit and relaunch",
      async () => {
        const tugbankPath = mkTempTugbank();
        try {
          seedTugbankForLaunch(tugbankPath);

          let cardId = "";
          let deckState: unknown = null;

          // ── Phase A: compose, wait for the original to land, quit ──────
          {
            const appA = await launchTugApp({
              testName: "at0535-overview-draft-relaunch-A",
              env: { TUGBANK_PATH: tugbankPath },
              persistInTestMode: true,
            });
            await openRail(appA);
            await composeDraft(appA);
            cardId = await appA.evalJS<string>(CARD_ID);
            expect(cardId).not.toBe("");

            // The upload of the ORIGINAL runs in the background and its
            // stored path is what the durable bag carries — the downsampled
            // bytes are far too large to persist. Waiting for it is the one
            // wait the relaunch story needs; quitting before it lands would
            // persist an atom with no route back to its picture.
            await appA.waitForCondition<boolean>(
              `(function(){
                window.tugdeck && window.tugdeck.saveState && window.tugdeck.saveState();
                var bag = window.__tug.getCardStateBag(${JSON.stringify(cardId)});
                var bytes = bag && bag.content ? bag.content.attachmentBytes : null;
                if (!bytes) return false;
                var ids = Object.keys(bytes);
                if (ids.length !== 1) return false;
                var e = bytes[ids[0]];
                return typeof e.path === "string" && e.path.length > 0;
              })()`,
              { timeoutMs: 25_000 },
            );
            deckState = await appA.evalJS<unknown>(
              `window.tugdeck.diag.getDeckState()`,
            );
            await appA.quitGracefully();
          }

          // ── Disk: the words in full, the picture as a reference ────────
          const onDisk = tugbankRead<RawBag>(
            tugbankPath,
            "dev.tugapp.deck.cardstate",
            cardId,
          );
          expect(
            onDisk,
            "expected the Overview card's bag on tugbank disk",
          ).not.toBeNull();
          const bag = onDisk?.value as RawBag | undefined;
          note("durable draft text", JSON.stringify(bag?.content?.draft?.text));
          expect(String(bag?.content?.draft?.text ?? "")).toContain(
            DRAFT.trim(),
          );
          const bytes = bag?.content?.attachmentBytes;
          const ids = Object.keys(bytes ?? {});
          expect(ids).toHaveLength(1);
          const entry = bytes![ids[0]!]!;
          expect(
            typeof entry.path === "string" &&
              (entry.path as string).startsWith("/"),
            `expected an absolute stored path, got ${JSON.stringify(entry.path)}`,
          ).toBe(true);
          // A reference, not an image: persisting the bytes is the surface
          // the path exists to avoid.
          expect(entry.content).toBe("");

          // ── Phase B: relaunch, re-seed, rehydrate ──────────────────────
          {
            const appB = await launchTugApp({
              testName: "at0535-overview-draft-relaunch-B",
              env: { TUGBANK_PATH: tugbankPath },
              persistInTestMode: true,
            });
            try {
              // Test-mode boot ignores tugbank layout reads, so the rail and
              // its bag are fed back the way at0413 feeds a session's.
              await appB.seedDeckState({
                state: deckState as never,
                cardStates: {
                  [cardId]: onDisk!.value as Record<string, unknown>,
                },
                focusCardId: cardId,
              });

              // The words came back.
              await appB.waitForCondition<boolean>(
                `${FIELD_TEXT}.indexOf(${JSON.stringify(DRAFT.trim())}) !== -1`,
                { timeoutMs: 20_000 },
              );
              note(
                "relaunched field text",
                await appB.evalJS<string>(FIELD_TEXT),
              );

              // The chip survived the orphan prune: an entry carrying a path
              // is not an orphan, however empty its `content` arrived.
              expect(
                await appB.evalJS<boolean>(
                  `document.querySelector(${JSON.stringify(FIELD_ATOM)}) !== null`,
                ),
              ).toBe(true);

              // And the bytes came back through the real blob read, which is
              // the difference between a picture that can be sent again and
              // one that can only be looked at.
              await appB.waitForCondition<boolean>(STRIP_TILE_DECODED, {
                timeoutMs: 25_000,
              });
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
  },
);
