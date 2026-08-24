# Adopt React + shadcn/ui for Tugdeck

Replace tugdeck's vanilla TypeScript DOM manipulation with React components
and shadcn/ui controls. Adopt Tailwind CSS as the styling framework, bridging
the existing Tuglook design token system into shadcn's CSS variable theming.

## Why the Vanilla TS Decision No Longer Holds

The original `component-roadmap.md` declared "vanilla TypeScript — no React,
no Svelte, no framework" when tugdeck was a four-panel terminal dashboard.
That was a defensible minimalism choice for rendering a git status card and
a file event log.

Then the scope changed. Tugdeck grew to ~19,000 lines of TypeScript across
33 source files and 23 test files. It now includes:

- A conversation UI with message rendering, code blocks, streaming indicators
- Question forms with radio buttons, checkboxes, text inputs
- Tool approval prompts with allow/deny actions
- File attachment handling with drag-and-drop and paste
- Settings panels with theme selection, toggles, path pickers
- Dropdown menus with toggle items and select groups
- A developer card with action buttons and progress indicators
- Session persistence via IndexedDB
- Tab bars with drag reorder

Every one of these features is built with raw `document.createElement` calls,
manual event listener wiring, and hand-managed DOM state. The conversation
card alone is 990 lines. The question card is 322 lines of createElement/
appendChild that would be ~60 lines of JSX with shadcn's RadioGroup, Checkbox,
and Button.

The vanilla TS approach now costs more than it saves:

| What you avoid with no framework | What you pay instead |
|----------------------------------|---------------------|
| ~45 KB gzipped bundle overhead | 19K lines of manual DOM code |
| React as a dependency | Reimplementing React's job by hand |
| Build complexity | No component reuse, no composition model |
| Learning curve | Every new feature requires boilerplate DOM wiring |

The project is past the crossover point. Continuing to build interactive UI
without a component model means either (a) writing a custom component library
from scratch (which is just React with extra steps), or (b) accepting that
every new feature takes 3-5x longer than it should.

## What We Adopt

### React 19

The rendering layer. Gives us:
- Declarative UI via JSX
- Component composition and reuse
- Built-in state management (useState, useReducer, useContext)
- Efficient DOM diffing and updates
- A massive ecosystem of compatible libraries

### shadcn/ui

The component library. Not a dependency — a collection of copy-pasted React
components that live in our codebase at `tugdeck/src/components/ui/`. We own
the source. We can modify any component. Key components we'll use immediately:

- **Button** — primary, secondary, danger, ghost variants
- **Input** — styled text input
- **Textarea** — styled multiline input
- **Checkbox** — custom rendered, accessible
- **RadioGroup** — custom rendered radio buttons
- **Switch** — toggle for boolean settings
- **DropdownMenu** — menu with items, checkboxes, radio groups
- **Dialog** — modal dialogs (about card, confirmations)
- **Card** — container component for card content areas
- **Tabs** — tab navigation
- **ScrollArea** — custom scrollbar styling
- **Select** — custom dropdown select
- **Tooltip** — hover tooltips

### Tailwind CSS v4

Required by shadcn/ui. Also genuinely useful — replaces the 2,468 lines of
hand-written CSS with utility classes. The Tuglook design token system maps
naturally into Tailwind's theme configuration via CSS custom properties.

### Lucide React

Already using `lucide` (the vanilla package). Switch to `lucide-react` for
React-native icon components. Same icons, same tree-shaking.

### Radix UI

Comes with shadcn/ui. Provides the accessible primitive behavior (keyboard
navigation, focus management, ARIA attributes) for every interactive component.
This is the thing we'd otherwise have to build from scratch.

## What We Keep

### WebSocket connection layer

`connection.ts` and `protocol.ts` are pure TypeScript dealing with binary
WebSocket frames. No DOM, no UI. These stay as-is and get wrapped in a React
context provider that exposes connection state and frame dispatch to components.

### Canvas layout engine

`deck-manager.ts` (1981 lines), `snap.ts` (517 lines), `card-frame.ts`,
and the snapping/positioning geometry are pure math and canvas manipulation.
These continue to manage card positions and sizing. React components render
*inside* the card containers that the layout engine positions.

### xterm.js

The terminal card wraps xterm.js, which manages its own DOM. This stays as
an imperative integration inside a React component (useEffect + ref pattern).

### Tuglook design tokens

The three-tier token system (palette → semantic → component) maps directly
to shadcn's CSS variable theming. shadcn already uses CSS custom properties
for all colors. We bridge them:

```css
:root {
  /* Tuglook tokens (source of truth) */
  --tl-text: #e6eaee;
  --tl-accent: #ff8a38;
  --tl-accent-cool: #35bcff;
  --tl-surface-content: #1a1d22;
  --tl-surface-control: #23262d;
  --tl-border: #5e656e;

  /* shadcn variables (mapped from Tuglook) */
  --background: var(--tl-surface-content);
  --foreground: var(--tl-text);
  --primary: var(--tl-accent);
  --primary-foreground: var(--tl-text-inverse);
  --secondary: var(--tl-surface-control);
  --secondary-foreground: var(--tl-text);
  --destructive: var(--tl-danger);
  --border: var(--tl-border);
  --input: var(--tl-border);
  --ring: var(--tl-accent-cool);
  --radius: var(--tl-radius-md);
}

.td-theme-bluenote {
  /* Override Tuglook tokens; shadcn variables follow automatically */
  --tl-accent: #4a9eff;
  /* ... */
}

.td-theme-harmony {
  --tl-text: #1a1d22;
  /* ... */
}
```

Three themes work through the same class-on-body mechanism. No changes to
the theme switching logic.

## Build Toolchain

### Bun + Vite

Use Vite as the dev server and production bundler, with Bun as the runtime
and package manager. This is the most battle-tested path for React + shadcn:

- `bun install` — package management
- `bun run dev` — starts Vite dev server with HMR
- `bun run build` — production build via Vite + Rollup
- Tailwind v4 via `@tailwindcss/vite` plugin (official, first-party)
- JSX transform handled by Vite's React plugin

The dist output (HTML + JS + CSS) continues to be embedded in the tugcast
Rust binary via rust-embed. The binary size impact is minimal — the entire
React + shadcn bundle is ~75-95 KB gzipped, ~200-400 KB uncompressed.

### Why Vite, not pure Bun bundler?

Bun's native bundler can handle JSX, but Tailwind v4 integration requires
a community plugin (`bun-plugin-tailwind`) that isn't production-proven.
Vite has first-party Tailwind v4 support via `@tailwindcss/vite` and gives
us HMR for free. This is a pragmatic choice — if Bun's bundler matures its
Tailwind support, we can switch later. The source code is the same either way.

### New Dependencies

| Package | Purpose | Size (gzip) |
|---------|---------|-------------|
| `react` + `react-dom` | Rendering | ~45 KB |
| `radix-ui` | Accessible primitives | ~15-25 KB (tree-shaken) |
| `tailwindcss` | Utility CSS | ~8-15 KB (purged) |
| `class-variance-authority` | Component variants | ~1 KB |
| `clsx` + `tailwind-merge` | Class merging | ~3 KB |
| `lucide-react` | Icons (replaces `lucide`) | ~2-5 KB (tree-shaken) |
| `@vitejs/plugin-react` | Vite React plugin | dev only |
| `@tailwindcss/vite` | Vite Tailwind plugin | dev only |

**Total production bundle increase: ~75-95 KB gzipped.**

### Removed Dependencies

| Package | Reason |
|---------|--------|
| `lucide` | Replaced by `lucide-react` |
| `isomorphic-dompurify` | React's JSX escaping handles most XSS; keep `dompurify` only for dangerouslySetInnerHTML in markdown rendering |

## Migration Strategy

The migration is incremental. React can mount inside vanilla TS containers.
We don't have to rewrite everything at once.

### Phase 0: Scaffold

Set up the React + shadcn + Tailwind + Vite toolchain alongside the existing
code. Create the Vite config, Tailwind config, `components.json`. Install
shadcn's base components (Button, Input, etc.). Map Tuglook tokens to shadcn
CSS variables. Verify the build produces embeddable dist output.

Create a React root that mounts inside the existing card content areas.
The deck-manager continues to own card positioning; React owns card content.

### Phase 1: Settings Card

The simplest card with the most native controls. Convert `settings-card.ts`
to a React component using shadcn RadioGroup (themes), Switch (dev mode),
Button ("Choose..."), and Card layout. This proves the full stack works
end-to-end: Tuglook tokens → shadcn theming → React rendering inside the
existing canvas layout.

### Phase 2: Question Card + Approval Prompt

Convert `question-card.ts` using shadcn RadioGroup, Checkbox, Input, Button.
Convert `approval-prompt.ts` using shadcn Button (primary + destructive
variants). These are self-contained components with clear before/after
comparisons.

### Phase 3: Conversation Card

The big one — 990 lines. Convert to React with:
- shadcn Textarea for message input
- shadcn Button for send/stop
- shadcn ScrollArea for the message list
- React state management for streaming indicators, message ordering
- Keep the markdown renderer (marked + DOMPurify) as a React component
  using dangerouslySetInnerHTML with sanitization
- Keep the Shiki code block highlighter as a React component

The attachment handler, tool card, and streaming state submodules all
become React components composed inside the conversation card.

### Phase 4: Remaining Cards

Convert git-card, files-card, stats-card, about-card, developer-card.
These are simpler display cards — mostly rendering data, few interactive
controls.

### Phase 5: Chrome Layer

Convert card-header, card-menu (now shadcn DropdownMenu), tab-bar (now
shadcn Tabs), and dock to React. This is the last phase because the chrome
layer is tightly coupled to the canvas layout engine. May require rethinking
how the deck-manager creates and positions card containers.

### Phase 6: Cleanup

Remove all old vanilla TS card implementations. Remove `cards.css`,
`cards-chrome.css`, `dock.css` — replaced by Tailwind utilities and shadcn
component styles. Keep `tokens.css` as the Tuglook token definitions (the
source of truth that feeds shadcn's CSS variables).

Rewrite tests using React Testing Library instead of the current happy-dom
DOM manipulation tests.

## What This Unlocks

Once React + shadcn is in place, every future feature is dramatically easier:

- **New form controls**: just `bunx shadcn@latest add slider` (or select,
  toggle, date-picker, etc.)
- **Dialogs and modals**: shadcn Dialog with portal rendering, focus trap,
  keyboard dismiss — all built in
- **Command palette**: shadcn Command component (cmdk integration)
- **Toast notifications**: shadcn Toast/Sonner
- **Resizable panels**: shadcn ResizablePanel (could eventually replace
  parts of the canvas layout engine)
- **Context menus**: shadcn ContextMenu with right-click support
- **Accessible by default**: every Radix-based component handles ARIA,
  keyboard navigation, focus management, and screen reader support
- **Consistent theming**: all components automatically respond to Tuglook
  theme changes through CSS variables
- **Faster development**: new UI features are composed from existing
  components, not built from raw DOM primitives

## Risks and Mitigations

### Bundle size increase
~75-95 KB gzipped is modest. The current xterm.js + shiki + marked bundle
is already substantial. The React overhead is a one-time cost that pays for
itself in reduced code volume.

### Migration disruption
The incremental strategy means no big-bang rewrite. Each phase produces a
working build. The canvas layout engine and WebSocket layer are untouched
during early phases.

### Tailwind learning curve
Tailwind is widely used and well-documented. The shadcn components come
pre-styled — we're not writing Tailwind from scratch, we're customizing
existing components.

### Two rendering models during migration
During phases 1-5, some cards are React and some are vanilla TS. This is
fine — the deck-manager already treats card content as opaque DOM. React
components mount via `createRoot` into the same container divs.

## File Structure After Migration

```
tugdeck/
├── index.html
├── vite.config.ts
├── tailwind.config.ts          # (if needed; Tailwind v4 may be CSS-only)
├── components.json             # shadcn configuration
├── src/
│   ├── main.tsx                # React root + deck initialization
│   ├── app.tsx                 # Top-level React component
│   ├── connection.ts           # WebSocket (unchanged, pure TS)
│   ├── protocol.ts             # Frame protocol (unchanged, pure TS)
│   ├── deck-manager.ts         # Canvas layout (unchanged, pure TS)
│   ├── snap.ts                 # Snap geometry (unchanged, pure TS)
│   ├── layout-tree.ts          # Layout types (unchanged, pure TS)
│   ├── serialization.ts        # State persistence (unchanged, pure TS)
│   ├── hooks/
│   │   ├── use-connection.ts   # WebSocket context hook
│   │   ├── use-feed.ts         # Feed subscription hook
│   │   └── use-theme.ts        # Theme context hook
│   ├── components/
│   │   ├── ui/                 # shadcn components (Button, Input, etc.)
│   │   ├── cards/
│   │   │   ├── conversation/
│   │   │   │   ├── conversation-card.tsx
│   │   │   │   ├── message-renderer.tsx
│   │   │   │   ├── code-block.tsx
│   │   │   │   ├── tool-card.tsx
│   │   │   │   ├── approval-prompt.tsx
│   │   │   │   ├── question-card.tsx
│   │   │   │   └── attachment-handler.tsx
│   │   │   ├── terminal-card.tsx
│   │   │   ├── git-card.tsx
│   │   │   ├── files-card.tsx
│   │   │   ├── stats-card.tsx
│   │   │   ├── settings-card.tsx
│   │   │   ├── developer-card.tsx
│   │   │   └── about-card.tsx
│   │   ├── chrome/
│   │   │   ├── card-header.tsx
│   │   │   ├── card-menu.tsx
│   │   │   ├── tab-bar.tsx
│   │   │   └── dock.tsx
│   │   └── lib/
│   │       └── utils.ts        # cn() helper for shadcn
│   └── styles/
│       ├── tokens.css          # Tuglook design tokens (source of truth)
│       └── globals.css         # Tailwind directives + shadcn variable mapping
└── package.json
```
