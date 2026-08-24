# Component Roadmap 2: tugcode + Conversation Frontend

Continuation of `component-roadmap.md`. Phases 1-3 delivered the terminal bridge, multi-card deck, and stats/polish/resilience. This document covers the next evolution: build toolchain modernization, UX polish, a single-command launcher, and a structured conversational interface to Claude powered by the Claude Agent SDK.

## Naming Convention (Extended)

| Name | Role | Description |
|------|------|-------------|
| **tugcast** | Backend server | Rust binary. Publishes live data streams over WebSocket. |
| **tugfeed** | Data source | A single stream within tugcast. Each feed produces typed frames. |
| **tugdeck** | Frontend UI | Web dashboard. The operator interface for viewing and controlling execution. |
| **tugcard** | Display component | A single panel within tugdeck. Each card renders one or more tugfeeds. |
| **tugcode** | Launcher | Single command that starts tugcast, opens the browser, and manages lifecycle. |
| **tugtalk** | Conversation engine | Bun/TypeScript process. Manages a Claude Agent SDK session for structured multi-turn conversation. Mediates all user ↔ Claude interaction: messages, interrupts, tool approvals, file/image attachments. |

## 1. Problem Statement

Phases 1-3 proved the architecture: tugcast streams a tmux session to a browser-based dashboard with terminal, filesystem, git, and stats panels. But the interaction model is still fundamentally *observing a terminal*. The user watches Claude Code's TUI output through a web-rendered xterm.js window. There is no way to:

- Interact with Claude through a rich conversational UI (typed messages, formatted responses, code blocks, tool call visibility)
- Drop files into the conversation
- See Claude's responses as structured content rather than ANSI escape sequences
- Launch a session without copying URLs from terminal output
- Use a modern, fast JavaScript runtime (the build toolchain still depends on npm/Node)

This roadmap addresses all of these gaps.

## 2. Design Principles (Updated)

The original principles still hold. These are additions:

- **Bun-native.** All JavaScript/TypeScript tooling uses Bun. No npm, no npx, no Node. Bun is the runtime, the bundler, and the package manager.
- **Conversation-first.** The primary interaction surface is a structured conversation card, not a terminal window. The terminal remains as a companion view, but the web frontend is how you *talk to* Claude.
- **One command, one experience.** `tugcode` is the only command users need. It starts the server, opens the browser, and manages the lifecycle. Closing the browser window shuts everything down.
- **Structured over raw.** The Claude Agent SDK provides typed, structured messages (text blocks, tool calls, tool results, images). tugdeck renders these natively instead of trying to parse terminal output.

## 3. Architecture Evolution

### Before (Phases 1-3)

```
User types in browser terminal (xterm.js)
  → keystrokes sent to tmux via PTY
  → Claude Code TUI processes input
  → TUI renders output as ANSI sequences
  → PTY captures output, streams to browser
  → xterm.js renders ANSI output

User watches. That's it.
```

### After (Phases 4-7)

```
┌────────────────────────── tugdeck ──────────────────────────┐
│                        Web Browser                           │
│  ┌────────────────────┐  ┌──────────┐  ┌─────────┐          │
│  │  Conversation      │  │ Terminal  │  │ Files / │          │
│  │  tugcard           │  │ tugcard   │  │ Git /   │          │
│  │  (primary input)   │  │ (observe) │  │ Stats   │          │
│  └────────┬───────────┘  └────┬─────┘  └────┬────┘          │
│           └───────────────────┴──────────────┘               │
│                       │                                      │
│             Multiplexed WebSocket                            │
└───────────────────────┬──────────────────────────────────────┘
                        │
┌───────────────────────┴────────── tugcast ────────────────────┐
│                                                               │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │              axum HTTP/WS Server                          │ │
│  └───────┬──────────────────────────────────┬───────────────┘ │
│          │                                  │                 │
│  ┌───────┴────────┐                ┌────────┴──────────┐      │
│  │  Feed Router   │                │  Agent Bridge      │      │
│  │  (terminal,    │                │  (IPC to tugtalk) │      │
│  │   fs, git,     │                └────────┬──────────┘      │
│  │   stats)       │                         │                 │
│  └────────────────┘                         │                 │
└─────────────────────────────────────────────┼─────────────────┘
                                              │ stdin/stdout JSON
┌─────────────────────────────────────────────┴─────────────────┐
│                        tugtalk                                │
│                   (Bun/TypeScript process)                     │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Claude Agent SDK V2 Session                              │  │
│  │  - Multi-turn conversation with full context              │  │
│  │  - Built-in tools (Read, Edit, Write, Bash, Glob, Grep)  │  │
│  │  - canUseTool callback → permission requests to user      │  │
│  │  - AskUserQuestion → clarifying questions to user         │  │
│  │  - File/image attachments from dropped files              │  │
│  │  - Session persistence and resume                         │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

**Key insight:** tugtalk is not a terminal wrapper. It *is* a Claude agent — the same capabilities as Claude Code, but with structured input/output instead of a TUI. Every interaction between the user and Claude is mediated by tugtalk: sending messages, interrupting with Ctrl-C, approving or denying tool use, answering clarifying questions, and attaching files or images via drag-and-drop, clipboard paste, or file picker. The terminal card still exists for observing tmux sessions, running manual commands, or watching builds — but the conversation card is the primary control surface.

## 4. Phase 4: Bun Pivot

**Goal:** Replace all npm/Node tooling with Bun. Single runtime for everything TypeScript.

### What Changes

| Before | After |
|--------|-------|
| `npm install` | `bun install` |
| `npx esbuild src/main.ts --bundle` | `bun build src/main.ts --outfile=dist/app.js --minify` |
| `package-lock.json` | `bun.lockb` |
| esbuild as dev dependency | Removed (bun has built-in bundler) |
| Node.js required at build time | Bun required at build time |

### Files Affected

| File | Change |
|------|--------|
| `tugdeck/package.json` | Remove esbuild dependency |
| `tugdeck/package-lock.json` | Delete (replaced by bun.lockb) |
| `tugdeck/bun.lockb` | Generated by `bun install` |
| `crates/tugcast/build.rs` | Replace npm/npx commands with bun equivalents |
| `.github/workflows/ci.yml` | Install bun instead of (or alongside) Node |

### build.rs Changes

The build script currently runs:
1. `npm install` (if node_modules missing)
2. `npx esbuild tugdeck/src/main.ts --bundle --outfile=<OUT_DIR>/tugdeck/app.js --minify`

After the pivot:
1. `bun install` (if node_modules missing)
2. `bun build tugdeck/src/main.ts --outfile=<OUT_DIR>/tugdeck/app.js --minify`

Bun's bundler handles TypeScript natively with zero configuration. No tsconfig.json changes needed. The `--minify` flag works identically.

### Verification

- `bun install` in tugdeck/ succeeds
- `bun build tugdeck/src/main.ts --outfile=dist/app.js --minify` produces a valid bundle
- `cargo build -p tugcast` succeeds (build.rs invokes bun)
- `cargo nextest run` — all tests pass
- Bundle size is comparable to esbuild output (within 10%)

---

## 5. Phase 5: Design Tokens, Icons & Terminal Polish

**Goal:** Fix visual issues, establish a design token system (shadcn/ui convention) and icon library (Lucide). This phase delivers the foundational styling infrastructure that all subsequent UI work depends on — semantic color tokens, consistent iconography, and basic terminal polish. The panel system (Phase 8) follows after the conversation frontend proves core value.

### 5.1 Terminal Padding

The terminal card currently has zero padding — text starts at the very edge of the card container. Add CSS padding inside the terminal card so text has breathing room.

```css
.card-slot[data-card="terminal"] {
  padding: 8px;
}
```

The FitAddon calculates terminal dimensions from the container's inner dimensions, so the terminal automatically shrinks to fit within the padding. No TypeScript changes needed.

### 5.2 Global Card Padding

All cards are jammed against the edges. Add consistent internal padding to every card slot:

```css
.card-slot {
  padding: 8px;
  box-sizing: border-box;
}
```

Card headers should remain flush with the card edges; only the content area gets padding. This may require restructuring card DOM slightly: header sits outside the padded area, content div gets the padding.

### 5.3 Resize Flash Fix

The terminal flashes/flickers when:
- Dragging resize handles between cards
- Moving the browser window
- Interacting with side panels that trigger layout reflow

Root cause: every grid change triggers `fitAddon.fit()` synchronously, which resizes the terminal and causes a full redraw during the resize gesture.

Fix: debounce resize events to the terminal card. During active resize (drag handle is held), suppress `fit()` calls. On `pointerup` (drag end), do a single `fit()`. Use `requestAnimationFrame` to batch resize operations.

```typescript
// In DeckManager, during drag:
private resizeDebounceTimer: number | null = null;

private debouncedResize(): void {
  if (this.resizeDebounceTimer) cancelAnimationFrame(this.resizeDebounceTimer);
  this.resizeDebounceTimer = requestAnimationFrame(() => {
    this.handleResize();
    this.resizeDebounceTimer = null;
  });
}
```

### 5.4 Grid Gap

Add a small gap between grid cells so cards don't touch:

```css
.deck-grid {
  gap: 2px;
}
```

### 5.5 Design Token System

The current tugdeck CSS uses hardcoded hex values everywhere (`#1e1e1e`, `#4ec9b0`, etc.). Before adding the conversation card — which has the most complex styling of any card — we need a proper token system so every color has a name, every name has a purpose, and changes propagate from one place.

The token architecture follows **shadcn/ui's convention**: every semantic color is a `name` / `name-foreground` pair. A `name` token is always a background; `name-foreground` is the text that sits on it. This pairing guarantees accessible contrast by construction.

#### Tier 1: Palette (raw values)

Raw color values defined once. Components never reference these directly — they exist only as targets for semantic tokens.

```css
:root {
  /* Gray scale (VS Code Dark baseline) */
  --palette-gray-1: #1e1e1e;
  --palette-gray-2: #252526;
  --palette-gray-3: #2d2d2d;
  --palette-gray-4: #3c3c3c;
  --palette-gray-5: #808080;
  --palette-gray-6: #cccccc;
  --palette-gray-7: #d4d4d4;
  --palette-gray-8: #ffffff;

  /* Hues */
  --palette-blue-1: #0e639c;
  --palette-blue-2: #569cd6;
  --palette-blue-3: #9cdcfe;
  --palette-green: #4ec9b0;
  --palette-yellow: #dcdcaa;
  --palette-red: #f44747;
  --palette-orange: #ce9178;
  --palette-purple: #c586c0;
}
```

#### Tier 2: Semantic Tokens

Named tokens that reference the palette. Every component uses these.

```css
:root {
  /* ── Surface & text ───────────────────────────────── */
  --background: var(--palette-gray-1);           /* page canvas */
  --foreground: var(--palette-gray-7);           /* primary text */

  --card: var(--palette-gray-2);                 /* elevated surface (card headers, panels) */
  --card-foreground: var(--palette-gray-6);      /* text on card surfaces */

  --muted: var(--palette-gray-3);                /* recessed/subtle surface */
  --muted-foreground: var(--palette-gray-5);     /* secondary text, timestamps, hints */

  --popover: var(--palette-gray-3);              /* floating surfaces (tooltips, menus) */
  --popover-foreground: var(--palette-gray-7);   /* text on popovers */

  /* ── Borders & inputs ─────────────────────────────── */
  --border: var(--palette-gray-4);               /* default border */
  --border-muted: var(--palette-gray-3);         /* subtle dividers */
  --input: var(--palette-gray-4);                /* input field border */
  --ring: var(--palette-blue-2);                 /* focus ring */

  /* ── Actions ──────────────────────────────────────── */
  --primary: var(--palette-blue-1);              /* primary action (buttons, links) */
  --primary-foreground: var(--palette-gray-8);   /* text on primary */

  --secondary: var(--palette-gray-3);            /* secondary action */
  --secondary-foreground: var(--palette-gray-7); /* text on secondary */

  --accent: var(--palette-blue-2);               /* highlight, selection, active state */
  --accent-foreground: var(--palette-gray-1);    /* text on accent */

  /* ── Status ───────────────────────────────────────── */
  --success: var(--palette-green);               /* created, clean, passing */
  --success-foreground: var(--palette-gray-1);

  --warning: var(--palette-yellow);              /* modified, building, attention */
  --warning-foreground: var(--palette-gray-1);

  --destructive: var(--palette-red);             /* removed, failed, error */
  --destructive-foreground: var(--palette-gray-8);

  --info: var(--palette-blue-3);                 /* renamed, informational */
  --info-foreground: var(--palette-gray-1);

  /* ── Radius ───────────────────────────────────────── */
  --radius: 6px;
  --radius-sm: 4px;
  --radius-lg: 8px;

  /* ── Chart / Sparkline ────────────────────────────── */
  --chart-1: var(--palette-green);               /* CPU/Memory sparkline */
  --chart-2: var(--palette-blue-2);              /* Token Usage sparkline */
  --chart-3: var(--palette-yellow);              /* Build Status sparkline */
  --chart-4: var(--palette-red);                 /* Error/threshold sparkline */
  --chart-5: var(--palette-purple);              /* Reserved */
}
```

#### Migration from Hardcoded Values

Every existing hardcoded color maps to a semantic token:

| Current hardcoded | Semantic token | Where used |
|---|---|---|
| `#1e1e1e` | `var(--background)` | Page bg, card content bg, xterm theme |
| `#252526` | `var(--card)` | Card headers |
| `#3c3c3c` | `var(--border)` | Card header border, dividers |
| `#d4d4d4` | `var(--foreground)` | Primary text, xterm foreground |
| `#cccccc` | `var(--card-foreground)` | Card header text |
| `#808080` | `var(--muted-foreground)` | Untracked files, secondary text |
| `#4ec9b0` | `var(--success)` | Created files, clean status, sparkline |
| `#dcdcaa` | `var(--warning)` | Modified files, build status, sparkline |
| `#f44747` | `var(--destructive)` | Removed files |
| `#569cd6` | `var(--accent)` | Renamed files, branch badge text |
| `#0e639c` | `var(--primary)` | Branch badge bg |
| `#9cdcfe` | `var(--info)` | Ahead/behind indicators |

TypeScript files that set inline colors (terminal-card.ts xterm theme, stats-card.ts sparkline colors) must also read from these tokens. The approach: read computed style from the document root at card initialization time, or pass token values as constructor arguments.

### 5.6 Lucide Icons

Replace all text-character icons (`+`, `~`, `-`, `>`) and custom SVG with [Lucide](https://lucide.dev) icons. Lucide is the icon library used by shadcn/ui — tree-shakeable SVGs, consistent 24x24 grid, 1.5px stroke weight.

**Installation:** `bun add lucide` (framework-agnostic ES module; imports individual SVG functions, no React required).

**Usage pattern** (vanilla TypeScript):

```typescript
import { createIcons, icons } from "lucide";
// Or individual imports for tree-shaking:
import { FilePlus, FileEdit, FileX, FileSymlink } from "lucide";
```

**Icon inventory** — icons needed across all existing + planned cards:

| Context | Icon | Lucide name |
|---|---|---|
| **Files card** | | |
| Created file | green plus | `FilePlus` |
| Modified file | yellow pencil | `FileEdit` |
| Removed file | red x | `FileX` |
| Renamed file | blue arrow | `FileSymlink` |
| **Git card** | | |
| Branch | git branch | `GitBranch` |
| Staged file | check circle | `CircleCheck` |
| Unstaged file | circle dot | `CircleDot` |
| Untracked file | circle dashed | `CircleDashed` |
| **Stats card** | | |
| CPU/Memory | activity | `Activity` |
| Tokens | coins | `Coins` |
| Build | hammer | `Hammer` |
| **Card chrome** | | |
| Collapse | chevron up | `ChevronUp` |
| Expand | chevron down | `ChevronDown` |
| **Conversation card** | | |
| Send message | arrow up | `ArrowUp` |
| Stop/interrupt | square | `Square` |
| Attach file | paperclip | `Paperclip` |
| Tool: Read | file-text | `FileText` |
| Tool: Edit | pencil | `Pencil` |
| Tool: Write | file-plus | `FilePlus2` |
| Tool: Bash | terminal | `Terminal` |
| Tool: Glob | folder-search | `FolderSearch` |
| Tool: Grep | search | `Search` |
| Tool: generic | wrench | `Wrench` |
| Tool approved | check | `Check` |
| Tool denied | x | `X` |
| Tool running | loader | `Loader` (animated spin) |
| Copy code | copy | `Copy` |
| Copied | check | `Check` |
| Error | alert-triangle | `AlertTriangle` |
| Interrupted | octagon | `Octagon` |

All icons inherit `currentColor` from their parent element, so they automatically use the correct semantic token color without additional styling.

### Verification (Phase 5)

- Terminal text has visible padding on all sides
- All cards have consistent internal padding
- Dragging resize handles does not cause terminal flashing
- Moving the browser window does not cause terminal flashing
- Grid has clean visual separation between cards
- All existing functionality preserved (resize, collapse, etc.)
- Zero hardcoded hex values remain in CSS files (all replaced by `var(--token)`)
- Zero hardcoded hex values remain in TypeScript files (read from CSS tokens)
- All text-character icons replaced with Lucide SVG icons
- Icons inherit `currentColor` and scale correctly at all card sizes

---

## 8. Phase 8: Panel System

**Goal:** Replace the fixed CSS Grid with a full Adobe-style dockable panel system. Cards become first-class objects: dockable to edges and to each other, tabbable together, floatable over the canvas, resizable, movable, each with a custom header menu. A single "tug" menu in the top-right corner adds new cards. This phase ships **after** Phase 7 (Conversation Frontend) to ensure core conversation value is proven before investing in heavy UI infrastructure.

### Panel System (Dockable Cards)

The current deck is a fixed CSS Grid — terminal left, three cards right, drag handles between them. This works for four cards in a predetermined arrangement. It breaks as soon as the user wants to rearrange cards, float a card over the canvas, tab two cards together, or add a new card type (like the conversation card). Before Phase 7 adds the conversation card, we need a real panel system.

The design follows the consensus architecture from Adobe Photoshop, VS Code, JupyterLab (Lumino), and Dockview: a **layout tree** where internal nodes are splits and leaf nodes are tab containers. Cards dock into the tree, float over it, or tab together within it.

#### Layout Tree

The layout is a recursive tree with two node types:

```typescript
type Orientation = "horizontal" | "vertical";
type LayoutNode = SplitNode | TabNode;

/** Internal node: splits space between children */
interface SplitNode {
  type: "split";
  orientation: Orientation;  // horizontal = children left-to-right
  children: LayoutNode[];
  weights: number[];         // proportional sizes, same length as children
}

/** Leaf node: one or more cards stacked as tabs */
interface TabNode {
  type: "tab";
  id: string;              // unique ID for drop targeting
  tabs: TabItem[];
  activeTabIndex: number;
}

interface TabItem {
  id: string;              // unique card instance ID
  componentId: string;     // card type: "terminal", "git", "files", "stats", "conversation"
  title: string;
  closable: boolean;       // false for the last remaining card
}
```

**Topology invariants** (enforced after every mutation):

1. **No same-grain nesting.** A horizontal split never directly contains another horizontal split — the inner node's children are promoted (flattened) into the outer. Same for vertical.
2. **No single-child splits.** If a split ends up with one child, the split is replaced by that child.
3. **Leaves are always tab nodes.** Every leaf is a tab container, even if it holds only one tab.
4. **Root can be either type.** A single undocked card is just a root TabNode.

**Default layout** (equivalent to the current fixed grid):

```
root: SplitNode(horizontal)
├── TabNode [Conversation]          weight: 0.667
└── SplitNode(vertical)             weight: 0.333
    ├── TabNode [Terminal]          weight: 0.25
    ├── TabNode [Git]              weight: 0.25
    ├── TabNode [Files]            weight: 0.25
    └── TabNode [Stats]            weight: 0.25
```

#### Dock Zones & Drop Targeting

When the user drags a card (by its tab or title bar), the system computes drop zones using the Lumino algorithm — pure cursor-position math, no compass widget:

**Step 1: Root edge test.** If the cursor is within 40px of any edge of the deck canvas, the drop zone is a root split (dock to the edge of the entire layout):

```
root-top     → new horizontal row above everything
root-bottom  → new horizontal row below everything
root-left    → new vertical column left of everything
root-right   → new vertical column right of everything
```

**Step 2: Tab node hit test.** Walk the layout tree, testing which TabNode's bounding rect contains the cursor. Each TabNode's DOM element provides `getBoundingClientRect()`.

**Step 3: Zone within the target TabNode.** Divide the hit TabNode's content area by edge proximity:

```
tab-bar zone  → cursor is within the tab bar height → dock as a new tab
widget-top    → closest to top edge → split target, new card above
widget-bottom → closest to bottom edge → split target, new card below
widget-left   → closest to left edge → split target, new card left
widget-right  → closest to right edge → split target, new card right
center        → target has only one tab → replace entire area
```

#### Visual Feedback

While dragging, a single overlay `<div>` (absolutely positioned, `pointer-events: none`, `background: var(--accent)` at 20% opacity, `border: 2px solid var(--accent)`) shows where the card will land. Its geometry is computed per zone:

| Zone | Overlay covers |
|------|---------------|
| root-left/right | Left/right 38.2% of deck canvas width (golden ratio complement) |
| root-top/bottom | Top/bottom 38.2% of deck canvas height |
| widget-left/right | Left/right 50% of target TabNode |
| widget-top/bottom | Top/bottom 50% of target TabNode |
| tab-bar | Just the tab bar height of the target |
| center | Entire target TabNode |

The overlay updates on every `pointermove` during drag. A 100ms hide delay prevents flicker when the cursor briefly crosses zone boundaries.

#### Sash Resizing

Between every pair of siblings in a SplitNode, a thin sash element (4px wide/tall, invisible until hovered) allows proportional resizing:

- On hover: sash background fades to `var(--border)`, cursor changes to `col-resize` or `row-resize`
- On drag: `setPointerCapture()`, recompute weights from cursor position, update flex sizes in real-time
- Minimum card size: 100px (prevents collapsing to nothing)
- On release: save layout to localStorage

Sashes replace the current drag-handle system. They are generated dynamically from the layout tree — one sash per adjacent pair of children in each SplitNode.

#### Floating Panels

Cards can be undocked from the tree and floated over the canvas. Floating panels are stored outside the layout tree:

```typescript
interface DockState {
  root: LayoutNode;
  floating: FloatingGroup[];
}

interface FloatingGroup {
  position: { x: number; y: number };
  size: { width: number; height: number };
  node: TabNode;
}
```

**Undocking:** Drag a tab away from any valid dock zone. When the cursor leaves all dock zones (40px+ from any valid target), the overlay disappears and the card becomes a floating panel at the cursor position.

**Re-docking:** Drag a floating panel's title bar over a dock zone. The standard drop-targeting algorithm applies — it docks back into the tree.

**Floating panel chrome:**
- Title bar: same as docked card header, but with a close button (`X` icon) that redocks the panel
- Resize: all four edges and four corners are drag targets
- Move: drag the title bar
- Background: `var(--card)`, `border: 1px solid var(--border)`, `box-shadow: 0 8px 24px rgba(0,0,0,0.4)`
- Z-order: floating panels stack above the docked layout; clicking a floating panel raises it

#### Tab Groups

When a card is dropped on the tab-bar zone of an existing TabNode, it joins that container as a new tab:

```
┌─ Git │ Files │ Stats ──────────────────────┐
│                                             │
│  (content of the active tab)                │
│                                             │
└─────────────────────────────────────────────┘
```

- Tab bar: `background: var(--card)`, tabs are horizontally arranged
- Active tab: `color: var(--foreground)`, `border-bottom: 2px solid var(--accent)`
- Inactive tab: `color: var(--muted-foreground)`
- Tab close button: `X` icon, visible on hover, `color: var(--muted-foreground)` → `var(--destructive)` on hover
- Dragging a tab out of a group undocks it (either to a new dock zone or to floating)
- Drag-reorder within the tab bar changes tab order
- If the last tab is removed from a TabNode, the TabNode is removed from the tree and the topology invariants run

#### Card Header Bar

Every card (docked or floating) has a header bar with a consistent structure:

```
┌─ 🔧 Title ──────────────────── [⋮] [−] [×] ─┐
│  content...                                     │
└─────────────────────────────────────────────────┘
```

| Element | Description |
|---------|-------------|
| **Icon** | Lucide icon identifying the card type (e.g., `Terminal` for terminal, `GitBranch` for git) |
| **Title** | Card name in `var(--card-foreground)`, 12px, uppercase, 600 weight |
| **Menu button** `[⋮]` | `EllipsisVertical` icon — opens the card's custom dropdown menu |
| **Collapse button** `[−]` | `Minus` icon (docked only) — collapses the card to header-only (28px). Click again to expand. |
| **Close button** `[×]` | `X` icon — removes the card from the layout. Disabled if this is the last instance. |

**Custom menu per card type:**

| Card | Menu items |
|------|------------|
| **Terminal** | Font size (S/M/L), Clear scrollback, WebGL on/off |
| **Git** | Refresh now, Show/hide untracked |
| **Files** | Clear history, Max entries (50/100/200) |
| **Stats** | Sparkline timeframe (30s/60s/120s), Show/hide sub-cards |
| **Conversation** | Permission mode (default/acceptEdits/bypassPermissions/plan), New session, Export history |

The menu is a positioned dropdown (`var(--popover)` background, `var(--popover-foreground)` text, `border: 1px solid var(--border)`, `box-shadow`). Appears below the `[⋮]` button, dismisses on click-outside or Escape.

#### The Tug Menu

A single button in the top-right corner of the deck canvas (not inside any card). It uses the tug logo from `resources/tug-logo-dark.svg` rendered as a 24x24 icon with `var(--foreground)` fill. Clicking it opens a dropdown menu:

```
┌─────────────────────────┐
│  + Terminal              │
│  + Conversation          │
│  + Git                   │
│  + Files                 │
│  + Stats                 │
│ ─────────────────────── │
│  Reset layout            │
│  Save layout as...       │
│  Load layout...          │
│ ─────────────────────── │
│  About tugdeck           │
└─────────────────────────┘
```

- **Add card**: Creates a new instance of that card type. The new card appears as a floating panel at the center of the canvas. The user docks it wherever they want. Multiple instances of the same card type are allowed (e.g., two terminals with different tmux sessions).
- **Reset layout**: Restores the default layout (conversation left, terminal/git/files/stats right).
- **Save/Load layout**: Named layout presets stored in localStorage. The user can save their arrangement and switch between presets.
- **About**: Version info, links.

The tug button is always visible, always in the top-right corner (positioned absolute over the canvas), `z-index` above both docked and floating panels. It is the only persistent UI element outside of the card system.

#### Serialization

The entire dock state serializes to JSON and persists in localStorage:

```typescript
interface SerializedDockState {
  version: 2;                        // bumped from v1 (current CSS Grid layout)
  root: SerializedNode;
  floating: SerializedFloatingGroup[];
  presetName?: string;               // named layout preset
}

type SerializedNode = SerializedSplit | SerializedTabGroup;

interface SerializedSplit {
  type: "split";
  orientation: "horizontal" | "vertical";
  children: SerializedNode[];
  weights: number[];
}

interface SerializedTabGroup {
  type: "tabs";
  activeId: string;
  tabs: SerializedTab[];
}

interface SerializedTab {
  id: string;
  componentId: string;   // "terminal" | "git" | "files" | "stats" | "conversation"
  title: string;
}

interface SerializedFloatingGroup {
  position: { x: number; y: number };
  size: { width: number; height: number };
  group: SerializedTabGroup;
}
```

**Migration from v1:** On first load, the current `LayoutState` (v1: `colSplit`, `rowSplits`, `collapsed`) is translated into a v2 `SerializedDockState` that produces the same visual arrangement. No layout is lost on upgrade.

**localStorage key:** `"tugdeck-layout"` (same key, version field distinguishes).

**Save debounce:** 500ms after any layout change (same as current).

#### Canvas

The deck container (`#deck-container`) is the canvas. It has:

- Background: `var(--background)`
- The layout tree renders as nested flex containers filling the canvas
- Floating panels are absolutely positioned children of the canvas
- The tug menu button is an absolutely positioned child in the top-right corner
- Sashes are absolutely positioned between flex children
- The drag overlay is an absolutely positioned child with `pointer-events: none`

When all cards are floating or closed, the canvas is visible as an empty dark background — this is intentional. The canvas is the ground truth; cards are objects placed on it.

### Verification (Phase 8)

- Cards can be dragged from one dock zone to another
- Cards can be tabbed together by dropping on a tab bar
- Cards can be floated by dragging away from all dock zones
- Floating cards can be re-docked by dragging over a dock zone
- Sash resizing works between all adjacent siblings in any split orientation
- Blue overlay shows correct geometry for all zone types during drag
- Tab close removes the card; last-tab-close removes the TabNode and cleans the tree
- Card header menus open and dismiss correctly
- Tug menu adds new card instances as floating panels
- Layout persists to localStorage and restores correctly on reload
- v1 layouts migrate to v2 without breaking
- Reset layout restores default arrangement
- The canvas is visible when all cards are floating or closed

---

## 6. Phase 6: tugcode Launcher

**Goal:** A single command that starts everything and opens the browser. The user controls lifetime explicitly with Ctrl-C.

### 6.1 User Experience

```bash
# Start a new session
tugcode

# Start with specific project directory
tugcode --dir /path/to/project

# Attach to an existing tmux session
tugcode --session my-session

# Custom port
tugcode --port 8080
```

What happens when you run `tugcode`:

1. Finds or creates a tmux session (default: `cc0`)
2. Starts `tugcast` as a child process, captures its stdout
3. Parses the auth URL from tugcast's startup output
4. Opens the auth URL in the system default browser
5. Waits for Ctrl-C (SIGINT)
6. On Ctrl-C: sends SIGTERM to tugcast → tugcast sends SIGTERM to tugtalk → all exit cleanly

The tmux session survives. Running `tugcode` again reattaches. The browser can be closed and reopened at any time — tugcast keeps running until tugcode is explicitly stopped.

### 6.2 Implementation: Rust Binary

tugcode is a new Rust binary crate at `crates/tugcode/`. It lives in the same workspace but is a separate binary from tugcast.

**Why Rust, not a shell script:**
- Proper signal handling (SIGTERM, SIGINT propagation)
- Cross-platform browser opening (`open` on macOS, `xdg-open` on Linux)
- Parsing tugcast's stdout reliably (regex for the auth URL)
- Monitoring child process lifecycle
- Coordinating SIGTERM propagation to child processes on Ctrl-C

### 6.3 Communication Between tugcode and tugcast

tugcode starts tugcast as a child process with stdout piped. tugcast's startup output includes:

```
tugcast: http://127.0.0.1:7890/auth?token=a3f8...c912
```

tugcode parses this line, extracts the URL, and opens it.

**Lifecycle management.** tugcode is the parent process and manages all child lifetimes directly:

- **Running:** tugcode stays alive until the user presses Ctrl-C. The browser can be closed and reopened freely — tugcast keeps serving, and refreshing the page reconnects the WebSocket.
- **Shutdown:** On Ctrl-C, tugcode sends SIGTERM to tugcast → tugcast sends SIGTERM to tugtalk → all processes exit cleanly. The tmux session survives.
- **No idle timeout.** There is no automatic shutdown when the browser disconnects. The user controls lifetime explicitly. This avoids losing work when laptops sleep, tabs reload, or network blips cause momentary disconnects.

### 6.4 Crate Structure

```
crates/tugcode/
├── Cargo.toml
└── src/
    └── main.rs    # CLI args, child process management, browser open
```

Dependencies: `clap` (CLI), `tokio` (async child process), `regex` (URL parsing from stdout).

### Verification

- `tugcode` starts tugcast, opens browser, dashboard loads
- Closing the browser tab does not kill tugcast — page can be reopened by navigating to the URL
- Refreshing the browser page reconnects the WebSocket and restores state
- tmux session survives after tugcode exits
- `tugcode --session existing-session` reattaches correctly
- `tugcode --dir /path/to/project` passes through to tugcast
- Ctrl-C on tugcode sends SIGTERM to tugcast → tugcast sends SIGTERM to tugtalk → all exit cleanly

---

## 7. Phase 7: Conversation Frontend

**Goal:** A full multi-turn conversational interface to Claude, rendered as a rich web UI in tugdeck. This is the centerpiece — the reason tugdeck exists.

### 7.1 Why the Agent SDK

The Claude Agent SDK (TypeScript V2) provides exactly what we need:

| Capability | How We Use It |
|-----------|---------------|
| **Multi-turn sessions** | `createSession()` + `send()` / `stream()` pattern. Full conversation context across turns. |
| **Built-in tools** | Read, Edit, Write, Bash, Glob, Grep — same capabilities as Claude Code, no implementation needed. |
| **Structured output** | Every message is typed: text blocks, tool use blocks, tool results. Trivially parseable for rich rendering. |
| **Tool approval** | `canUseTool` callback pauses execution and surfaces permission requests to the user via tugdeck. |
| **Clarifying questions** | `AskUserQuestion` tool generates multiple-choice questions that tugdeck can render as interactive UI. |
| **Image/file attachments** | Messages can include base64-encoded images. Users can drop files into the conversation. |
| **Session persistence** | Sessions have IDs. Can be resumed across application restarts. |
| **Streaming responses** | Token-by-token streaming for real-time response rendering. |

The V2 API surface is minimal:

```typescript
import { unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk";

await using session = unstable_v2_createSession({
  model: "claude-sonnet-4-5-20250929",
  allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
  permissionMode: "default",  // or "plan", "acceptEdits", "bypassPermissions"
  canUseTool: async (toolName, input) => {
    // Forward to tugdeck for user approval
    return handleToolApproval(toolName, input);
  }
});

// Turn 1
await session.send("Help me refactor the auth module");
for await (const msg of session.stream()) {
  // Forward each message to tugcast → tugdeck
  forwardToTugcast(msg);
}

// Turn 2 (full context preserved)
await session.send("Now add tests for the changes you made");
for await (const msg of session.stream()) {
  forwardToTugcast(msg);
}
```

### 7.2 tugtalk: The Conversation Engine

tugtalk is a standalone Bun/TypeScript process that manages the Claude Agent SDK session. It communicates with tugcast via JSON-lines over stdin/stdout.

```
tugdeck/
├── src/
│   ├── main.ts            # (existing) Frontend entry point
│   ├── connection.ts       # (existing) WebSocket lifecycle
│   ├── ...
│   └── cards/
│       ├── conversation-card.ts  # (new) Primary interaction surface
│       └── ...
│
tugtalk/
├── package.json            # @anthropic-ai/claude-agent-sdk dependency
├── src/
│   └── main.ts             # Agent process: session management, IPC
```

#### IPC Protocol (tugcast ↔ tugtalk)

Communication is JSON-lines over stdin (tugcast → tugtalk) and stdout (tugtalk → tugcast). Each line is a complete JSON object.

**Inbound (tugcast → tugtalk stdin):**

```jsonc
// User sends a message
{"type": "user_message", "text": "Help me refactor auth.py", "attachments": []}

// User sends a message with file attachment
{"type": "user_message", "text": "Review this file", "attachments": [
  {"filename": "auth.py", "content": "...", "media_type": "text/plain"}
]}

// User responds to tool approval request
{"type": "tool_approval", "request_id": "req-123", "decision": "allow"}

// User responds to clarifying question
{"type": "question_answer", "request_id": "req-456", "answers": {"Which approach?": "Option A"}}

// User interrupts current turn (Ctrl-C / stop button)
{"type": "interrupt"}

// User sends image from clipboard paste or file drop
{"type": "user_message", "text": "", "attachments": [
  {"filename": "screenshot.png", "content": "<base64>", "media_type": "image/png"}
]}
```

**Outbound (tugtalk stdout → tugcast):**

```jsonc
// Session initialized
{"type": "session_init", "session_id": "sess-abc"}

// Assistant text (streaming, may arrive in chunks)
{"type": "assistant_text", "text": "I'll help you refactor...", "is_partial": true}

// Assistant text (final for this block)
{"type": "assistant_text", "text": "I'll help you refactor the auth module. Let me start by reading the file.", "is_partial": false}

// Tool use (Claude wants to use a tool)
{"type": "tool_use", "tool_name": "Read", "tool_use_id": "tu-789", "input": {"file_path": "auth.py"}}

// Tool result (tool executed successfully)
{"type": "tool_result", "tool_use_id": "tu-789", "output": "def login(username, password):..."}

// Tool approval request (needs user permission)
{"type": "tool_approval_request", "request_id": "req-123", "tool_name": "Bash", "input": {"command": "rm -rf /tmp/test"}}

// Clarifying question
{"type": "question", "request_id": "req-456", "questions": [
  {"question": "Which approach?", "header": "Approach", "options": [
    {"label": "Option A", "description": "Refactor in place"},
    {"label": "Option B", "description": "Create new module"}
  ], "multiSelect": false}
]}

// Turn complete
{"type": "turn_complete", "result": "I've refactored the auth module..."}

// Turn cancelled (response to interrupt)
{"type": "turn_cancelled", "partial_result": "I was in the middle of..."}

// Error
{"type": "error", "message": "Session expired"}
```

### 7.3 New Feed IDs

| ID | Feed | Direction | Payload | Channel Type |
|----|------|-----------|---------|-------------|
| `0x40` | Conversation output | tugcast → tugdeck | JSON (agent messages) | watch (snapshot of latest) + broadcast (streaming) |
| `0x41` | Conversation input | tugdeck → tugcast | JSON (user messages, approvals) | mpsc (inbound) |

The conversation feed is special: it uses both watch (for the full conversation state on reconnect) and broadcast (for real-time streaming of partial responses).

#### Message Identity & Ordering

Every message in the conversation feed has a canonical identity for deduplication, ordering, and reconciliation:

| Field | Type | Description |
|-------|------|-------------|
| `msg_id` | string | Unique message identifier (UUID v4), assigned by tugtalk when the message is created |
| `seq` | integer | Monotonically increasing sequence number per session, starts at 0, gap-free. Assigned once per message — **stable across all partial updates** of that message. |
| `rev` | integer | Revision counter within a message, starts at 0. Increments on each partial update. A complete message has its final `rev`. |
| `blocks` | array | Ordered list of content blocks, each with a `block_index` (0-based within the message) |
| `status` | enum | `partial` (streaming), `complete` (final), `cancelled` (interrupted) |

**Ordering guarantee:** `seq` numbers are gap-free within a session. If tugdeck receives seq 5 before seq 4 (e.g., due to a race between broadcast and watch channels), it buffers seq 5 and waits for seq 4. Messages are rendered in `seq` order, never arrival order.

**Buffering timeout:** If a gap persists for more than 5 seconds (e.g., seq 4 never arrives due to a dropped event or producer restart), tugdeck abandons the buffer and requests a full state resync via the watch channel (0x40). The buffered out-of-order messages are discarded and replaced by the authoritative watch snapshot. This prevents indefinite render stalls.

**Streaming updates:** While Claude is generating a response, tugtalk emits partial messages with the same `msg_id` and `seq` but incrementing `rev` (0, 1, 2, ...) and `status: "partial"`. Each partial update contains the full accumulated content up to that point (not a delta). tugdeck renders the highest `rev` seen for each `msg_id`. The final update has `status: "complete"`. Because `seq` is stable across partials, the ordering guarantee applies to messages, not revisions — revisions only compete within a single message.

**Block identity:** Within a message, blocks are identified by `msg_id` + `block_index`. This allows surgical updates — e.g., a tool result block can be updated independently when the tool completes, without re-rendering the entire message.

**Deduplication rules:**
- **Complete messages:** tugdeck maintains a set of seen `(msg_id, seq)` pairs. Duplicate deliveries (possible on reconnect when both watch snapshot and broadcast overlap) are silently dropped.
- **Partial updates:** For a given `msg_id`, tugdeck tracks the highest `rev` rendered. A partial with `rev` <= the current rendered rev is dropped (stale). A partial with a higher `rev` replaces the current rendering. This means out-of-order partials are harmless — the latest content always wins.

### 7.4 Conversation Card (tugdeck)

The conversation card is the primary interaction surface. It replaces the terminal as the main way to interact with Claude.

#### Layout

```
┌─────────────────────────────────────────────┐
│  Conversation                          [···] │
├─────────────────────────────────────────────┤
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │ You                                  │    │
│  │ Help me refactor the auth module    │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │ Claude                               │    │
│  │ I'll help you refactor the auth      │    │
│  │ module. Let me start by reading it.  │    │
│  │                                      │    │
│  │ ┌─ Read: auth.py ─────────────────┐ │    │
│  │ │ ✓ Read 45 lines                  │ │    │
│  │ └─────────────────────────────────┘ │    │
│  │                                      │    │
│  │ Here's what I found...              │    │
│  │                                      │    │
│  │ ```python                           │    │
│  │ def login(username, password):      │    │
│  │     # Refactored implementation     │    │
│  │     ...                             │    │
│  │ ```                                 │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  ┌─ Claude wants to run ────────────────┐   │
│  │ Bash: pytest tests/test_auth.py      │   │
│  │                  [Allow]  [Deny]     │   │
│  └──────────────────────────────────────┘   │
│                                             │
├─────────────────────────────────────────────┤
│ ┌─────────────────────────────────┐ [Send]  │
│ │ Type a message...          [📎] │         │
│ └─────────────────────────────────┘         │
└─────────────────────────────────────────────┘
```

#### Formatting & Styling Specification

Every element rendered in the conversation card maps to semantic tokens from Phase 5, uses Lucide icons from Phase 5, and follows the patterns below. The goal: Claude's responses should feel like a native application UI, not a raw text dump.

##### Message Containers

**User message:**

```
┌─────────────────────────────────────────────────────┐
│                                   ┌───────────────┐ │
│                                   │ User message   │ │
│                                   │ text here      │ │
│                                   └───────────────┘ │
│                                   attachment chips   │
└─────────────────────────────────────────────────────┘
```

- Right-aligned bubble
- Background: `var(--primary)`, text: `var(--primary-foreground)`
- Border-radius: `var(--radius-lg)`
- Padding: 12px 16px
- Max width: 80% of conversation area
- Attachment chips (if any) appear below the bubble as small pills showing filename + `Paperclip` icon

**Assistant message:**

```
┌─────────────────────────────────────────────────────┐
│ ┌─────────────────────────────────────────────────┐ │
│ │ Markdown-rendered response text                 │ │
│ │                                                 │ │
│ │ ┌─ tool use card ─────────────────────────────┐ │ │
│ │ │  ...                                        │ │ │
│ │ └─────────────────────────────────────────────┘ │ │
│ │                                                 │ │
│ │ More response text continues after tool use     │ │
│ └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

- Left-aligned, full width (no bubble — it is the content area)
- Background: `var(--background)`, text: `var(--foreground)`
- Content is a sequence of blocks: text, tool use, tool result, images, interleaved in the order they arrive
- No outer border — the assistant's response area is the default surface

**Interrupted message:**

- Same as assistant message, but the entire container has `opacity: var(--conversation-interrupted-opacity, 0.5)`
- A small label appears at the bottom: `Octagon` icon + "Interrupted" in `var(--muted-foreground)`
- The partial content is preserved — whatever was rendered before the interrupt stays visible

##### Markdown Rendering

Assistant text blocks are rendered as Markdown → HTML using **marked** (minimal, fast, no plugins needed initially). The rendered HTML is styled with prose-like rules scoped to `.conversation-prose`:

```css
.conversation-prose {
  color: var(--foreground);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.6;
}

.conversation-prose h1,
.conversation-prose h2,
.conversation-prose h3 {
  color: var(--foreground);
  font-weight: 600;
  margin-top: 1.5em;
  margin-bottom: 0.5em;
}

.conversation-prose h1 { font-size: 1.25em; }
.conversation-prose h2 { font-size: 1.125em; }
.conversation-prose h3 { font-size: 1em; }

.conversation-prose p {
  margin: 0.75em 0;
}

.conversation-prose strong {
  color: var(--foreground);
  font-weight: 600;
}

.conversation-prose em {
  font-style: italic;
}

.conversation-prose a {
  color: var(--accent);
  text-decoration: underline;
}

.conversation-prose ul, .conversation-prose ol {
  padding-left: 1.5em;
  margin: 0.5em 0;
}

.conversation-prose li {
  margin: 0.25em 0;
}

.conversation-prose code {
  font-family: "Menlo", "Monaco", "Courier New", monospace;
  font-size: 0.9em;
  background: var(--muted);
  padding: 2px 5px;
  border-radius: var(--radius-sm);
}

/* Fenced code blocks — handled separately by the code block renderer */
.conversation-prose pre {
  margin: 0;
  padding: 0;
  background: none;
}
```

**Markdown safety policy:** Model output and tool results are **untrusted content**. Strictly no raw HTML rendering — all HTML tags are stripped, no "safe subset" allowlist. The defense is layered:

1. **DOMPurify (primary):** All marked output is piped through DOMPurify before DOM insertion via `innerHTML`. DOMPurify is configured to strip **all** HTML tags and attributes — not the default safe-subset behavior:

   ```typescript
   DOMPurify.sanitize(html, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
   ```

   This means any `<script>`, `<img onerror=...>`, `javascript:` URL, or inline event handler in model/tool output is reduced to its text content. This is the authoritative safety boundary.
2. **CSP (defense-in-depth):** tugdeck's HTML sets a Content-Security-Policy meta tag: `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data: blob:;` — this blocks any injected script from executing even if it somehow bypasses DOMPurify.

Note: `marked` itself does **not** strip or escape raw HTML by default. The `{gfm: true, breaks: true}` configuration enables GitHub-Flavored Markdown and soft line breaks — it has no effect on HTML sanitization. Do not rely on marked for safety; DOMPurify is the sole sanitizer.

This is intentionally minimal. No `max-width` prose constraints — the conversation card width is the constraint. No typographic scale — headings are de-emphasized because Claude's responses are conversational, not documents.

##### Code Blocks

Fenced code blocks get special treatment — they are the most visually prominent element in a conversation with a coding assistant.

```
┌─ TypeScript ──────────────────────────── Copy 📋 ─┐
│                                                     │
│  function greet(name: string): string {             │
│    return `Hello, ${name}!`;                        │
│  }                                                  │
│                                                     │
└─────────────────────────────────────────────────────┘
```

- Container: `background: var(--muted)`, `border: 1px solid var(--border)`, `border-radius: var(--radius)`
- Header bar: language label left-aligned in `var(--muted-foreground)`, copy button right-aligned with `Copy` icon
- Code font: `Menlo, Monaco, Courier New, monospace`, 13px
- Code color: `var(--foreground)` base, syntax tokens override per-element
- Copy button: `Copy` icon → `Check` icon for 2 seconds after click, color transitions from `var(--muted-foreground)` to `var(--success)`
- Horizontal scroll on overflow (no wrapping)
- Max height: 400px with vertical scroll; the header bar is sticky

**Syntax highlighting** uses a token set mapped to palette colors, matching the VS Code Dark theme that is already the visual baseline:

```css
:root {
  --syntax-keyword: var(--palette-blue-2);     /* if, else, return, import */
  --syntax-string: var(--palette-orange);      /* "hello", 'world' */
  --syntax-number: var(--palette-green);       /* 42, 3.14 */
  --syntax-function: var(--palette-yellow);    /* fn declarations, calls */
  --syntax-type: var(--palette-green);         /* class, struct, interface names */
  --syntax-variable: var(--palette-blue-3);    /* identifiers */
  --syntax-comment: var(--palette-gray-5);     /* // comments */
  --syntax-operator: var(--foreground);        /* +, -, =, => */
  --syntax-punctuation: var(--foreground);     /* (), {}, [] */
  --syntax-constant: var(--palette-blue-3);    /* true, false, null */
  --syntax-decorator: var(--palette-purple);   /* @decorator, #[attr] */
  --syntax-tag: var(--palette-blue-2);         /* HTML/JSX tags */
  --syntax-attribute: var(--palette-blue-3);   /* HTML/JSX attributes */
}
```

For the actual highlighter: **Shiki** is the best fit. It uses VS Code's TextMate grammars directly (exact same highlighting as the editor), runs in the browser, and produces pre-tokenized HTML that maps cleanly to CSS custom properties via a custom theme.

**Language loading strategy:** Initialize Shiki with a curated set of 17 languages: TypeScript, JavaScript, Python, Rust, Shell/Bash, JSON, CSS, HTML, Markdown, Go, Java, C, C++, SQL, YAML, TOML, Dockerfile. When Claude sends a code block with an unlisted language, attempt a dynamic load via `highlighter.loadLanguage()`. If the grammar is unavailable, fall back to plain monospace (`var(--foreground)` on `var(--muted)`) — no highlighting is better than broken highlighting.

##### Tool Use Cards

When Claude calls a tool (Read, Edit, Write, Bash, Glob, Grep), it appears as a collapsible card inline in the response:

**Collapsed (default):**

```
┌─ 📄 Read  src/auth.ts ───────── ✓ ─────── ▸ ─┐
└────────────────────────────────────────────────┘
```

**Expanded:**

```
┌─ 📄 Read  src/auth.ts ───────── ✓ ─────── ▾ ─┐
│                                                 │
│  ┌─ Input ────────────────────────────────────┐ │
│  │ file_path: "src/auth.ts"                   │ │
│  └────────────────────────────────────────────┘ │
│                                                 │
│  ┌─ Result ───────────────────────────────────┐ │
│  │ export function authenticate(token: string) │ │
│  │ ...                                         │ │
│  │              (42 lines — show all)          │ │
│  └────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

Styling:

- Container: `background: var(--muted)`, `border: 1px solid var(--border)`, `border-radius: var(--radius)`
- Header row: Lucide icon for the tool (see icon inventory in 5.6) + tool name in `var(--card-foreground)` + input summary (truncated) + status indicator + expand/collapse chevron
- Status indicator: `Loader` (spinning, `var(--accent)`) while running, `Check` (`var(--success)`) on success, `X` (`var(--destructive)`) on failure, `Octagon` (`var(--warning)`) if interrupted
- Input section: monospace font, `var(--muted-foreground)`, shows the tool input as key-value pairs
- Result section: for text results, monospace font with truncation at 10 lines + "show all" link; for Read results, syntax-highlighted if the filename has a known extension; for Bash results, rendered as terminal output (monospace, `var(--foreground)` on `var(--background)`)
- Entire card is clickable to toggle expand/collapse

##### Tool Approval Prompts

When Claude wants to use a tool that requires permission, the approval prompt replaces the tool status and blocks further conversation:

```
┌─ 🔧 Bash ─────────────────────────────────────┐
│                                                 │
│  Claude wants to run:                           │
│                                                 │
│  ┌──────────────────────────────────────────┐   │
│  │ $ pytest tests/test_auth.py              │   │
│  └──────────────────────────────────────────┘   │
│                                                 │
│              [ Allow ]    [ Deny ]              │
│                                                 │
└─────────────────────────────────────────────────┘
```

- Container: `border: 2px solid var(--warning)`, thicker border to draw attention
- Command preview: monospace, `var(--foreground)` on `var(--muted)` background
- Allow button: `background: var(--success)`, `color: var(--success-foreground)`, `border-radius: var(--radius)`
- Deny button: `background: var(--destructive)`, `color: var(--destructive-foreground)`, `border-radius: var(--radius)`
- While awaiting approval, the input area is disabled with a note: "Waiting for tool approval..."
- After Allow: the card transitions to a normal tool use card (collapsed, with status indicator)
- After Deny: the card shows `X` icon in `var(--destructive)`, tool result shows "Denied by user"

##### Clarifying Questions

When Claude asks a clarifying question (via `AskUserQuestion`), it renders as an interactive card:

```
┌─────────────────────────────────────────────────┐
│  Which approach do you prefer?                  │
│                                                 │
│  ○ Refactor in place                            │
│    Modify the existing module directly           │
│                                                 │
│  ○ Create new module                            │
│    Build a replacement and swap it in            │
│                                                 │
│  ○ Other: [___________________________]         │
│                                                 │
│                              [ Submit ]         │
└─────────────────────────────────────────────────┘
```

- Container: `background: var(--card)`, `border: 1px solid var(--accent)`, `border-radius: var(--radius)`
- Question text: `var(--foreground)`, 14px, semi-bold
- Option labels: `var(--foreground)`, 14px
- Option descriptions: `var(--muted-foreground)`, 13px
- Radio buttons / checkboxes: `var(--accent)` when selected, `var(--border)` when unselected
- "Other" text input: `background: var(--muted)`, `border: 1px solid var(--input)`, `color: var(--foreground)`
- Submit button: `background: var(--primary)`, `color: var(--primary-foreground)`
- While awaiting answer, the main input area is disabled
- After submission, the card becomes static (non-interactive) showing the selected answer highlighted in `var(--accent)`

##### Images

Images from Claude's responses or from tool results (e.g., screenshots from Read):

- Rendered inline at natural dimensions, max-width: 100% of conversation area
- Border: `1px solid var(--border)`, `border-radius: var(--radius)`
- Click to open full-size in a modal overlay (`background: var(--background)` with 90% opacity backdrop)
- Image loading: show a placeholder rectangle in `var(--muted)` with `Loader` icon until loaded

##### Error Banners

```
┌─ ⚠ Error ───────────────────────────────────────┐
│  Session expired. Please refresh to reconnect.   │
└──────────────────────────────────────────────────┘
```

- Container: `background: var(--destructive)`, `color: var(--destructive-foreground)`, `border-radius: var(--radius)`
- Icon: `AlertTriangle` from Lucide
- Inline within the message flow (not a toast/overlay)

##### Streaming State

While Claude is actively generating a response:

- Text appears token-by-token with a blinking cursor indicator (a thin `var(--accent)` bar at the end of the current text)
- Tool use cards appear as soon as the tool call is emitted, initially in "running" state with `Loader` spinning
- The input area shows the stop button (`Square` icon) instead of the send button (`ArrowUp` icon)
- A subtle animated gradient border (`var(--accent)` → transparent) pulses on the assistant message container to indicate activity

#### Input Area

The input area at the bottom of the conversation card:

- Text input field (multi-line, auto-expanding)
- Send button (or Enter to send, Shift+Enter for newline)
- File attachment button (opens file picker, or accepts drag-and-drop)
- Drag-and-drop zone: dropping files anywhere on the conversation card attaches them to the next message
- Clipboard paste: pasting an image (e.g. screenshot) attaches it to the current message

File handling:
- Images (png, jpg, gif, webp): sent as base64-encoded image attachments
- Text files (code, markdown, etc.): sent as text content with filename metadata
- Other files: read as text if possible, rejected with error if binary

#### Interrupt (Ctrl-C)

While Claude is responding or executing tools, the user can interrupt at any time:

- **Keyboard:** Ctrl-C (or Escape) sends an `interrupt` message to tugtalk
- **UI:** A stop button appears in the input area while a turn is active, replacing the send button
- **Behavior:** tugtalk cancels the in-progress Agent SDK turn. Any partial response is preserved and rendered with a "cancelled" indicator. The conversation remains in a valid state — the user can immediately send a new message.
- **During tool execution:** If Claude is mid-tool-use (e.g. a long-running Bash command), the interrupt cancels the tool and the turn. The tool result shows as cancelled.

**Cancellation contract:** Tool cancellation is **best-effort**, not guaranteed-atomic. The strategy varies by tool type:

| Tool | Cancellation behavior |
|------|----------------------|
| **Read, Glob, Grep** | Effectively instant — SDK request is cancelled, no side effects |
| **Edit, Write** | Best-effort — if the write is in-flight, the file may be partially written. The user sees a "cancelled" indicator and should inspect the file. |
| **Bash** | tugtalk sends SIGTERM to the child process. If the process does not exit within 3 seconds, SIGKILL follows. Partial stdout is captured and included in the tool result. |
| **WebFetch, WebSearch** | HTTP request is aborted. No side effects. |

After interrupt, the conversation is always in a valid state at the protocol level. However, external side effects from partially-executed tools (e.g., a half-written file from Write, or a partially-completed shell command from Bash) are the user's responsibility to inspect. The conversation card marks the interrupted turn clearly so the user knows which tool was in-flight.

### 7.5 Startup Flow (with tugcode)

```
tugcode
  │
  ├── Start tugcast (child process)
  │     └── tugcast starts tugtalk (child process)
  │           └── tugtalk creates Agent SDK session
  │
  ├── Parse auth URL from tugcast stdout
  ├── Open browser
  │
  └── Browser loads tugdeck
        ├── WebSocket connects to tugcast
        ├── Terminal card: shows tmux session (existing)
        ├── Conversation card: ready for input
        │     └── User types first message → tugcast → tugtalk → Claude
        ├── Files card: shows filesystem events
        ├── Git card: shows git status
        └── Stats card: shows system stats
```

### 7.6 Default Layout (Updated)

With the panel system from Phase 8, the conversation card takes the dominant left-side position. The default layout tree:

```
root: SplitNode(horizontal)
├── TabNode [Conversation]          weight: 0.667
└── SplitNode(vertical)             weight: 0.333
    ├── TabNode [Terminal]          weight: 0.25
    ├── TabNode [Git]              weight: 0.25
    ├── TabNode [Files]            weight: 0.25
    └── TabNode [Stats]            weight: 0.25
```

```
┌────────────────────────────────────────────┐
├────────────────────────┬───────────────────┤
│                        │ Terminal TugCard  │
│  Conversation TugCard  ├───────────────────┤
│  (primary)             │ Git TugCard       │
│                        ├───────────────────┤
│                        │ Files TugCard     │
│                        ├───────────────────┤
│                        │ Stats TugCard     │
├────────────────────────┴───────────────────┤
└────────────────────────────────────────────┘
```

This is the default, but the user can rearrange freely: tab the terminal with git, float the stats card, dock conversation and terminal side-by-side, or any other arrangement. The layout persists to localStorage via the Phase 8 serialization system.

### 7.7 Session Management

The Agent SDK V2 session is long-lived. It persists across:
- **Page refreshes:** tugtalk keeps the session alive. On reconnect, tugdeck receives the conversation state from tugcast (via the conversation watch channel) and renders the full history.
- **tugcode restarts:** The session ID is stored by tugtalk. On restart, tugtalk calls `resumeSession(sessionId)` to continue the conversation with full context. Meanwhile, tugdeck renders the cached conversation from IndexedDB instantly (see below).
- **Idle periods:** The session stays alive as long as tugtalk is running.

Session lifecycle:
1. `tugcode` starts → tugtalk creates a new session (or resumes if a session ID exists)
2. User converses through tugdeck
3. User closes browser → nothing happens. tugcast and tugtalk keep running. User can reopen the browser and reconnect.
4. User presses Ctrl-C on tugcode → SIGTERM chain → all processes exit
5. User runs `tugcode` again → tugtalk resumes the session → conversation continues

#### Conversation Cache (IndexedDB)

tugdeck maintains a local cache of the conversation history in IndexedDB. This provides instant rendering on page load, before the WebSocket connects or the Agent SDK session resumes.

- **On every update:** tugdeck writes the current message list to IndexedDB (debounced 1s). Each message is keyed by `msg_id` with its `seq` number.
- **On page load:** tugdeck reads the cache and renders it immediately. The user sees their conversation before the WebSocket is even open.
- **On session resume:** When tugtalk resumes and the watch channel (0x40) delivers authoritative state, tugdeck runs the reconciliation algorithm (see below) to merge cached and live state with minimal DOM churn.
- **On session resume failure:** If tugtalk cannot resume (session expired, API error), it starts a new session. tugdeck shows a divider: "Previous session ended. New session started." The cached conversation stays visible above the divider as read-only context.

IndexedDB is used instead of localStorage because conversations with code blocks, tool results, and images can easily exceed localStorage's ~5MB limit.

**Reconciliation algorithm:** When the watch snapshot arrives, tugdeck reconciles it with the cached rendering:

1. Walk both lists (cached and authoritative) in `seq` order.
2. For each message in the authoritative list:
   - If `msg_id` matches the cached message at the same position and content is identical → keep the existing DOM node (no re-render).
   - If `msg_id` matches but content differs (e.g., a partial message that is now complete) → update in place.
   - If `msg_id` is new (not in cache) → insert at the correct position.
3. Any cached messages not present in the authoritative list are removed (this handles messages from a session that was rolled back or expired).
4. After reconciliation, tugdeck writes the authoritative state to IndexedDB, replacing the stale cache.

In practice, steps 2-3 rarely trigger because the cache and authoritative state are almost always identical. The algorithm exists as a correctness guarantee, not a hot path.

**Retention & privacy:** Cached conversations are scoped by project directory (see Session Scoping below). Each project gets its own IndexedDB database (`tugdeck-<project-hash>`). tugdeck provides a "Clear history" action in the conversation card menu that deletes the IndexedDB database for the current project. There is no automatic expiration — the user controls retention explicitly. No conversation data is sent to any server other than the Anthropic API (which is inherent to the Claude session).

#### Session Scoping

Sessions are scoped by **project directory** — the `--dir` argument to tugcode (defaults to the current working directory). Each project gets its own session:

| Scoping dimension | How it's handled |
|-------------------|-----------------|
| **Project directory** | tugtalk stores the session ID in `.tugtool/.session`. Different directories = different sessions. |
| **IndexedDB cache** | Keyed by a hash of the project directory path. No cross-project data bleed. |
| **Permission mode** | Runtime setting, not part of session scope. Switching modes mid-conversation is supported. |
| **User identity** | Implicit from the `ANTHROPIC_API_KEY` environment variable. No multi-user support needed. |

This means: running `tugcode` in `/project-a` and `tugcode` in `/project-b` produces two completely independent sessions with separate conversation histories.

#### Crash Recovery

If tugtalk crashes mid-turn (segfault, OOM, unhandled exception):

1. **tugcast detects the crash.** tugtalk is a child process of tugcast. When it exits unexpectedly, tugcast captures the exit code.
2. **Error event sent to tugdeck.** tugcast emits an error event on the conversation feed (0x40): `{"type": "error", "message": "Conversation engine crashed. Reconnecting...", "recoverable": true}`.
3. **tugdeck shows an error banner.** The banner appears inline in the conversation with `AlertTriangle` icon and the error message.
4. **tugcast restarts tugtalk.** After a 1-second delay, tugcast spawns a new tugtalk process.
5. **tugtalk attempts session resume.** It reads the session ID from `.tugtool/.session` and calls `resumeSession(sessionId)`.
6. **On successful resume:** The watch channel delivers authoritative state. tugdeck reconciles and the conversation continues. A subtle note appears: "Session reconnected."
7. **On failed resume:** tugtalk starts a fresh session and writes the new session ID. tugdeck shows the divider: "Previous session ended. New session started." The cached conversation stays visible above.

**What is lost:** The in-flight turn at the time of the crash is lost. No turn replay is attempted — the complexity of replaying a partially-executed turn with side effects (tool calls, file writes) is not worth the risk. The user can re-send their last message if they want to retry.

**Stale UI cleanup:** After a crash, any pending tool approval prompts or running tool cards in tugdeck are explicitly marked stale. A visual overlay appears on each affected card: `AlertTriangle` icon + "Session restarted — this request is no longer active" in `var(--muted-foreground)`. Action buttons (Allow/Deny, Submit) are disabled. This prevents the user from interacting with prompts that no longer correspond to a live tool request in tugtalk.

**Crash budget:** If tugtalk crashes 3 times within 60 seconds, tugcast stops restarting and sends a fatal error event. The user sees: "Conversation engine failed repeatedly. Please restart tugcode." This prevents infinite crash loops.

### 7.8 Permission Model

Permission modes control which tools require user approval. Switching modes is **dynamic** — no new session needed. The `canUseTool` callback lives in tugtalk, not in the Agent SDK session itself. When the user switches modes, tugtalk changes its local approval logic while the session and full conversation context are preserved.

| Mode | Behavior |
|------|----------|
| `default` | All tools require approval (surfaced in conversation card) |
| `acceptEdits` | Read/Edit/Write/Glob/Grep auto-approved, Bash requires approval |
| `bypassPermissions` | All tools auto-approved (dangerous, for trusted environments) |
| `plan` | Same as `default`, plus plan-mode flag on the session |

tugdeck lets the user choose the permission mode from the conversation card header menu (see card menu in Phase 8). The default is `acceptEdits` (matches Claude Code's typical interactive mode). Switching mid-conversation takes effect immediately on the next tool call — no restart, no context loss.

**SDK validation note:** This design assumes permission mode changes are purely local to tugtalk's `canUseTool` callback and do not require SDK session-level changes. If the Agent SDK V2 introduces session-level permission semantics that influence planning or tool selection behavior beyond the callback, tugtalk may need to create a new session on mode switch. The adapter layer (see Risks) isolates the rest of the system from this possibility. Verify this assumption against the SDK documentation when V2 stabilizes.

### 7.9 Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| Agent SDK V2 is unstable preview | high | medium | Pin to specific version, wrap API surface in an adapter layer, monitor changelog |
| XSS via model/tool output in Markdown rendering | high | low | DOMPurify with `ALLOWED_TAGS: []` strips all HTML (sole sanitizer; marked does not sanitize). CSP meta tag as defense-in-depth. |
| Conversation state consistency (ordering, dedup) | high | medium | Message identity model with `msg_id` + `seq` numbers, gap-free ordering guarantee, reconciliation algorithm on reconnect |
| tugtalk crash mid-turn loses in-flight work | medium | medium | Auto-restart with 1s delay, session resume, IndexedDB cache preserves history. Crash budget (3 in 60s) prevents loops. No turn replay — complexity not worth risk. |
| Dynamic permission switching depends on SDK behavior | medium | low | Adapter layer isolates assumption. If SDK introduces session-level permission semantics, tugtalk can create new session on switch. Verify when V2 stabilizes. |
| IPC overhead for real-time streaming | low | low | JSON-lines is fast enough for text streaming; benchmark to confirm |
| Conversation card rendering complexity | medium | medium | marked + DOMPurify for Markdown, Shiki for syntax highlighting (17 languages initially, lazy-load rest). Proven tools, no custom parsers. |
| Session resumption failures | medium | low | Store session ID in `.tugtool/.session`. IndexedDB cache provides instant rendering on reload. Reconciliation algorithm handles divergence. If resume fails, start a new session with divider; cached history stays visible. |
| ANTHROPIC_API_KEY management | medium | low | tugtalk reads from environment variable (same as Claude Code). tugcode could prompt if missing. |
| Agent SDK breaking changes before V2 stabilizes | high | medium | The adapter layer in tugtalk isolates the rest of the system from SDK API changes. |
| Bun build.rs bootstrapping non-hermetic in CI | low | medium | Enforce `bun install --frozen-lockfile` in CI. Cache `node_modules` in CI. Pin Bun version in CI config. |

---

## 9. Implementation Order

Phases are sequenced so that **core conversation value ships before heavy UI infrastructure**. Phase 5 establishes the styling foundation. Phase 7 delivers the conversation frontend. Phase 8 adds the panel system after conversation is proven.

```
Phase 4: Bun Pivot
  └── 1 step: replace npm/esbuild with bun in build.rs, update CI

Phase 5: Design Tokens, Icons & Terminal Polish
  ├── Step 0: Design token system (CSS custom properties, migrate all hardcoded colors)
  ├── Step 1: Lucide icons (replace text-character icons, add to card chrome)
  └── Step 2: Terminal polish (padding, resize debounce, grid gap)

Phase 6: tugcode Launcher
  ├── Step 0: tugcode binary (start tugcast, parse URL, open browser, signal-wait loop)
  └── Step 1: SIGTERM propagation (tugcode → tugcast now; extends to tugtalk in Phase 7 Step 2)

Phase 7: Conversation Frontend
  ├── Step 0: Scaffold tugtalk (Bun project, Agent SDK dependency, IPC skeleton)
  ├── Step 1: Implement tugtalk session management (create, resume, send, stream)
  ├── Step 2: Implement IPC bridge in tugcast (spawn tugtalk, relay messages, crash restart)
  ├── Step 3: Add conversation feed IDs (0x40, 0x41) + message identity model to protocol
  ├── Step 4: Conversation card shell (message list, input area, user bubbles)
  ├── Step 5: Markdown rendering with marked + DOMPurify + prose styles
  ├── Step 6: Code blocks with Shiki syntax highlighting + copy button
  ├── Step 7: Tool use cards (collapsible, status indicators, Lucide icons)
  ├── Step 8: Tool approval prompts (Allow/Deny, input area blocking)
  ├── Step 9: Clarifying question cards (radio/checkbox, submit)
  ├── Step 10: Implement interrupt (Ctrl-C / stop button → cancel with per-tool contract)
  ├── Step 11: File drop, clipboard paste, and attachment handling
  ├── Step 12: Streaming state (cursor, stop button, activity indicator)
  ├── Step 13: IndexedDB conversation cache (instant render, reconciliation algorithm)
  ├── Step 14: Session scoping by project directory + crash recovery
  ├── Step 15: Default layout preset (conversation primary, terminal visible in right column)
  └── Step 16: End-to-end integration and acceptance

Phase 8: Panel System (ships after Phase 7)
  ├── Step 0: Layout tree data structure (SplitNode, TabNode, serialization, v1→v2 migration)
  ├── Step 1: Tree renderer (nested flex containers from layout tree, sash resizing)
  ├── Step 2: Tab groups (tab bar rendering, tab reordering, tab close)
  ├── Step 3: Drag-and-drop dock targeting (zone detection, blue overlay, tree mutation)
  ├── Step 4: Floating panels (undock, re-dock, move, resize, z-order)
  ├── Step 5: Card header bar (icon, title, menu button, collapse, close)
  ├── Step 6: Per-card menus (Terminal, Git, Files, Stats, Conversation dropdown menus)
  └── Step 7: Tug menu (top-right logo button, add cards, reset/save/load layout)
```

---

## 10. Key Dependencies (New)

### tugtalk (Bun/TypeScript)

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/claude-agent-sdk` | Claude Agent SDK V2 for multi-turn conversation |
| `bun` (runtime) | Runtime, bundler, package manager |

### tugcode (Rust)

| Crate | Purpose |
|-------|---------|
| `clap` | CLI argument parsing |
| `tokio` | Async child process management |
| `regex` | Parse auth URL from tugcast stdout |

### tugdeck (TypeScript, additions)

| Package | Purpose |
|---------|---------|
| `lucide` | SVG icon library (tree-shakeable, shadcn-compatible) |
| `marked` | Markdown → HTML rendering for conversation messages |
| `dompurify` | HTML sanitization for model/tool output (XSS defense-in-depth) |
| `shiki` | Syntax highlighting using VS Code TextMate grammars |

---

## 11. Success Metrics

| Phase | Metric | Target |
|-------|--------|--------|
| **Phase 4** | Build time regression vs. npm/esbuild | < 10% slower |
| **Phase 4** | Bundle size vs. esbuild output | Within 10% |
| **Phase 5** | Hardcoded hex values remaining | 0 in CSS, 0 in TypeScript |
| **Phase 5** | Text-character icons remaining | 0 (all replaced with Lucide) |
| **Phase 7** | First message → first response token (after session established) | < 2 seconds |
| **Phase 7** | Cached conversation render on page load (IndexedDB → DOM) | < 200ms |
| **Phase 7** | Streaming text render frame rate | 60fps (no dropped frames during token-by-token render) |
| **Phase 7** | Reconnect correctness | 0 reconciliation mismatches per 100 reconnects |
| **Phase 7** | Crash-free session rate | > 99% of sessions complete without tugtalk crash |
| **Phase 7** | Reconciliation DOM churn on reconnect | < 5% of message nodes re-rendered (typical case: 0%) |
| **Phase 8** | Layout save/restore round-trip | < 50ms |
| **Phase 8** | Drag feedback frame rate | 60fps (overlay tracks cursor without lag) |

**Measurement methodology:**

*Browser instrumentation (runtime metrics):*
- **UI latency** (first token, cache render, layout round-trip): measured with `performance.now()` in development builds. Report p50 and p95 over 20 runs.
- **Frame rate** (streaming render, drag feedback): measured with Chrome DevTools Performance panel. A "dropped frame" is any frame exceeding 16.67ms. Report worst-case frame time over a 10-second capture.
- **DOM churn**: instrumented via a `MutationObserver` that counts node insertions/removals during reconciliation. Report as percentage of total message nodes touched.

*CI pipeline (build metrics):*
- **Build time**: measured by CI step timing (`time cargo build`, `time bun build`). Baseline captured before Bun pivot; regressions beyond target fail the build.
- **Bundle size**: CI reports output file size. Regressions beyond target fail the build.

*Test harness (correctness metrics):*
- **Reconnect correctness**: automated harness simulates disconnects, tab reloads, and tugtalk crashes. Correctness verified by diffing the DOM snapshot before disconnect against after reconnect — any structural mismatch counts as a failure. Run 100 iterations per release.
- **Crash-free rate**: tracked over sustained test sessions (1 hour continuous use, 100 sessions). A crash is any unexpected tugtalk exit.

---

## 12. Resolved Questions

1. ~~**Markdown renderer.**~~ **Resolved:** `marked` for Markdown-to-HTML, `DOMPurify` as the sole sanitizer (marked does not strip HTML by default). CSP meta tag as defense-in-depth. Strictly no raw HTML rendering — all tags stripped. Prose styles are custom CSS scoped to `.conversation-prose`.

2. ~~**Code syntax highlighting.**~~ **Resolved:** Shiki — uses VS Code TextMate grammars directly, produces pre-tokenized HTML, supports custom themes via CSS custom properties. Exact same highlighting as the editor.

3. ~~**Conversation persistence across tugcode restarts.**~~ **Resolved:** IndexedDB cache with reconciliation. tugdeck writes messages (keyed by `msg_id`, ordered by `seq`) to IndexedDB on every update. On page load, the cached conversation renders immediately. When the watch channel delivers authoritative state, the reconciliation algorithm walks both lists in `seq` order, keeping matching DOM nodes and updating only what differs. If session resume fails, a divider appears and cached history stays visible. IndexedDB is scoped per project directory to prevent cross-project data bleed.

4. ~~**Permission mode switching.**~~ **Resolved:** Dynamic switching via tugtalk's `canUseTool` callback — no new session needed. The callback lives in tugtalk, not in the Agent SDK session. Switching is instant and preserves full conversation context. SDK validation note: if V2 introduces session-level permission semantics, the adapter layer isolates the impact.

5. ~~**Terminal card role.**~~ **Resolved:** Visible in the right column, not collapsed, in the default layout. The terminal is useful as a companion — watching builds, git output, manual commands. The default layout puts it at ~33% width in the right column, giving it presence without competing with the conversation card. The panel system (Phase 8) makes this a non-issue for experienced users: they dock, tab, float, collapse, or close the terminal to taste, and the layout persists.

6. ~~**Shiki bundle size.**~~ **Resolved:** Curated initial set of 17 languages, lazy-load the rest. Fall back to plain monospace if a grammar isn't available — no highlighting is better than broken highlighting.

7. ~~**Message identity model.**~~ **Resolved:** Every message has a `msg_id` (UUID v4) and `seq` (monotonically increasing integer, gap-free per session). Blocks within messages are identified by `msg_id` + `block_index`. Streaming updates reuse the same `msg_id` with `status: "partial"` → `"complete"`. Deduplication via `(msg_id, seq)` set. See section 7.3.

8. ~~**Markdown safety policy.**~~ **Resolved:** DOMPurify with `ALLOWED_TAGS: [], ALLOWED_ATTR: []` is the sole sanitizer — strips all HTML tags from model/tool output. marked does not sanitize by default and is not relied upon for safety. CSP meta tag as defense-in-depth. See section 7.4.

9. ~~**Process lifecycle.**~~ **Resolved:** No idle timeout. tugcode stays alive until Ctrl-C. Browser can be closed and reopened freely. SIGTERM propagation chain: tugcode → tugcast → tugtalk. See section 6.3.

10. ~~**Session scoping.**~~ **Resolved:** Sessions are scoped by project directory. Session ID stored in `.tugtool/.session`. IndexedDB cache keyed by project directory hash. Permission mode is a runtime setting, not part of session scope. See section 7.7.

11. ~~**Crash recovery.**~~ **Resolved:** tugcast auto-restarts tugtalk with 1s delay. tugtalk attempts session resume. In-flight turn is lost (no replay). Crash budget: 3 crashes in 60s → fatal error. See section 7.7.

12. ~~**Accessibility.**~~ **Deferred.** Keyboard-only docking, screen-reader labels, and contrast checks will be addressed as a dedicated pass after core functionality ships.

---

*tugcode launches. tugcast streams. tugtalk talks. tugdeck renders.*
