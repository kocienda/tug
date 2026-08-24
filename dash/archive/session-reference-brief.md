# Session Reference Brief

Status: **design complete — ready to devise.** Every design question below is decided; nothing in this document is awaiting an answer.
Date: 2026-08-08

## How to read this document

This is a finished design brief for one body of work: making Tug refer to a session the same way everywhere. It is written to be handed to a session that was not part of the design discussion, so it states decisions rather than deliberations, and gives the reasoning for each so an implementer can tell a load-bearing constraint from an incidental one.

Three things it is **not**: it is not an implementation plan (that is what devising it produces), it does not sequence the work, and it does not estimate it.

Where a decision was reached by rejecting an alternative, the rejected alternative is recorded with its reason and marked **do not re-propose**. Those are not open options; re-opening them costs a round that has already been spent.

**The visual design already exists as running code.** A gallery design spike card auditioned every visual decision here against live fixtures, and it is the reference for what the components should look like:

- `tugdeck/src/components/tugways/cards/gallery-session-identity.tsx`
- `tugdeck/src/components/tugways/cards/gallery-session-identity.css`
- Registered in `gallery-registrations.tsx` as `gallery-session-identity`; open it from the Component Gallery ("Session Identity", Feedback category).

Read that card before building. Its docstrings carry the same decisions as this brief, anchored to the markup that implements them, and its CSS comments explain the geometry. Everything in it that already exists as a `Tug*` component **is** the real component (`CardTitleBar`, `TugPulse`, `TugSessionRow`, `TugListRow`, `TugProgressIndicator`); only the session atom and the identity stack are prototypes, and turning those two into a real component is a large part of this work. Nothing in `gallery-session-identity.css` is inherited by the app — it is all scaffolding and prototype, and it is meant to be replaced by tokens, not copied.

## Purpose

Tug refers to sessions in at least seven forms across at least fifteen surfaces, with five near-parallel precedence rules and no shared component, no shared typography, and no doctrine entry. This brief defines one identity model, one resolver, one component family with density tiers, a text-only citation form, and a fork-lineage grammar.

Root cause of the sprawl: **[D123] ("a pane's name is one string produced in one place") exists for pane titles but was never extended to session identity.** The canonical formatter is dead code; the doctrine entry does not exist. This work is [D123] applied to the session.

## The audit

### Identifier forms and where they come from

| Form | Example | Producer | Notes |
|---|---|---|---|
| tug session UUID | `f6e43925-…` | client mint at spawn (`session-card.tsx:1799`) | routing key; diverges from claude's id on fork (`tugcode/src/session.ts:7337`) |
| 8-char short id | `ab7579ac` | render-time `slice(0,8)`, computed independently in three places (`session-name.ts:26`, `changeset.rs:737`, `changeset.rs:755`) | never stored |
| adjective-noun tag | `stocky-pixie` | client mint from 512×1024 lexicon (`session-tag.ts:65`), unique index in `sessions.db` (`session_ledger.rs:1381`) | lost on fork; silently dropped on suffix exhaustion; faked non-uniquely for external sessions via `deriveStableTag` |
| user name | `/rename` | `sessions.name` + `name_user_set` | the only user-editable form |
| auto title (incipit) | "Add animation to card resize…" | Claude Code `ai-title` JSONL records, scraped only by the external scan (`external_sessions.rs:926`) | no live capture — fresh titles lag until a scan |
| project/branch prefix | `tugtool/stocky-pixie (branch)` | `sessionCardTitleOverride` (`session-card-title.ts:36`) | derived, never persisted |
| `prior_owner_name` | Changes orphan hint | changeset feed `display_name` (`changeset.rs:755`) | a fourth naming pipeline no other surface consults |

### Five parallel precedence rules

`sessionChipDisplay` (orphaned since the Z4B diet), `sessionRowTitle` (picker), `sessionEntryTitle` (heuristic hash-equality sniff), Rust `session_row_title` (no tag arm), Rust `session_display_name`. No two identical.

### Surface divergences

- **Picker** leads with the incipit; tag is buried in a metadata line typographically identical to the timestamp; external sessions show a synthesized tag that exists nowhere else.
- **Title bar** (`tugtool/stocky-pixie`) and the **picker row** for the same session share no substring at all.
- **Lens** rows match the title bar, but the filter-match projection passes `branch: null` (`cards-data-source.ts:290`) while the rendered row passes the real branch.
- **Gazette** ref chips print the full 36-char UUID — the label rule is a path-shaped `split("/").pop()` that is a no-op on a UUID (`gazette-card.tsx:112`). `post.sessionId` is loaded and discarded.
- **Tab strip** shows the literal registry title "Session" for a stacked Session card (`tug-tab-bar.tsx:441`) — the [D123] drift failure, still live in one surface.
- **Changes card** names sessions with its own vocabulary and renders no identifier; the owner id sits unpainted in a DOM attribute.
- **Commit messages / History card** render the `Tug-Session:` trailer as a truncated prompt incipit plus the **full UUID** — the only user-facing full-UUID display besides the Gazette chip, and the incipit half is frequently ambiguous.
- **Typography:** tag, title, and UUID are undifferentiated plain text at four uncoordinated sizes (picker `md`, Lens `sm`, title bar `sm`, Gazette chip `2xs`).

## The model

### One role per form — forms never swap jobs

**Tag = the callsign.** The stable, typable, distinguishing handle; answers *which one?* Appears on every surface, always in the same visual treatment, always the lead identifier. Immutable — no `/retag`. Becomes addressable: the deferred `tag → session_id` resolver and `/resume <tag>` land as part of this work.

**Title = the description.** Answers *what's it about?* Always subordinate to the callsign — it never leads on any surface.

The description is **generated and rolling**. The incipit is retired as its source: first prompts are too samey and ambiguous to scan by, and worse, a first prompt describes where the session *started* — it goes stale the moment the work turns. The description must be **current**: what this session is for, is doing, and has done, *right now*, changing as the work changes.

The facility for that already exists. `SharedAgent` (`tugcast/src/shared_agent.rs`) runs a pooled Haiku worker with two latency lanes (`JobClass::Classify` / `JobClass::Summarize`), and the PULSE and shell classification already ride it. The description becomes a third job on the **Summarize** lane — call it the **synopsis** — composed from the session's recent turns and re-run as the work moves, exactly as the PULSE headline is. Precedence: an explicit `/rename` always wins and freezes the line; absent one, the synopsis is the description; absent both (a session with no turns yet), the line is honestly empty.

Three details to settle while building, deliberately left open because they want to be tuned against real output rather than specified in advance: the re-run trigger (turn count, elapsed time, or a topic-shift signal); the wording register (the PULSE prompt's own headline rules at `shared_agent.rs:1285` are the precedent — *"a headline with no verb is a label, and a label is a failure"*); and where the synopsis persists so it survives reload without a re-run. It rides the existing worker pool and recycle caps, so it needs no new infrastructure.

**Project = the context.** Always rendered, joined to the callsign as one run (`tugtool/stocky-pixie`) — the form does not vary by surface.

**Branch is not identity.** It is workspace state that changes under a session; rendered beside the callsign it reads as an unexplained signal. It lives in the telemetry placard. This retires the `(branch)` suffix that `sessionCardTitleOverride` currently appends off-`main`.

**UUID = plumbing.** Machine fields, tooltips, and a copy affordance (`TugCopyBadge`, whose docstring already names session ids as its use case). Never a primary label, never a display fallback — the fallback is always the tag, which every session can have.

### One resolver

`resolveSessionIdentity(sessionId) → { project, branch, tag, lineage, title, state, liveness }` — a structured object, grown from `session-card-title.ts`, absorbing and deleting `sessionChipDisplay`, `sessionRowTitle`, `sessionEntryTitle`, and the client-side hash sniff. The Rust feed grows its tag arm so the client never re-derives. Every surface consumes the resolver; no surface composes identity strings itself. This is the session-identity analog of [D123]'s `composePaneTitleBarText`.

### Two registers, one identity

The organizing distinction, and the thing to get right first:

- **Presence** — a surface that *is* the session (the masthead, the row about to open it) renders the callsign as typography: chatbox icon, bold sans, **no enclosure**.
- **Citation** — a surface that *refers* to a session from foreign context (a Gazette post, the Changes orphan hint, a History commit) wraps the same identity in the **session atom**, where an enclosed chip correctly reads as a link to the thing elsewhere.

The title bar is not a citation. It *is* the session — there is no chip to click through to anywhere — so it never wears the atom.

### One component family — density tiers

**`TugSessionIdentity`**, composing existing Tug components (never hand-roll UI that exists as a `Tug*` component; borrowing its CSS is still hand-rolling). Surfaces choose a *tier*, never a *format*:

| Tier | Contents | Consumers |
|---|---|---|
| **Chip** | the session atom; hover → full identity via `TugPlacard`; click → raise/open | Gazette refs, Changes orphan hint, inline mentions |
| **Line** | `project/callsign` + optional truncated title | tab strip, slot-stack picker, Window menu |
| **Row** | the four-line identity stack | picker, `/resume` sheet, Lens Sessions group |
| **Masthead** | expanded card chrome, the stack's top three lines | Session card title bar |

### Typography

The tag gets one distinct, recognizable treatment everywhere it appears — it is the one identifier that is never prose.

- **Bold sans, never monospace.** Mono belongs to flat text (the commit trailer), not to session chrome.
- **The mark is the chatbox icon**, which already means *session* in the app. Not a dot, which could mean anything.
- **The form is always `<project>/<callsign>`, as a single bold run** — one face, one weight, one color, one text node. Never a muted context run mixed against a bold tag. Two spans opened a gap after the slash and let each half truncate independently (`tugto… syrupy-beam`); one run can do neither. This holds in both registers.
- **The icon gap is one number,** identical in both registers and at every tier — it ships as a single token (`--tugx-session-identity-icon-gap`), not a per-surface choice. Presence and citation are the same mark at different weights; a gap that drifted by surface would break the recognition the whole convention is built on.

### The session atom

The citation register's form is a **rounded, specialized pill** — deliberately not the squared house `TugBadge` — so session references have their own look and feel, recognizable before reading.

It paints in one theme-authored **session color**: a new role token, one hand-authored value per theme file like danger or success, contrast-audited (`bun run audit:theme-contrast`). Shape and color together always mean exactly one thing: "a session, referenced from elsewhere." The color **seeds from the `agent` family** — the model's color, because a session is an agent surface — chosen against accent, link, and success candidates on the spike card. One color knob drives ground, border, ink, and icon by mixing toward transparent and toward the theme's own text token, so one rule reads on all six themes.

**Per-session tint: auditioned and retired — do not re-propose.** A deterministic hash-derived per-session hue was rejected because color is a semantic channel in Tug (role tokens mean danger/success/caution/accent), so a hashed hue reads as meaning while meaning nothing — every glance asks a question with no answer. The distinctiveness it was hired for is already carried by the lexicon words themselves. The single session color is the correction, not a contradiction: one fixed color that *means session* keeps the channel semantic.

### The atom is a real Tug atom

Copying a session atom writes every flavor Tug's clipboard already speaks (`lib/tug-native-clipboard.ts`), and pasting one into a Tug surface pastes the **atom**, not a string:

| Flavor | Payload | Effect |
|---|---|---|
| `dev.tug.prompt-atoms` | `{"kind":"session","tag":"tugtool/syrupy-beam","id":"f6e43925"}` | Paste into a Tug composer, a Jot, a Gazette reply → the atom re-materializes as the pill, live and clickable. |
| `text/plain` | `tugtool/syrupy-beam (f6e43925)` | **The citation.** Paste into a terminal, a commit message, another app → exactly the trailer grammar. |
| `text/html` | `<span data-tug-session="f6e43925">tugtool/syrupy-beam</span>` | Paste into a non-Tug rich-text surface → the callsign, styled, carrying its id. |
| wire marker | `` `@tugtool/syrupy-beam` `` | Submitted prompt text keeps the mention's structural identity through JSONL, so replay re-mints the chip instead of showing prose. |

The wire marker is the existing mechanism at `lib/atom-mention-marker.ts`. The session atom **joins** this system; it does not build a parallel one. Note the consequence worth preserving: the plain-text flavor *is* the citation, which is what earns the flat-text form its keep.

### The identity stack — the row and the masthead are one thing

The row tier is **four lines** — callsign, description, PULSE, then metadata (time · turns · size). The masthead is exactly the top three of those. One component, one leading scheme, two mounts.

The row is **Lens-like**: the phase dot leads, pulsing while the session runs and settling small and quiet when it does not — the picker and the Lens have been showing the same thing two different ways. The dot is **row furniture, not part of the reference**: it never rides a citation.

**Lens-*like*, not Lens-*sized*.** The Lens's 28px indicator (`TUG_SESSION_ROW_INDICATOR_SIZE`) is sized for its job *there*: catching the eye when something changes, legible from across the room. A list row is read up close and deliberately, and at 28 the dot becomes furniture the callsign has to work around. The row tier takes **16px**, so the dot and the name sit together as one mark rather than two things sharing a line.

**Leading is not uniform, and must not be.** The lines are two groups: the callsign is *identity*; the description, PULSE, and metadata all say *what it is doing*. So the space under the callsign separates the groups while the lines below it sit tight enough to read as one block.

#### The geometry, measured

Measured in the running app (not estimated). These are the numbers the components should ship:

| | value | note |
|---|---|---|
| lead gap (callsign → description) | **5px** | `--tugx-session-identity-lead-gap` |
| line gap (between the lower three) | **1px** | `--tugx-session-identity-line-gap` |
| line-height, all stack lines | **tight** (`--tug-line-height-tight`) | explicit, never inherited — see below |
| `--tugx-pulse-bar-height` in the stack | **18px** (default is 34px) | with `--tugx-pulse-baseline: 13px` |
| row dot | **16px** ring box | overhangs left by its own inset |
| row sub-line indent | **10px** | |
| row block padding | **12px** | |
| row height, four lines | **93px** | 69px content inside 24px padding |
| **`--tug-masthead-height`** | **72px** — **RATIFIED** | fixed; JS mirrors it as a constant |

Three geometry findings that cost rounds to discover, recorded so they are not rediscovered:

1. **Line-height first, margin second.** These lines are single runs, not prose, so each must take the tight line-height *explicitly*. Left to inherit the card's ~1.45 body leading, a 13px run sits in a 19px box, and the half-leading above and below it is space no margin can take back. Margin tuning cannot fix leading that line-height caused.
2. **`TugPulse`'s inline bar is fixed at 34px**, sized for a PULSE standing alone on a strip. Dropped into the stack that is a 14px run inside a 34px box — **20px of air** against 14–15px lines on every side, and the single largest contributor to the stack reading loose. Set the published knob down and move `--tugx-pulse-baseline` with it: the baseline is stated from the *top* of the bar, so shrinking one without the other clips descenders. These are knobs `TugPulse` publishes; do not reach into its internals ([L20]).
3. **Block padding and leading are opposite jobs.** Closing the lines up is what makes four lines read as one entry; standing the block off the separator rules is what keeps it from reading as crowded. Tuning one as if it were the other is why the row read wrong through two rounds.

Placement details for the row: the dot's *ring box* overhangs left by its own inset so the **dot** — not its box — lands on the row's margin (the dot paints at 60% of its box; the rest is the breath the pulse throws), and it overhangs block-wise into the row's padding so it does not set the callsign line's height. This is what `TugSessionRow`'s `inset` fit already does, at the smaller size.

`TugSessionRow` grows a description line and a metadata line to become this tier; the picker moves off its hand-assembled `TugListRow`.

### The masthead — the title bar grows up

One-line 36px title bars are a vestige of pixel-starved UIs displaying the name of a file on disk. Neither applies to Tug: a card's chrome can expand vertically to say more about what it contains. The Session card's chrome becomes a **masthead**, three lines:

- Lead line: `project/callsign` + the pane controls.
- Second line: the description.
- Third line: the PULSE (`TugPulse`, inline layout) — the session's standing intent and current activity, resident in the chrome.
- Trailing affordance: a small pulse/info widget — hover or click opens a `TugPlacard` with the telemetry at a glance (state, turns, created/compacted stamps, branch, the citation with a copy affordance).

The masthead stays **identity-first**; the numbers are one gesture away, not resident.

Architecture: chrome remains the Pane's ([L09]/[L25]). `cardTitleStore`'s override evolves from a string to a structured identity payload; `TugPane` renders masthead density when a card publishes one and keeps the one-line bar otherwise. The load-control bar's "Session created …" line is an absorption candidate. The mechanism generalizes: any card with real content identity (a file card's path + dirty state) can publish a masthead later.

#### The Z2 PULSE strip is removed, not duplicated

The PULSE currently lives as `SessionPulseStrip` — the Z2 strip, one line above the prompt entry (`session-pulse-strip.tsx` / `.css`, mounted at `session-card.tsx:4423`). **Once the masthead carries the PULSE, that strip comes out.** The same voice in two places on one card is worse than either place alone, and the masthead is the better one: identity and current activity read together, and the composer gets its vertical space back.

This is a real piece of work, not a deletion, because the strip is not just a line of text. Everything it owns must be re-homed or deliberately retired:

- **The dwell queue.** Lines coalesce with a minimum dwell (`MIN_DWELL_MS`) so rapid thoughts don't strobe; the newest pending line wins when the dwell expires, and the user's own submit clears immediately. This pacing is what makes the voice readable and it must move with the PULSE, not be reimplemented.
- **The compaction pin.** A `Compacting context…` pin holds for the length of a `/compact` started from this card — the one stretch the voice cannot narrate, because the wire streams nothing between the submit and the boundary. Fed by `compactionProgressStore`.
- **The `pulse/enabled` toggle.** The strip hides entirely when the tugbank default is off. In the masthead, "hidden" cannot mean a collapsing chrome — the height is fixed and must not become content-driven. Decide the empty-line behavior explicitly: the masthead keeps its height and the PULSE line is simply absent.
- **The activity sparkline.** The tape rides the PULSE line's trailing edge; `TugPulse`'s inline layout already takes a trailing accessory. Note `TUG_SESSION_ROW_SPARK_WIDTH` / `_HEIGHT` are documented as deliberately matching the strip's numbers so the same series reads identically on both surfaces — if the strip's constants move or die, that pairing and its docstring must be updated rather than silently orphaned.
- **The focus stop.** The strip's PULSE label registers a `useFocusable` leaf into the card's cycle (`SESSION_CYCLE_ORDER_PULSE`, inside a `CycleScope` sharing the card's mode id, [P10]). Chrome is the Pane's, so a stop that moves into the masthead is moving across an ownership boundary — settle where it lands, or retire the stop, but do not leave a dangling order in the cycle.

**The Z2 status row is unchanged.** The row above the strip — STATE / TIME / TOKENS / CONTEXT / WORK — keeps its content, its layout, its position, and its tokens exactly as they are. The only change anywhere in that region is that the PULSE row beneath it goes away. Do not take the strip's removal as license to restyle, re-space, or re-scope the status row while in the neighbourhood, and do not migrate any of its fields into the masthead or the telemetry placard on the grounds that they would fit there — some of them would, and it is still out of scope. If removing the row below it leaves the status row sitting differently against the prompt entry, correct that with spacing alone.

**Height is a fixed second tier.** `--tug-chrome-height` (36px, declared identically in all six themes) gains a sibling `--tug-masthead-height` at **72px**. One fixed value, not content-driven: every masthead card is therefore the same height as every other, geometry stays computable without measurement, and the existing invariant that JS mirrors the chrome height as a constant (`CARD_TITLE_BAR_HEIGHT = 36`, `tug-pane.tsx:87`) extends unchanged rather than becoming a measurement problem. Identity that overflows truncates (middle-truncation via `TugLabel`) and the placard carries the full text; **the masthead never reflows to fit its content.**

### The citation — text-only form

Prose, commit messages, exports, and logs need a canonical plain-text reference. The **citation** is:

```
stocky-pixie (f6e43925)
```

— callsign plus parenthesized 8-char short id. The short id makes the citation durable beyond one machine's ledger (tags are machine-local; git history is forever) and disambiguates any future tag reuse across machines. With project context when the context doesn't supply it: `tugtool/stocky-pixie (f6e43925)`.

This is the **only** sanctioned flat-text form, and the only place monospace appears. Applications:

- **`Tug-Session:` commit trailer** becomes the citation, replacing the truncated-prompt-plus-full-UUID form (`changes-route-controller.ts:278`).
- **Transcript export filename** becomes `tug-session-<tag>-<shortid>` instead of the bare hash.
- Anywhere else a session must be named in flat text (dev log, diagnostics, Gazette export).
- The atom's `text/plain` clipboard flavor.

#### Commit trailers: two lines, human and machine

The commit carries **both** — full disambiguation is worth one extra line:

```
Tug-Session: stocky-pixie (f6e43925)
Tug-Session-Id: f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f
```

The citation trailer is what a human reads and what the History card renders. The id trailer is the machine key — what `changes.db` joins on (that table is keyed by the full tug session id), what survives short-id ambiguity across machines, and what future tooling resolves against. It is never displayed.

#### Resolution: structured-first, pattern-match later

Tug has two mechanisms for making an identifier interactive, and this work uses them in sequence.

**Phase 1 — structured field (this brief).** tugcast parses the trailers out of the commit body server-side into typed fields on `GitLogCommit`, exactly as `Tug-Dash:` is already parsed into `tug_dash` (`tugcast-core/src/types.rs:193`, rendered as a badge at `tug-history-list.tsx:344`). The History card renders the citation at chip tier on the commit's identity line beside the SHA and dash badge. **The trailer lines are stripped from the displayed body** — today they are raw text dumped through `TugMarkdownText` (a syntax styler, not a renderer), which is what produces the wrapped UUID and truncated incipit in the current History card. `Tug-Session:` is the last of our trailers with no structured field; this closes that gap.

**Phase 2 — pattern match (deferred, not part of this work).** Citations in free prose — a Gazette post, a typed message, a plan doc, a commit Tug did not author — light up through the content annotator, whose registry is built for exactly this extension (`lib/annotator/registry.ts:99`: "a detector plus an entry here, with no edit to any transcript, cell, or menu surface"). Two prerequisites, both real:

- **Hex collision.** The 8-char short id is 8 lowercase hex characters with at least one digit, which is precisely what `scanCommitShas` matches (`detect-commit-sha.ts:54`, 7–40 hex with a digit). A bare short id in annotated text would be claimed by the commit-SHA detector and sent to the git resolver. The session detector must therefore match the **whole citation** (`<tag> (<hex>)`) and claim the run before the SHA scanner reaches the parenthesized part.
- **Scope.** The History card sits outside any `AnnotationScope` (mounted only by the transcript, `session-card-transcript.tsx:418`), so the annotator is inert there until one is mounted.

Phase 1 is unblocked by neither and fixes the commit display on its own.

#### The unresolvable citation

A citation can name a session this ledger has no record of — a commit made on another machine, a Gazette post older than a salvaged database. **The atom keeps its shape and slashes its icon.** Shape is what tells a reader *what kind of thing* is being named, and that remains true when the lookup fails, so the pill stays. The failure is stated in the one mark that already carries the meaning "session": the chatbox icon gains a slash (`MessageSquareOff`). It drops the session color for the theme's muted ink and takes a dashed border, so it reads as inert rather than as a link that happens to be broken. It **is** inert: no navigation, no raise, no hover placard. The tooltip says *Session not found* rather than repeating the tag the reader can already see.

Note what this is **not**: sessions are never dead. A session that exists can always be resumed, so liveness is not a property a *reference* renders — the phase dot is row furniture and never appears on a citation. "Missing" here means only *not resolvable from here*, which is a fact about this ledger, not about the session.

### Fork lineage grammar

A fork inherits visible lineage: **`<root-tag>-<Letter><Number>`**, e.g. `stocky-pixie-A1`.

- The **letter** identifies the branch *point* in the root session: the first rewind point forked from is `A`, a fork taken from a different point is `B`, and so on.
- The **number** sequences forks from the same point: the second fork from point `A` is `stocky-pixie-A2`.
- A fork of a fork extends: `stocky-pixie-A1-B2`. Display may middle-truncate deep chains so root and leaf both survive; the chip tooltip carries the full lineage.
- Storage: the fork records its root tag + lineage segments; the display string is derived by the resolver.

Grammar note: the ledger's current mint-collision suffix is a bare `-N` (`tag_base` at `session_ledger.rs:4760` permits exactly one numeric suffix). That grammar must yield — with the reroll cap, natural mint collisions are vanishingly rare, so the bare-`-N` backstop is retired (or replaced with a full reroll against the ledger) and `-<Letter><Number>` becomes the only sanctioned suffix, reserved for lineage. Fork today silently mints an unrelated fresh tag (`session.ts:7337` — the ledger row and tag stay behind on the old id); the fork path must instead carry the lineage-suffixed tag through the spawn.

### Tag space

Verdict: **the space is sufficient; keep two words.**

- 512 adjectives × 1024 nouns = 524,288 combinations against a per-machine ledger that realistically accumulates thousands of rows — mint collisions under the reroll cap are already rare and get rarer with lexicon growth.
- The scarce resource is not combinations but *human distinctiveness within the working set* — a dozen concurrent sessions that must not blur. More or longer words hurt that (three-word tags scan and type worse). The remedy is the typographic convention, not a bigger namespace.
- Grow the lexicon opportunistically (more 4–5-letter nouns are the cheap axis; nouns dominate the product), never structurally.
- **Never recycle a tag.** Uniqueness holds against every row the ledger has ever held, including trashed sessions — a Gazette post or commit citation from last month must never come to mean a different session.
- The lineage grammar is the structured extension of the space: every root tag fans out into its own `-A1…` subspace for free.
- External sessions get **real minted tags backfilled at scan time**, retiring the non-unique `deriveStableTag` display path entirely.

## Data-layer repairs

Needed regardless of the visual work, and several of the surfaces above are blocked without them.

1. **Live `ai-title` capture** — the bridge forwards `ai-title` records into the ledger as they stream; today a fresh title waits for an external scan (`external_sessions.rs:926`). (Reduced in importance by the synopsis, but the field is still consumed.)
2. **Tag arm in the Rust title rule** — `session_row_title` (`changeset.rs:724`) carries the tag so `prior_owner_name` and the changeset feed speak the same language; the client hash-equality sniff (`session-name.ts:98`) is deleted.
3. **Backfilled tags for external sessions** — minted and persisted at scan time; `deriveStableTag` retires from production.
4. **Fork carries lineage** — the fork spawn threads the suffixed tag; no more silent fresh mint.
5. **Suffix-exhaustion fix** — a mint that exhausts the bare-`-N` backstop currently lands a NULL tag silently (`session_ledger.rs:2366`); with the backstop retired this becomes a full reroll, never a tagless row.
6. **Tab strip reads the pane title** — `tug-tab-bar.tsx:441` drops its `componentId === "text"` gate and goes through `paneTitleBarTextFor` like every other surface.
7. **Gazette chip resolves identity** — `RefChip` gains a session case that calls the resolver; the raw-UUID label dies.
8. **Changes card adopts the chip tier** — the orphan hint and (where useful) bucket headers render `TugSessionIdentity` chips instead of ad-hoc feed strings.
9. **Commit trailers parsed server-side** — `Tug-Session:` and `Tug-Session-Id:` become typed fields on `GitLogCommit` alongside `tug_dash` (`tugcast-core/src/types.rs:193`), and both lines are stripped from the body the History card renders. The writer side (`tugdash-core/src/ops.rs:812`, `changes-route-controller.ts:278`) emits the citation plus id pair.

## Scope

**In scope.** The resolver consolidation; `TugSessionIdentity` and its tokens; the session color in the six theme files; `TugSessionRow` growing to the four-line stack; the masthead tier in `TugPane`; **removing the Z2 `SessionPulseStrip` and re-homing what it owns**; the synopsis job on `SharedAgent`; the commit-trailer read and write paths; adoption at every surface named in the audit; the nine data-layer repairs; the doctrine entry.

**Explicitly out of scope.** Phase 2 annotator pattern-matching for citations in free prose (deferred; prerequisites listed above). Mastheads for non-session cards (the mechanism should generalize, but nothing else adopts it here). **The Z2 status row**, which stays exactly as it is — see the note under the masthead.

**Constraints that bind the implementation.**

- The Rust workspace treats **warnings as errors** (`-D warnings`).
- `changes.db` schema changes require bumping `CHANGES_SCHEMA_VERSION` with a registered migration; never edit the DDL alone. Every writable ledger open goes through `tugcore::ledger_db` (enforced by the `no_ad_hoc_ledger_opens` test).
- Tugdeck laws apply: **[L02]** external state enters React only through `useSyncExternalStore`; **[L06]** appearance changes go through CSS and DOM, never React state; **[L19]** `.tsx`/`.css` pairs with `data-slot`; **[L20]** token sovereignty — a component owns its own `--tugx-*` and composes others through their published knobs without reaching inside. Read `tuglaws/tuglaws.md`, `pane-model.md`, and `component-authoring.md` before touching tugdeck code.
- Theme tokens are **hand-authored** in `tugdeck/styles/themes/*.css` (six files) — there is no generation script. Validate with `bun run audit:theme-contrast`; no theme may exceed the `brio` accessibility budget.
- Verify tugdeck changes with `bunx vite build` — the debug app loads the prod rollup bundle.
- **Never hand-roll UI that exists as a `Tug*` component.** Borrowing its CSS is still hand-rolling.

## Doctrine

The outcome gets a **D-number**: session identity is one structured record produced by one resolver; every surface renders it through `TugSessionIdentity` at a declared density tier; the tag is the immutable callsign and always leads; the UUID never leads; the citation is the only sanctioned flat-text form. Companion updates: the masthead amendment to the pane-chrome sections of `pane-model.md`, and the lineage/suffix grammar recorded beside the tag machinery.

## Decision register

Every design question, with its answer. Nothing here is open.

| Question | Decision |
|---|---|
| Registers | Presence (typographic, for surfaces that *are* the session) vs citation (the session atom, for references from foreign context). |
| Callsign face | Bold sans. Monospace never appears in graphical session rendering. |
| Callsign form | Always `<project>/<callsign>`, one bold run, one text node. |
| Icon gap | One token, identical in both registers and at every tier. |
| Citation form | The session atom — a rounded pill of its own, not the squared house badge. |
| Session color | One theme-authored role token, seeded from the `agent` family, hand-authored per theme file. |
| Per-session tint | **Retired — do not re-propose.** Color is semantic in Tug; a hashed hue means nothing. |
| Clipboard | The atom is a real Tug atom — sidecar, plain-text citation, HTML, wire marker. |
| Description source | A rolling, generated **synopsis** on `SharedAgent`'s Summarize lane. `/rename` overrides and freezes it. The incipit is retired as a source. |
| Incipit leading | Never — the callsign leads on every surface. |
| Branch | Not part of identity; telemetry placard only. The `(branch)` title suffix retires. |
| Row tier | Four lines — callsign, description, PULSE, metadata. Lens-*like*, not Lens-*sized*: 16px dot on the row's margin, 10px sub-line indent, 12px block padding around tight leading. |
| Masthead | Three lines (callsign / description / PULSE), grouped leading, identity-first. |
| Masthead height | **72px, ratified.** A fixed second tier; overflow truncates; the placard carries the full text. |
| Masthead telemetry | Identity-only chrome; telemetry one hover/click away via a placard widget. |
| The Z2 PULSE strip | **Removed** once the masthead carries the PULSE. Its dwell queue, compaction pin, `pulse/enabled` behavior, sparkline, and focus stop are re-homed, not reimplemented. |
| The Z2 status row | **Unchanged** — content, layout, position, and tokens all stay. Removing the PULSE row beneath it is the only change in that region. |
| Liveness on a reference | Not a thing — sessions are never dead. The phase dot is row furniture and never rides a citation. |
| Unresolvable citation | The atom keeps its shape, slashes its icon, goes muted and inert, tooltip *Session not found*. |
| Commit trailers | Both — a human `Tug-Session:` citation and a machine `Tug-Session-Id:` full UUID. |
| Citation resolution | Structured-first (server-parsed typed fields, following `Tug-Dash:`). Annotator pattern-matching is a deferred second phase. |
| Fork lineage | Visible, `<Letter><Number>` suffixes (`stocky-pixie-A1`); letter = branch point, number = sequence. |
| Tag mutability | Immutable; no `/retag`. |
| Tag space | Two words; opportunistic lexicon growth; never recycle; lineage is the structured extension. |
