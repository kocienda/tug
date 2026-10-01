# Per-Workspace Themes

**Purpose:** Every workspace shows the same theme. A workspace should carry its own theme, so switching workspaces also switches the look, and a theme can be set from the Workspaces card itself.

---

## Purpose {#purpose}

The user asked for per-workspace themes:

> I think we could add a picker/menu to the workspace row in the Workspaces card that would allow for the theme to be set directly. New workspaces would take on the theme that was active in the workspace that was active at the time of creation. After that, change the theme with the Theme menu (or shortcut) would only apply to the current workspace. We should then also add a new `Apply To All Workspaces` command to the bottom of the View > Theme menu, which would do what it says, apply the currently-chosen theme to all workspaces.

Today there is one theme for the whole app. It is stored in the `dev.tugapp.app` / `theme` tugbank key and applied once for the whole document.

---

## Evidence {#evidence}

**[F01] The theme is one global value, applied to the whole document.** `TugThemeProvider.setTheme` (`tugdeck/src/contexts/theme-provider.tsx`) does the following in order:
- applies the theme;
- calls `sendCanvasColor` so the host window matches;
- sets React state and calls `notifyThemeChange()`;
- writes `localStorage["td-theme"]`;
- calls `putTheme` to write the tugbank key.

The setter and getter are registered with `action-dispatch.ts`, and the `set-theme` and `next-theme` actions run through them. **(verified)**

**[F02] Applying a theme is asynchronous in both build modes.**
- In release builds, `activateProductionTheme` swaps the `href` of `<link id="tug-theme-override">` and waits for the stylesheet's `load` event before it resolves.
- In dev builds, `setTheme` POSTs to `/__themes/activate`. The Vite server then re-renders `virtual:tug-active-theme.css` and delivers it by hot module reload (HMR).

So neither path can apply a theme inside a synchronous commit. **(verified, read from `theme-provider.tsx` and `vite.config.ts`)**

**[F03] A workspace switch is one synchronous commit.** `DeckManager.activateSpace` (`tugdeck/src/deck-manager.ts`):
- swaps `deckState`;
- sets `activeSpaceId`;
- marks the canvas;
- calls `notify("activateSpace", "cut")`.

All of this happens inside one `_flipFirstResponder` callback. Parked workspaces stay mounted (their cards keep their live DOM), so the cards that become visible in that commit are already built. Any theme change that lands later than this commit shows the incoming cards in the outgoing workspace's theme for at least one frame. **(verified)**

**[F04] A workspace is already a persisted record, and adding an optional field is easy.**
- `serialize` (`tugdeck/src/serialization.ts`) writes each space as `{ id, name, focusedCardId?, deck }` inside a `version: 5` envelope.
- `parseSpaces` reads an entry field by field and treats a missing optional field as absent.

A `theme?` field fits the same way `focusedCardId?` does. **(verified)**

**[F05] At startup the theme is applied before first render, from the global key.** `main.tsx` does the following before React mounts:
- reads `readLayout` and `readTheme` from the tugbank cache;
- applies the theme with `activateProductionTheme` (release) or `syncDevActiveTheme` (dev);
- sends the canvas color.

The saved layout, which already names the active space, has been read by then. So the active space's own theme is available before first paint. **(verified)**

**[F06] An outside write to the theme key is applied live.** In `main.tsx`, `tugbankClient.onDomainChanged` watches `dev.tugapp.app` / `theme` and calls the registered setter when the value changes. A `currentTheme` guard stops `putTheme` from echoing back into an endless loop. **(verified)**

**[F07] The host builds the Theme submenu itself.** `AppDelegate.swift` lists the themes in two groups, dark then light, with a separator between them. Then come a separator and `Next Theme` (⇧⌘T, `view.nextTheme`). The checkmark comes from `activeThemeName`, which the deck keeps current through `publishActiveTheme` in `host-menu-state.ts`. `selectTheme` sends the `set-theme` control frame. **(verified)**

**[F08] The workspace row already has a trailing cluster and a `···` menu.** `cards-space-header.tsx` renders a `TugListRow`. Its trailing cluster holds the card and session tally badges and a `···` trigger. The trigger opens the same menu as a right-click: Rename, Delete and the other row verbs, sent to the root of the responder chain. **(verified)**

**[F09] Some consumers may cache theme-derived values.** Candidates are the sparkline colors, the canvas dot grid and the baked atom-chip images. They are expected to subscribe to `notifyThemeChange` (`theme-tokens.ts`). This has not been checked consumer by consumer. A cache held by a parked workspace's still-mounted cards is the specific risk. Listing every subscriber to `theme-tokens` and every reader of a computed style that caches its result would confirm or rule it out. **(inference, not verified)**

---

## Decisions {#decisions}

**[B01] The theme is a property of the workspace.** Each space record gets an optional `theme: string`, serialized in the v5 blob next to `focusedCardId` ([F04]). The theme on screen is always the active workspace's theme. A space with no `theme` field (every space in a layout saved before this change) takes the global key's value when it loads. So the first launch after this ships looks exactly as before.

**[B02] The global `dev.tugapp.app` / `theme` key mirrors the theme on screen.** It is rewritten whenever the on-screen theme changes, including on a workspace switch. This keeps the existing readers correct without teaching them about workspaces:
- the host canvas color;
- the `localStorage` / `putTheme` path;
- the reconciliation loop in `main.tsx` ([F06]).

An outside `tugbank write … theme <name>` therefore means "set the current workspace's theme". The echo guard has to treat a switch-driven write as already applied, so the mirror write does not re-enter the setter.

**[B03] Startup applies the active workspace's theme.** `main.tsx` takes the theme from the active space in the saved layout and falls back to the global key ([F05]). The first frame is in the right theme, with no flash and restyle.

**[B04] A new workspace takes the active workspace's theme.** `createSpace` copies the outgoing active space's theme onto the new record before it activates it. Creating a workspace never changes what is on screen.

**[B05] The Theme menu, ⇧⌘T and `set-theme` apply to the current workspace only.** They write the active space's `theme` and update the global mirror ([B02]). The Theme submenu's checkmark shows the current workspace's theme, through the existing `publishActiveTheme` path ([F07]).

**[B06] View > Theme ends with `Apply To All Workspaces`.**
- **Placement:** it goes at the bottom of the submenu, after `Next Theme`, behind its own separator.
- **What it does:** it sets every workspace's `theme` to the current workspace's theme. No confirmation.
- **Command:** it is a registered command, so it can carry a key equivalent later.
- **Enablement:** it is disabled when every workspace already has the current theme. The host reads that state from the deck's menu-state push, the same channel the checkmark uses. A disabled item tells the user something true; an enabled one that would do nothing tells them something false.

**[B07] The workspace row gets a theme swatch, and the `···` menu does not get a Theme item.**
- **The swatch:** a small chip in the row's trailing cluster ([F08]), drawn in that workspace's theme's canvas color.
- **The menu it opens:** a theme menu grouped like View > Theme (dark, then light).
- **Why a swatch:** it shows the setting as well as opening it, so a reader can scan the Workspaces list and see which workspace wears which theme without opening anything. A `···` menu item would only open it.
- **A parked workspace:** choosing a theme for it only writes that workspace's record. Nothing on screen repaints until the user switches to it. Choosing for the active workspace is the same as [B05].

**[B08] In release builds, a workspace switch changes the theme in the same commit as the cut.** The single swapped `<link>` ([F02]) is replaced by one `<link>` per theme that some workspace uses.
- **Loading:** these links are loaded ahead of time at startup and whenever a theme is first used, and every one except the active theme's is `disabled`.
- **Switching:** toggling `disabled` is synchronous once the sheet has loaded. So `activateSpace` flips it inside the commit described in [F03], then calls `notifyThemeChange()` and `sendCanvasColor`.
- **One code path:** `setTheme` ends in the same flip, so a theme change from the menu and a theme change from a switch share one path.
- **Base theme:** it continues to mean "no override enabled".
- **A theme not yet loaded:** the first use of a theme in a session may still wait for its sheet. That is allowed for a menu pick, because the user is choosing something new. It is never allowed on a switch, because every workspace's theme is loaded ahead of time.

**[B09] In dev builds, a theme change during a switch is allowed to lag at first.** The dev server's single HMR'd virtual module ([F02]) cannot flip synchronously. Fixing that means serving each theme as its own expanded module from `vite.config.ts` so dev can use the [B08] flip, which is real work. The lag is accepted for now, documented at the switch site, and revisited only if it bothers the user in daily use.

**[B10] Tests must sample the frame, not check the end state.** The claim in [B08] concerns the first frame after a switch. An app-test that only reads the final theme passes even when the incoming workspace flashes the wrong theme. The switch test records each frame and checks that the first frame after the cut is already in the incoming theme.

App-tests also cover:
- [B04] inheritance;
- [B06], on both the effect and the item's enablement;
- [B07], picking a theme for a parked workspace without repainting;
- the theme surviving a relaunch ([B03]).

---

## Open Questions {#open-questions}

- **Does any consumer of theme-derived values hold a stale cache across a switch?** See [F09]. The answer may add a refresh step to the switch, but it does not change the design. Settle it by reading the subscribers while implementing, and confirm with the frame-sampled switch test ([B10]) on a deck that shows a sparkline and an atom chip.

---

## Non-goals {#non-goals}

- **A theme setting in the Settings card.** It was considered and dropped. A "default theme for new workspaces" setting would conflict with [B04], where a new workspace inherits the active workspace's theme, and that is the rule the user chose.
- **A Theme item in the row's `···` menu.** Rejected in favor of the swatch ([B07]). One door is enough, and the swatch is the one that also shows the setting.
- **Rendering different themes side by side.** Only the active workspace is visible, so a theme stays document-wide. Scoping theme tokens to a subtree, so that a parked workspace's hidden DOM or an overview thumbnail carries its own theme, is not part of this work.
- **Synchronous theme switching in dev builds now.** Deferred under [B09].

---

## Exit {#exit}

**An arc.** A natural order for the first steps:

1. **Model and storage:** `theme?` on the space record, serialization and parse, the global-key mirror ([B01], [B02]), startup ([B03]) and inheritance in `createSpace` ([B04]).
2. **Switch-time application in release builds:** the per-theme `<link>` set and loading themes ahead of time, the flip inside `activateSpace`'s commit, and `setTheme` reduced to the same flip ([B08]), with the frame-sampled test ([B10]).
3. **Menu semantics:** `set-theme` and `next-theme` act on the current workspace, the checkmark shows it ([B05]), and `Apply To All Workspaces` is added to the host menu with its enablement ([B06]).
4. **The row swatch and its menu** in `cards-space-header.tsx` ([B07]).

Step 2 depends on step 1. Steps 3 and 4 depend on step 1 but not on each other.
