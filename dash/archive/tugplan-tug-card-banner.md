# TugCardBanner — card-scoped modal banner

**Status:** draft — awaiting review before implementation.
**Motivation:** the T3.4.c Step 6 `lastError` affordance shipped as an inline strip inside the bottom split-panel (`tide-card.tsx` `TideLastErrorBanner`). Live smoke against a `pkill -x tugcast` transport drop revealed the result is visually wrong (broken border, cramped between panes) and — more importantly — *semantically* wrong. When the session is lost there is nothing useful the user can do inside the card; the UI should reflect that by going inert, not by showing a dismissable note above a still-interactive prompt editor.

**Approach:** build a new public tugways component, `TugCardBanner`, that takes TugBanner's visual language (strip + detail panel, tone tokens) and TugSheet's scoping mechanics (portal into the card, `inert` on `.tugcard-body`, positioned under the title bar). Tide card adopts it in place of the inline banner; other cards can adopt it for future card-level error / attention surfaces.

---

## Contents

1. [Goal](#goal)
2. [Non-Goals](#non-goals)
3. [Success Criteria](#success-criteria)
4. [Strategy](#strategy)
5. [Component API](#component-api)
6. [Scoping + inert](#scoping-inert)
7. [Animation](#animation)
8. [Responder chain integration](#chain)
9. [Tokens](#tokens)
10. [Consumer-side wiring — Tide card](#consumer-tide)
11. [Why this is the right shape](#why)
12. [Files + line estimates](#files)
13. [Tests](#tests)
14. [Steps](#steps)
15. [Out of scope (V1)](#out-of-scope)
16. [Risks](#risks)
17. [References](#references)

---

## Goal {#goal}

Ship `TugCardBanner` as a card-scoped modal barrier that matches TugBanner's visual grammar (users see the same urgency language whether it's app-level or card-level) while staying scoped to a single card (other cards and the app chrome remain live). Replace the inline Tide card error strip with it.

## Non-Goals {#non-goals}

- Replacing TugBanner. The app-modal banner remains the right surface for process-wide conditions (e.g., unrecoverable React render error, server offline across the whole app).
- A full notification / toast system. That's orthogonal — this is one card's barrier UI.
- Multi-banner stacking within a card.
- Re-theming TugBanner. Share base tokens, not aliases.

## Success Criteria {#success-criteria}

- `pkill -x tugcast` on a bound Tide card: strip slides in, detail panel renders, card body goes `inert`, title bar stays interactive. Dismiss → `inert` removed synchronously with the exit animation.
- Other cards on the same canvas remain fully interactive throughout.
- `bun run audit:tokens lint` clean.
- `bun test` clean across the workspace; both the new component test and the retargeted Tide card integration test pass.
- Component passes the authoring-guide checklist ([component-authoring.md](../tuglaws/component-authoring.md)).

---

## Strategy {#strategy}

**Hybrid composition** — take the visual structure of [TugBanner](../tugdeck/src/components/tugways/tug-banner.tsx)'s `variant="error"` branch (strip at top + centered detail panel + pinned footer), and the portal / inert / positioning machinery of [TugSheet](../tugdeck/src/components/tugways/tug-sheet.tsx). Neither component's code is shared by import — `TugCardBanner` is a new top-level public component that re-implements both concerns cohesively. (Attempting to *extend* TugBanner with a `scope="card" | "app"` prop was considered and rejected: the two components have divergent positioning, portal targets, animations, and lifecycles; coupling them would create branching that obscures both.)

**Self-managed lifecycle → TugAnimator** per [L13](../tuglaws/tuglaws.md#motion). The banner's consumer controls mount via a `visible` prop; the component owns enter/exit animation timing and sequences `inert` removal off `animate().finished`, the same pattern TugBanner's status variant uses (`tug-banner.tsx:131-153`) and TugSheet uses (`tug-sheet.tsx:348+`).

**Card-scoped `inert`** — `.tugcard-body` gets the attribute while visible, exactly as TugSheet does (`tug-sheet.tsx:434-452`). Title bar stays live so users can close the card. Other cards stay live because `inert` is scoped to this card's body subtree.

## Component API {#component-api}

Declarative, `visible`-driven. Mirrors TugBanner's shape so the two components read as siblings.

```tsx
export interface TugCardBannerProps {
  /** Whether the banner is shown. @selector [data-visible="true"] | [data-visible="false"] */
  visible: boolean;
  /** Layout variant. @selector [data-variant="error"] | [data-variant="status"] @default "error" */
  variant?: "error" | "status";
  /** Visual severity. @selector [data-tone="danger"] | [data-tone="caution"] | [data-tone="default"] @default "danger" */
  tone?: "danger" | "caution" | "default";
  /** Short high-contrast strip label (left of the message — e.g. "Connection lost"). */
  label?: string;
  /** Strip message text. */
  message: string;
  /** Optional Lucide icon for the strip (status variant most useful). */
  icon?: string;
  /** Detail panel body content (error variant). */
  children?: React.ReactNode;
  /** Pinned footer content for the detail panel (error variant). */
  footer?: React.ReactNode;
  /** Disables inert for gallery demos. @default false */
  contained?: boolean;
  className?: string;
}
```

**Key differences from TugBanner:**
- `label` is new. TugBanner's strip takes one `message`; our error cases want `Connection lost` — `transport closed` shape (two-part: bold short label + longer message).
- No built-in dismiss control. Per [L11](../tuglaws/tuglaws.md#component-architecture), dismiss is the consumer's responsibility — they pass a `footer` with their own button (e.g., `TugPushButton`) whose `onClick` dispatches through the chain or calls a local setter. Matches TugSheet's Cancel/Save pattern.
- No `onDismiss` / `onClose` callback props. Callbacks for user interactions are prohibited per [L11].

Both `variant="error"` and `variant="status"` are implemented in V1; 90% of the code is shared and shipping both keeps the component API parallel to TugBanner from day one.

## Scoping + inert (TugSheet-style) {#scoping-inert}

- **Portal target**: consume `TugcardPortalContext` — the same context TugSheet uses. Mount into the `.tugcard` element via `createPortal`.
- **Position**: absolute-positioned inside `.tugcard`, clipped `top: var(--tug-chrome-height)` so the strip emerges just below the title bar. Matches TugSheet's `.tug-sheet-clip` technique — same CSS variable so card chrome height stays consistent.
- **`inert` application**: while `visible=true`, set `inert` on the sibling `.tugcard-body` (exact TugSheet pattern at `tug-sheet.tsx:434-452`). Remove on hide. Cleanup on unmount in all paths.
- **Backdrop**: a dim surface covers the card body behind the detail panel (reusing `--tug7-surface-overlay-primary-normal-dim-rest`, same as TugBanner error-variant). No pointer events on the backdrop since the body is already `inert` — the backdrop is visual only.
- **Other cards stay live**: `inert` is scoped to this card's body subtree. Deck canvas, other cards, and app chrome are untouched. This is the whole point of "card-modal" vs TugBanner's "app-modal."

## Animation (L13: self-managed → TugAnimator) {#animation}

- **Enter**: strip slides from `translateY(-100%)` → `translateY(0)`; detail panel fades in from `opacity: 0`. Both via TugAnimator's `animate()`, coordinated via `group()` where needed for simultaneous timing.
- **Exit**: reverse; `inert` removal sequenced off `.finished` so visual and interaction state stay synchronized (interaction is not restored until the banner is visually gone).
- **Mount flash guard**: `hasBeenVisibleRef` pattern from TugBanner — initial mount with `visible=false` skips the exit animation so the strip doesn't flicker at `translateY(0)` for one frame before hiding.
- **No CSS keyframes**: per [L14](../tuglaws/tuglaws.md#motion), CSS keyframes are for library-managed lifecycle (Radix presence). We own the lifecycle → TugAnimator.

## Responder chain integration {#chain}

- **The banner itself is not a responder.** It's display; it owns no semantic state beyond `visible` (and `visible` is owned by the consumer).
- **Footer buttons are controls.** Consumer passes `<TugPushButton>` (or equivalent) in the footer; clicking it dispatches whatever action the consumer chose through the chain via `useControlDispatch`.
- **Escape / Cmd+. behavior: deferred to V2.** V1 does not install a keyboard close path. If needed, we'd add a `dismissOnEscape` prop and a chain responder registration that handles `cancelDialog`. For the Tide card's connection-lost case, Dismiss-click is sufficient.
- **FocusScope**: wrap the detail panel in `@radix-ui/react-focus-scope` with `trapped={visible}` so Tab cycles within the banner while it's open. Cheap insurance even when the footer has one button; covers future cases with multiple actions. Matches TugSheet.

## Tokens (L17, L18, L20) {#tokens}

Own component-tier aliases in `tug-card-banner.css`, resolving to the *same* base `--tug7-*` tokens TugBanner uses. The visual language is shared deliberately; each component owns its own alias namespace per [L20](../tuglaws/tuglaws.md#composition).

```css
body {
  --tugx-card-banner-strip-bg:      var(--tug7-surface-control-primary-filled-danger-rest);
  --tugx-card-banner-strip-fg:      var(--tug7-element-control-text-filled-danger-rest);
  --tugx-card-banner-strip-border:  var(--tug7-element-control-border-filled-danger-rest);
  --tugx-card-banner-detail-bg:     var(--tug7-surface-global-primary-normal-overlay-rest);
  --tugx-card-banner-detail-fg:     var(--tug7-element-global-text-normal-default-rest);
  --tugx-card-banner-detail-border: var(--tug7-element-global-border-normal-default-rest);
  --tugx-card-banner-backdrop-bg:   var(--tug7-surface-overlay-primary-normal-dim-rest);
}
```

Tone variants override `--tugx-card-banner-strip-*` (danger / caution / default) following TugBanner's precedent. [L17](../tuglaws/tuglaws.md#token-system): one-hop aliases. [L18](../tuglaws/tuglaws.md#token-system): element/surface vocabulary preserved.

**`@tug-pairings` block** declares strip-fg/bg and detail-fg/bg. **`@tug-renders-on`** annotation on every color rule that doesn't co-declare `background-color`. **Both the compact and expanded-table formats** required per [component-authoring.md § @tug-pairings Table](../tuglaws/component-authoring.md#tug-pairings-table).

A new `banner` value for the seven-slot `component` slot could be introduced later if we want strip-specific tokens (e.g., `--tug7-surface-banner-primary-filled-danger-rest`). Not today — reusing `control`-scoped filled-danger surfaces matches what TugBanner already does and avoids a token-system change.

## Consumer-side wiring — Tide card {#consumer-tide}

**Delete** from `tide-card.tsx`:
- `TideLastErrorBanner` sub-component.
- The `.tide-card-bottom` wrapper div in the bottom `TugSplitPanel`.

**Delete** from `tide-card.css`:
- `.tide-card-bottom`, `.tide-card-error-banner`, `.tide-card-error-banner-label`, `.tide-card-error-banner-message`, `.tide-card-error-banner-dismiss`.

**Keep**:
- `CAUSE_LABELS` map and `BannerErrorCause` type — now feed `label`.
- `dismissedAt` state + `bannerError` derivation.

**Add** in `TideCardBody`'s root `<div className="tide-card">`:

```jsx
<div className="tide-card" data-testid="tide-card">
  <TugSplitPane ...> ... </TugSplitPane>
  <TugCardBanner
    visible={bannerError !== null}
    variant="error"
    tone="danger"
    label={bannerError ? CAUSE_LABELS[bannerError.cause] : undefined}
    message={bannerError?.message ?? ""}
    footer={
      bannerError && (
        <TugPushButton
          emphasis="outlined"
          role="action"
          onClick={() => setDismissedAt(bannerError.at)}
        >
          Dismiss
        </TugPushButton>
      )
    }
  >
    <p>The card can't reach its session. Dismiss to continue; close and reopen the card to retry.</p>
  </TugCardBanner>
</div>
```

The `resume_failed` interception path (card observer → picker notice) is unchanged — that cause still doesn't reach the banner.

## Why this is the right shape {#why}

- **Visual consistency with TugBanner**: user sees the same urgency grammar whether it's app-level or card-level. Tone tokens reused → themes stay consistent across both surfaces without manual coordination.
- **Correct modality**: card-scoped `inert` is what the Tide card's transport-closed state actually needs — there is nothing useful the user can do below the title bar until the banner is dismissed (or a new session bound). TugBanner would be wrong because it'd block the whole app.
- **Reusable primitive**: any card can surface errors, onboarding notices, or attention states via this component. Not a Tide-card-only widget.
- **Laws-clean**: [L13](../tuglaws/tuglaws.md#motion) (self-managed → TugAnimator), [L14](../tuglaws/tuglaws.md#motion) (no CSS keyframes for self-managed lifecycle), [L19](../tuglaws/tuglaws.md#component-architecture) (component authoring guide), [L20](../tuglaws/tuglaws.md#composition) (token sovereignty). No L06 violation — visibility is React-driven because consumers need to derive it from their stores, but enter/exit animation mutates CSS/DOM through TugAnimator, not React state.

## Files + line estimates {#files}

| File | Action | Estimated lines |
|---|---|---|
| `tugdeck/src/components/tugways/tug-card-banner.tsx` | new | ~220 |
| `tugdeck/src/components/tugways/tug-card-banner.css` | new | ~160 |
| `tugdeck/src/__tests__/tug-card-banner.test.tsx` | new | ~120 |
| `tugdeck/src/components/tugways/cards/tide-card.tsx` | replace inline banner | −40 net |
| `tugdeck/src/components/tugways/cards/tide-card.css` | delete inline banner rules | −50 net |
| `tugdeck/src/__tests__/tide-card-last-error.test.tsx` | retarget testids + label | ~+0 net |

## Tests {#tests}

### Component tests (`tug-card-banner.test.tsx`)

Minimum set per [component-authoring.md § Testing](../tuglaws/component-authoring.md#testing):

1. Renders without throwing inside a card portal context.
2. `visible=true` mounts content; `visible=false` removes content after exit animation completes.
3. `data-variant`, `data-tone`, `data-visible` attributes reflect props.
4. `inert` attribute appears on `.tugcard-body` when `visible=true`; disappears synchronously with the exit animation when `visible=false`.
5. `contained=true` skips `inert` application.
6. Footer content renders when passed; strip and detail body render `label` + `message`.
7. Tone class changes flip the strip aliases (smoke — no color assertion, just presence of the tone attribute).

### Integration test retarget (`tide-card-last-error.test.tsx`)

The existing 3 test cases retarget:
- Assertions move from `data-testid="tide-card-error-banner"` → `data-testid="tug-card-banner"` (the new component's root).
- Dismiss assertion clicks the consumer-supplied TugPushButton by label ("Dismiss") instead of the raw "×" button from the inline implementation.
- Behavior assertions unchanged: banner appears on first error, hides on dismiss, reappears on a new error with a different `at`.

## Steps {#steps}

### Step 1 — Component implementation

**Files:**
- `tugdeck/src/components/tugways/tug-card-banner.tsx` (new).
- `tugdeck/src/components/tugways/tug-card-banner.css` (new).

**Work:**
- Port TugBanner's error-variant JSX structure: strip (label + message), detail panel (body + footer).
- Add `label` as a new prop (rendered inside the strip, left of the message, bolder font).
- Graft TugSheet's portal + `inert` + positioning machinery: consume `TugcardPortalContext`, `createPortal` into the card, `inert` on `.tugcard-body` while visible.
- TugAnimator enter/exit with `hasBeenVisibleRef` mount-flash guard.
- FocusScope wrap on the detail panel with `trapped={visible}`.
- Tone variants (danger / caution / default) via alias overrides on `[data-tone="..."]`.
- Status variant: strip-only, no detail panel, same enter/exit animation.

**Verification:**
- `bunx tsc --noEmit` clean.
- `bun run audit:tokens lint` clean (new `--tugx-card-banner-*` aliases declared; pairings table present).

### Step 2 — Component tests

**File:** `tugdeck/src/__tests__/tug-card-banner.test.tsx` (new).

**Work:** the 7 cases listed in [Tests](#tests).

**Verification:** `bun test tug-card-banner` passes.

### Step 3 — Tide card adoption

**Files:**
- `tugdeck/src/components/tugways/cards/tide-card.tsx`.
- `tugdeck/src/components/tugways/cards/tide-card.css`.

**Work:** delete inline `TideLastErrorBanner` + associated CSS; render `<TugCardBanner>` at the body root as shown in [Consumer-side wiring](#consumer-tide).

**Verification:** `bun test tide-card` passes (integration test retargets satisfied via Step 4).

### Step 4 — Integration test retarget

**File:** `tugdeck/src/__tests__/tide-card-last-error.test.tsx`.

**Work:** update the 3 existing cases to query the new banner's testid and label-click the Dismiss button.

**Verification:** `bun test tide-card-last-error` passes.

### Step 5 — Manual smoke

**Work:**
- Start a Tide card bound to a project.
- Run `pkill -x tugcast`.
- Verify: strip slides in; detail panel appears; card body goes `inert` (prompt editor unfocusable, split pane handle immovable, tools panel inactive); title bar close button still works; other cards on the deck remain fully interactive.
- Dismiss: click the Dismiss button. Exit animation plays; `inert` released after animation completes.
- Reopen tugcast; open a fresh Tide card to confirm a clean path forward.

**Verification:** matches [Success Criteria](#success-criteria).

### Step 6 — Gallery demo (not deferred / not optional)

**File:** `tugdeck/src/components/tugways/cards/gallery-registrations.tsx` (probably) + a new `gallery-card-banner.tsx` mock-up card.

**Work:** add a gallery entry so the component is visible in the theme inspector. Use `contained=true` within a fake `.tugcard` wrapper — TugBanner's gallery treatment is the template.

**Verification:** theme-audit gallery shows TugCardBanner across light/dark themes.

*Optional — can land in a follow-up commit if the main work is already green.*

## Out of scope (V1) {#out-of-scope}

- **Escape / Cmd+. dismiss.** V2 adds `dismissOnEscape` prop + chain `cancelDialog` handler.
- **Click-outside dismiss.** Card-modal intentionally — not adding.
- **Multiple banners per card.** Don't stack; re-render replaces.
- **Loading / busy states.** Not this component's job.
- **Auto-dismiss timers.** Card-modal for an error condition — timed auto-dismiss would hide state the user hasn't acknowledged. Explicit dismiss only.
- **`banner`-scoped seven-slot tokens.** Share `control` surfaces with TugBanner; introduce a dedicated component slot only if future requirements diverge.

## Risks {#risks}

**R1 — Animation coordination bugs under rapid visible flips.** A test dispatching two errors back-to-back could hit the banner mid-enter-animation. TugAnimator's `key` slot (used elsewhere in the codebase) handles this; follow TugBanner's pattern of a stable `key` on each `animate()` call so overlapping animations replace cleanly rather than stack. Low risk but worth a manual smoke.

**R2 — `inert` cleanup on parent unmount.** If the card unmounts while the banner is visible, the `inert` cleanup runs in the effect's return function — verified pattern from TugSheet. Still: add a test that unmounts the banner while `visible=true` and asserts `.tugcard-body` is no longer `inert`.

**R3 — FocusScope with a single button.** Radix's FocusScope can emit `onUnmountAutoFocus` warnings or unexpected focus moves when trap is disabled with nothing tabbable inside. Mirror TugSheet's handling (`handleMountAutoFocus` + `handleUnmountAutoFocus`) and ensure the single-button case works; fallback is to skip FocusScope for footer-less banners.

**R4 — `inert` attribute interaction with SelectionGuard.** SelectionGuard clamps selection to card boundaries. A selection that spans the detail-panel → body boundary while `inert` is set: does the clamp still fire? Manual smoke by right-clicking inside the detail panel after making a selection elsewhere in the card. Expected: selection inside the detail panel works; body selection is prevented because the body is `inert`.

**R5 — Theme coverage.** TugBanner already has danger / caution / default tone tokens across both brio and harmony themes. TugCardBanner uses the same base tokens → no new theme tuning needed. If future tone tokens diverge, both components need updating together.

## References {#references}

- Predecessor: [tugplan-tide-card.md § Step 6](./tugplan-tide-card.md#step-6) — the inline `lastError` affordance this plan supersedes.
- Visual precedent: [TugBanner](../tugdeck/src/components/tugways/tug-banner.tsx) — app-modal, same error-variant shape.
- Mechanical precedent: [TugSheet](../tugdeck/src/components/tugways/tug-sheet.tsx) — card-modal portal + inert + `tug-chrome-height` clip pattern.
- Authoring contract: [component-authoring.md](../tuglaws/component-authoring.md).
- Laws: [L06](../tuglaws/tuglaws.md#state-and-mutation-zones), [L11](../tuglaws/tuglaws.md#component-architecture), [L13/L14](../tuglaws/tuglaws.md#motion), [L19](../tuglaws/tuglaws.md#component-architecture), [L20](../tuglaws/tuglaws.md#composition).
- Token naming: [token-naming.md](../tuglaws/token-naming.md).
