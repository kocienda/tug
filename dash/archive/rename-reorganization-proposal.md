# Rename & Reorganization Proposal

Five renames, two directory moves. After this work completes:

- `retronow` and the `--rn-` prefix are gone from the styling system
- `panel` / `floating-panel` are gone from the tugdeck UI layer
- The plugin lives in its own `tugplug/` subdirectory with the `tugplug` namespace
- All Rust code lives in its own `tugcode/` subdirectory
- The launcher binary is called `tugtool` (the umbrella command)
- The CLI binary is called `tugcode`

The top-level `/u/src/tugtool/` becomes a mono-repo container of subdirectory
projects: `tugcode/`, `tugdeck/`, `tugplug/`, `tugtalk/`.

**Critical staging principle:** Because two binaries are swapping names (`tugcode`
launcher => `tugtool`, `tugtool` CLI => `tugcode`), we must be meticulous. Each
step removes a name entirely, verifies it is gone, and only then does a subsequent
step reuse that name for its new purpose. A temporary name (`tug-launch`) is used
as a waypoint to avoid any moment where two things share a name.

---

## 1. retronow / --rn-* => tuglook / --tl-*

The styling system in `tugdeck/styles/` uses `--rn-*` CSS custom properties as
Tier 1 palette tokens, sourced from the retronow project. Rename the prefix
to `--tl-*` (tuglook) and remove all `retronow` references.

### Files to change

| File | Occurrences | What changes |
|------|-------------|-------------|
| `tugdeck/styles/tokens.css` | ~177 `--rn-` refs | All `--rn-` declarations and references => `--tl-`; all "retronow" / "Retronow" in comments => "tuglook" / "Tuglook" |
| `tugdeck/styles/panels.css` | 1 `--rn-` ref | `--rn-line-ui` => `--tl-line-ui`; header comment update |
| `tugdeck/styles/cards.css` | 0 `--rn-` refs | Header comment: "Retronow design language" => "Tuglook design language" |
| `tugdeck/styles/dock.css` | 0 `--rn-` refs | Header comment: "Retronow design language" => "Tuglook design language" |
| `dash/retronow-style-system-redesign.txt` | Many | Rename file to `tuglook-style-system-redesign.txt`; update content |
| `.tugtool/tugplan-retronow-style-system.md` | Many | Historical — leave as-is or add note at top |
| `.tugtool/tugplan-implementation-log.md` | Several | Historical references — leave as-is |

### Mechanical rename in tokens.css

Straightforward find-replace:
- `--rn-` => `--tl-` (177 occurrences in tokens.css, 1 in panels.css)
- `retronow` => `tuglook` in comments (case-preserving)
- `rn-theme-brio` => `tl-theme-brio` in comments (source-of-truth references,
  not active selectors — actual CSS selectors use `td-theme-*`)

### No TypeScript changes needed

The TypeScript code only reads `--td-*` semantic tokens via `getComputedStyle()`.
No TS file reads `--rn-*` variables directly. The rename is CSS-only.

### Verification

```bash
grep -r "\-\-rn-" --include='*.css' tugdeck/        # expect 0 hits
grep -ri "retronow" --include='*.css' tugdeck/       # expect 0 hits
cd tugdeck && bun test && bun run build              # all pass
```

---

## 2. panel / floating-panel => card (tugdeck terminology cleanup)

The tugdeck UI uses "panel" and "floating panel" throughout — in file names, class
names, CSS selectors, type names, and DOM structure. The correct term is **card**
(or tugcard). That's the whole point of the name "tugdeck" — it's a deck of cards.

This is the largest rename by line count. It touches every tugdeck source file,
every CSS class in panels.css, and the core data model types.

### Naming map

| Current name | New name | Rationale |
|-------------|----------|-----------|
| `PanelManager` | `DeckManager` | Manages the deck of cards |
| `FloatingPanel` | `CardFrame` | The frame (chrome, resize handles, header) around a card |
| `PanelState` | `CardState` | Position, size, tabs, active tab for one card |
| `CanvasState` | `DeckState` | The full deck: array of card states |
| `PanelSet` | `CardSet` | Connected group of cards sharing edges |
| `SharedEdge` | `SharedEdge` | Stays — describes geometry, not a panel |
| `keyPanelId` | `keyCardId` | The card with keyboard focus tint |
| `focusPanel()` | `focusCard()` | Bring a card to front |
| `acceptsKey()` | `acceptsKey()` | Stays — already card-agnostic |
| `FLOATING_TITLE_BAR_HEIGHT` | `CARD_TITLE_BAR_HEIGHT` | Title bar height constant |
| `FloatingPanelCallbacks` | `CardFrameCallbacks` | Callback interface |

### File renames

| Current path | New path |
|-------------|----------|
| `tugdeck/src/floating-panel.ts` | `tugdeck/src/card-frame.ts` |
| `tugdeck/src/panel-manager.ts` | `tugdeck/src/deck-manager.ts` |
| `tugdeck/src/__tests__/floating-panel.test.ts` | `tugdeck/src/__tests__/card-frame.test.ts` |
| `tugdeck/src/__tests__/panel-manager.test.ts` | `tugdeck/src/__tests__/deck-manager.test.ts` |
| `tugdeck/styles/panels.css` | `tugdeck/styles/cards-chrome.css` |

Note: `panels.css` becomes `cards-chrome.css` (not `cards.css`, which already
exists and contains card *content* styles). The new name reflects that it styles
card chrome — title bars, tabs, resize handles, snap guides, sashes.

### CSS class renames

Every CSS class in the current `panels.css` gets renamed:

| Current class | New class |
|--------------|-----------|
| `.panel-root` | `.deck-root` |
| `.panel-card-container` | `.card-container` |
| `.panel-card-area` | `.card-area` |
| `.panel-card-mount` | `.card-mount` |
| `.panel-tab-bar` | `.card-tab-bar` |
| `.panel-tab` | `.card-tab` |
| `.panel-tab-active` | `.card-tab-active` |
| `.panel-tab-close` | `.card-tab-close` |
| `.panel-tab.dragging` | `.card-tab.dragging` |
| `.floating-panel` | `.card-frame` |
| `.floating-panel-content` | `.card-frame-content` |
| `.floating-panel-resize` | `.card-frame-resize` |
| `.floating-panel-resize-{n,s,e,w,nw,ne,sw,se}` | `.card-frame-resize-{...}` |
| `.panel-header` | `.card-header` |
| `.panel-header-key` | `.card-header-key` |
| `.panel-header-icon` | `.card-header-icon` |
| `.panel-header-title` | `.card-header-title` |
| `.panel-header-spacer` | `.card-header-spacer` |
| `.panel-header-btn` | `.card-header-btn` |

Classes that don't contain "panel" stay unchanged:
`.snap-guide-line`, `.snap-guide-line-x`, `.snap-guide-line-y`,
`.virtual-sash`, `.virtual-sash-vertical`, `.virtual-sash-horizontal`,
`.set-flash-overlay`, `.disconnect-banner`, `.card-dropdown-menu`, `.card-dropdown-item`

### CSS custom property renames

| Current token | New token |
|--------------|-----------|
| `--td-panel` | `--td-card` |
| `--td-panel-soft` | `--td-card-soft` |
| `--td-titlebar-active` | `--td-header-active` |
| `--td-titlebar-inactive` | `--td-header-inactive` |

These appear in `tokens.css` (declarations, 3 themes x 2 tokens each = ~12 lines)
and are consumed in `cards-chrome.css` and `cards.css`.

The legacy alias `--card: var(--td-panel)` in tokens.css becomes `--card: var(--td-card)`.

### TypeScript files to update

**Files with heavy changes (class/type/import renames + CSS class strings):**

| File | Key changes |
|------|-------------|
| `src/card-frame.ts` (was `floating-panel.ts`) | Class `CardFrame`, interface `CardFrameCallbacks`, all `.floating-panel*` and `.panel-header*` class strings |
| `src/deck-manager.ts` (was `panel-manager.ts`) | Class `DeckManager`, all `PanelState`=>`CardState`, `CanvasState`=>`DeckState`, `FloatingPanel`=>`CardFrame`, `keyPanelId`=>`keyCardId`, all `.panel-*` and `.floating-panel` CSS class strings, `focusPanel`=>`focusCard` |
| `src/layout-tree.ts` | `PanelState`=>`CardState`, `CanvasState`=>`DeckState`, field `panels`=>`cards` |
| `src/serialization.ts` | All `PanelState`=>`CardState`, `CanvasState`=>`DeckState`, `makePanelState`=>`makeCardState`, `panels`=>`cards` in serialized format, comments |
| `src/snap.ts` | `PanelState`=>`CardState`, `PanelSet`=>`CardSet`, `panelToRect`=>`cardToRect`, `panelAId`/`panelBId`=>`cardAId`/`cardBId`, `panelIds`=>`cardIds` |
| `src/tab-bar.ts` | All `.panel-tab*` CSS class strings |
| `src/card-header.ts` | All `.panel-header*` CSS class strings |

**Files with light changes (import path + type name updates):**

| File | Key changes |
|------|-------------|
| `src/main.ts` | Import path `./panel-manager` => `./deck-manager`, `PanelManager` => `DeckManager`, comment update |
| `src/dock.ts` | Import path + type `PanelManager` => `DeckManager`, property `panelManager` => `deckManager`, about string |
| `src/cards/conversation-card.test.ts` | Comment referencing "panel manager owns focus" |

**Test files (heavy — CSS selector strings throughout):**

| File | Key changes |
|------|-------------|
| `src/__tests__/card-frame.test.ts` (was `floating-panel.test.ts`) | All `FloatingPanel`=>`CardFrame`, `.floating-panel*` and `.panel-header*` selectors, `PanelState`=>`CardState` |
| `src/__tests__/deck-manager.test.ts` (was `panel-manager.test.ts`) | All `PanelManager`=>`DeckManager`, `.floating-panel` and `.panel-*` selectors, `makePanelState`=>`makeCardState` |
| `src/__tests__/dock.test.ts` | `.floating-panel` and `.panel-header` selectors |

### HTML change

`tugdeck/index.html` line 11: `<link rel="stylesheet" href="panels.css">`
=> `<link rel="stylesheet" href="cards-chrome.css">`

### Serialization compatibility

The v4 localStorage format currently serializes `{ version: 4, panels: [...] }`.
After the rename the key becomes `{ version: 5, cards: [...] }`. Bump the version
so `deserialize()` correctly falls back to `buildDefaultLayout()` for old v4 data
rather than crashing on a missing `cards` key. This is the same pattern used for
the v3 => v4 migration (discard and rebuild).

### What NOT to rename

- **Card content classes**: `.files-card`, `.git-card`, `.stats-card`,
  `.conversation-card`, etc. These already use `card` correctly.
- **`card-header.ts` and `card-menu.ts`**: These file names are already correct.
  Only the CSS class strings inside them change.
- **`--td-*` semantic token prefix**: Stays. `td` = tugdeck.
- **Snap/sash/guide classes**: These describe geometry, not panels.

### Verification

```bash
grep -r "floating-panel\|PanelManager\|PanelState\|FloatingPanel\|panel-header\|panel-tab\|panel-root" \
  --include='*.ts' --include='*.css' tugdeck/        # expect 0 hits
cd tugdeck && bun test && bun run build              # all pass
```

---

## 3. Plugin namespace tugtool => tugplug + move to tugplug/

Two things happen together: the plugin namespace changes from `tugtool` to
`tugplug`, and the plugin files move from the project root into a `tugplug/`
subdirectory.

### Namespace changes

| File | What changes |
|------|-------------|
| `.claude-plugin/plugin.json` | `"name": "tugtool"` => `"name": "tugplug"` |
| `hooks/auto-approve-tug.sh` | `tugtool:*` pattern => `tugplug:*` (lines 15, 20) |
| `hooks/ensure-init.sh` | `tugtool:*` pattern => `tugplug:*` (line 12) |
| `skills/plan/SKILL.md` | `/tugtool:plan` refs => `/tugplug:plan` |
| `skills/implement/SKILL.md` | `/tugtool:implement` refs => `/tugplug:implement` |
| `skills/merge/SKILL.md` | `/tugtool:merge` refs => `/tugplug:merge` |
| `CLAUDE.md` | All `/tugtool:plan`, `/tugtool:implement`, `/tugtool:merge` => `/tugplug:*` |
| `README.md` | Plugin invocation examples |

**Note:** Agent frontmatter `name:` fields (e.g., `name: coder-agent`) do NOT
include a namespace prefix — they stay unchanged. The `tugtool:` prefix is added
by Claude Code's plugin loader from the plugin name. So changing plugin.json is
sufficient for agents.

### Directory move

```bash
mkdir tugplug
mv .claude-plugin agents skills hooks tugplug/
```

### New layout

```
tugplug/
├── .claude-plugin/
│   └── plugin.json
├── agents/
│   ├── architect-agent.md
│   ├── auditor-agent.md
│   ├── author-agent.md
│   ├── clarifier-agent.md
│   ├── coder-agent.md
│   ├── committer-agent.md
│   ├── critic-agent.md
│   ├── integrator-agent.md
│   └── reviewer-agent.md
├── skills/
│   ├── plan/SKILL.md
│   ├── implement/SKILL.md
│   └── merge/SKILL.md
├── hooks/
│   ├── hooks.json
│   ├── auto-approve-tug.sh
│   └── ensure-init.sh
└── CLAUDE.md          (plugin-specific guidelines)
```

### CLAUDE.md split

The current CLAUDE.md mixes two concerns:
- **Project conventions** (crate structure, build policy, testing, error codes)
- **Plugin operations** (skill invocation, agent architecture, worktree workflow)

After the move:
- **Root `CLAUDE.md`**: Crate structure, build policy, testing, common CLI commands
- **`tugplug/CLAUDE.md`**: Skill descriptions, agent contracts, worktree workflow,
  beads policy, plan mode policy

Both files are loaded by Claude Code when using `--plugin-dir tugplug` from the
project root.

### Plugin invocation

```bash
claude --plugin-dir tugplug
/tugplug:plan "add user authentication"
/tugplug:implement .tugtool/tugplan-auth.md
/tugplug:merge .tugtool/tugplan-auth.md
```

### Verification

```bash
grep -r "tugtool:" --include='*.md' --include='*.json' --include='*.sh' tugplug/  # expect 0 hits
# plugin loads from new location
claude --plugin-dir tugplug
```

---

## 4. Free the tugcode name: rename launcher to tug-launch (temporary)

This is the first half of the binary name swap. The current `tugcode` launcher
binary gets a temporary name `tug-launch` to free up the `tugcode` name for reuse.

**Why a temporary name?** The `tugcode` name is currently occupied by the launcher
binary. The `tugtool` name is currently occupied by the CLI binary. Both names need
to go to different binaries. A temporary name breaks the cycle:

```
tugcode (launcher) ──> tug-launch (temp) ──> tugtool (final)
tugtool (CLI)      ──────────────────────> tugcode (final)
```

### Files to change

| File | What changes |
|------|-------------|
| `crates/tugcode/` | Rename directory to `crates/tug-launch/` |
| `crates/tug-launch/Cargo.toml` | `name = "tug-launch"`, `[[bin]] name = "tug-launch"` |
| `crates/tug-launch/src/main.rs` | All string literals: `"tugcode"` => `"tug-launch"` (~15 occurrences including `#[command(name = "tugcode")]`, error prefix strings, test parse args) |
| `Cargo.toml` (workspace) | `members` list: `tugcode` => `tug-launch` |
| `crates/tugcast/build.rs` | Comment on line 120: `tugcode` => `tug-launch` |
| `tugdeck/src/cards/conversation-card.ts` | `"restart tugcode"` => `"restart tug-launch"` |
| `tugdeck/src/cards/conversation-card.test.ts` | Same string in test assertion |

### Verification

```bash
grep -r "tugcode" --include='*.rs' --include='*.toml' --include='*.ts' .   # expect 0 hits
cargo build && cargo nextest run                                           # all pass
```

After this step, the name `tugcode` is completely free.

---

## 5. Rename CLI binary: tugtool => tugcode

Now that `tugcode` is free, give it to the CLI binary (which runs `validate`,
`init`, `worktree`, `merge`, etc.).

### Files to change

| File | What changes |
|------|-------------|
| `crates/tugtool/` | Rename directory to `crates/tugcode/` |
| `crates/tugcode/Cargo.toml` | `name = "tugcode"`, `[[bin]] name = "tugcode"` |
| `crates/tugcode/src/cli.rs` | `#[command(name = "tugcode")]`; all `try_parse_from(["tugtool", ...])` in tests (~30 occurrences) |
| `crates/tugcode/src/*.rs` | Any remaining self-referencing strings |
| `Cargo.toml` (workspace) | `members` list: `tugtool` => `tugcode` |
| `tugplug/skills/implement/SKILL.md` | `tugtool init`, `tugtool worktree`, `tugtool commit`, etc. => `tugcode` |
| `tugplug/skills/merge/SKILL.md` | `tugtool merge`, `tugtool doctor` => `tugcode merge`, `tugcode doctor` |
| `tugplug/hooks/ensure-init.sh` | `tugtool init --quiet` => `tugcode init --quiet` |
| `tugplug/hooks/auto-approve-tug.sh` | `tugtool\ *` bash pattern => `tugcode\ *` |
| `.claude/settings.local.json` | `"Bash(tugtool:*)"` => `"Bash(tugcode:*)"` |
| `CLAUDE.md` | All `tugtool <subcommand>` references => `tugcode <subcommand>` |
| `tugplug/CLAUDE.md` | Same |
| `Justfile` | All `cargo run -p tug` and similar => `cargo run -p tugcode` |
| `README.md` | CLI usage examples |

### Verification

```bash
# "tugtool" should no longer appear as a binary/command name
# (it will still appear as the project name and in tugtool-core)
grep -rn "tugtool " --include='*.sh' --include='*.json' tugplug/         # expect 0 hits
grep -rn "\"tugtool\"" --include='*.rs' crates/tugcode/                  # expect 0 hits
cargo build && cargo nextest run                                          # all pass
```

After this step, the name `tugtool` is free as a binary name (it still exists as
the project name and in `tugtool-core`, which is correct).

---

## 6. Rename launcher to tugtool + move all Rust code into tugcode/

Two things happen in this final step:

**6a.** The temporary `tug-launch` becomes `tugtool` — the umbrella user-facing
command that starts tugcast and opens the browser.

**6b.** All Rust infrastructure moves from the project root into the `tugcode/`
subdirectory, making `/u/src/tugtool/` a clean mono-repo container.

### 6a. tug-launch => tugtool

| File | What changes |
|------|-------------|
| `crates/tug-launch/` | Rename directory to `crates/tugtool/` |
| `crates/tugtool/Cargo.toml` | `name = "tugtool"`, `[[bin]] name = "tugtool"` |
| `crates/tugtool/src/main.rs` | All `"tug-launch"` strings => `"tugtool"` |
| `Cargo.toml` (workspace) | `members` list: `tug-launch` => `tugtool` |
| `crates/tugcast/build.rs` | Comment: `tug-launch` => `tugtool` |
| `tugdeck/src/cards/conversation-card.ts` | `"restart tug-launch"` => `"restart tugtool"` |
| `tugdeck/src/cards/conversation-card.test.ts` | Same |

Verification checkpoint:
```bash
grep -r "tug-launch" --include='*.rs' --include='*.toml' --include='*.ts' .  # expect 0 hits
cargo build && cargo nextest run                                              # all pass
```

### 6b. Move Rust workspace into tugcode/ subdirectory

Move these files from the project root into `tugcode/`:

| From (project root) | To (tugcode/) |
|---------------------|---------------|
| `Cargo.toml` | `tugcode/Cargo.toml` |
| `Cargo.lock` | `tugcode/Cargo.lock` |
| `.cargo/config.toml` | `tugcode/.cargo/config.toml` |
| `clippy.toml` | `tugcode/clippy.toml` |
| `rust-toolchain.toml` | `tugcode/rust-toolchain.toml` |
| `Justfile` | `tugcode/Justfile` |
| `crates/` | `tugcode/crates/` |
| `tests/` | `tugcode/tests/` |
| `Formula/` | `tugcode/Formula/` |
| `dist/app.js` | remove (tugdeck build artifact, regenerated) |
| `scripts/` | `tugcode/scripts/` |

### Resulting mono-repo layout

```
/u/src/tugtool/                    (mono-repo root)
├── CLAUDE.md                      (project-level guidelines)
├── README.md
├── .tugtool/                      (tugplan infrastructure)
├── dash/                       (design documents)
│
├── tugcode/                       (Rust workspace)
│   ├── Cargo.toml                 (workspace root)
│   ├── Cargo.lock
│   ├── .cargo/config.toml
│   ├── clippy.toml
│   ├── rust-toolchain.toml
│   ├── Justfile
│   ├── Formula/
│   ├── scripts/
│   ├── tests/                     (test fixtures)
│   └── crates/
│       ├── tugcode/               (CLI: validate, init, worktree, merge, etc.)
│       ├── tugtool/               (launcher: starts tugcast, opens browser)
│       ├── tugtool-core/          (library: plan parsing, validation)
│       ├── tugcast/               (HTTP/WS server)
│       └── tugcast-core/          (server library)
│
├── tugdeck/                       (browser frontend — TypeScript)
│   ├── src/
│   ├── styles/
│   └── package.json
│
├── tugplug/                       (Claude Code plugin)
│   ├── .claude-plugin/
│   ├── agents/
│   ├── skills/
│   └── hooks/
│
└── tugtalk/                       (protocol)
```

### .gitignore update

The root `.gitignore` entry `/target/` must change to `/tugcode/target/`.

### Path updates after move

All references to Rust commands and paths need to account for the new location:

| Context | Before | After |
|---------|--------|-------|
| Building | `cargo build` (from root) | `cd tugcode && cargo build` or `cargo build --manifest-path tugcode/Cargo.toml` |
| Testing | `cargo nextest run` (from root) | `cd tugcode && cargo nextest run` |
| Plugin hooks | `tugcode init --quiet` | `tugcode init --quiet` (binary is in PATH — no path change needed) |
| CLAUDE.md | `cargo build` | `cd tugcode && cargo build` |
| Root `CLAUDE.md` | Crate structure shows `crates/` | Shows `tugcode/crates/` |

**Note:** The `tugcode` and `tugtool` binaries are installed to PATH (via cargo),
so plugin hooks and agent invocations that call them by name (`tugcode init`,
`tugtool`) are unaffected by the directory move. Only `cargo` commands (build, test,
clippy) need path awareness.

### Final verification

```bash
# All stale names are gone
grep -r "tugcode" --include='*.rs' --include='*.toml' tugcode/crates/tugtool/  # only the launcher, not the old CLI
grep -r "tug-launch" .                                                          # expect 0 hits
grep -r "\"tugcode\"" tugcode/crates/tugtool/src/                               # expect 0 (launcher is now tugtool)

# Builds clean from new location
cd tugcode && cargo build && cargo nextest run

# tugdeck still works
cd tugdeck && bun test && bun run build
```

---

## Execution order (meticulous staging)

Each step removes a name, confirms it is gone, and only then does a later step
reuse that name. No step ever has two things sharing a name.

| Step | What | Names freed | Names claimed | Verify |
|------|------|-------------|---------------|--------|
| 1 | retronow => tuglook | `retronow`, `--rn-` | `tuglook`, `--tl-` | `bun test` |
| 2 | panel => card | `panel`, `floating-panel` | `card`, `card-frame` | `bun test` |
| 3 | Plugin => tugplug + move | `tugtool:` (namespace) | `tugplug:` (namespace) | plugin loads |
| 4 | Launcher: tugcode => tug-launch | **`tugcode`** (freed!) | `tug-launch` (temp) | `cargo build` |
| 5 | CLI: tugtool => tugcode | **`tugtool`** (freed as binary) | **`tugcode`** (reused!) | `cargo build` |
| 6a | Launcher: tug-launch => tugtool | `tug-launch` (freed) | **`tugtool`** (reused!) | `cargo build` |
| 6b | Move Rust into tugcode/ | root `Cargo.toml` | `tugcode/Cargo.toml` | `cargo build` from `tugcode/` |

Each step should be a separate commit. Steps 4, 5, and 6a are the critical
name-swap sequence — they must happen in exactly this order.

---

## Out of scope

- **Renaming `--td-*` semantic tokens**: These stay. `td` = tugdeck, correct.
- **Renaming `.tugtool/` directory**: Tugplan infrastructure dir, not the plugin.
- **Renaming `tugtool-core` crate**: Library crate for plan parsing/validation.
  Named after the project, not the binary. Stays.
- **Historical tugplan files**: Plans in `.tugtool/archive/` and completed tugplans
  reference old names. These are historical records and should not be rewritten.
- **Renaming the git repo or project root**: The project is still `tugtool`.
- **Card content classes**: `.files-card`, `.conversation-card`, etc. already use
  `card` — no change needed.
- **Roadmap/tugplan references to "panel"**: Design records, not live code.
