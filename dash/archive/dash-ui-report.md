# Dashes in the UI — report, first round, and the revision

**Revised 2026-08-16, after the first round shipped and the owner reviewed it live.** The original report proposed folding dash identity into the session identity grammar; that round landed (inventory below), and the owner's review of the shipped result found the treatment wrong in two specific ways. This document now carries three things: what shipped and where it lives, the owner's verdicts, and the corrected design the next round implements. The corrected design supersedes the "Settled" register decisions the first edition closed with.

## 1. What shipped in round one {#shipped}

| Piece | Where it landed |
| --- | --- |
| `TugBadge` elision fix | The badge's face text rides its own `.tug-badge-text` span (`tug-badge.tsx:214-235`, `tug-badge.css:212`), so every badge elides instead of clipping both ends |
| `dashForSession` selector | `lib/dash-session-index.ts` — session-keyed lookup derived from the changeset aggregate, memoized per snapshot; no second store |
| Identity third run | `tug-session-identity.tsx` renders a dash marker run (`GitBranch` glyph + name on the line tier, glyph alone on the chip tier); the masthead's trailing badge slot is deleted (`session-masthead.tsx:528` states the rule) |
| Lens dash sub-rows | `cards-data-source.ts` emits a `dash-subrow` row kind under each bound session's pane row; rendered by `DashSubrowCell` in `cards-section.tsx` via `DashFactsRun` |
| Review tint | The marker takes the caution tone when the dash's plan reads `stale`/`never-reviewed` (`lib/dash-review.ts`); tooltip carries the sentence |

The Dashes section stayed as the account-global roster, per the first edition's decision. That part holds.

## 2. The owner's verdicts on the shipped result {#verdicts}

**2a. The two-register treatment bifurcated the identity.** The line tier shows `⎇ scroll-preserve-…` while the chip tier shows a bare glyph with the name hidden in a tooltip — the same session spells its identity two different ways depending on where you meet it. The register split was the design; the design was wrong. There must be **one format**, worn identically by every surface.

**2b. The masthead truncates with room to spare.** `scroll-preserve-resize` clips to `scroll-preserve-…` in a masthead with ample free width. The cause is not space pressure: `.tug-session-identity-dash-name` carries a hard ceiling, `max-inline-size: var(--tugx-session-identity-dash-max, 14ch)` (`tug-session-identity.css:102`), so any dash name over 14 characters truncates unconditionally. A name must never elide while there is room to show it — ceilings that fire regardless of available width are the defect, not a tuning knob.

**2c. The Lens sub-row reads as an outdent, not a nest.** The `dash-subrow` is its own row in the flat list, so it takes its own alternating-stripe band (a visible break from the session it belongs to) and its leading glyph sits at the list's outer gutter — *left* of the session's own text inset. The result reads as a stray sibling, not as a fact about the row above it.

## 3. The corrected design {#corrected-design}

### 3a. One identity format, everywhere {#one-format}

```
[custom-name]:[project/callsign]#[dash-name]
```

- **No spaces around the `:`** — `scroll-preservation:tugtool/sporty-snail`, not `scroll-preservation : tugtool/sporty-snail`. The separator belongs to the callsign run, as today, so it vanishes with it.
- **`#` is the dash sigil, and it replaces the `git-branch` glyph in the identity.** The dash run is text in the grammar — `#scroll-preserve-resize` — in the callsign's muted register, with the review tint riding the run's ink exactly as it rides the glyph today. The glyph-only chip treatment is dead: **the chip tier wears the same string as the line tier.** One format means one — the Reporter's footer atom and the masthead spell the session identically.
- **Absent parts drop with their sigil.** No custom name → `tugtool/sporty-snail#scroll-preserve-resize`. No dash → `scroll-preservation:tugtool/sporty-snail`. Neither → the bare `project/callsign`. `custom-name` and `dash-name` are both often absent, and the format degrades by deletion, never by placeholder.
- The `project/` prefix keeps riding the callsign run (`sessionIdentityLine`), unchanged — "callsign" in the format above is that composed run.
- **The citation stays dash-free.** `sessionCitation` is the flat string that outlives the binding in pastes and commits; a citation carrying `#dash` would rot when the dash lands. This is a copy-path rule, not a display rule — every *displayed* identity wears the full format.

Implementation surface: `sessionTitleParts` (or a sibling) grows the dash arm so the format is produced in one place ([D123]'s rule — one name, one producer); `tug-session-identity.tsx` renders it on both tiers and deletes the chip/line marker asymmetry; the separator spacing change lands in `tug-session-identity.css` where the runs compose.

### 3b. Elision only under real pressure {#elision}

Delete the `14ch` ceiling (`--tugx-session-identity-dash-max` and its `max-inline-size` at `tug-session-identity.css:100-106`). The dash run keeps `flex: 0 1 auto; min-width: 0` so it still shrinks first under a genuine squeeze, but its natural width is its own — a masthead with room shows `#scroll-preserve-resize` whole. The squeeze priority is unchanged: the dash run gives way first, then the per-register name/callsign rule. Audit the other two runs for the same class of defect while in there: any fixed `ch` ceiling that can truncate while the container has free width violates the same rule.

### 3c. The Lens: an extra line in the session row, actually indented {#lens-line}

The dash stops being a row of its own. Delete the `dash-subrow` row kind from `cards-data-source.ts` (and its cell registration in `cards-section.tsx`); instead, when the pane row's session has a dash (`dashForSession`, same selector), **the session row itself grows a fourth line**:

```
[dot] scroll-preservation:tugtool/sporty-snail#scroll-preserve-…   <slots>
      Preserve scroll position across card width changes…
      6 turns, 1.6 MB. Last updated: Aug 16, 2:46 PM. Ready.
      #scroll-preserve-resize  working  step 6/10  [stale-mark]
```

- **Same band.** The line lives inside the session's row, so it takes the row's own background — no alternating-stripe break between a session and its dash.
- **Actually indented.** The line starts at the row's *text* inset (aligned with the description and pulse lines, i.e. past the phase dot), never at the list's outer gutter. The shipped sub-row's 20px `padding-inline-start` on a separate row put its glyph left of the session text — the new line indents *inward* from the session's content edge.
- **Content:** the dash name in the grammar's own spelling (`#name`), the stage word, `step i/N` when present, the review mark — `DashFactsRun` survives as the renderer, re-hosted inside the pane row cell. No jump chips, as before.
- The row's measured height grows with the line — rows render at real measured heights, so nothing else changes; the line travels with its session by construction, and the row-count/stripe-parity bookkeeping that a separate row kind required is simply gone.
- Multiple sessions on one dash render the line under each, same truth as before.

The Dashes section stays as the account-global roster (parked dashes must remain findable), and still sheds its session jump chips in favor of the in-row line.

## 4. The Join sheet — from tripwire to active hunt {#join-sheet}

Plainly: the Join sheet once appeared completely dead in real use, it was never reproduced, and the standing posture was to wait for it to happen again and capture evidence (the protocol in `closing-dash-backend-issues-brief.md#join-sheet`). Waiting is no longer the plan. The backend campaign built the instrumentation that makes a dead click diagnosable — a refusing lane now states its reason in the face, a disabled control looks disabled, `__deckTrace` and the join receipts exist — so the next round **goes looking instead of waiting**: with a real dash live (one exists right now), open the Changes shade in the release instance and exercise the join surface deliberately, through the whole lifecycle — implementing, built, conflicted, landed. Either it misbehaves and the capture protocol runs on the spot with a live subject, or it survives deliberate exercise and the original report is downgraded to "fixed by the legibility round, cause among the closed defects." Both outcomes end the tripwire. What remains forbidden is only the third path: building a speculative fix with no captured evidence — the three candidate shapes (refusing / stale / covered) still have three different fixes.

## 5. The Z4A Join route — still its own pass {#z4a}

Unchanged from the first edition: the Join segment in the prompt entry's Z4A route group (`tug-prompt-entry.tsx`, `joinAvailable` / `onSelectRoute`) and the join-message prompt are a *mode* design question, deserving a focused discussion after the identity work. One concrete item now attached to it: the join's doubled subject prefix (`tugdash(close-backend): tugdash(backend): …` on `5ba5ce400`) — whoever composes the squash message prefixes a draft subject that already carries a scope; fix it in this pass.

## 6. Entry points — still deferred {#entry-points}

Unchanged: dash workflows start from slash-command archaeology, acceptable for now; revisit after the identity revision lands, when the surfaces that show a dash become natural places to start one.

## 7. Suggested order {#order}

1. **The one-format identity revision** — `custom-name:project/callsign#dash-name` produced in one place, worn by both tiers, spaces deleted, glyph retired from the identity, citation untouched.
2. **The elision fix** — kill the `14ch` ceiling; elide only under real pressure; audit the sibling runs for the same defect.
3. **The Lens in-row dash line** — delete the `dash-subrow` row kind; the session row grows the indented fourth line.
4. **The Join sheet hunt** — deliberate lifecycle exercise in the release instance with a live dash; capture or downgrade.
5. Then the Z4A/join-mode pass (doubled prefix included), then entry points.

Superseded by this revision: the first edition's closing register decisions (glyph+name on line, glyph-only on atom). Retained from the first edition: `dashForSession` as the single shared read, the Dashes section as the roster, the citation's dash-free rule, and the review tint riding the run's ink.
