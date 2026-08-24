# T3.2 Remaining: Prompt Input Completion

*Final items for tug-prompt-input before moving to T3.3 (Stores) and T3.4 (tug-prompt-entry).*

---

## Audit: T3.2 Exit Criteria

Status of each exit criterion from [tide.md](tide.md) T3.2:

| Criterion | Status | Notes |
|-----------|--------|-------|
| Text input with atoms: caret, selection, undo/redo | ✅ Done | Native WebKit, `<img>` replaced elements |
| Atoms render as `<img>` with SVG: icons, text, theme | ✅ Done | tug-atom-img.ts, regenerateAtoms on theme change |
| Auto-resize (1 row → maxRows) | ✅ Done | autoResize(), growDirection prop |
| Prefix detection identifies route | ❌ Not started | First-character routing (`>`, `$`, `:`, `/`) |
| `@` file completion works | ✅ Done | CompletionProvider interface, mock in gallery |
| `/` slash command completion works | ❌ Not started | Needs a second trigger character + provider |
| Drag-and-drop file → atom | ✅ Done | Drop caret, caretRangeFromPoint, atom insertion |
| Copy/cut/paste preserves atoms | ✅ Done | HTML + plain text clipboard, insertHTML |
| Option+Arrow stops at atom boundaries | ✅ Done | Range.compareBoundaryPoints clamping |
| History navigation works | ✅ Done | HistoryProvider, Cmd+Up/Down |
| IME composition works | ✅ Done | _composing + _compositionJustEnded |
| Return/Enter key config with Shift | ✅ Done | Native newline, configurable submit/newline |
| No -webkit-user-modify | ✅ Done | Standard contentEditable |
| CSS Custom Highlight suppression | ✅ Done | ::highlight(card-selection) transparent |
| Token-compliant styling | ✅ Done | focusStyle, borderless, selection tokens |
| Gallery card with testing surface | ✅ Done | Spike retired, clean gallery card |
| Editing state persists [L23] | ✅ Done | captureState/restoreState via tugbank |

**Two gaps:** prefix detection and `/` slash command completion.

---

## Item 1: Slash Command Completion

**Goal:** Generalize the typeahead system to support multiple trigger characters, each with its own completion provider. Add `/` for command completion alongside the existing `@` for file completion.

**Architecture:** Approach A — multiple providers. Each trigger character maps to exactly one provider. When T3.3 connects real data sources, the wiring is one line per trigger.

### Sub-step 1.1: Replace single provider with provider map

**Engine (`tug-text-engine.ts`):**

Replace `completionProvider: CompletionProvider | null` with `completionProviders: Record<string, CompletionProvider>` (default `{}`).

Touchpoints to update:
- Line 285: config field declaration → `completionProviders: Record<string, CompletionProvider> = {}`
- Line 1117-1118: input handler guard `else if (this.completionProvider)` → `else if (Object.keys(this.completionProviders).length > 0)`

**Component (`tug-prompt-input.tsx`):**

Replace `completionProvider?: CompletionProvider` prop with `completionProviders?: Record<string, CompletionProvider>`.

Touchpoints:
- Props interface (line 72): rename prop, change type
- Destructuring (line 184): rename
- Engine mount (line 252): `engine.completionProviders = completionProviders ?? {}`
- Sync effect (line 338-340): same rename

### Sub-step 1.2: Generalize detectTypeaheadTrigger

**Current state:** `detectTypeaheadTrigger` (line 605) hardcodes `@`:
```typescript
if (text[range.start - 1] !== "@") return;
```

**Change:** Check the character before the caret against all keys in `this.completionProviders`. If it matches, activate typeahead with that trigger's provider.

```typescript
private detectTypeaheadTrigger(): void {
    const range = this.getSelectedRange();
    if (!range || range.start !== range.end) return;
    if (range.start === 0) return;
    const text = this.getText();
    const char = text[range.start - 1];
    const provider = this.completionProviders[char];
    if (!provider) return;
    // ... activate typeahead, store trigger + provider
}
```

**Typeahead state addition:** Add `trigger: string` and `provider: CompletionProvider | null` to the `_typeahead` object so `updateTypeaheadQuery` and `acceptTypeahead` know which provider to call.

Current `_typeahead` state (line 312-320):
```typescript
private _typeahead = {
    active: false,
    query: "",
    anchorOffset: 0,
    anchorRect: null as DOMRect | null,
    filtered: [] as CompletionItem[],
    selectedIndex: 0,
};
```

Add:
```typescript
    trigger: "",
    provider: null as CompletionProvider | null,
```

### Sub-step 1.3: Update updateTypeaheadQuery and acceptTypeahead

Both currently reference `this.completionProvider!`. Change to `this._typeahead.provider!`.

- `updateTypeaheadQuery` (line 651): `this._typeahead.filtered = this._typeahead.provider!(query)`
- `detectTypeaheadTrigger` (line 622): `this._typeahead.filtered = provider("")` and store `this._typeahead.provider = provider`
- `acceptTypeahead`: no change needed — it reads from `_typeahead.filtered` which is already populated by the active provider
- `cancelTypeahead`: reset `trigger` and `provider` to defaults

### Sub-step 1.4: Acceptance behavior per trigger

The `@` trigger inserts an atom and deletes the `@query`. The `/` trigger should do the same — insert a command atom and delete the `/query`. The `acceptTypeahead` method (line 660) already handles this generically using `_typeahead.anchorOffset` and `_typeahead.query`. No change needed — the trigger character is at `anchorOffset` and gets deleted along with the query.

However, slash commands may want to insert **text** rather than an **atom**. For example, `/commit` might insert the text "/commit" rather than an atom chip. This depends on what `CompletionItem.atom` contains — the provider controls this. For now, all completions produce atoms. This can be revisited when T3.3 provides real slash command data.

### Sub-step 1.5: Gallery card — add mock command provider

Add to the gallery card:

```typescript
const TYPEAHEAD_COMMANDS = [
  "/commit", "/review", "/help", "/clear", "/plan",
  "/implement", "/dash", "/compact", "/memory",
];

function galleryCommandCompletionProvider(query: string): CompletionItem[] {
  const q = query.toLowerCase();
  const cmds = q.length === 0
    ? TYPEAHEAD_COMMANDS.slice(0, 8)
    : TYPEAHEAD_COMMANDS.filter(c => c.toLowerCase().includes(q)).slice(0, 8);
  return cmds.map(c => ({
    label: c,
    atom: { kind: "atom" as const, type: "command", label: c, value: c },
  }));
}
```

Wire both providers:
```typescript
<TugPromptInput
  completionProviders={{
    "@": galleryFileCompletionProvider,
    "/": galleryCommandCompletionProvider,
  }}
  ...
/>
```

### Sub-step 1.6: Verify and test

- Type `@` → file completion popup appears (unchanged behavior)
- Type `/` → command completion popup appears
- Tab/Enter accepts, Escape cancels, arrows navigate (unchanged)
- Both triggers work in the same document (type text, then `@file`, then more text, then `/cmd`)
- Typeahead cancels correctly when switching between triggers
- Existing features unaffected (atoms, clipboard, history, IME)

---

## Item 2: Route Atoms

**Goal:** Make route prefixes visible, tangible, and deletable inside the editor. When the user types a route prefix as the first character, it becomes a **route atom** — a styled `<img>` element at position 0 that shows the active route and can be backspaced away.

**Status:** Sub-steps 2.1-2.5 (basic prefix detection with character consumption) are implemented and merged. This revision replaces the invisible-consumption model with visible route atoms.

**Route prefixes:**
- `>` → AI route (Claude Code)
- `$` → shell route (future)
- `:` → surface command route (local)
- `/` → slash command mode (implies `>` route, AND triggers `/` completion)

### Design: route atoms

A route atom is a regular atom `<img>` with `data-atom-type="route"` and a distinct visual treatment:
- Smaller than content atoms — just the route character, no icon, minimal padding
- Different color scheme — uses a dedicated token set (e.g., `--tug7-surface-atom-primary-normal-route-rest`) to distinguish from content atoms
- Always at position 0 — the engine enforces this

The engine and DOM treat route atoms identically to content atoms (they're `<img>` elements in the text flow). The distinction is semantic — consumers (tug-prompt-entry) check the first atom's type on submit.

### Sub-step 2.6: tug-atom-img — add route atom rendering

Add a `createRouteAtomImgElement(char: string)` function to `tug-atom-img.ts`:
- Renders the route character (e.g., `>`) as SVG text with no icon
- Uses route-specific theme tokens for bg/border/text color
- Narrower than content atoms (character + minimal padding)
- Sets `data-atom-type="route"` and `data-atom-label` to the character

Also add `routeAtomImgHTML(char: string)` for `insertHTML` usage.

### Sub-step 2.7: Theme tokens for route atoms

Define tokens in both brio.css and harmony.css:
```
--tug7-surface-atom-primary-normal-route-rest
--tug7-element-atom-border-normal-route-rest
--tug7-element-atom-text-normal-route-rest
```

These should be subtler than content atom tokens — perhaps the same background but a muted or accent-tinted border/text to mark them as structural rather than content.

### Sub-step 2.8: Engine — replace character consumption with route atom insertion

Revise `detectRoutePrefix()`:
- Instead of consuming the typed character, replace it with a route atom at position 0
- `setSelectedRange(0, 1)` + `execCommand("delete")` + `execCommand("insertHTML", false, routeAtomImgHTML(firstChar))`
- Fire `onRouteChange(firstChar)`
- For `/`: insert the route atom AND let the completion trigger fire (the `/` character is consumed by the atom insertion, but the typeahead trigger needs to activate — see below)

**`/` stacking detail:**
When `/` is typed as the first character:
1. `detectRoutePrefix` replaces it with a route atom → `onRouteChange("/")` fires
2. But the `/` text character is now gone (replaced by an atom), so `detectTypeaheadTrigger` won't see it
3. Solution: after inserting a route atom for a character that's also a completion trigger, explicitly activate the typeahead with that trigger's provider. This is a direct call to set up `_typeahead` state, not a detection — we know the trigger.

### Sub-step 2.9: Engine — enforce position 0 constraint

The route atom must stay at position 0:
- **Caret guard:** In the click handler or a selection-change observer, if the caret is at position 0 and there's a route atom, nudge it to position 1 (after the atom). This prevents typing before the route atom.
- **No drag:** Route atoms shouldn't be draggable to other positions. The existing atom click-select behavior is fine (click selects the atom, backspace deletes it).

### Sub-step 2.10: Engine — backspace on route atom clears the route

When the user deletes the route atom (backspace from position 1):
- The normal `execCommand("delete")` removes the atom
- The input handler detects the deletion and checks: was there a route atom at position 0 before, and is it gone now?
- If so, fire `onRouteChange(null)` (or `onRouteChange("")`) to signal the route was cleared

Implementation: track `_hasRouteAtom` as a boolean flag. Set it when a route atom is inserted. In the input handler's deletion path, if `_hasRouteAtom` was true and the first child is no longer a route atom `<img>`, fire `onRouteChange(null)` and clear the flag.

### Sub-step 2.11: Component and gallery card updates

**Component:**
- `onRouteChange` callback type changes to `(route: string | null) => void` to support clearing
- No other component changes — the engine handles everything

**Gallery card:**
- The route indicator already shows the current route via `routeRef`
- Update `handleRouteChange` to show "none" or `>` (default) when route is null
- Add visual feedback when route changes (the indicator updates via direct DOM write, already L06 compliant)

### Sub-step 2.12: getText and captureState behavior

`getText()` returns `TUG_ATOM_CHAR` for the route atom at position 0, just like any atom. `getAtoms()` returns it as the first atom with `type: "route"`. `captureState()` includes it in the serialized state.

On submit, tug-prompt-entry (T3.4) will:
1. Read `getAtoms()` — if `atoms[0].type === "route"`, extract `atoms[0].label` as the route character
2. Strip the route atom from the submitted text
3. Dispatch to the appropriate feed based on the route

This keeps the engine simple — it doesn't know about routes, it just renders atoms. The routing logic lives in the consumer.

### Sub-step 2.13: Verify and test

- Type `>` in empty editor → route atom appears at position 0, route indicator shows `>`
- Type `$` → route atom shows `$`
- Type `/` → route atom shows `/`, completion popup opens
- Cannot type before the route atom (caret nudged to position 1)
- Backspace at position 1 → route atom deleted, route indicator shows default
- Type `>hello world` → route atom `>` at position 0, "hello world" as text
- Content atoms after the route atom work normally (insert, select, delete)
- getText() returns `\uFFFChello world` — route atom is the first FFFC
- getAtoms()[0] has type "route", label ">"
- History navigation preserves route atoms
- Persistence preserves route atoms

---

## Item 3: Maximize Mode

**Goal:** Allow the prompt input to expand beyond its `maxRows` limit to fill available space, for serious prompt authoring.

**Rationale:** Prompt authoring is a first-class activity. Cramped input fields are a relic of form-based UIs. When the user wants to write a detailed prompt, the input should be able to grow to fill the available vertical space — potentially the entire card height — scrolling only when *that* bound is exceeded.

### Sub-step 3.1: Add `maximized` prop and data attribute

**Component (`tug-prompt-input.tsx`):**

New prop:
```typescript
/**
 * Expand the editor to fill available container space.
 * The container must be a flex column with a constrained height.
 * When true, maxRows is ignored and the editor fills the flex parent.
 * @default false
 */
maximized?: boolean;
```

Add to destructuring with default: `maximized = false,`

Set `data-maximized` on both the wrapper (`.tug-prompt-input`) and the editor div:
```tsx
<div data-slot="tug-prompt-input" data-maximized={maximized || undefined} ...>
  ...
  <div className="tug-prompt-input-editor" data-maximized={maximized || undefined} ...>
```

The wrapper needs the attribute for flex layout. The editor needs it for the overflow/height behavior.

### Sub-step 3.2: CSS for maximized state

**`tug-prompt-input.css`:**

The wrapper becomes a flex column that fills its parent:
```css
.tug-prompt-input[data-maximized] {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
```

The editor fills the wrapper and scrolls:
```css
.tug-prompt-input-editor[data-maximized] {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
```

`flex: 1` + `min-height: 0` is the standard pattern for a flex child that fills available space and scrolls when content exceeds it. The parent's constrained height (from the card content area or gallery section) provides the boundary.

### Sub-step 3.3: Engine — autoResize skips when maximized

**`tug-text-engine.ts`:**

New config field:
```typescript
maximized = false;
```

In `autoResize()`, add an early return:
```typescript
private autoResize(): void {
    if (this.maximized) {
        // Maximized: CSS flex handles sizing, just ensure overflow is auto
        this.root.style.height = "";
        this.root.style.overflowY = "auto";
        this.root.style.marginTop = "";
        return;
    }
    // ... existing logic
}
```

When maximized:
- No inline height manipulation (flex handles it)
- `overflow-y: auto` always (content scrolls when it exceeds the flex-constrained height)
- No margin-top (grow direction is irrelevant — the editor fills all available space)

**Public relayout method:**

Add a public `relayout()` on `TugTextEngine` that calls `autoResize()`:
```typescript
/** Re-evaluate sizing. Called by the component when external conditions change (e.g., maximize toggle). */
relayout(): void {
    this.autoResize();
}
```

This is needed because toggling maximize OFF must restore the correct inline height based on content — CSS can't measure `scrollHeight`. Without this, the editor sits at `min-height` until the next input event. The `relayout()` call from `useLayoutEffect` is a sync DOM write during the commit phase — L03 and L06 compliant. It preserves user-visible content that would otherwise clip (L23).

**Component sync:**

Wire at mount: `engine.maximized = maximized;`

Add sync effect:
```typescript
useLayoutEffect(() => {
    if (engineRef.current) {
        engineRef.current.maximized = maximized;
        engineRef.current.relayout();
    }
}, [maximized]);
```

When toggling ON: `relayout()` → `autoResize()` → early return clears inline styles, CSS flex takes over.
When toggling OFF: `relayout()` → `autoResize()` → measures `scrollHeight`, restores correct inline height and overflow. No visual glitch.

### Sub-step 3.4: Gallery card — maximize toggle

Add a maximize button and a demo container with constrained height.

**Container:** The maximize feature requires the parent to be a flex column with a constrained height. In production, tug-prompt-entry inside a card provides this naturally. For the gallery demo, wrap the editor section in a fixed-height flex container when maximized:

```tsx
<div style={maximized ? { display: "flex", flexDirection: "column", height: "300px" } : undefined}>
    <div className="prompt-input-toolbar">...</div>
    <TugPromptInput maximized={maximized} ... />
</div>
```

When not maximized, no wrapper styles — the editor uses its normal autoResize behavior. When maximized, the 300px container provides the boundary. This is an honest test harness, not a responsive layout demo.

**Toggle button** in the toolbar:
```tsx
<TugPushButton size="sm" emphasis="ghost" onClick={() => setMaximized(m => !m)}>
    {maximized ? "Minimize" : "Maximize"}
</TugPushButton>
```

`maximized` is `useState<boolean>(false)`. This is a configuration prop, not appearance state — the visual change comes from `data-maximized` + CSS (L06).

### Sub-step 3.5: Verify and test

- Toggle maximize → editor expands to fill the container height
- Type many lines → editor scrolls within the container bounds
- Toggle back → editor returns to maxRows behavior
- Atoms, typeahead, history, drag-drop all work in maximized mode
- autoResize doesn't set inline height when maximized
- Theme change works (regenerateAtoms still fires)
- Persistence works (captureState/restoreState unaffected)

---

## Execution Order

1. **Slash command completion** — ✅ Done. Generalized typeahead to multiple triggers.
2. **Route atoms** — ✅ Done. Visible route prefixes as styled atoms at position 0.
3. **Maximize mode** — CSS flex-driven expansion. autoResize stands down when maximized; CSS `flex: 1` + `min-height: 0` fills available space.

All three items prepare tug-prompt-input for integration into T3.4 (tug-prompt-entry).

---

## Exit Criteria (for this remaining work)

- `/` trigger opens command completion with a separate provider
- Multiple trigger characters work simultaneously (`@` and `/`)
- First-character prefix detection fires `onRouteChange` callback
- Route prefixes are consumed (not displayed in the editor)
- `maximized` prop expands the editor to fill available container space
- Gallery card demonstrates all three features with mock data
- Existing features (atoms, clipboard, IME, history, drag-drop) unaffected
