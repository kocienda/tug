<!-- brief-skeleton v1 -->

# Content visibility: the card that went blank, and the reckoning it calls for

**Purpose:** A session card moved into a workspace that is not on screen comes up with no visible content, and nothing the user does brings it back. It is the latest of several regressions in how content, cards, shades and sheets become visible or stay visible, and the user's judgment is that the recent fixes in this area have been band-aids at best. This brief pins the mechanism of the latest one and sets the ground for a full audit of the code that has been landing around visibility.

---

## Purpose {#purpose}

The user, testing the surface `workspaces-refine` landed as `f5c8d7d54`:

> Changing a card to a different workspace made its content *disappear*! [...] Nothing I could do would bring back the content in the card I had. I had to close that session, which unbound the arc, then open a new session card and rebind. As soon as I did that and then moved that card to another workspace (which wasn't visible), the content disappeared again, and I could never bring it back.

And, pulling back:

> We have experienced some very bad regressions lately in the area of content, card, shade, and sheet visibility. It feels like the "fixes" you've made are band-aids at best and *horrid hacks* at worst. We need to get this back under control. [...] I want a full reckoning and complete cleanup and refactoring of this code to get us back on a stable footing, with a full tuglaws audit as well.

So there are two purposes here, and the second outranks the first. The first is the defect: why the card went blank, established to the mechanism. The second is the audit it earns: every piece of code landed lately that decides whether content is visible, read cold against `tuglaws/tuglaws.md`, with the hacks named and taken out.

---

## Evidence {#evidence}

### The defect

**[F01] The blank card's whole DOM is present and laid out; its body computes to opacity 0** — inspected live on the user's Release instance through tugcast's loopback `/api/eval` (the `diag/eval` opt-in was set for the inspection and revoked afterwards). With the card's workspace shown, the pane measured 675×1176, the body 673×1085, the transcript's scroll height 12244, every tool block a non-zero height, the composer 46px tall, and `.session-card` computed `opacity: 0` from an inline `style="...; opacity: 0;"`. No animation was attached to the element. The healthy session card beside it had no inline opacity and computed 1. **(verified, measured)**

**[F02] The inline opacity is written by `SessionCardBody`'s first-mount fade, and the fade's completion cannot land on an element with no box** — `session-card.tsx` (the "First-mount fade-in" effect) sets `el.style.opacity = "0"` synchronously and opens a `TugAnimator` group animating opacity 0 → 1, relying on the group's `commitStyles()` to write the final value. `tug-animator.ts` wraps `commitStyles()` in `try { } catch { /* target detached; nothing to commit */ }` and then cancels the animation. `commitStyles()` throws `InvalidStateError` for an element that is not being rendered, and a card mounted into a hidden workspace layer sits under `.tug-space-layer { display: none }` (`space-layer.css`). So the animation finishes, the commit throws, the swallow cancels the animation, and the hand-written `opacity: 0` is the element's state from then on. Nothing later touches it: a workspace switch changes the layer's `display`, and no code re-runs the fade. The effect skips itself only when the store is replaying or cold-restoring, which is why a card mid-restore is spared and a live one is not. **(verified: the writer read out of the code; the resulting state measured live; clearing the inline opacity restored the user's card on the spot)**

**[F03] The same class has a milder sibling in the composer** — the live card's editor carried `--tugx-editor-line-box: 14px` where the healthy card's carried `30px`. `line-box-metric.ts` publishes the measurement from CodeMirror's measure cycle and, by design, re-measures only on a reconfigure or a document change, never on a geometry change. A composer that first measures inside a hidden layer settles on the estimate and keeps it until the user types. **(verified, measured live)**

**[F04] Measurements that observe survive a hidden mount; measurements that run once do not** — the hidden card carried `--tugx-block-header-height: 0px` on all 78 of its tool blocks while hidden, and every one read a real height once shown, because `block-chrome.tsx` measures through a `ResizeObserver`. `TugPane`'s own measurements are armed on the shown transition (`851756ed4`). Card content's are not, as a class. **(verified, measured live)**

**[F05] The harness did not reproduce the blank** — seven throwaway app-test probes moved a session card through the store method, the real spine menu, and the user's own layout blob, into parked, visited-and-hidden, one-up and two-up destinations, with a resumed fixture and with a `new`-mode synthetic binding, then switched there and measured. Every one came back with the body visible and the tool blocks, entries and composer at real heights. The mechanism in `[F02]` depends on a WAAPI animation finishing while the target has no box; the probes never asserted the inline opacity, and the difference between the harness's motion environment and the user's was not pinned down. **(verified that it did not reproduce; the reason is inference)**

**[F06] The audit of `workspaces-refine` named this class and left it** — the audit report flagged that card content first-mounting into a hidden layer measures with no boxes and that only `TugPane`'s own measurements were armed on the shown transition, and deferred it as belonging with the eviction-policy question `[Q01]`. It was the wrong prediction of consequence: the class was not a geometry nuisance but a card with no visible content and no way back. **(verified, from the arc's own record)**

### The pattern

**[F07] Visibility is decided in at least eight places, by at least five mechanisms, with no one rule** — read out of the code during this investigation, each a place where content can be present and not visible:

- `.tug-space-layer { display: none }` for a mounted workspace not on screen (`space-layer.css`, `workspaces-refine` `[B06]`).
- `[data-card-host] { display: contents | none }` for the active card of a pane versus its background tabs (`card-host.tsx`).
- The card host's own pre-restore mask, `hostContentEl.style.opacity = "0"`, lifted in `onContentReady` on the child's next commit (`card-host.tsx`).
- The session body's first-mount fade, `el.style.opacity = "0"` then a WAAPI ramp, lifted by `commitStyles()` (`session-card.tsx`, `[F02]`).
- The transcript's replay gate, `data-replaying` driving `visibility: hidden` (`session-card-transcript.tsx`, `[DT10]`).
- The load overlay's modal hold, `inert` plus a scrim over the transcript region (`session-load-control-bar.tsx`).
- An arriving pane's `visibility: hidden` inline style until its arrive beat runs (`tug-pane.tsx`, `deck-canvas.tsx`).
- A departure ghost, a blank tile at the closing card's rect (`deck-canvas.tsx`, `818717169`), itself the retirement of a cloned face that shipped one day earlier (`963206078`).
- A pane-modal sheet's clamp that refuses to measure against a canvas with no box and leaves whatever cap it wrote last (`tug-sheet.tsx`, `f1a0d7a1b`).

Each of these was reasoned about on its own. None of them was reasoned about against the others, and `[F02]` is what one of them does to another. **(verified, read out of the code; the list is what one investigation turned up, not a census)**

**[F08] The area has been landing at a rate that outran its review** — between 2026-09-12 and 2026-09-16 the files that decide visibility took, among others: `sheet-visibility`, `three-beat-settle`, `sheet-reservation`, `picker-card-arrival`, `split-newcomer-seating`, `member-height-one-rule`, `height-before-commit`, `divided-arrival`, `hidden-arrival` (three landings), `unbound-floor`, `close-during-arrival` (two landings), `workspaces`, `departure-ghost`, `workspaces-refine`, `departure-mark`, and `sheet-shade-placement` (two landings). Several are corrections of the one before: `departure-mark` retires `departure-ghost`'s clone, `hidden-arrival`'s second landing re-measures what its first measured off a stale report, `close-during-arrival`'s second holds what its first measured too late. **(verified, from `git log` on those files)**

---

## Decisions {#decisions}

**[B01] The next session is an audit, not a fix, and it starts here.** The blank card is the entry point because its mechanism is fully known, but the deliverable is a 360° read of every landing in `[F08]` and every mechanism in `[F07]`, cold, against `tuglaws/tuglaws.md` and `tuglaws/design-decisions.md`, with the code that makes content visible reduced to rules a reader can hold. The blank card's fix comes out of that read rather than ahead of it. A one-line patch to `SessionCardBody` would close the report and leave the class.

**[B02] The audit's standard is one rule per question.** For each of: what hides a thing, what shows it, and who is allowed to write that state, the audit ends with one answer written in `tuglaws/`. Where two mechanisms answer one question today, one is retired. Where an inline style is written by hand and lifted by something else, the writer and the lifter become one owner. `[L06]` says appearance goes through CSS and DOM attributes; a hand-written inline opacity that a separate animation is expected to undo is the shape this brief calls a band-aid, and the audit names every instance of it.

**[B03] A measurement taken by content is either observed or armed on the shown transition; a one-shot mount measurement is a defect.** `[F04]` is the evidence on both sides. The audit sweeps `tugdeck/src/components/tugways/` and `tugdeck/src/components/chrome/` for mount-time reads that write a CSS variable or an inline style once, and each becomes an observation or a re-arm keyed on `useSpaceLayerShown()`, the transition `TugPane` already keys on. The composer's line-box metric (`[F03]`) is the first.

**[B04] An entrance never leaves the element's state in the animation's hands.** The caller that writes a start state owns the end state, and writes it on completion whether or not `commitStyles()` succeeded. The animator's swallow stays; it is correct for the detached-element case it was written for. And an entrance does not play at all for a card whose layer is not shown, because there is no beat to share.

**[B05] The reproduction lands in the harness before any fix, and asserts the state, not the layout.** A test that moves a live session card into a visited, hidden workspace, switches there, and asserts the inline `opacity` on `.session-card` is not `"0"` and the computed opacity is `1`, alongside the composer's line-box metric. It runs with motion enabled if that is what it takes to see the animation finish under `display: none`; `[F05]` is the record of what a layout-only assertion misses. `at0580` grows the same assertion on its existing legs.

**[B06] Keeping visited workspaces mounted stands.** `workspaces-refine` `[B06]` is not the defect; a hidden layer is the ordinary case content has to survive, and the audit treats "mounted but not shown" as a first-class state every visibility mechanism must answer for, not an edge to be avoided.

---

## Open Questions {#open-questions}

- **Which of the `[F08]` landings are hacks and which are sound** is the audit's question, not this brief's. The brief names the ground; the cold read decides.
- **Why the harness did not reproduce `[F02]`** (`[F05]`). It matters because the test in `[B05]` has to be red before the fix. The likely difference is the animation environment; the audit settles it by running the probe with the inline-opacity assertion and, if it is still green, reading how `TugAnimator` behaves in the harness.

---

## Non-goals {#non-goals}

- **Patching `SessionCardBody`'s fade alone.** It would close the report and keep the class. Rejected by `[B01]`.
- **Changing `tug-animator`'s `commitStyles()` swallow.** It is right for a detached element. The defect is a caller that hand-writes a state and then trusts the animation to undo it.
- **Unmounting cards in hidden workspaces to avoid the class.** Rejected by `[B06]`.
- **An eviction or memory policy for mounted workspaces.** Still `[Q01]` of `workspaces-refine`, still deferred.
- **The Workspaces card's press and mark.** Their own brief, `workspaces-press-and-mark-brief.md`, their own session.

---

## Exit {#exit}

**An arc**, walked as an audit that produces fixes rather than as a fix. Its shape:

1. The reproducing app-test for `[F02]` per `[B05]`, red first, and the answer to why it was not red before.
2. The cold read: every landing in `[F08]` and every mechanism in `[F07]`, each judged against `tuglaws/tuglaws.md` and `tuglaws/design-decisions.md`, with a written finding per mechanism: sound, band-aid, or hack, and why.
3. The consolidation the read calls for: one owner per hide-and-show state, entrances that own their end state (`[B04]`), content measurements that observe or re-arm (`[B03]`), and the laws written down in `tuglaws/` so the next arc reads them before it adds a ninth mechanism.
4. The blank card's fix, falling out of 3 rather than preceding it, with `at0580` and the new test green.

Step 1 first, step 2 before step 3, step 4 last. The read is the work; the fixes are what it leaves behind.
