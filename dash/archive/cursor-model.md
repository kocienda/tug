# Cursor Model

System-wide audit and design for cursor icons across cards and components.

## Problem

The browser's default `cursor: auto` shows an I-beam over any text content, including text that is `user-select: none` (non-selectable chrome). This makes the app feel like a web page — the I-beam implies the text can be selected or edited when it cannot. A native macOS app shows a pointer (arrow) over non-selectable UI and an I-beam only over editable or selectable text fields.

After the selection model rework (items 6 and 7 of text-component-fit-and-finish), we have three selection categories (selectable, copyable, chrome) and explicit `user-select: none` on `.tugcard-content`. The cursor should match these categories.

## Design Principle

**The cursor tells the user what will happen if they click.** It is not decoration — it communicates affordance.

| Cursor | Meaning | When to show |
|--------|---------|-------------|
| `default` (arrow) | Click, no text interaction | Chrome: buttons, labels, section headers, toolbars, card backgrounds, empty space |
| `text` (I-beam) | Click to place caret or drag to select text | Selectable content: text inputs, textareas, contentEditable, markdown view content |
| `pointer` (hand) | Click to activate | Interactive controls that aren't text: links inside markdown, clickable list items |
| `grab` / `grabbing` | Drag to move | Card title bar (already implemented) |
| `not-allowed` | Action is blocked | Disabled controls (already implemented on most components) |
| `crosshair` | Precision pick | Color pickers (already implemented) |
| `ew-resize` / `ns-resize` / `nwse-resize` | Drag to resize | Resize handles, textarea resize grip (already implemented) |

## Current State

### What's correct

These components already set appropriate cursors:

| Component | Cursor | Status |
|-----------|--------|--------|
| Card title bar | `grab` / `grabbing` | Correct |
| TugButton | `pointer` (rest), `not-allowed` (disabled) | Correct |
| TugCheckbox | `pointer` (rest), `not-allowed` (disabled) | Correct |
| TugSwitch | `pointer` (rest), `not-allowed` (disabled) | Correct |
| TugSlider thumb/track | `pointer` | Correct |
| TugAccordion trigger | `pointer` (rest), `not-allowed` (disabled) | Correct |
| TugChoiceGroup segments | `pointer` (rest), `not-allowed` (disabled) | Correct |
| TugOptionGroup items | `pointer` (rest), `not-allowed` (disabled) | Correct |
| TugLabel (with htmlFor) | `pointer` (clicks focus the target input) | Correct |
| TugLabel (without htmlFor) | `default` | Correct |
| TugInput | inherits `text` from browser (input element default) | Correct |
| TugTextarea | inherits `text` from browser | Correct |
| TugInput (disabled) | `not-allowed` | Correct |
| TugTextarea (disabled) | `not-allowed` | Correct |
| TugInput (readOnly) | `default` | Correct |
| TugTextarea (readOnly) | `default` | Correct |
| Menu items | `default` (rest), `not-allowed` (disabled) | Correct |
| Tab bar tabs | `default` | Correct |
| Color strips | `crosshair` | Correct |

### What's wrong

| Element | Current cursor | Should be | Why |
|---------|---------------|-----------|-----|
| `.tugcard-content` (chrome text) | `auto` (I-beam over text) | `default` (arrow) | Non-selectable chrome should never show I-beam |
| `body` / app background | `auto` (I-beam if text present) | `default` | No text interaction anywhere outside cards |
| TugMarkdownView content | `auto` (I-beam) | `text` | Content IS selectable — should show I-beam explicitly |
| TugPromptInput container (outside editor) | `auto` (I-beam) | `default` | Only the contentEditable area should show I-beam |
| TugBulletin (informational) | `default` | `default` | Correct, but verify |
| TugValueInput | inherits from browser | `text` | Editable — should show I-beam explicitly |

## Implementation Plan

### Step 1: Set `cursor: default` on the baseline

Set `cursor: default` on `body` and `.tugcard-content`. This makes the arrow cursor the default everywhere. Components that need a different cursor override it explicitly.

```css
/* globals.css */
body {
  cursor: default;
}

/* tug-card.css */
.tugcard-content {
  cursor: default;
}
```

This single change fixes the most visible problem: I-beam over chrome text.

### Step 2: Set `cursor: text` on selectable components

Selectable components that lost their I-beam (because they now inherit `default` from the card content area) need to set it explicitly:

| Component | CSS rule |
|-----------|---------|
| `.tugx-md-scroll-container` | `cursor: text` |
| `.tug-prompt-input-editor` | `cursor: text` (may already get this from contentEditable UA styles) |

Native `<input>` and `<textarea>` elements get `cursor: text` from the browser's UA stylesheet, so `.tug-input` and `.tug-textarea` should be unaffected. Verify after step 1.

### Step 3: Audit edge cases

After steps 1-2, walk through every gallery card tab and verify:

- [ ] All chrome text shows arrow cursor
- [ ] All text inputs show I-beam cursor
- [ ] All textareas show I-beam cursor
- [ ] Prompt input editor shows I-beam, prompt input chrome shows arrow
- [ ] Markdown view content shows I-beam (drag-to-select affordance)
- [ ] Markdown view blocks with code show I-beam
- [ ] Buttons show pointer cursor
- [ ] Disabled controls show not-allowed cursor
- [ ] Slider thumb/track shows pointer cursor
- [ ] Card title bar shows grab cursor
- [ ] Resize handles show resize cursors
- [ ] Tab bar tabs show default cursor
- [ ] Empty card background shows default cursor
- [ ] Canvas background (between cards) shows default cursor
- [ ] Copyable labels show default cursor (not pointer — right-click copy, not click)

### Step 4: Document the cursor conventions

Add a section to `tuglaws/component-authoring.md`:

- "Chrome components inherit `cursor: default` from `.tugcard-content`."
- "Selectable components set `cursor: text` in their CSS."
- "Interactive controls set `cursor: pointer` in their CSS."
- "Disabled controls set `cursor: not-allowed`."
- "Never leave `cursor: auto` on any element — it shows I-beam over text, which implies selectability."

## Key Files

- `tugdeck/src/globals.css` (add `cursor: default` to body)
- `tugdeck/src/components/tugways/tug-card.css` (add `cursor: default` to `.tugcard-content`)
- `tugdeck/src/components/tugways/tug-markdown-view.css` (add `cursor: text`)
- `tugdeck/src/components/tugways/tug-prompt-input.css` (verify editor cursor)
- `tuglaws/component-authoring.md` (document conventions)
