<!-- brief-skeleton v1 -->

# Every sidebar card in the Window menu

**Purpose:** Tug.app's only menu route to a sidebar card is six Show ⟨card⟩ rows in the Maker menu, which a release build hides. Move them to the Window menu as a panel list in the Illustrator manner — one row per sidebar card, marked for presence, with a submenu that arranges the card left or right and is live only while the card shows. The rows read the three-rung ladder the shortcuts already run and show it back as three marks: nothing, a check, a checked square.

> **The rows are in View now, not Window.** `briefs/menu-bar-relocation-brief.md` moved the whole sidebar family — the five card parents with their Show/Left/Right submenus, Hide Sidebars, and Resize Sidebars to Fit — into the View menu under `view.sidebar.*`, `view.toggleSidebars` and `view.resizeSidebarsToFit`, on the HIG's reading that Show Sidebar is a View verb. Everything this brief decided about the rows themselves stands unchanged: the panel-list shape, the three-rung ladder, the mixed-state square, the submenu's toggle-then-sides order. The one mechanism that moved with them is [B09]'s mark copy — `refreshSidebarParentMarks` now runs in the **View** branch of `menuNeedsUpdate` and matches the `view.sidebar.` prefix, and because View is rebuilt whole on every open it must run **after** `rebuildViewMenu` rather than before, or it writes the marks onto the previous open's discarded parent items. Read every `Window ▸ ⟨Card⟩` below as `View ▸ ⟨Card⟩`.

---

## Purpose {#purpose}

Every sidebar card — Jots, Tripwires, Arcs, Cards, Layout, Overview — gets a parent row under Window whose mark says whether the card is hidden, showing, or showing and holding the keyboard. Its submenu holds the toggle row, whose title says what the next click does, and a Left / Right radio pair enabled only while the card is showing. Selecting the toggle runs the same three-state ladder the Maker rows run today. The Layout card's own controls are untouched; both surfaces drive one store and stay in agreement without knowing about each other.

Settled in conversation on 2026-09-02.

---

## Evidence {#evidence}

**[F01] The Show ⟨card⟩ rows live in a menu a shipped Tug never shows.** `tugapp/Sources/AppDelegate.swift:1333`–`:1338` builds them under Maker, and `:1369` hides that menu whenever `makerModeEnabled` is false, which `:21` derives from the debug build profile. A release user has no menu route to any sidebar card. **(verified — read from the tree)**

**[F02] The rows already run a three-rung ladder, not a toggle.** Each handler (`AppDelegate.swift:1482`–`:1508`) sends a `toggle-<card>` control; `tugdeck/src/action-dispatch.ts:539`–`:566` routes it to `toggleSidebarCard` in `tugdeck/src/sidebar-toggle.ts`, which reads the deck and does one of three things: show the card and bring the keyboard to it, bring the keyboard to it, or hide it. The "holds the keyboard" test is `getFirstResponderCardId`, which `tugdeck/src/deck-manager.ts:818` derives from `activePaneId` — deck state, not a side channel. **(verified)**

**[F03] Side placement is already store surface.** `action-dispatch.ts:723`–`:757` handles `set-sidebar-side` and `set-sidebar-open`; `deck-manager.ts:1683` `setSidebarSide` re-pins a floated card and reimposes; `tugdeck/src/lib/layout-imposer.ts:350` `sidebarSide` answers a card's side, defaulting to right. The Layout card's Off / Left / Right rows (`tugdeck/src/components/layout/layout-card.tsx:830`–`:850`) dispatch exactly these, setting the side first on a hidden card so it appears where the press said. **(verified)**

**[F04] Checkmarks and enablement for Window rows ride the registry gate mechanism.** A command entry with `mirrored: true` publishes `validate`, `state`, and `dynamicTitle` (`tugdeck/src/components/tugways/command-registry.ts:280`, `:327`, `:331`); `computeCommandCapabilities` (`tugdeck/src/lib/host-menu-state.ts:306`) turns them into a gate keyed by `menuItemId`; the Swift validator applies title, state, and enablement by identifier before any hand-rolled tier (`AppDelegate.swift:2161`–`:2178`). The width radio group (`command-registry.ts:820`–`:841`) is the exact precedent, reading its facts off `chain.menu`. The six current Show entries (`command-registry.ts:1795`–`:1845`) are not mirrored and publish no state. **(verified)**

**[F05] The gate's `state` is a plain boolean at both ends.** `MenuCommandGate.state?: boolean` (`host-menu-state.ts:205`); `computeCommandCapabilities` keeps a state only when `typeof rawState === "boolean"` (`:328`); Swift decodes `gate["state"] as? Bool` (`AppDelegate.swift:2920`) into `CommandGate.state: Bool?` and sets `.on` / `.off` (`:2175`). A third mark needs the wire widened. **(verified)**

**[F06] The deck subscription already pushes on every focus change, and the projection already carries the focused card.** `initHostMenuState` subscribes `push` to the deck (`host-menu-state.ts:1086`), and since the first responder is derived from `activePaneId` [F02], a focus move is a deck notification. `MenuStateDeckProjection.focusedActiveCardId` (`:549`, filled at `:737`) is the same read the ladder makes. No new subscription is needed. **(verified)**

**[F07] AppKit will not fire an action on an item that owns a submenu.** Hovering opens the submenu; clicking the parent does nothing. The tree already relies on this: the Open Recent comment (`AppDelegate.swift:895`–`:899`) records that a parent carrying a submenu is never asked `validateMenuItem` and is enabled only when its submenu holds an enabled item, and the harness models the same rule (`tugapp/Sources/TestHarness/TestHarnessConnection.swift:522`–`:524`). A parent can still display a state. **(verified)**

**[F08] The Window menu is `NSApp.windowsMenu`, managed by section, never rebuilt whole.** `AppDelegate.swift:1197`–`:1201` states the rule; `rebuildWindowPaneList` (`:2640`–`:2657`) churns only the `window.pane.*` slice between the anchor separator (`:1297`) and the next one, and runs on every open via `menuNeedsUpdate` (`:2456`). A static group added before the anchor is safe and gets an open-time pass for free. **(verified)**

**[F09] The harness can read all of it.** `snapshotMenu` (`TestHarnessConnection.swift:480`–`:500`) reports each item's `state.rawValue` and recurses into submenus; `menuItemState` answers per identifier. `tests/app-test/at0168-menu-structure.test.ts:172`–`:179` lists the six `maker.*` ids and will need the new ids; `at0501-rail-toggle.test.ts` covers `sidebar-toggle.ts`. **(verified)**

**[F10] The registered sidebar cards are six, fixed at boot.** `getAllRegistrations()` filtered on `layoutRole === "sidebar"` (`layout-card.tsx:283`–`:292`) yields jots, tripwires, `dashes` (the Arcs card's wire id, `tugdeck/src/lib/arcs-card-id.ts:20`), cards, layout, overview. Registration is a boot step, so a static list in Swift matches it. **(verified)**

---

## Decisions {#decisions}

**[B01] One submenu per card, and the parent carries the mark.** Because of [F07], the toggle cannot be the parent's own click. The parent row `Window ▸ ⟨Card⟩ ▸` shows the state; its submenu holds the toggle row, a separator, and Left / Right. The parent's enablement falls out of AppKit's rule: the toggle row is always enabled, so the parent always is, and the side pair is dark exactly when the card is hidden.

**[B02] The mark is the ladder, read back — three states, one fact.** Off means no instance of the card exists; on means it shows but does not hold the keyboard; mixed means it shows and is the first-responder card. A click on the toggle row does what the ladder already does at that rung [F02]: show and activate, activate, hide. The rows therefore keep sending the existing `toggle-<card>` controls, and a chord bound to one keeps meaning what the row displays.

**[B03] The mixed-state glyph is the SF Symbol `checkmark.square`.** User's call: "more window-like." Set as `mixedStateImage` on the six parent rows and six toggle rows, one shared template image with a semibold configuration at the native check's point size, so the two marks weigh the same. AppKit's own check stays for the on state.

**[B04] The toggle row's title says what the next click does.** Show ⟨Card⟩, Activate ⟨Card⟩, Hide ⟨Card⟩, published through the entry's `dynamicTitle` [F04]. A row whose click means three different things must name the one it will do.

**[B05] Widen the gate's `state` wire additively.** A `state` predicate may return `"mixed"` as well as a boolean; the publisher passes it through; the Swift decoder maps a boolean to on / off and the string to `.mixed`. Every existing gate is untouched, and the harness's `rawValue` report already distinguishes the three.

**[B06] Add a `sidebars` fact to the deck projection.** Keyed by component id, per registered sidebar card: whether an instance exists, its side from `sidebarSide`, and whether its instance is the focused active card. Derived in `projectDeckState` beside `cardWidth`, mirrored into `CommandMenuFacts`. The toggle entry's `state` and the side radios' `validate` and `state` all read this one fact.

**[B07] Twelve new mirrored registry entries under `window.sidebar.<id>.*`, and the six `maker.*` entries retarget.** Per card: `.show` (validate true, three-state `state`, dynamic title) and `.left` / `.right` (validate = showing, state = side matches). The existing `TOGGLE_*` entries keep their command ids and move their `menuItemId` to the new `.show` rows, so keymap rebinding keeps working and no user override is orphaned.

**[B08] Left / Right reuse `set-sidebar-side`, unchanged.** The radios are live only while the card shows, so the Layout card's set-then-show dance [F03] is not needed here. The side rides `representedObject`, the shape `setCardWidthFromMenu` uses (`AppDelegate.swift:1880`).

**[B09] The parent's mark is copied in the Window menu's open-time pass.** The validator is never asked about a submenu parent [F07], so `menuNeedsUpdate` for the Window menu, which already runs `rebuildWindowPaneList` [F08], also copies each `.show` gate's state onto its parent.

**[B10] The group stands before the pane-list anchor, after the width rows.** The pane list stays adjacent to AppKit's own window entries at the tail, where it belongs.

**[B11] The six Show rows leave the Maker menu.** Show Left / Right Rail and Show DevTools stay; the rail shortcuts and their ladder are unchanged. The at0168 id list moves with them.

**[B12] The Layout card is in the list and is otherwise untouched.** It is a sidebar card, so it gets a row like the others. Its own Off / Left / Right controls keep working as they are; both surfaces drive one store.

**[B13] Tests.** Update `at0168-menu-structure` for the new ids and the Maker removals; add one app-test that shows a card through its row, reads the parent's mark and the side pair's enablement, moves focus elsewhere and reads the check, moves the side and reads the radio, hides it and reads the empty mark. It declares `@covers` for `AppDelegate.swift`, `host-menu-state.ts`, `command-registry.ts`, and `sidebar-toggle.ts`.

---

## Open Questions {#open-questions}

None.

---

## Non-goals {#non-goals}

- **A flat click-to-toggle list with a separate "Move Sidebar Left / Right" pair.** The literal Illustrator shape. Rejected: the side controls belong with the card they move, and [F07] makes the per-card submenu the only way to have both on one row.
- **A plain open / closed toggle for the row.** Rejected: it would make the row mean something different from the chord it displays, and the three marks make the existing ladder legible instead.
- **A diamond as the mixed-state glyph.** Rejected: in a Mac Window menu the diamond has meant a minimized window, and AppKit's own entries at this menu's tail still use it. Also rejected: `checkmark.circle.fill` and `circle.fill`, in favor of the square [B03].
- **Building the card list from a push.** Rejected: registration is fixed at boot [F10], and Swift already hardcodes the six.
- **Any change to the Layout card's controls or the rail shortcuts.** Out of scope by the user's statement.

---

## Exit {#exit}

A direct **`/arc`**. The decisions are made above, the parts are few and their order is plain — widen the wire, add the fact, add the entries, build the group, retire the Maker rows, retest — and the task list is written from this brief.
