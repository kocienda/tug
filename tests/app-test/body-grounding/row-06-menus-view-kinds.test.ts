/**
 * row-06-menus-view-kinds.test.ts — every View item but the sidebar and
 * theme rows performs with the body of each other kind first responder.
 *
 * A piece of row 6 ([B02] row 6); the sweep and its parts are `_row-06.ts`'s.
 *
 * @foreground
 * @family row-06-menus
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugapp/Sources/MainWindow.swift
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/host-menu-state.ts
 */

import { describeKindsSweep } from "./_row-06";

describeKindsSweep({ foreground: true }, "view", "the View menu but its sidebar and theme rows");
