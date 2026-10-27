/**
 * The Overview composer's draft outlives its card's page.
 *
 * Hiding the rail destroys the Overview card and showing it mints a fresh
 * one ([F07]); under per-card web views the card's page goes with it, and so
 * does the page's own holder. The shell holds the draft instead
 * (`overview.draft`): a body's composer proposes it (`forwardOverviewDraft`),
 * the words replacing the last and the pictures standing until they move, and
 * the next Overview body's composer takes it from the replica
 * (`takeShellOverviewDraft`), whenever the shell's snapshot reaches it. An
 * empty draft lets it go. The shell writes what it holds to one app-wide
 * tugbank key and seeds itself from it at launch, so a let-go in any space's
 * Overview is a let-go after a relaunch too.
 *
 * @covers tugdeck/src/lib/overview-composer-draft.ts
 * @covers tugdeck/src/bus/declarations/relays.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { TugTextEditingState } from "../../../lib/tug-text-types";
import { OVERVIEW_CARD_ID } from "../../../lib/overview-card-id";
import { createTestBus, type TestBus } from "../../../bus/test-bus";
import { overviewDraft } from "../../../bus/declarations/relays";
import {
  forwardOverviewDraft,
  holdOverviewDraftInShell,
  retellOverviewDraft,
  takeShellOverviewDraft,
  type DurableOverviewDraft,
  type OverviewComposerDraftState,
  type OverviewDraftDisk,
} from "../overview-composer-draft";

function draft(text: string, atoms: TugTextEditingState["atoms"] = []): TugTextEditingState {
  return { text, atoms, selection: null } as TugTextEditingState;
}

const IMAGE_ATOM = { position: 0, type: "image", label: "image-1", value: "image-1", id: "atom-1" };
const BYTES = { "atom-1": { content: "iVBORw0KGgo=", mediaType: "image/png" } };
const RESTED = { "atom-1": { content: "iVBORw0KGgo=", mediaType: "image/png", path: "/rest/atom-1.png" } };

/** A tugbank key that outlives the shells reading it, as the real one does. */
function memoryDisk(initial: unknown = undefined): OverviewDraftDisk & { value: unknown; writes: DurableOverviewDraft[] } {
  const disk = {
    value: initial,
    writes: [] as DurableOverviewDraft[],
    read: () => disk.value,
    write: (v: DurableOverviewDraft) => {
      disk.value = v;
      disk.writes.push(v);
    },
  };
  return disk;
}

let bus: TestBus;
afterEach(() => bus?.dispose());

async function pages(disk: OverviewDraftDisk | null = null) {
  bus = createTestBus();
  const shell = bus.shell();
  const releaseHold = holdOverviewDraftInShell(shell.bus, disk);
  const overview = bus.body("ov-1", OVERVIEW_CARD_ID);
  await bus.flush();
  const held = (): OverviewComposerDraftState | null => overviewDraft.on(shell.bus).getSnapshot();
  return { shell, overview, held, releaseHold };
}

describe("the shell's hold on the Overview draft", () => {
  test("holds what a body forwards: the words replace the last, the pictures stand until they move", async () => {
    const { overview, held } = await pages();
    expect(held()).toBeNull();
    forwardOverviewDraft(draft("half a question ", [IMAGE_ATOM as never]), BYTES, overview.bus);
    await bus.flush();
    expect(held()).toEqual({ draft: draft("half a question ", [IMAGE_ATOM as never]), attachmentBytes: BYTES });

    forwardOverviewDraft(draft("half a question about ", [IMAGE_ATOM as never]), undefined, overview.bus);
    await bus.flush();
    expect(held()).toEqual({ draft: draft("half a question about ", [IMAGE_ATOM as never]), attachmentBytes: BYTES });
  });

  test("an empty draft, or no draft, lets it go", async () => {
    const { overview, held } = await pages();
    forwardOverviewDraft(draft("words"), undefined, overview.bus);
    await bus.flush();
    expect(held()).not.toBeNull();
    forwardOverviewDraft(draft(""), undefined, overview.bus);
    await bus.flush();
    expect(held()).toBeNull();
    forwardOverviewDraft(draft("again"), undefined, overview.bus);
    forwardOverviewDraft(null, undefined, overview.bus);
    await bus.flush();
    expect(held()).toBeNull();
  });

  test("survives the Overview card's destruction and seeds the next Overview body", async () => {
    const { overview } = await pages();
    forwardOverviewDraft(draft("half a question about ", [IMAGE_ATOM as never]), BYTES, overview.bus);
    await bus.flush();
    // The rail is hidden: the card and its page go.
    bus.leave(overview);
    bus.detach("ov-1");
    await bus.flush();

    // Shown again, under a fresh card id. Its composer asks before the
    // shell's snapshot has reached the page, and is handed it when it does.
    const next = bus.body("ov-2", OVERVIEW_CARD_ID);
    const taken: OverviewComposerDraftState[] = [];
    takeShellOverviewDraft((held) => taken.push(held), next.bus);
    expect(taken).toEqual([]);
    await bus.flush();
    expect(taken).toEqual([{ draft: draft("half a question about ", [IMAGE_ATOM as never]), attachmentBytes: BYTES }]);

    // Taken once: a later change of the shell's draft is not handed again.
    forwardOverviewDraft(draft("more"), undefined, next.bus);
    await bus.flush();
    expect(taken).toHaveLength(1);
  });

  test("a card that is not the Overview is not sent it, and a page that is not a body takes nothing", async () => {
    const { shell, overview } = await pages();
    forwardOverviewDraft(draft("words"), undefined, overview.bus);
    const session = bus.body("s1", "session");
    await bus.flush();
    expect(overviewDraft.on(session.bus).arrived()).toBe(false);
    const taken: unknown[] = [];
    takeShellOverviewDraft((held) => taken.push(held), shell.bus);
    forwardOverviewDraft(draft("from the shell"), undefined, shell.bus);
    await bus.flush();
    expect(taken).toEqual([]);
    expect(overviewDraft.on(shell.bus).getSnapshot()?.draft).toEqual(draft("words"));
  });

  test("a shell that reloads under the Overview body is told the draft again, pictures and all", async () => {
    const { shell, overview } = await pages();
    retellOverviewDraft(overview.bus);
    forwardOverviewDraft(draft("half a question ", [IMAGE_ATOM as never]), BYTES, overview.bus);
    await bus.flush();
    // Only the shell reloads: a new shell page, holding nothing.
    bus.leave(shell);
    const reloaded = bus.shell();
    holdOverviewDraftInShell(reloaded.bus, null);
    await bus.flush();
    expect(overviewDraft.on(reloaded.bus).getSnapshot()).toEqual({
      draft: draft("half a question ", [IMAGE_ATOM as never]),
      attachmentBytes: BYTES,
    });
  });
});

describe("the shell's hold across a relaunch", () => {
  test("a let-go is written at once, so the next launch seeds nothing", async () => {
    // The reported shape: a draft that had been carried into another space's
    // Overview is deleted, and must not be standing in the prompt again
    // after a relaunch.
    const disk = memoryDisk({ draft: draft("", [{ position: 0, type: "session", label: "tug/snowy-rugby", value: "tug/snowy-rugby" } as never]) });
    const { overview, held } = await pages(disk);
    expect(held()?.draft?.atoms).toHaveLength(1);
    forwardOverviewDraft(null, undefined, overview.bus);
    await bus.flush();
    expect(held()).toBeNull();
    expect(disk.value).toEqual({ draft: null });
    bus.dispose();

    // Relaunch: a new shell over the same key.
    const next = await pages(disk);
    expect(next.held()).toBeNull();
  });

  test("words are written once they settle, the pictures as references, and seed the next launch", async () => {
    const disk = memoryDisk();
    const { overview, held, releaseHold } = await pages(disk);
    forwardOverviewDraft(draft("half a question ", [IMAGE_ATOM as never]), RESTED, overview.bus);
    forwardOverviewDraft(draft("half a question about ", [IMAGE_ATOM as never]), undefined, overview.bus);
    await bus.flush();
    // Coalesced: nothing yet, then one write when the shell lets go.
    expect(disk.writes).toEqual([]);
    expect(held()?.attachmentBytes).toEqual(RESTED);
    releaseHold();
    expect(disk.writes).toEqual([
      {
        draft: draft("half a question about ", [IMAGE_ATOM as never]),
        attachmentBytes: { "atom-1": { content: "", mediaType: "image/png", path: "/rest/atom-1.png" } },
      },
    ]);
    bus.dispose();

    const next = await pages(disk);
    expect(next.held()).toEqual({
      draft: draft("half a question about ", [IMAGE_ATOM as never]),
      attachmentBytes: { "atom-1": { content: "", mediaType: "image/png", path: "/rest/atom-1.png" } },
    });
  });

  test("a picture with no route back to its bytes does not come back", async () => {
    const disk = memoryDisk({
      draft: draft("￼look", [IMAGE_ATOM as never]),
      attachmentBytes: { "atom-1": { content: "", mediaType: "image/png" } },
    });
    const { held } = await pages(disk);
    expect(held()?.draft).toEqual(draft("look"));
  });
});
