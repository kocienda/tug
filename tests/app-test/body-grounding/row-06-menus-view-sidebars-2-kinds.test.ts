/**
 * row-06-menus-view-sidebars-2-kinds.test.ts — View › Sidebar's other rows
 * (Overview, Workspaces) perform with the body of each other kind first
 * responder.
 *
 * A piece of row 6 ([B02] row 6); the sweep and its parts are `_row-06.ts`'s.
 * A rail's own rows are read, not performed.
 *
 * @family row-06-menus
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugapp/Sources/MainWindow.swift
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/host-menu-state.ts
 */

import { describeKindsSweep } from "./_row-06";

describeKindsSweep("view-sidebars-2", "View › Sidebar's other rows");
