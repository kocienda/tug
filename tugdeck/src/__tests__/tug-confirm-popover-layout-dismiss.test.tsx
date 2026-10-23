/**
 * A confirm that a layout change dismisses is cancelled, never left open and
 * hidden, under jsdom.
 *
 * An open popover closes when its trigger moves: a window resize, or any
 * layout ancestor of the trigger resizing. It hides its content first, so no
 * exit plays detached from the trigger, then asks to close. A controlled
 * confirm has no `onOpenChange`: its close is the chain's `DISMISS_POPOVER`,
 * which it resolves as a cancel. A dismiss that only asked through
 * `onOpenChange` left the confirm open and invisible — its owner still
 * waiting on an answer nobody could give (`row-33-arrangement`'s delete).
 *
 * @covers tugdeck/src/components/tugways/tug-popover.tsx
 * @covers tugdeck/src/components/tugways/tug-confirm-popover.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import React from "react";

import type { DeckManager } from "../deck-manager";
import { installJsdom, mountDeck, onePaneDeck, settle, unmountDeck } from "./jsdom-deck";

const substrate = installJsdom();
const { container, win } = substrate;

const COMPONENT = "confirm-dismiss-probe";
const CARD = "card-1";

let manager: DeckManager;
let raise: (() => void) | null = null;
const answers: string[] = [];

beforeAll(async () => {
  const { registerCard } = await import("../card-registry");
  const { TugConfirmPopover } = await import("../components/tugways/tug-confirm-popover");

  function ConfirmProbe(): React.ReactElement {
    const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
    const [open, setOpen] = React.useState(false);
    React.useLayoutEffect(() => {
      raise = () => setOpen(true);
    }, []);
    return (
      <div>
        <button type="button" data-probe="anchor" ref={setAnchor}>
          Anchor
        </button>
        <TugConfirmPopover
          open={open}
          anchorEl={open ? anchor : null}
          message="Delete it?"
          confirmLabel="Delete"
          onConfirm={() => {
            answers.push("confirm");
            setOpen(false);
          }}
          onCancel={() => {
            answers.push("cancel");
            setOpen(false);
          }}
        />
      </div>
    );
  }

  registerCard({
    componentId: COMPONENT,
    contentFactory: () => <ConfirmProbe />,
    defaultMeta: { title: "Confirm probe", closable: true },
  });
  manager = await mountDeck(substrate, onePaneDeck(COMPONENT, [CARD]));
});

afterAll(() => unmountDeck(substrate, manager));

const confirmEl = (): HTMLElement | null => win.document.querySelector<HTMLElement>('[data-slot="tug-confirm-popover"]');

describe("a confirm a layout change dismisses", () => {
  test("is cancelled and goes, not left open and hidden", async () => {
    expect(raise).not.toBeNull();
    const { act } = await import("react");
    await act(async () => {
      raise!();
      await settle();
    });
    expect(confirmEl(), "the confirm opened").not.toBeNull();
    expect(container.isConnected).toBe(true);

    await act(async () => {
      win.dispatchEvent(new (win as unknown as typeof globalThis).Event("resize"));
      await settle();
    });
    expect(answers, "the dismiss resolved the confirm as a cancel").toEqual(["cancel"]);
    await act(async () => {
      await settle();
    });
    expect(confirmEl(), "the confirm closed with it").toBeNull();
  });
});
