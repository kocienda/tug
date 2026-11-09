/**
 * row-06-menus-text-kinds.test.ts — every Text item (case, comments, line
 * breaks, quotes, gremlins) performs with the body of each other kind first
 * responder.
 *
 * A piece of row 6 ([B02] row 6); the sweep and its parts are `_row-06.ts`'s.
 *
 * @family row-06-menus
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugapp/Sources/MenuBarBuilder.swift
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/host-menu-state.ts
 */

import { describeKindsSweep } from "./_row-06";

describeKindsSweep("text", "the Text menu");
