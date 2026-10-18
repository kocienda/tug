/**
 * The Overview composer's draft outlives its card's page.
 *
 * Hiding the rail destroys the Overview card and showing it mints a fresh
 * one ([F07]); under per-card web views the card's page goes with it, and so
 * does the page's own holder. The shell holds the draft instead: a body's
 * composer forwards it (`forwardOverviewDraft`, over the `dispatch` door to
 * the shell's `hold-overview-draft` handler), the words replacing the last
 * and the pictures standing until they move, and the next Overview card's
 * first body is handed it as its bag (`overviewDraftSeedBag`, through the
 * hand-off's kind seed). An empty draft lets it go, and a card the deck holds
 * state for — a relaunch's — keeps its own.
 *
 * @covers tugdeck/src/components/overview/overview-composer-draft.ts
 * @covers tugdeck/src/lib/body-handoff.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { IDeckManagerStore } from "../../../deck-manager-store";
import type { TugTextEditingState } from "../../../lib/tug-text-types";
import { registerCard } from "../../../card-registry";
import { registerDeckStore } from "../../../lib/deck-store-registry";
import { bodyCardsStore } from "../../../lib/body-cards-store";
import { _resetHandOffForTest, _setHostCapabilitiesForTest, handOffToBody } from "../../../lib/body-handoff";
import { SHELL_ACTIONS_FOR_CARDS, runShellActionForCard } from "../../../action-registry";
import { OVERVIEW_CARD_ID } from "../../../lib/overview-card-id";
import {
  HOLD_OVERVIEW_DRAFT,
  _resetOverviewDraftShellHolderForTest,
  forwardOverviewDraft,
  installOverviewDraftShellHolder,
  overviewDraftSeedBag,
} from "../overview-composer-draft";

function draft(text: string, atoms: TugTextEditingState["atoms"] = []): TugTextEditingState {
  return { text, atoms, selection: null } as TugTextEditingState;
}

const IMAGE_ATOM = { position: 0, type: "image", label: "image-1", value: "image-1", id: "atom-1" };
const BYTES = { "atom-1": { content: "iVBORw0KGgo=", mediaType: "image/png" } };

let uninstall: () => void = () => {};

beforeEach(() => {
  _resetOverviewDraftShellHolderForTest();
  uninstall = installOverviewDraftShellHolder();
});

afterEach(() => {
  uninstall();
});

describe("the shell's hold on the Overview draft", () => {
  test("is one of the actions a body may ask of the shell", () => {
    expect(SHELL_ACTIONS_FOR_CARDS.has(HOLD_OVERVIEW_DRAFT)).toBe(true);
  });

  test("holds what a body forwards: the words replace the last, the pictures stand until they move", () => {
    expect(overviewDraftSeedBag()).toBeUndefined();
    // As the body's forward arrives in the shell, over the `dispatch` door.
    runShellActionForCard(HOLD_OVERVIEW_DRAFT, {
      draft: draft("half a question ", [IMAGE_ATOM as never]),
      attachmentBytes: BYTES,
    });
    expect(overviewDraftSeedBag()).toEqual({
      content: { draft: draft("half a question ", [IMAGE_ATOM as never]), attachmentBytes: BYTES },
    });

    runShellActionForCard(HOLD_OVERVIEW_DRAFT, { draft: draft("half a question about ", [IMAGE_ATOM as never]) });
    expect(overviewDraftSeedBag()).toEqual({
      content: { draft: draft("half a question about ", [IMAGE_ATOM as never]), attachmentBytes: BYTES },
    });
  });

  test("an empty draft, or no draft, lets it go", () => {
    forwardOverviewDraft(draft("words"));
    expect(overviewDraftSeedBag()).toBeDefined();
    forwardOverviewDraft(draft(""));
    expect(overviewDraftSeedBag()).toBeUndefined();
    forwardOverviewDraft(draft("again"));
    forwardOverviewDraft(null);
    expect(overviewDraftSeedBag()).toBeUndefined();
  });

  describe("the next Overview card's first body", () => {
    const cardStates = new Map<string, Record<string, unknown>>();
    const deck = {
      getSnapshot: () => ({ cards: [{ id: "ov-2", componentId: OVERVIEW_CARD_ID }, { id: "ov-3", componentId: OVERVIEW_CARD_ID }] }),
      spaceOf: () => null,
      getSpaceDeck: () => undefined,
      getCardState: (cardId: string) => cardStates.get(cardId),
    } as unknown as IDeckManagerStore;
    const posted: Array<{ intent: { bag?: unknown } }> = [];
    const g = globalThis as { webkit?: unknown };
    let priorWebkit: unknown;

    beforeEach(() => {
      registerCard({
        componentId: OVERVIEW_CARD_ID,
        contentFactory: () => null,
        defaultMeta: { title: "Overview", closable: true },
      });
      posted.length = 0;
      priorWebkit = g.webkit;
      g.webkit = {
        messageHandlers: { bodyCreate: { postMessage: (body: { intent: { bag?: unknown } }) => posted.push(body) } },
      };
      registerDeckStore(deck);
      _resetHandOffForTest();
      _setHostCapabilitiesForTest({ bodyViews: true });
    });

    afterEach(() => {
      cardStates.clear();
      g.webkit = priorWebkit;
      registerDeckStore(null);
      _setHostCapabilitiesForTest({ bodyViews: false });
      bodyCardsStore._reset();
    });

    test("is handed the held draft as its bag; a card with state of its own keeps it", () => {
      forwardOverviewDraft(draft("half a question about ", [IMAGE_ATOM as never]), BYTES);
      handOffToBody("ov-2", () => ({ kind: "mount" }));
      expect(posted[0]?.intent.bag).toEqual({
        content: { draft: draft("half a question about ", [IMAGE_ATOM as never]), attachmentBytes: BYTES },
      });

      const relaunched = { content: { draft: draft("from the relaunch") } };
      cardStates.set("ov-3", relaunched);
      handOffToBody("ov-3", () => ({ kind: "mount" }));
      expect(posted[1]?.intent.bag).toEqual(relaunched);
    });
  });
});
