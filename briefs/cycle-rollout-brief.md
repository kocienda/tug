<!-- brief-skeleton v1 -->

# Cycles: a record of related arcs, shown in the Session card and the sidebar

**Purpose:** One sketch often yields several briefs whose arcs depend on each other, and today the only way to see and run that work is to know which `/arc` commands to type and in what order. The user wants a first-class container for that work, a **cycle**, that anyone can see and follow from the Session card and the sidebar. This brief is the index: what a cycle is, what the Cycle Band spike settled, and the stages that build it bottom up.

---

## Purpose {#purpose}

The prompting case is the session `liven/rotund-plaid`: one sketch became eight briefs, and the work ran as a set of `/arc` commands, some in parallel and some waiting on others, across more than one session. Nothing in the app showed that set as one thing. The user's statement of the problem was to make a multi-arc workflow simple for everyone, without magic incantations.

An earlier attempt, the `docket` branch, was rolled back. The user's reading of why: it legislated too much UI at once. The instruction for this work is the opposite: build incrementally, bottom up, one step at a time.

The user's framing of the concept: a cycle is first-class in the data layer, a container of arcs, briefs and sketches, and every arc is on a cycle. The surfaces show control and progress and have no prompt of their own.

---

## Evidence {#evidence}

**[F01] An arc's state is derived, not stored.** An arc is a git branch `tugarc/<name>` plus a worktree, and "its lifecycle and status derive from git, not a database", with an append-only arc log beside it. Read in the module header of `tugrust/crates/tugarc-core/src/log.rs`. **(verified)**

**[F02] The arc record already says which session ran each stage.** `ArcRecord` in `tugrust/crates/tugarc-core/src/arc.rs` carries the document the arc opened on, its kind, its plan, and `stages`, each an `ArcStageLine` with a `session_id`. `tugtool arc` has `bind`, `unbind` and `status` verbs, the last reporting "the sessions working on it". **(verified)**

**[F03] A sketch record names one arc.** `SketchRecord` in `tugrust/crates/tugarc-core/src/sketch.rs` holds a single `SketchArc` (name and generation start). Nothing today lets one sketch stand over several briefs or arcs. The same file has `want_of(text)`, which takes a sketch's opening line. **(verified)**

**[F04] The deck's arc surfaces exist and are separate files.** The arc shade is `tugdeck/src/components/tugways/cards/session-arc-shade.tsx` with its three panels in `session-arc-panels.tsx`; the sidebar card is `tugdeck/src/components/arcs/arcs-card.tsx`; a session finds its arc through `useArcForSession` and `tugdeck/src/lib/arc-session-index.ts`. tugcast has `tugrust/crates/tugcast/src/feeds/arc.rs`. The file list was read; the contents of the feed, the shade and the Arcs card were not, so how they carry arc data today is not established here.

**[F05] The spike exists and builds.** The Cycle Band spike is `tugdeck/src/spikes/spike-cycle-band.tsx`, `spike-cycle-band.css` and `spike-cycle-band-layout.ts`, landed by the user as `c0a5c7b57`, `88e22bdf55` and `54475b5199`. Its last revision passes `tsc`, oxlint, `vite build` and the motion, visibility, token and type-alignment audits. The user reviewed it rendered across about ten rounds; the model never saw it rendered. **(verified)**

**[F06] The map layout is pure and already separate.** `spike-cycle-band-layout.ts` takes entries and their waits and returns columns, rows and wire seats, with no pixels and no React. It does longest-path layering, drops waits another wait implies, holds a seat for a wire that passes a column, and seats a sketch in the column before the entries it heads. It has no unit tests yet. **(verified)**

**[F07] A session chip can already be pressed.** `SessionIdentityView` in `tugdeck/src/components/tugways/cards/session-identity.tsx` takes an `onOpen` and is interactive when given one. The spike uses that for its links between sessions. **(verified)**

**[F08] The skills that would write a cycle were not read.** `/tugplug:brief` and the `/arc` door are where briefs and arcs come into being. What each records today, and where a cycle write would go in each, is not established here.

---

## Decisions {#decisions}

### The concept

**[B01] A cycle is a container of entries, and an entry is one brief and its one arc.** Brief to arc is always one to one. A sketch can cause several inter-related briefs; that does not change the pairing. Stated by the user outright.

**[B02] Every arc is on a cycle.** A bare `/arc` writes a real cycle of one, because that arc may be an early stage of work that later gains another brief and arc.

**[B03] A cycle is never closed and has no landing gesture of its own.** Entries and sketches can be appended at any time, since work may proceed only once late information arrives. Each arc still lands by its own join.

**[B04] An entry's state is derived, never stored:** joined, running, ready or waiting, from what the arc log and git already say and from the entry's waits. This follows [F01] and keeps the cycle record from disagreeing with the arcs it names.

**[B05] Gates are notes, not states.** "After you approve the spike" and "needs your mood board" are text on an entry. They do not block anything mechanically.

**[B06] Entries are numbered and sketches are lettered.** Entries take 1, 2, 3 in the order added and are never renumbered. Sketches take A, B. A digit always means work that can land and a letter always means where it came from. Rejected: B1/A1 prefixes, which give one entry two names, and one sequence for everything, which makes "1 of 8 landed" and "waits on 3" skip numbers.

**[B07] The skills name a cycle, from its sketches.** The name is distilled from the cycle's sketches by a rule the skills carry. It is not taken from an arc's name and not left to whatever the model happens to pick.

### The surfaces

**[B08] No surface has a prompt.** The Session card's cycle shade and the sidebar card show a cycle and never send a turn.

**[B09] A cycle shows in both the session that wrote it and every session bound to one of its arcs, with links between them.** Every running entry names its session with the ordinary session chip, and pressing the chip goes to that session. There is no separate "go to session" control.

**[B10] The Z2 status cell that reads ARC reads CYCLE, and toggles the shade.** It stays an ordinary status cell. A separate expand control on the status row's edge was tried in the spike and rejected.

**[B11] The cycle shade is a header, the map, one list of assets, and a two-line footer.** The header has the lowering control, the cycle's name and how much has landed. The list is the shade's only scroller. The footer's lines are what this session is doing now and what is ready next. A cycle of one is drawn the same way, with the bound arc's steps and verbs inside its entry; this reverses the first form of this decision, which kept the arc shade's three panels for a cycle of one (2026-11-26, at the user's direction). Other shades present over the cycle shade without replacing it.

**[B12] The map draws the cycle as a graph.** Each entry is a tile and each wait a wire; a tile's column is how deep its waits run. A sketch is a circle with a wire to each entry it heads. A wire is solid once what it leaves has landed. Borders on waiting tiles and unmet wait chips are solid gray, not dashed.

**[B13] Each asset has one representation.** A sketch or an entry appears once under the map, holding everything about it: for an entry, its arc, session, brief, waits, note, state and steps. This holds in the sidebar too, where the row opens in place.

**[B14] A press on the map never moves the map.** It brings the pressed asset to the top of the list under the map. In the Session card the list scrolls and the map is fixed above it. In the sidebar each cycle's header and map pin to the top of the card while its assets scroll under them.

**[B15] Selection is one set, the same on both maps.** A click selects one asset. A shift-click joins it to the selection or takes it out. A click on the map's background clears everything. With two or more selected the list shows only those, with a Back control that clears.

**[B16] There is never more than one scrollbar in a surface.** The shade does not scroll when its list does.

**[B17] The sidebar card becomes Cycles & Arcs and uses the same parts.** The same map at smaller measures, the same letters and numbers, one row per asset. An arc on a cycle of one is the same row with no map and no number. A folded or rested cycle keeps a strip of its entries' states.

### The rollout

**[B18] The work lands bottom up, one stage at a time.** Data first, then the feed, then one shared map, then the two surfaces. No surface is built before the data under it exists. This is the direct answer to how the docket attempt failed.

**[B19] The map is one shared component.** The spike's layout file and map view graduate into `tugdeck/src/components/tugways/`, drawn at two sizes, with unit tests on the layout. Both surfaces compose it.

---

## Open Questions {#open-questions}

- **The naming rule itself.** [B07] says the skills distil a name from the sketches. What the rule is, and what a cycle is called when its only arc was opened with no sketch, is not settled. It needs the skills read ([F08]) and probably the user's eye on a few examples.
- **Where the cycle record lives on disk and how an entry finds its arc.** The sketch store's layout is the nearest model ([F03]), but an arc name is unique only within one generation of the arc log, so an entry has to name a generation, not just a name. Settled by reading `tugarc-core` when stage 1 is briefed.
- **How "the session that wrote it" is recorded.** [B09] needs it. The arc record carries session ids per stage ([F02]); whether the cycle record carries its writer or it is read from elsewhere is open.

---

## Non-goals {#non-goals}

- **Starting things from the UI.** Start buttons, start in a new session, any door that fills the prompt, and the "New Cycle" and "Bind" controls the spike drew are all deferred. The user: "We need to defer the UI and doors for starting cycles for the moment. One step at a time." The spike's footer NEXT line can say what is ready; it carries no Start for now.
- **Gates as states.** Rejected in [B05].
- **A cycle landing or closing gesture.** Rejected in [B03].
- **The docket track.** The map borrows the idea of a graphical depiction from it and nothing else. The user's judgment was that the docket design went over the top.
- **A second representation of any asset,** such as a detail panel beside the list. Rejected in [B13].
- **Showing cycle UI in the transcript.** The shade stands over an ordinary transcript.

---

## Exit {#exit}

A set of arcs, one per stage, each from its own brief written from this one when its turn comes. Stage briefs are not written ahead, so each can use what the stage before it found.

| Stage | Lands | Waits on |
|---|---|---|
| 1 | The cycle record in `tugarc-core`, `tugtool cycle` verbs to create, add an entry, add a sketch, list and show, and derived entry state | nothing |
| 2 | The skills write cycles: `/tugplug:brief` adds an entry with its waits and note, the `/arc` door puts its arc on its entry or on a new cycle of one, and both follow the naming rule | 1 |
| 3 | tugcast sends cycles with derived states and each entry's sessions; tugdeck holds them in a store | 1 |
| 4 | The shared map component and its layout tests | nothing |
| 5 | The cycle shade and the CYCLE cell in the Session card | 3, 4 |
| 6 | The Cycles & Arcs sidebar card | 3, 4 |
| 7 | The spike retired: durable findings recorded in `tuglaws/`, the spike files and registry lines deleted | 5, 6 |

Stage 1 is next. Stages 2, 3 and 4 can run side by side once it has landed.
