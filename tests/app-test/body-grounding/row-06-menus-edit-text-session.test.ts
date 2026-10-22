/**
 * row-06-menus-edit-text-session.test.ts — every other Edit item (undo,
 * find, case) performs with a Session body first responder.
 *
 * A piece of row 6 ([B02] row 6); the sweep and its parts are `_row-06.ts`'s.
 *
 * @family row-06-menus
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugapp/Sources/MainWindow.swift
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/host-menu-state.ts
 */

import { describeSessionSweep } from "./_row-06";

describeSessionSweep("edit-text", "the rest of the Edit menu");
