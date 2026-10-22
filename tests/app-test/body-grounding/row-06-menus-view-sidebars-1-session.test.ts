/**
 * row-06-menus-view-sidebars-1-session.test.ts — View › Sidebar's Arcs,
 * Jots and Layout rows perform with a Session body first responder.
 *
 * A piece of row 6 ([B02] row 6); the sweep and its parts are `_row-06.ts`'s.
 * A sidebar shown from View › Sidebar once left its new body holding the
 * keyboard after the shell had handed it back ([B05], row 6).
 *
 * @family row-06-menus
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugapp/Sources/MainWindow.swift
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/host-menu-state.ts
 */

import { describeSessionSweep } from "./_row-06";

describeSessionSweep("view-sidebars-1", "View › Sidebar's Arcs, Jots and Layout rows");
