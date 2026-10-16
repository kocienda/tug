/**
 * row-06-menus-view-sidebars-2-session.test.ts — View › Sidebar's other
 * rows (Overview, Workspaces) perform with a Session body first responder.
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

import { describeSessionSweep } from "./_row-06";

describeSessionSweep({ foreground: true }, "view-sidebars-2", "View › Sidebar's other rows");
