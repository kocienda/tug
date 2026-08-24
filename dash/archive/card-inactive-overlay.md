# Card Inactive Content Overlay

Add a composited overlay to the content area of unfocused cards to visually convey "inactive" without needing per-element token overrides for every possible content variant.

## Problem

The card title bar and tab bar have stable, known elements — we can (and do) control their focused/unfocused appearance with dedicated `titlebarOn`/`titlebarOff` tokens. But the content area is completely variable: terminals, code editors, component galleries, inspectors, forms, tables, prose. There's no practical way to define inactive-state tokens for every element that could appear inside a card.

We need a single compositing overlay that dims or desaturates the content area of an unfocused card, regardless of what's inside it.

## Approach

Use a CSS `::after` pseudo-element on the card content area with `mix-blend-mode` to composite a subtle inactive wash over the content. The overlay is purely CSS — no React state, no extra DOM elements, no JavaScript.

### Blend mode selection

The right blend mode depends on the theme's lightness:

- **Dark themes (brio):** Use `screen` with a dark overlay color. `screen` lightens — it washes out the content slightly, reducing contrast and making it feel receded. A low-alpha dark gray works here because `screen` with black is a no-op, so you need a slightly lighter gray to get any effect. Alternatively, use `luminosity` with a mid-gray to pull everything toward a uniform lightness.

- **Light themes (harmony):** Use `multiply` with a light overlay color. `multiply` darkens — it lays a subtle haze over the content, reducing contrast. A low-alpha white-ish gray works because `multiply` with white is a no-op, so a slightly darker value produces the dimming.

- **Either theme:** `saturation` with a zero-saturation (gray) overlay desaturates the content, making it feel muted/inactive without changing lightness. This might be the most theme-agnostic option — inactive content loses its color vibrancy but doesn't get noticeably lighter or darker.

### Recommendation

Start with `saturation` using a gray overlay. It's theme-agnostic and produces a natural "inactive" feel: the content is still visible and readable but clearly not the active focus. If that's too subtle, layer it with a light `multiply` or `screen` wash.

The overlay color and blend mode should be theme tokens so brio and harmony can tune independently.

## Tokens

Two new tokens in the base theme and each override:

```css
/* Card — Inactive Content Overlay */
--tug-surface-card-primary-normal-contentDim-color: --tug-color(gray, t: 50);
--tug-surface-card-primary-normal-contentDim-blend: saturation;
```

The `color` token is the overlay fill. The `blend` token is the `mix-blend-mode` value. Separating them lets each theme choose independently — brio might use `screen` with a dark gray while harmony uses `multiply` with a light gray.

Note: CSS custom properties can hold any value, including keyword values like `saturation` or `multiply`. The component CSS reads the blend mode from the token with `mix-blend-mode: var(--tug-card-content-dim-blend)`.

## Component aliases in tug-card.css

```css
body {
  --tug-card-content-dim-color: var(--tug-surface-card-primary-normal-contentDim-color);
  --tug-card-content-dim-blend: var(--tug-surface-card-primary-normal-contentDim-blend);
}
```

## CSS implementation

```css
.tugcard-content {
  position: relative;  /* needed for ::after positioning */
}

.card-frame[data-focused="false"] .tugcard-content::after {
  content: "";
  position: absolute;
  inset: 0;
  background-color: var(--tug-card-content-dim-color);
  mix-blend-mode: var(--tug-card-content-dim-blend);
  pointer-events: none;  /* clicks pass through to content */
  z-index: 1;            /* above content, below any floating UI */
}
```

The overlay only appears on unfocused cards (`data-focused="false"`). When the card gains focus, the pseudo-element disappears — no transition needed, the switch should be instant.

## Scope

- The overlay covers the `.tugcard-content` area only, not the title bar or tab bar (those are already handled by `titlebarOn`/`titlebarOff` tokens).
- The `.tugcard-accessory` area (tab bars, findbars) sits between the title bar and content. It could either be covered by a separate overlay or left alone since accessories have limited, predictable content. Recommend leaving it alone initially — the title bar token system already handles tab bar styling, and findbars are rarely visible.
- `pointer-events: none` means the content is still interactive even when dimmed. Users can click into an inactive card to focus it, and the content underneath responds normally.

## What to try first

1. Add the two tokens to `tug-base-generated.css` and `harmony.css`
2. Add the component aliases to `tug-card.css`
3. Add the `::after` rule
4. Evaluate visually — tune the overlay color's alpha and tone, try different blend modes

If `saturation` alone is too subtle, try combining: `saturation` for desaturation plus a second pass with `multiply`/`screen` for slight lightness shift. But start simple — one overlay, one blend mode, tune from there.
