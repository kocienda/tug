/**
 * A document row on the Changes shade opens its file through the shell.
 *
 * The shade stands in a Session card's body, whose deck store is the body's
 * bridge: its `addCard` is inert, because the deck's arrangement is the
 * shell's. A row that opened its document with `openFileInCard` on that store
 * opened nothing. It dispatches the `OPEN_FILE` command, which a body's
 * unanswered-command fallback carries to the shell, whose deck canvas answers
 * it with `openFileInCard` — the route a Text card's document link takes.
 *
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-documents.tsx
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import React from "react";

import { installJsdom } from "../../../../../__tests__/jsdom-deck";

const substrate = installJsdom();

afterAll(() => substrate.restore());

const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
  document.body.innerHTML = "";
});

describe("SessionChangesArcDocuments in a body", () => {
  test("a row's click and its open button each hand OPEN_FILE to the shell, from the host card", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { setUnhandledCommandFallback } = await import("@/command-dispatch");
    const { DeckManagerContext } = await import("@/deck-manager-context");
    const { CardStatePreservationContext } = await import("@/components/tugways/use-card-state-preservation");
    const { SessionChangesArcDocuments } = await import("../session-changes-arc-documents");
    type Store = NonNullable<React.ContextType<typeof DeckManagerContext>>;

    // The body's bridge: every call answers nothing and adds no card.
    const added: unknown[] = [];
    const inert = new Proxy({} as Record<string, unknown>, {
      get: (_target, key) =>
        key === "addCard" ? (...args: unknown[]) => (added.push(args), null) : () => null,
    }) as unknown as Store;

    const handedOver: Array<{ id: string; payload: unknown }> = [];
    releases.push(
      setUnhandledCommandFallback((entry, payload) => {
        handedOver.push({ id: entry.id, payload });
        return true;
      }),
    );

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <DeckManagerContext value={inert}>
          <CardStatePreservationContext value={{ cardId: "A", register: () => {} }}>
            <SessionChangesArcDocuments
              documents={{ brief: "/p/.tug/arcs/x/brief.md", brief_title: "The brief" }}
            />
          </CardStatePreservationContext>
        </DeckManagerContext>,
      );
    });

    const row = host.querySelector<HTMLElement>('[data-slot="session-arc-document"]');
    expect(row).not.toBeNull();
    await act(async () => {
      row!.click();
    });
    const button = row!.querySelector<HTMLElement>("button");
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
    });

    const open = { id: "open-file", payload: { path: "/p/.tug/arcs/x/brief.md", originCardId: "A" } };
    expect(handedOver).toEqual([open, open]);
    expect(added).toEqual([]);
    await act(async () => root.unmount());
  });
});
