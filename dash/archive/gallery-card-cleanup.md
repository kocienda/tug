# Gallery Card File Cleanup

*Every Component Gallery card gets its own file. No exceptions, no mega-files.*

---

## The Rule

Each gallery card lives in its own file under `tugdeck/src/components/tugways/cards/`, following the naming convention:

```
gallery-{component}-content.tsx      — content component
gallery-{component}-content.css      — styles (only if needed)
```

Card registrations live in a single shared file:

```
gallery-registrations.tsx            — registerGalleryCards() + GALLERY_DEFAULT_TABS
```

Shared gallery styling lives in:

```
gallery.css                          — layout, controls, matrix, section styles
```

---

## Current Problem

`gallery-card.tsx` is a 1200-line mega-file containing five unrelated gallery content components, all card registrations, shared constants, and helper functions. Finding the TugPushButton gallery means hunting through a file named "gallery-card". Meanwhile, most other components already have their own `gallery-{component}-content.tsx` files.

### Files that already follow the convention
- `gallery-checkbox-content.tsx`
- `gallery-switch-content.tsx`
- `gallery-input-content.tsx`
- `gallery-label-content.tsx`
- `gallery-marquee-content.tsx`
- `gallery-skeleton-content.tsx`
- `gallery-popup-button-content.tsx`
- `gallery-animator-content.tsx`
- `gallery-cascade-inspector-content.tsx`
- `gallery-mutation-tx-content.tsx`
- `gallery-observable-props-content.tsx`
- `gallery-palette-content.tsx`
- `gallery-scale-timing-content.tsx`
- `gallery-theme-generator-content.tsx`

### Files that need renaming
| Current | New |
|---------|-----|
| `gallery-card.css` | `gallery.css` |
| `gallery-badge-mockup-content.tsx` | `gallery-badge-content.tsx` |
| `gallery-badge-mockup.css` | `gallery-badge-content.css` |
| `gallery-popup-button.css` | `gallery-popup-button-content.css` |

### Content to extract from `gallery-card.tsx`
| Content | New file |
|---------|----------|
| `GalleryButtonsContent` + `SubtypeButton` + button constants | `gallery-push-button-content.tsx` |
| `GalleryChainActionsContent` | `gallery-chain-actions-content.tsx` |
| `GalleryDefaultButtonContent` | `gallery-default-button-content.tsx` |
| `GalleryTabBarContent` | `gallery-tab-bar-content.tsx` |
| `GalleryTitleBarContent` | `gallery-title-bar-content.tsx` |
| `registerGalleryCards()` + `GALLERY_DEFAULT_TABS` | `gallery-registrations.tsx` |

After extraction, `gallery-card.tsx` is deleted.

---

## After Cleanup

Every file in `cards/` will be one of:
- `gallery-{component}-content.tsx` — one component's gallery card
- `gallery-{component}-content.css` — that card's styles (if needed)
- `gallery-registrations.tsx` — all card registrations
- `gallery.css` — shared gallery layout styles
- `hello-world-card.tsx` — the hello world card (not a gallery card)
