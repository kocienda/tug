<!-- brief-skeleton v1 -->

# Workspaces: a named-deck level above cards

**Purpose:** A person working in Tug on several projects or purposes has one deck and no way to keep a setup for each. Workspaces add a level above cards: named, switchable arrangements of cards and sidebars, managed from the Cards card, switched with a single click.

---

## Purpose {#purpose}

The user's opening, in their words: workspaces "exist on a level *higher than cards*, and provide a way for a human dev to set up their projects (and perhaps sidebars too) in a flexible way for different projects or purposes, and then switch between them." The hope is to "transform the current Cards sidebar card, add a *level* on top of the current design, make it possible to add/configure/manage workspaces, name them, move cards between them, and then switch between them with a single click."

Today one Tug instance holds one deck. Every Session card, file card, and sidebar the user opens lands in that one arrangement, and the only way to work on something else is to close cards or open them on top. Nothing remembers a setup, and nothing lets two setups coexist.

Settled in conversation on 2026-09-15.

---

## Evidence {#evidence}

**[F01] The deck is one flat value, and it already holds everything a workspace would own.** `DeckState` in `tugdeck/src/layout-tree.ts` is `{ cards, panes, activePaneId, imposition, … }`, and `serialize()` at `tugdeck/src/serialization.ts:156` writes exactly `{ version: 4, cards, panes, activePaneId?, imposition }`, deliberately omitting session-only fields (flow offset, column offsets, bullseye, arriving). The imposition record (`tugdeck/src/lib/layout-imposer.ts:292`–`330`) carries slot kind, content width, fit/flow, every sidebar card's side and pin, rail order and shares, and column arrangements. Content cards, sidebars, and layout are all inside the one value. **(verified)**

**[F02] The deck is persisted as one tugbank blob per instance.** `putLayout` (`tugdeck/src/settings-api.ts:264`) writes `dev.tugapp.deck.layout` / `layout`; the focused card id is a separate row at `dev.tugapp.deck.state` / `focusedCardId` (`settings-api.ts:199`); per-card state bags are one row each at `dev.tugapp.deck.cardstate/{cardId}`. The database is `~/Library/Application Support/Tug/instances/<TUG_INSTANCE_ID>/tugbank.db` (`tugrust/crates/tugcore/src/instance.rs:163`–`187`). One instance, one deck. `deserialize()` (`serialization.ts:185`) migrates v2 and v3 on read; writes are always v4, and `buildDefaultLayout()` (`serialization.ts:748`) is an empty deck with Cards pinned right. **(verified)**

**[F03] Sidebars are deck facts, not app preferences.** `imposition.sidebars` is keyed by component id "because a sidebar card is a singleton: its side is a property of the card *type*" (`layout-imposer.ts:315`–`322`); rails key their order and shares by component id too. [D121] states there is no app-wide sidebar-side preference. Deck invariant 6 (`layout-tree.ts`, enforced by `validateDeckState`) says at most one pane hosts each sidebar card type and that pane carries no slot. The five registered sidebar cards are Cards, Arcs (id `dashes`), Jots, Layout, Overview, fixed at boot (`layoutRole: "sidebar"`, `tugdeck/src/card-registry.ts:301`). The factory rail is `FACTORY_RAIL_ORDER = [cards, dashes, layout]` at `tugdeck/src/deck-manager.ts:393`. Sidebar reopen width is separate and per card type in `tugdeck/src/lib/sidebar-width-store.ts`. **(verified)**

**[F04] A Session card's project is a ledger fact keyed by card id, not a deck field.** `CardState` has no cwd. Tugcast's sessions ledger records `(card_id, project_dir, session_id)` at spawn, and `tugdeck/src/lib/session-restore.ts` restores after reload by sending `list_card_bindings` and matching the deck's session cards by `card_id`; a binding with `has_jsonl`, `turn_count > 0`, or `is_alive` resumes, anything else spawns fresh in place. The in-memory `cardSessionBindingStore` (`tugdeck/src/lib/card-session-binding-store.ts`) is keyed by card id. So a card whose id is unchanged keeps its session and its running tugcode process wherever the card is moved. **(verified)**

**[F05] The Cards card is already the deck's switching surface, and already has the machinery a second level needs.** [D121]: "the filterable, metadata-rich Cards list — not a tab strip — is the switching surface." `tugdeck/src/components/cards/cards-card.tsx` renders a pane-first mirror bucketed into Sessions / Files / Tools (`cards-groups.ts`, resolved off `cardsGroup` on the registration, `card-registry.ts:256`). Group headers are cursorable rows: Enter/Space toggle collapse, the header is the group's drag handle, and a whole group moves as one block on `useBlockReorder`. Rows front their card on click or Enter, close by ×, join the layout selection on Space, and move slots through `SlotPicker`. Its presentation state persists at `dev.tugapp.cards` with keys `cardsRowOrder`, `cardsGroupOrder`, `cardsCollapsedGroups` (`cards-store/types.ts:29`–`35`); row order keys are the bound session id for a session pane, the card id otherwise, and the pane id for a stack. **(verified)**

**[F06] The rename to Workspaces is already decided.** [D172] gives the Cards card ⌃⌘W, "taken against this card's coming rename to **Workspaces**, so the letter is right slightly before its noun is" (`tuglaws/chord-tiers.md:190`, `tuglaws/design-decisions.md:691`). The Window menu's per-card sidebar rows (`briefs/window-sidebar-brief.md`) read a `sidebars` fact off the deck projection, so their marks follow whichever deck is projected. **(verified)**

**[F07] The word "workspace" is already spoken for on the wire.** `workspace_key` (`tugdeck/src/protocol.ts:134`) is a session's canonical project directory as echoed by tugcast; [D113] and `WorkspaceRegistry` use the same sense. Nothing in `tuglaws/` or `briefs/` describes a named set of cards. **(verified)**

**[F08] Capture on switch is an existing path.** `captureAllForTeardown` (`deck-manager.ts:5492`) and the six capture moments in `tuglaws/state-preservation.md` write every card's state bag before a DOM mutation. The bag is keyed by card id and restored by the card's own components at mount. No new capture mechanism is needed for a card that leaves the screen when its workspace does. **(verified)**

**[F09] `filterRegisteredCards` sweeps a blob's unregistered cards at load, and the Cards card must be registered before layout restore or its rail evaporates** (`cards-card-registration.tsx:9`–`13`, `deck-manager.ts` `loadLayout`). Any per-workspace deck goes through the same sweep. **(verified)**

---

## Decisions {#decisions}

**[B01] A workspace is a named deck.** The level above the deck is an ordered list of workspaces, each holding one deck of the shape in [F01] plus its own focused card id, and a pointer to the active one. Switching means the deck manager renders a different deck. Content cards, panes, slot layout, sidebars, and rails all follow, because they are all inside the deck [F01]. Nothing is filtered or hidden; inactive decks are simply not mounted. This rules out tagging cards inside one big deck (a switch would be a filter, hidden cards would hold slots, invariants would break) and rules out a workspace as a Tug instance (a switch would be a relaunch, and instances are build flavors, not things a person names).

**[B02] Sidebars are per workspace.** User's call. It falls out of [B01] and [F03] with no extra state: a review workspace can show Arcs and Overview while a coding one shows Jots. Each workspace's imposition carries its own sidebar sides, rail order, and shares. Sidebar reopen width stays per card type, deck-wide, as today.

**[B03] The user noun is Workspaces; the code gets a distinct name.** User's call, on [F06] and [F07]. The Cards card is retitled Workspaces and keeps ⌃⌘W. In code the deck-level record is not called a workspace, so `workspace_key` keeps its one meaning. Proposed identifier: **`space`** (`SpaceState`, `spaces`, `activeSpaceId`, `dev.tugapp.deck.layout` v5 fields `spaces` and `activeSpaceId`). It is short, has no existing sense in the tree, and names the same idea macOS Spaces names. The identifier is the arc's to confirm at its first step; only the distinctness is decided here.

**[B04] Inactive workspaces restore their sessions lazily.** User's call. On app reload, only the active workspace's session cards go through `restoreSessions` [F04]. A workspace restores its sessions the first time it is activated in this app run. Ten workspaces therefore do not spawn ten sets of tugcode at boot. A session row in an inactive workspace still shows ledger facts (alive, turn count) read from `list_card_bindings`, which already lists every card id, without spawning anything.

**[B05] Switching never closes a session.** A card in a workspace that leaves the screen is unmounted, not closed: its state bag is captured on the existing teardown path [F08], its binding stays in `cardSessionBindingStore`, and its tugcode process keeps running. Switching back remounts the card and restores scroll, focus, and content from the bag. This is the property that makes a workspace a place to leave work rather than a way to lose it.

**[B06] A workspace carries no project and no constraint on its members.** User's call: "i can have any mix of cards in my workspace." A workspace is a name and a deck. New Session inside it opens the picker exactly as today. Nothing ties a workspace to a directory, and nothing prevents two repos, or none, from sharing one.

**[B07] Moving a card between workspaces is a move of the card record, id unchanged.** The card and its pane leave the source deck's `cards` and `panes` and join the destination deck's, keeping the card id, so the session binding and state bag ride along untouched [F04] [F08]. The moved pane arrives at the bottom of its column in the destination, the rule [D194] already sets for arrivals. Sidebar cards are not moved between workspaces (user's call, and invariant 6 makes each a per-deck singleton [F03]); they are shown or hidden per workspace by the existing ladder.

**[B08] The Cards card grows one outer level and becomes the Workspaces card.** Workspace rows become the outermost group headers, above Sessions / Files / Tools. The active workspace is expanded and marked; each inactive workspace is collapsed to one row. Reuse is the point [F05]:

- A single click or Enter on a workspace row activates it.
- Dragging a pane row from one workspace's group into another moves the card [B07].
- Dragging a workspace header reorders workspaces, on the same block reorder the inner group headers already use.
- New, Rename, Duplicate, and Delete live on the workspace row's context menu; Rename is inline on the row. Delete of a workspace holding live sessions confirms first, with the same guard the Session card's close uses, and closes those sessions on confirm.
- Escape keeps its shrinking order (filter, layout selection, focus out); an expanded inactive workspace is a read-only view of its rows and its rows are not in the layout selection, because the layout verbs act on the active deck only.

**[B09] The layout blob goes to version 5, and a v4 blob becomes one workspace.** `serialize()` writes `{ version: 5, spaces: [{ id, name, deck, focusedCardId? }], activeSpaceId }` where `deck` is the v4 shape. `deserialize()` wraps a v4 (or older, after the existing migrations) blob as a single workspace named **Main**, so no existing deck changes shape on first launch. Per-card state rows are unchanged. The focused card id moves inside each workspace record, and the `dev.tugapp.deck.state` row is read once as the migrated Main workspace's focus and then no longer written. The Cards card's row-order map needs no scoping: its keys are session ids and card ids, unique across workspaces [F05]. `filterRegisteredCards` runs per deck [F09].

**[B10] The Window menu follows the active workspace, and gains a Workspaces section.** The sidebar rows already read the deck projection [F06], so their marks read the active deck with no change. A section of one radio row per workspace, marked for the active one, is added under Window, managed by section as `briefs/window-sidebar-brief.md` [F08] requires. Every row is a registered command per [L30]. No chord is assigned to switching or cycling workspaces in this cut: ⌃⌘digits are widths ([D130]) and the letter tier is a card's.

**[B11] Cards moved or created while a workspace is active land in that workspace.** `addCard`, `showSidebarPane`, the type picker, `run-command-in-new-session`, and every other creation path write to the active deck. There is no cross-workspace open in this cut; a card is opened where the user is standing and moved from the Workspaces card if it belongs elsewhere.

---

## Open Questions {#open-questions}

- **The empty workspace.** A new workspace is a deck with no content cards. Does it inherit the factory rail (Cards, Arcs, Layout pinned right) or start bare? The factory rail exists so a fresh deck has its doors, and a workspace whose Cards card is hidden has no door back except ⌃⌘W and the Window menu. Leaning: a new workspace opens with the factory rail, and the arc can confirm at its first step.
- **Duplicate.** Whether Duplicate copies cards (fresh ids, which for a Session card means an unbound card opening on the picker) or only the layout and sidebars. Leaning: layout and sidebars only, since a session cannot be in two places.

---

## Non-goals {#non-goals}

- **Workspace as a tag or filter over one deck.** Rejected: a switch would not be a switch, hidden cards would still occupy panes and slots, and the deck invariants ([F03]) would need exceptions for members that are not on screen.
- **Workspace as a Tug instance or window.** Rejected: an instance is a build flavor with its own tugbank and processes, so a switch is a relaunch, and the user wants one click.
- **A project directory on a workspace.** Rejected by the user: no constraint on what a workspace holds.
- **Moving sidebar cards between workspaces.** Rejected by the user; each is a per-deck singleton and is shown or hidden per workspace instead.
- **Eager restore of every workspace's sessions at boot.** Rejected for this cut in favour of lazy restore [B04]; it can be revisited if a background workspace's sessions need to be live before the user visits it.
- **Reusing the word "workspace" in code.** Rejected: it already means a session's project directory on the wire [F07].
- **A chord for switching or cycling workspaces.** Deferred, not designed: the digit and letter tiers are taken, and the click and the Window menu are the doors in this cut.
- **Shared sidebars across workspaces.** Rejected by the user in favour of per-workspace sidebars [B02].

---

## Exit {#exit}

**An arc.** The parts and an order that keeps every step landable:

1. The deck-level record and its persistence: the v5 blob, the v4-to-Main migration, `serialize` / `deserialize` round-trip tests, and the focused-card move [B09].
2. The deck manager hosts many decks and renders one: activate, capture on leave, remount on return [B01] [B05], with the creation paths pointed at the active deck [B11].
3. Lazy session restore per workspace [B04], and the ledger-fact rows for inactive sessions.
4. Card move between decks [B07].
5. The Workspaces card: outer level, switch, reorder, move by drag, the context-menu verbs, the rename of the card [B08] [B03].
6. The Window menu section [B10], the ⌃⌘W noun catching up, and the app-tests: a v4 blob migrating to Main, a switch that leaves a session alive and restores its scroll, a move that keeps a session bound, a relaunch that restores only the active workspace's sessions.
