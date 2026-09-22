# Card Identity Resolution

**Purpose:** A card's identity — what it holds, and therefore what its row says — is currently readable only while the card is mounted, so every card in a workspace nobody has activated draws as its registration's generic default. The fix is one resolution API that answers for any card in any workspace, live or parked.

---

## Purpose {#purpose}

The Workspaces card is "*far too eager* in dropping the session information for cards not in the current workspace. This is bad and goes completely against my design intent." A Session card sitting in an unvisited workspace draws as a row titled `session` with no description, no beat line, no slot picker, and a close `×` where its identity should be. "Once I click into the workspace, the information restores."

The ask is that this never be lost — and not only for sessions: "I want this fixed comprehensively for all cards and workspaces, and I want it done in a way that creates a *properly clean API* to make the required information easily available."

---

## Evidence {#evidence}

**[F01] Nothing drops the information; nothing ever picked it up.** `resolveCard` in `tugdeck/src/components/cards/cards-data-source.ts:574` has exactly one door into session identity — `} else if (binding !== undefined) {` at `:607`, where `binding` is the **live** `cardSessionBindingStore` entry a card only receives when it mounts. A workspace nobody has activated mounts no cards, so every Session card in it takes the `else` and is titled from `card.title || defaultTitle(componentId)`. `tugSessionId` and `projectDir` then come back `null` (`:622`), and the list builds a *generic* cell rather than `CardsSessionRow`. The `×` and the missing slot picker are not separate cosmetic defects; they are the tell that the row fell through to the generic branch. **(verified — read out of the code)**

**[F02] The durable record is already in hand, and is consulted for one thing only.** `spaceBindingsLedgerStore` (`tugdeck/src/lib/space-bindings-ledger-store.ts`) caches the boot `list_card_bindings_ok` frame, which lists **every card id the ledger knows** rather than only the active deck's — precisely so it can answer for a workspace nobody has opened. Each `CardBinding` row (`tugdeck/src/protocol.ts:290`) carries `session_id`, `project_dir`, `name`, `name_user_set`, `tag`, `synopsis`, `turn_count`, `is_alive`, `has_jsonl`, and the arc. The Workspaces card reads all of that for a single boolean: `cachedSessionLive` (`cards-data-source.ts:440`), which feeds the header's `N live` count. Everything the title line and the description line need is in the same row, unread. **(verified)**

**[F03] The identity stores are bind-seeded, so a resolved id alone would not be enough.** `SessionIdentityRow` resolves name, synopsis and tag from the per-session stores (`session-name-store`, `session-synopsis-store`, `session-tag-store`), keyed by session id and filled when a card binds. Grepping `synopsis` across `session-restore.ts`, `deck-manager.ts` and `card-session-binding-store.ts` finds no seeding path from the boot frame — the payload arrives and only its `is_alive`/`turn_count` fields are ever read. **(verified)**

**[F04] This is not a session-only defect, and the file cards prove it by having been patched for it one kind at a time.** `resolveCard` already hand-rolls two per-kind durable fallbacks: `text` and `file-view` both fall back to `parkedBagContent` / `parkedFile` (`:109`, `:418`), added because a parked file card was being called "File". The Commit and Diff cards preserve their targets through the same `useCardStatePreservation` bag (`commit-card.tsx:52`, `diff-card.tsx`) but have no fallback branch, so a parked one draws its registration's default title. Each kind that has been fixed was fixed in its own `else if`; each kind that has not been fixed is silently broken. **(verified)**

**[F05] The degradation reaches past the Workspaces card.** `cardTitleStore` (`tugdeck/src/lib/card-title-store.ts`) is explicitly a *mounted-card* channel — "cards write `set(cardId, …)` once their identity resolves and `clear(cardId)` (or unmount) when it goes away" — and the tab bar, the deck canvas, the Window menu and the pane chrome all read it. Any surface naming a card in a non-active workspace is reading from a store that is empty by design for exactly those cards. **(verified — read out of the docstring; the per-surface symptoms have not each been reproduced)**

**[F06] The rule this work needs is already written down in the codebase, as a precedent applied once.** `parkedBagContent`'s docstring states it plainly — *where the live map cannot answer, the durable record does* ([P08]) — and cites the session case as the precedent it was following. The session case never received the treatment. **(verified)**

**[F07] The activity tape needs no work.** A parked session has no local activity history and `SessionIdentityRow` draws a flatline, which is the documented intent: "an instrument that disappears when it reads zero cannot be told apart from one that is broken." A restored session with no recent work draws the same flatline, so the parked row is not distinguishable as degraded on that axis. **(verified — read out of the component docstring and visible in the user's second screenshot)**

---

## Decisions {#decisions}

**[B01] Card identity is *resolved*, never *mounted*.** The product invariant is one sentence: a card's row says what the card holds, in every workspace, from the first frame after boot, whether or not anything of that card is standing. Mounting is an implementation detail of the active workspace and must not be an input to what a card is called. This rules out any fix that makes the answer correct only after a visit, and it is the line every test below pins.

**[B02] The resolver is declared by the card's registration, not switched on inside the Workspaces card.** `CardRegistration` gains an identity capability beside `cardsGroup` — a live resolver and a parked resolver — and `resolveCard` becomes a call rather than a chain of `else if`s. This is the "clean API" the work is for, and the argument is [F04]: a per-kind branch in a consumer means every new card type is born broken and is fixed only when somebody notices. Registration-declared resolution makes coverage total by construction, the same way `resolveCardsGroup` already guarantees every card type files somewhere by falling back to `"tools"`. Revisit only if a card kind's identity genuinely cannot be expressed as a function of its id and its persisted bag.

**[B03] One total function is the whole public surface: `cardIdentity(cardId)`.** It answers for any card id, live or parked, and returns a complete identity — title, secondary line, path or session id, icon, and which source answered. Live sources are preferred; the durable record answers when they cannot; the two are never merged field-by-field, because a half-live identity is a state nobody can reason about. Consumers do not learn which registries exist, and no consumer is permitted to reach past it into `cardSessionBindingStore`, the open registries, or the bag.

**[B04] Session identity is restored by seeding the identity stores from the boot frame, not by giving the row a second ladder.** The `list_card_bindings_ok` payload already carries `name`, `name_user_set`, `tag` and `synopsis` for every card ([F02]); those fold into the name, tag and synopsis stores as the frame lands — the same values a rebind seeds. The alternative, teaching `SessionIdentityRow` a durable-only fallback it consults when the live stores are empty, is rejected in Non-goals: that component exists because three description ladders drifted, and a second source inside it is a fourth. Seeding keeps one ladder and changes only what is in the buckets it reads. It also pays out everywhere at once — the masthead, the picker and Open Quickly read the same stores.

**[B05] Every surface that names a card reads the resolver.** The Workspaces card, the tab bar, the deck canvas, the Window menu and Open Quickly go through `cardIdentity`. `cardTitleStore` keeps its write channel — a mounted card publishing its own override is still the live truth and still the notification path — but it stops being the *only* thing a reader consults, so a name is available for a card that has never stood up ([F05]).

**[B06] The name and the description are instant; the metadata line may arrive.** Title, secondary line and session id come from the boot frame with no round trip, so no row ever renders as degraded. The third line's turn count, size and last-used time come from the session ledger, which `sessionLedgerStore` already fetches per project directory on first read — so that line fills in a beat later. A row that shows its name immediately and gains a statistic shortly after is not what the user is complaining about; a row that shows `session` is.

**[B07] A parked identity is presented as true, not as provisional.** No staleness badge, no dimming, no "unloaded" affordance. The ledger's record of what a card holds is correct; the card merely is not standing. The only presentational consequence of parked-ness that stays is the existing `data-cards-space-inactive` mark, which is about *where you are*, not about how much is known.

**[B08] The invariant is pinned by tests at both altitudes.** A pure test over `cards-data-source` — a card with a ledger-cache row and no binding resolves to a full session identity with a non-null `tugSessionId` — and a cold-boot app-test over a parked workspace asserting the row carries `data-session-id`, a description line, and no close affordance. A registration-coverage test in the shape of `cards-groups.test.ts` pins that every registered card type resolves an identity for a parked card, so a new card type cannot be added broken.

---

## Open Questions {#open-questions}

- **What triggers the per-project session-ledger fetch, and when?** [B06] leans on `sessionLedgerStore`, which is cached by project directory and self-dispatches `list_sessions` on first read. Across several workspaces that is one round trip per distinct project at boot. Whether that is fine as an eager boot fan-out, or should be deferred until a row is actually on screen, depends on how many projects a real deck spans and what `list_sessions` costs on a large ledger — neither of which was measured here.
- **Does `cardTitleStore` fold into the resolver or stay beside it?** [B05] keeps its write channel and redirects readers, which is the smaller change. Whether the store should eventually *become* the live half of the resolver — one object rather than two that must agree — is a design call that wants the resolver to exist first.

---

## Non-goals {#non-goals}

- **A durable fallback inside `SessionIdentityRow`.** Considered and rejected. That component was written to end a drift between three independently-authored description ladders; a second source consulted when the live stores are empty is a fourth ladder wearing a fallback's clothes. Seeding the stores ([B04]) achieves the same result with one ladder.
- **Mounting or spawning parked cards so they bind.** Rejected outright. The restore design deliberately does not stand up a workspace nobody has activated, and making identity depend on doing so would trade a cosmetic defect for real subprocesses.
- **Changing the workspace header's `N live` arithmetic.** It already reads the durable cache and is already correct ([F02]); it is the one consumer that got this right, and it is left alone.
- **Making the tape draw history for a parked session.** The flatline is the designed answer ([F07]). Backfilling activity would mean fetching per-session history for every card at boot, which is a different feature with a different cost.
- **A staleness or "not loaded" affordance on parked rows.** Rejected by [B07] — the record is true, and marking it provisional would re-introduce the very sense of "this workspace's information is lesser" the work exists to remove.

---

## Exit {#exit}

An arc. The order is load-bearing in one place and free elsewhere.

The resolution API comes first and alone: the identity capability on `CardRegistration`, the `cardIdentity(cardId)` function, and the registration-coverage test. It lands as a pure addition with no consumer changed — at that point the two existing hand-rolled fallbacks (`text`, `file-view`) move behind it unchanged, which is the proof that the shape fits the cases already solved.

Session identity then has two halves that can land in either order but must both land before the defect is closed: the store seeding from `list_card_bindings_ok` ([B04]), and the parked-session branch in `resolveCard` that hands the row a `tugSessionId` and a `projectDir` so it builds `CardsSessionRow` rather than a generic cell. The cold-boot app-test belongs with the second.

The remaining card kinds — Commit, Diff, and any other holding a preserved target ([F04]) — are one declaration each against the API, and are where the "comprehensively for all cards" half of the ask is actually discharged. The other surfaces ([B05]) follow, with the Window menu and the tab bar the most visible.
