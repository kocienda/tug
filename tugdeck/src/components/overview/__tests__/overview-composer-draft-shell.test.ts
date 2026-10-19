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
 * empty draft lets it go.
 *
 * @covers tugdeck/src/components/overview/overview-composer-draft.ts
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
  takeShellOverviewDraft,
  type OverviewComposerDraftState,
} from "../overview-composer-draft";

function draft(text: string, atoms: TugTextEditingState["atoms"] = []): TugTextEditingState {
  return { text, atoms, selection: null } as TugTextEditingState;
}

const IMAGE_ATOM = { position: 0, type: "image", label: "image-1", value: "image-1", id: "atom-1" };
const BYTES = { "atom-1": { content: "iVBORw0KGgo=", mediaType: "image/png" } };

let bus: TestBus;
afterEach(() => bus?.dispose());

async function pages() {
  bus = createTestBus();
  const shell = bus.shell();
  holdOverviewDraftInShell(shell.bus);
  const overview = bus.body("ov-1", OVERVIEW_CARD_ID);
  await bus.flush();
  const held = (): OverviewComposerDraftState | null => overviewDraft.on(shell.bus).getSnapshot();
  return { shell, overview, held };
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
});
