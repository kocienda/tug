# Workspace Theme Menu Polish

**Purpose:** The theme menu on a workspace row works, but it applies a theme more slowly than View > Theme, sometimes flashes the content, and its chips do not tell the themes apart.

---

## Purpose {#purpose}

Per-workspace themes have shipped. The user tried the theme swatch on a workspace row in the Workspaces card and reported three things:

> - Switching themes from the workspace row menu seems *slower* than doing so from the Swift menu, not by a lot, but noticeable.
> - Switching themes from the workspace row menu sometimes *flashes the content*, especially when going from a light theme to a dark theme.
> - The color chips in the workspace row menu should show the *key color* for the theme, not just a light/dark ship.

In the screenshot that came with the report, every dark theme's chip is near-black and every light theme's chip is a similar mid-gray. Nothing in the menu says which group is which apart from a separator.

---

## Evidence {#evidence}

**[F01] The row menu applies the theme only after a 350 ms blink.** The swatch's menu is a `TugPopupMenu` (`tugdeck/src/components/tugways/internal/tug-popup-menu.tsx`).
- When an item is picked, `handleItemSelect` plays a double-blink on the item with `animate(…, { duration: "--tug-motion-duration-slow" })`. The comment there gives that duration as 350 ms.
- The caller's `onSelect` runs only in `animate(…).finished.then(…)`, so `chooseSpaceTheme` and the theme change it starts begin after the blink has finished.
- From `onSelect` on, the two menus share one path: `applyTheme`, then the stylesheet flip and `finishThemeChange` in `theme-provider.tsx`. AppKit's own menu blink is much shorter.

So the delay the user feels is most likely the blink. This was read from the code; the two paths have not been timed. **(verified, from the code)**

**[F02] On the row path, the theme flips while the menu is closing.**
- In the blink's `.then`, `onSelect(id)` is followed at once by the close (`setOpen(false)`).
- `applyTheme` resolves a microtask later and flips the stylesheet.
- The same moment holds three other pieces of work: Radix removing the menu, `onCloseAutoFocus` returning focus to the swatch, and the Workspaces list re-rendering, because `setSpaceTheme` changed the snapshot.

The Swift path has none of these alongside its flip. **(verified, from the code)**

**[F03] Nothing that reads the theme rebuilds the cards.** Nothing outside `theme-provider.tsx` calls the theme context hook. No element is keyed on the theme name, so a theme change remounts nothing. The only subscribers to `notifyThemeChange` are the atom chip re-bake and the sparkline colors. So the flash is not a remount. **(verified, by grep)**

**[F04] The cause of the flash is not known.** Two candidates fit the report and neither has been measured:
- **(a) Uneven repaint.** In the crowded close moment of [F02], the composited layers (cards, sidebars) repaint a frame behind the page itself, or the window background changes before the web content does. `sendCanvasColor` sends the new canvas color to the Swift host in `finishThemeChange`. Either would show most when going from light to dark.
- **(b) A first-use fetch.** The theme picked from the row had not been used yet this session, so its stylesheet was fetched and flipped while the menu was closing. The themes picked from the Swift menu may already have been loaded.

A test that records every frame would separate the two. **(inference, not verified)**

**[F05] The chip shows the canvas color, which does not tell themes apart.**
- `ThemeSwatch` in `cards-space-header.tsx` fills the chip with `themeCatalogEntry(theme).canvasColor`. That value is each stylesheet's `--tugx-host-canvas-color`.
- The five dark values run from `#111816` to `#1b1813`. The five light themes' canvas colors are dark grays, from `#3d4347` to `#454145`.
- That matches the screenshot: two groups of near-identical chips. **(verified)**

**[F06] Each theme has its own Key hue, in one token.** `tuglaws/theme-engine.md` defines a per-theme **Key** hue: the color of selection, toggle-on, links and filled action buttons. Every theme file declares it as `--tug7-surface-control-primary-filled-action-rest`:

| Dark | Key hue | Light | Key hue |
|---|---|---|---|
| Ironclad | cobalt | Sloop | blue |
| Caravel | seafoam | Ketch | iris |
| Barque | purple | Skiff | seafoam |
| Galleon | cerulean | Kayak | sapphire |
| Collier | rose | Pinnace | rose |

The value is written as `--tug-color(<hue>, l: 650, c: 400)` in dark themes and `c: 320` in light ones. So the catalog needs it resolved to a concrete color, the same way it already holds the canvas color. Within each group, every hue is different. **(verified)**

**[F07] The popup menu already supports section headings.** `TugPopupMenuEntry` has a `{ type: "label", label }` entry, drawn as a non-interactive `.tug-menu-label` heading. Today `themeMenuItems` separates the two groups with a bare `{ type: "separator" }` and no heading. **(verified)**

---

## Decisions {#decisions}

**[B01] The row's theme menu applies the theme when it is clicked, and the blink still plays.**
- Add an opt-in prop to `TugPopupMenu` that calls `onSelect` when the blink starts instead of when it finishes. Close the menu at the end of the blink, as it does today.
- The swatch's menu turns the prop on. Every other menu keeps its current timing.
- **Why:** the blink is the confirmation that a pick landed, and the user should still see it. What is wrong is making the theme change wait for it ([F01]).
- **A side effect:** this also takes the flip out of the close moment that [F02] describes. That close moment is one of the candidate causes of the flash.
- The prop needs a precise name and doc comment. The `blinkingRef` guard has to stay up for as long as it does today, so that a chain dispatch started by `onSelect` cannot dismiss the menu early.

**[B02] Measure the flash before fixing it, and measure only after [B01] has landed.**
- Write an app-test that starts a `requestAnimationFrame` recorder before the press. It then picks a dark theme while a light one is showing, through the real swatch menu with a real pointer.
- Each frame, it records the background colors of the document root, of one card, and of a sidebar.
- The same test then makes the same change through the native View > Theme item, for comparison.
- **Which fix, if any:**
  - **No mixed frame after [B01]:** the flash is fixed, and the test stays as the guard against it coming back.
  - **Layers disagree within one frame:** cause [F04](a). Fix it where the stylesheet flip happens.
  - **Only a theme's first pick flashes:** cause [F04](b). Fix it by loading every shipped theme's stylesheet ahead of time while the menu is open.
- **Why:** a fix written from a guess cannot be shown to work. A hop or flash "verified" by a green end-state test has been wrong in this codebase before. The test has to sample frames.

**[B03] The chip is filled with the theme's Key hue, and nothing else.**
- `theme-catalog.ts` gains a `keyColor` for each theme: the resolved value of `--tug7-surface-control-primary-filled-action-rest` ([F06]).
- `theme-catalog.test.ts` checks it against each stylesheet, the same way it checks `canvasColor`.
- `ThemeSwatch` fills with `keyColor`, on the row and in every menu item.
- The hairline the chip already has stays, so a chip stays visible against a surface of the same color.
- **Why:** the user decided it. The Key hue is the color a user sees in a theme, and the canvas color is not ([F05]).

**[B04] The menu labels its Dark and Light groups.**
- `themeMenuItems` puts a `Dark` heading before the dark themes and a `Light` heading before the light themes, using the menu's existing `label` entry ([F07]).
- **Why:** two hues are shared across the groups (Caravel and Skiff are both seafoam; Collier and Pinnace are both rose). Within one group no two chips share a hue, so once each group is labelled, every chip in the menu is distinct where it sits. The light/dark split is already the menu's structure, so labelling it is enough.
- The row's own swatch is a single chip with no group around it. Its `aria-label` already names the theme.

---

## Non-goals {#non-goals}

- **A chip that combines the Key hue with the theme's ground** (a Key dot on a canvas-colored square). It was proposed to tell the shared hues apart, and rejected: labelling the menu's groups ([B04]) already does that, and a plain Key fill is simpler to read.
- **Shortening the popup menu's blink for every menu.** The blink's length is an app-wide motion decision. [B01] fixes this menu's timing without changing any other menu.
- **Changing View > Theme in the Swift host.** The native menu is not the slow one, and it shows no chips.
- **Fixing the flash before [B02]'s measurement.** Its cause is still open ([F04]).

---

## Exit {#exit}

**An arc.** The natural order:

1. **Fire on press** ([B01]): the new `TugPopupMenu` prop, turned on for the swatch's menu.
2. **Key chips and group headings** ([B03], [B04]): `keyColor` in the catalog and its test, `ThemeSwatch` filled with it, and the Dark and Light headings in `themeMenuItems`. Extend `at0665`, which already reads the swatch colors and the menu's items, to check the new colors and the headings.
3. **The flash probe** ([B02]): the frame-sampled app-test comparing the row menu with the native menu, run after step 1. Then the fix the measurement names, or no fix if step 1 already removed the flash.

Step 3 depends on step 1. Step 2 is independent of both.
