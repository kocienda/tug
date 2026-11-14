/**
 * The alternate copy is one seat with two names, and the surface picks.
 *
 * ⌥⇧⌘C, its Edit menu item and its context-menu row are one command. Where
 * Copy gives the source — an editor, a native input — the seat reads Copy as
 * Plain Text. Where Copy gives plain text — a rendered transcript cell — it
 * reads Copy as Markdown. The surface says which by what its responder
 * answers `queryActionState` with, and both doors read that one answer
 * through `copyAlternateTitle`, so the menu bar and the context menu cannot
 * name the seat differently.
 *
 * Real `ResponderChainManager`, the real registry entry, and the real
 * projection the host's menu is fed from.
 */

import { describe, expect, test } from "bun:test";

import { ResponderChainManager } from "../responder-chain";
import { TUG_ACTIONS } from "../action-vocabulary";
import {
  COMMANDS,
  COPY_ALTERNATE_MARKDOWN,
  EMPTY_MENU_FACTS,
  copyAlternateTitle,
} from "../command-registry";
import type { CommandValidationSource } from "../command-registry";
import { buildTextEditingMenuItems } from "../text-editing-menu";
import { computeCommandCapabilities } from "@/lib/host-menu-state";

const MENU_ITEM = "edit.copyAlternate";

function source(chain: ResponderChainManager): CommandValidationSource {
  return {
    validateAction: (action) => chain.validateAction(action),
    validateActionInKeyCard: (action) => chain.validateActionInKeyCard(action),
    queryActionState: (action) => chain.queryActionState(action),
    queryActionStateInKeyCard: (action) => chain.queryActionStateInKeyCard(action),
    menu: EMPTY_MENU_FACTS,
  };
}

/**
 * A root that answers the seat with its plain-text face, as the deck's root
 * and a body's root do, and under it the surface holding first responder.
 */
function chainWith(surface: "rendered" | "source"): ResponderChainManager {
  const chain = new ResponderChainManager();
  chain.register({
    id: "root",
    parentId: null,
    actions: { [TUG_ACTIONS.COPY_ALTERNATE]: () => {} },
  });
  if (surface === "rendered") {
    chain.register({
      id: "surface",
      parentId: "root",
      actions: {
        [TUG_ACTIONS.COPY]: () => {},
        [TUG_ACTIONS.COPY_ALTERNATE]: () => {},
      },
      queryActionState: (action) =>
        action === TUG_ACTIONS.COPY_ALTERNATE ? COPY_ALTERNATE_MARKDOWN : undefined,
    });
  } else {
    // A source surface answers Copy and leaves the seat to the root.
    chain.register({
      id: "surface",
      parentId: "root",
      actions: { [TUG_ACTIONS.COPY]: () => {} },
    });
  }
  chain.makeFirstResponder("surface");
  return chain;
}

function gate(chain: ResponderChainManager) {
  const entry = COMMANDS.find((e) => e.id === TUG_ACTIONS.COPY_ALTERNATE);
  if (entry === undefined) throw new Error("the registry has no alternate-copy entry");
  return computeCommandCapabilities(source(chain), [entry])[MENU_ITEM];
}

describe("the alternate copy's Edit menu title", () => {
  test("a rendered surface holding first responder reads Copy as Markdown", () => {
    expect(gate(chainWith("rendered")).title).toBe("Copy as Markdown");
  });

  test("a source surface reads Copy as Plain Text", () => {
    expect(gate(chainWith("source")).title).toBe("Copy as Plain Text");
  });

  test("the title is always stated, so the host's item never keeps a stale one", () => {
    // The host writes a pushed title onto the item and leaves it there, so a
    // gate that fell silent when the first responder moved off a rendered
    // surface would leave the item reading Copy as Markdown over an editor.
    const empty = new ResponderChainManager();
    expect(gate(empty).title).toBe("Copy as Plain Text");
  });

  test("the surface's answer names the face and never becomes a check mark", () => {
    const rendered = gate(chainWith("rendered"));
    expect(rendered.state).toBeUndefined();
    expect(rendered.enabled).toBe(true);
  });
});

describe("the alternate copy's context-menu row", () => {
  function rowLabel(state: string | undefined): string | undefined {
    const entries = buildTextEditingMenuItems({
      hasSelection: true,
      source: source(chainWith("source")),
      ...(state !== undefined ? { copyAlternateState: state } : {}),
    });
    return entries.find((e) => e.action === TUG_ACTIONS.COPY_ALTERNATE)?.label;
  }

  test("a rendered surface's menu reads Copy as Markdown", () => {
    expect(rowLabel(COPY_ALTERNATE_MARKDOWN)).toBe("Copy as Markdown");
  });

  test("a surface that says nothing reads Copy as Plain Text", () => {
    expect(rowLabel(undefined)).toBe("Copy as Plain Text");
  });

  test("the row is labelled by its own surface, not by the first responder", () => {
    // The menu dispatches to the surface it opened over. A rendered cell
    // holding first responder elsewhere must not rename an editor's row.
    const entries = buildTextEditingMenuItems({
      hasSelection: true,
      source: source(chainWith("rendered")),
    });
    expect(entries.find((e) => e.action === TUG_ACTIONS.COPY_ALTERNATE)?.label).toBe(
      "Copy as Plain Text",
    );
  });

  test("both doors name the seat through one function", () => {
    expect(copyAlternateTitle(COPY_ALTERNATE_MARKDOWN)).toBe("Copy as Markdown");
    expect(copyAlternateTitle(undefined)).toBe("Copy as Plain Text");
    expect(copyAlternateTitle(true)).toBe("Copy as Plain Text");
  });
});
