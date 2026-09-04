# A commit wears one pill everywhere it is named

**Purpose:** A commit is the unit the whole app's work lands in, and today it is drawn with the same read-only skin a `file_path` in a tool header wears — glyph, label, resting underline. Four of them beside an arc pill read as rubble. The `spike-commit-atom` spike settled the look on 2026-09-04: the **Node pill**. This brief rolls it out to every surface that names a commit and retires the spike.

---

## Purpose {#purpose}

The user's notes, from the spike:

- Commits are important enough a resource to get their own atom *look*, rather than being one more annotated resource. The look must work *everywhere* — transcripts, the History shade, the Overview, the composer.
- Of the four candidates (Node pill, Rail, Slab, Ink), the **Node pill**.
- There is no reason to *always* set the `commit:` text in monospace. The face follows the surface the way the other atoms do: monospace in text entry, proportional in the transcript.
- The baseline has to be right. Two drawings hung the pill low in a sentence before the third seated it.
- The new atom follows **all the conventions of existing atoms**. It joins the system; it does not stand beside it.

---

## Evidence {#evidence}

**[F01] Every placed commit today is `TugAtomRef`'s generic read-only skin, reached through `CommitShaText`.** `tugdeck/src/components/tugways/tug-atom-ref.tsx` renders glyph + `commit:<8>` for `{ kind: "commit" }`, in the code face (`tug-atom-ref.css` pins `var(--tugx-block-code-font, var(--tug-font-family-mono))`). `commit-sha-text.tsx` wraps it and owns every pointer gesture on the sha (copy target, not link; `menu` off under a host that claims the right-click). Its mounts: the History shade's rows (`commit-presentation.tsx:215`, with `content` carrying filter `<mark>`s), the `/commit` receipt header (`cards/session-commit-receipt-block.tsx:201`), the join receipt (`cards/session-join-receipt-block.tsx:264`). **(verified)**

**[F02] The Overview's trailing refs row mounts the skin directly.** `components/overview/overview-card.tsx:391` renders `TugAtomRef` with `{ kind: "commit", sha }` inside its own `annotationProps` wrapper span, which owns the annotation contract, the pending state, and the unresolvable tooltip. The screenshot that prompted the spike is this row: an arc pill (`TugArcAtom`) followed by four commit refs. **(verified)**

**[F03] A commit written in prose is normalized to the same label by a portal, and underlined by the annotation sheet.** The annotator marks a confirmed sha `data-tug-annotation="commit-sha"`; `commit-tip-portals.tsx` empties the span and portals `commit:<8>` wrapped in a `TugTooltip` (`commitTip`), preserving the written characters on `data-tugx-commit-text`. `styles/tug-annotation.css` lists `[data-tugx-wrapped].tugx-annotation[data-tug-annotation="commit-sha"]` among the shapes that take the resting underline and the hover recolor. A click on it opens the diff (`use-annotation-menu.tsx`, `handleOpenAnnotatedDiff`), so in prose the mark *is* interactive, unlike the receipt and History mounts. **(verified)**

**[F04] The composer already has a `commit` atom type, baked as the generic chip.** `lib/tug-atom-img.ts` carries a `commit` glyph (`GitCommitHorizontal`, "a point on a line, not a file on disk") in the generic chip vocabulary. The session atom is the one type baked as a *pill*: `paintSessionChip` traces the rounded rect at `SESSION_CHIP_BORDER_ALPHA` and paints the dot at the register's diameter; `computeAtomChipGeometry` takes the register. `tug-atom-chip.tsx`'s stated font policy is that baked chips track the **transcript** font, not the editor's. **(verified)**

**[F05] The pill enclosure is one skin, and two atoms already wear it by borrowing.** `tug-session-identity.css` `[data-tier="chip"]`: `block-size` from `--tugx-atom-height`, 999px corners, border at 30% currentcolor, transparent fill, sans face pinned, `line-height: normal`; `data-interactive` firms the border to 45% on hover; `data-missing` dashes it and mutes the ink. `ArcSigil atom` (`arc-sigil.tsx`, via `TugArcAtom`) wears the class and the tier rather than authoring a second pill — "siblings by construction". The History shade's rows already seat a `TugArcAtom` at `register="prose"` in the subject's inline flow (`tug-history-list.tsx:473`). **(verified)**

**[F06] The pill's baseline problem has a settled answer, and the spike reproduced both the problem and the answer.** A flex container borrows its first item's baseline; when that item is a textless dot the browser synthesizes one from its bottom edge, and the pill hangs off its own dot. `tug-session-identity.css` fixes it with a zero-width `::before` strut carrying `U+200B`, centred like the label, so the container's baseline *is* the label's — and states that no `vertical-align` may go with it. The spike's first two drawings (`align-items: center` + a nudge; then a `1ex`-seated nudge) both hung; the third adopts the strut and sits. **(verified)**

**[F07] The registers and the line-box floor are already in place for a pill in prose.** `lib/atom-register.ts`: `prose` 22px / `reading` 24px, one dot diameter (6px), published as `atomRegisterVars`; the transcript's two bodies floor their leading to `--tugx-atom-line-box-floor` so an atom never changes a line's height. Nothing new is needed for a commit pill to stand in a sentence. **(verified)**

**[F08] The doctrine pins the identity atom's face for a reason the commit does not share.** `tuglaws/entity-presentation.md` ("The face is the atom's, like the size"): an identity atom is a *named object*, there is no mono rendition of one, and dropped into the History shade's mono rows the pill came out in Plex Mono. The same doc's commit paragraphs say the label is `commit:<8ch>`, one token, never resized, and that the atom answers the pointer with an underline and no colour move. **(verified)**

**[F09] What pins the current look.** App-tests that read a commit's label or skin: `at0239-session-history-view`, `at0365-overview-card`, `at0366-overview-copy`, `at0419-join-receipt`, `at0425-arc-conflicted-join`, `at0432-commit-row-menu`, `at0459-transcript-commit-mention`, `at0332-pane-occlusion`. The label spelling is shared with the clipboard (`commitAtomLabel`, `commitCopyText`), so tests asserting `commit:<8>` text survive a skin change; tests reaching for `.tug-atom-ref` under a sha do not. **(verified from the file list; the selectors are the arc's to read)**

**[F10] A commit has no atom form today; the conventions it must join are the session atom's.** `lib/annotator/atom-segment.ts`'s `atomSegmentFor` has arms for `file-path`, `directory`, `url` and `session`, and answers `null` for `commit-sha` — so the menu offers a confirmed sha neither `Copy as Atom` nor `Insert Atom into Prompt`, and `atom-segment.test.ts` pins it among the kinds that insert as text. `payloadForAtom` (`lib/annotator/payloads.ts`) has no `commit` type arm to invert. The `commit` glyph in `tug-atom-img.ts`'s chip vocabulary has no producer anywhere in `lib/` or `components/`. The session atom is the precedent for joining: `lib/session-atom.ts` states it — the same clipboard flavors (`text/plain` + the `dev.tugapp.prompt-atoms` sidecar) through `writeClipboardViaNative`, the same sidecar parser on paste, the same backtick-`@` wire marker at submit, "there is no parallel mechanism". **(verified)**

---

## Decisions {#decisions}

**[B01] The commit atom is a pill: the session/arc enclosure, a node for a mark, the label `commit:<8>`.** One new component, `TugCommitAtom` (`tug-commit-atom.tsx` + `.css`, `data-slot="tug-commit-atom"`), wearing `tug-session-identity` + `data-tier="chip"` exactly as `ArcSigil atom` does — the box, corners, border, padding, hover and missing states are the settled skin's, reached by the same selectors, so the three pills cannot drift on numbers. The **node** is the commit's own mark: a ring at the register's dot diameter (`--tugx-atom-dot-size`), drawn in ink, static — a commit has no phase, so it never takes the session dot's colour or pulse. The **label** keeps the doctrine's spelling, and the word stays: the spike's word-off axis was drawn and the user chose the word on. Rail, Slab and Ink are retired; recorded here so they are not re-proposed. **(approved 2026-09-04)**

**[B02] The face follows the surface, as the other atoms' does.** `TugCommitAtom` sets no `font-family`. Proportional in the transcript, the Overview, and a receipt header; monospace in the History shade's mono rows; `tabular-nums` on the hash so eight hex characters are one width in either face. In the composer the pill is a baked chip and takes the chip convention as it stands — chips track the transcript font ([F04]) — so a commit atom is the same face before and after it is sent, like every other chip. This scopes [F08]'s rule rather than contradicting it: the identity pill pins sans because a *name* has a face; a *hash* has none, and takes its surface's. `entity-presentation.md` says so in a sentence beside the existing paragraph, and the row for "a commit record's sha" in its table reads **Atom (pill)**. **(approved 2026-09-04)**

**[B03] The baseline is the label's, by the strut, and nothing else.** `TugCommitAtom` carries the `::before` `U+200B` strut with `align-self: center` and the negative gap margin; no `vertical-align` anywhere, on the atom or on any host. The flex-row hosts (History rows, receipt headers, the Overview refs row) are indifferent; the prose hosts already floor the line box ([F07]). One app-test pins the number: in a transcript sentence the pill's label baseline and the neighbouring word's baseline differ by ≤ 1px at both registers.

**[B04] Every surface mounts the one component, in this order.**

1. **`CommitShaText` mounts `TugCommitAtom` instead of `TugAtomRef`.** It keeps every gesture it owns; `content` becomes `labelContent` (the `nameContent` shape) and decorates the hash characters only, so a filter match highlights the hash and leaves the word and the box alone. This converts the History shade, the `/commit` receipt and the join receipt in one move. `commit-sha-text.css`'s hover underline retires — the pill's own hover (border 30% → 45%) is the rollover, and the cursor stays `default`, because these mounts are copy targets.
2. **The Overview refs row** (`overview-card.tsx:391`) mounts `TugCommitAtom`; the wrapper span keeps the contract and its pending/unresolvable states. An unresolvable ref wears `data-missing` — dashed border, muted ink, the same shape — rather than a bare label.
3. **Prose mentions** — `useCommitTipPortals` portals `TugCommitAtom` (inside its `TugTooltip`) into the emptied span instead of the bare label. The span is interactive there (it opens the diff), so the pill takes `data-interactive` and the pointer cursor *in this mount only* — the mark is the same, the affordance is the host's, which is already how `TugSessionCitation` works. `commit-sha` leaves the underline and hover-recolor lists in `styles/tug-annotation.css` for the `[data-tugx-wrapped]` shape: a pill does not take a text underline.
4. **The composer** — the commit becomes a real atom by the session's route ([F10], [B07]): `atomSegmentFor` gains a `commit-sha` arm answering `{ type: "commit", label: commit:<8>, value: <full sha> }`, `payloadForAtom` gains the inverse, the plain-text flavor beside it is the label (the spelling every surface and the clipboard already share), and the round trip is pinned per kind in `atom-segment.test.ts` as the others are. `tug-atom-img.ts` bakes the `commit` type as a pill by the session path: `paintSessionChip` generalizes to a pill painter that takes the mark (phase dot for a session, static ring for a commit), geometry from the same register-aware branch of `computeAtomChipGeometry`. The `GitCommitHorizontal` glyph retires from the chip vocabulary. The face is the chip convention's per [B02].
5. **`TugAtomRef` loses its `commit` arm.** `commitAtomLabel` moves to `lib/commit-format.ts` beside `COMMIT_LABEL_LENGTH`, and the clipboard paths import it from there; the spelling does not change.

**[B05] Doctrine and the spike's exit.** `tuglaws/entity-presentation.md` gains the commit-atom paragraph — the pill, the node, the face rule of [B02], the strut of [B03] — and a design-decision entry records the choice and the three retired candidates. `spike-commit-atom.tsx/.css` are deleted and the `card-taxonomy` pin steps back to thirteen. `spike-commit-surfaces` stays: it is about commit *surfaces*, not the mark, and its History-row demo shows the pill for free through `CommitShaText`.

**[B06] Tests.** The `commit:<8>` text assertions in [F09] stand. Assertions reaching for `.tug-atom-ref` under a sha are re-pinned to `[data-slot="tug-commit-atom"]`. One new app-test drives the four surfaces — a transcript mention, an Overview ref, a History row, a `/commit` receipt — and pins the slot on each, the mono/proportional face by host, and the baseline of [B03]. `bun run audit:theme-contrast` stays within the `brio` budget (the pill authors no rest colour of its own).

**[B07] The commit atom follows every convention of existing atoms — the checklist.** Each item names where the convention lives, so a step can read it rather than reinvent it:

- **Two skins, decided by authorship** (`tuglaws/entity-presentation.md`): placed → atom, written → mention normalized to the atom's label. `TugCommitAtom` is the placed skin; the prose portal is how a confirmed mention takes it.
- **One register table, three renderers** (`lib/atom-register.ts`): the DOM pill reads `atomRegisterVars` the host publishes; the SVG chip and the Canvas bake read `atomRegisterMetrics`. The node is the register's dot diameter. No vertical number authored anywhere else; `atom-register.test` holds the arithmetic.
- **The pill enclosure by borrowing** (`tug-session-identity.css` `[data-tier="chip"]`, the way `ArcSigil atom` does it): box, corners, border, padding, `text-indent: 0`, `data-interactive` hover, `data-missing` shape. The label is the one run that never shrinks; a squeeze elides inside it.
- **The baseline strut** ([B03]), and the host's line-box floor rather than any `vertical-align`.
- **The label is a name** — `commit:<8ch>`, one token, never resized, the clipboard's own spelling, decorated (filter `<mark>`s) only on the hash characters.
- **The annotation contract where the mark is actionable** (`data-tug-annotation`, `data-tug-focus="refuse"`, `data-no-activate`, `data-tugx-findable` for Find), serviced by the delegated layer; the affordance is keyed on the *presence* of the annotation, never a modifier class.
- **Gesture ownership stays with the host** (`CommitShaText` stops every pointer gesture; the Overview wrapper and the prose span own theirs), so the pill renders presentationally and never claims a click of its own.
- **The hover is the entity's** (`entity-tips.tsx` `commitTip` in a `TugTooltip variant="entity"`), never a `title` attribute.
- **The atom joins the clipboard and the wire** ([F10]): `Copy as Atom` / `Insert Atom into Prompt` through `atomSegmentFor`, the `text/plain` + sidecar flavors through `writeClipboardViaNative`, paste through the sidecar parser, submit through the backtick-`@` marker. No parallel mechanism.
- **The bake and the live pill are one picture** — same numbers from the register, same label, the face per [B02].
- **The laws**: [L06] appearance is CSS + inherited tokens, no React state; [L11] the atom declares what it is and the deck level acts; [L15] tokens, never hex — the pill authors no rest colour, only `currentcolor` mixes for state; [L19] `.tsx`/`.css` pair with a module docstring and `data-slot`; [L20] compose — the pill is `ArcSigil`'s borrowing, not a third enclosure.

---

## Open Questions {#open-questions}

- **What a commit atom's `value` resolves through.** A session atom resolves its callsign against the ledger; a commit's full sha needs a repository root to become a `commit-sha` payload again (`payloadForAtom` wants `root` and `paths`). The likely answer is the session precedent — resolve at annotation time through the card's repo, and an atom the card cannot resolve wears `data-missing` — but the step on [B04].4 reads `commit-resolution.ts` and says so.
- **Naming the shared pill sheet.** Session, arc, and now commit all wear `tug-session-identity.css`'s chip tier by borrowing. A third borrower is the moment a `tug-atom-pill.css` earns its name. Not required for this rollout; worth a line in the audit if the borrowing reads as a lie by then.

---

## Non-goals {#non-goals}

- **Changing the label.** `commit:<8ch>`, one token, never resized, the clipboard's spelling — all stand.
- **A per-sha tint, or any colour on the node.** Retired for sessions for the same reason; a colour nothing explains is noise.
- **Touching the session or arc pills.** They are the reference; the commit pill joins them.
- **The file arm of `TugAtomRef`**, or the mono pin in `tug-atom-ref.css` for file refs. Out of scope.
- **The Changes shade's per-file commit descriptors** (`tug-changes-list.tsx`) — those are diff requests, not a named commit on a surface.
- **A live commit atom.** A commit does not change; the bake is enough in the composer and there is nothing to subscribe to in the transcript.

---

## Exit {#exit}

A plain **`/arc`**, with its task list written from this brief. The parts order themselves: the component and its strut ([B01], [B03]); `CommitShaText` and its three hosts ([B04].1); the Overview row and the prose portal ([B04].2–3); the composer bake with the face question answered first ([B04].4, Open Questions); the `TugAtomRef` arm and the label's move ([B04].5); doctrine, the decision entry, the spike's deletion and the pin ([B05]); the tests ([B06]).
