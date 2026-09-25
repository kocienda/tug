# Vertical Type Alignment

*Text that shares a row shares a baseline, by a mechanism, and never by a nudge.*

*Cross-references: `[D##]` → [design-decisions.md](design-decisions.md). `[L##]` → [tuglaws.md](tuglaws.md).*

---

## Why this document exists

A row in this app mixes faces constantly: a bold sans tool name beside a mono
command, a letterspaced legend above a proportional value, an inline glyph in a
sentence. When such a row read wrong, the repair reached for was a hand-tuned
offset — `position: relative; top: 1px`, a sub-pixel `translateY`, a length
`vertical-align` — chosen by eye at the site that looked wrong.

Those offsets accumulated into a corpus of fifteen declarations across nine
stylesheets, and the corpus argued with itself. In one file two adjacent rules
carried the same `top: 1px`, one explaining that the sans name "centers a hair
high against the mono detail" and the other that the mono detail "centers a hair
high against the bold sans name." Both cannot be true. Neither was falsifiable,
because neither was ever measured — and the same file's own docstring already
stated the mechanism that makes both unnecessary.

That is the failure mode this law is against. Not any individual pixel: the
absence of anywhere for a pixel to be **wrong**.

## The fonts are not the cause, and that question is closed

Vertical metrics read directly out of the bundled `woff2` files in
`tugdeck/public/fonts/` — decompressing the brotli stream and reading `head`,
`hhea` and `OS/2`:

| face | upem | hhea asc / desc / gap | typo asc / desc / gap | cap | x-height |
|---|---|---|---|---|---|
| `IBMPlexSans-Regular` | 1000 | 1025 / −275 / 0 | 780 / −220 / 300 | 698 | 516 |
| `IBMPlexSans-SemiBold` | 1000 | 1025 / −275 / 0 | 780 / −220 / 300 | 698 | 522 |
| `IBMPlexMono-Regular` | 1000 | 1025 / −275 / 0 | 780 / −220 / 300 | 698 | 516 |
| `IBMPlexMono-SemiBold` | 1000 | 1025 / −275 / 0 | 780 / −220 / 300 | 698 | 516 |
| `IBMPlexSansCondensed-Regular` | 1000 | 1025 / −275 / 0 | 780 / −220 / 300 | 698 | 516 |

Same em square, same ascent, same descent, zero line-gap, same cap height, and
`USE_TYPO_METRICS` clear on every face so the browser uses the `hhea` numbers
uniformly across all five. **Sans and mono at one `font-size` and one
`line-height` land on the same baseline with no assistance.**

So "the mono face sits differently" is not an available explanation, and neither
is a `size-adjust` or `ascent-override` descriptor on an `@font-face`. A row that
reads wrong is a row whose *layout* is doing something, and the rules below are
about layout.

---

## The five rules

### (i) Text sharing a row shares one `font-size` and one `line-height`

**Mechanism.** One font size across a row means "centered in the same line box"
is also "same baseline" — that is the whole alignment trick, and
`tugdeck/src/components/tugways/blocks/block-header.css`'s docstring is the
reference implementation of it.

Where optical size parity argues for a mono step-down beside sans — mono reads
larger at the same nominal size — **same size plus weight contrast wins**. Bold
is how a run becomes primary; a half-step of size is how a row loses its
baseline.

**Instrument.** The probe. A row whose runs report different `fontSize` values is
a row this rule already has an opinion about, before anybody looks at the spread.

There is no sanctioned token for a step-down. There was one —
`--tugx-block-args-size` in `block-chrome.css` — declared, documented, and
consumed by nothing after the header moved out to `BlockHeader` ([D01]). It was
deleted rather than resolved, because a token that is declared and unconsumed is
worse than no token: the next person wanting a step-down finds an apparently
sanctioned one. A surface that genuinely wants one now has to argue against this
rule instead of inheriting a shortcut.

**This rule is the one of the five with no static guard, and it has a live
violation — the row this law was written about.** `audit:type-alignment` reads
one rule at a time, and "two font sizes in one row" is a fact about two rules
and the markup between them, so nothing in `just lint` reaches it. The probe
does: on a tool-call header the runs set at the row's own 13px agree to
**0.00px**, and the trailing timing / result badge — a `sm` `TugBadge`, 10px —
reads **1.13px** above them. That badge is one of the three y positions the
original report showed in one frame; the nudge sweep closed the other two and
left this one, because closing it means enlarging every tool block's badges,
which is a visible typographic decision rather than an alignment repair.
`at0625-type-baseline.test.ts` therefore asserts on the runs at the row's own
size and `note()`s the off-size run by name, so the number is in every report
rather than absorbed into a looser bound. Whoever takes the decision has the
measurement waiting.

### (ii) A row mixing faces aligns by baseline, or by one declared line box

Never by `align-items: center` over boxes of differing height. Centring two boxes
that are not the same height centres their *boxes*, and the baselines inside them
land wherever the difference put them — which is exactly the drift a nudge is
then invented to correct.

**Mechanism.** `.tug-line-box`, declared in `tugdeck/styles/tug-line-box.css` and
imported from `tugdeck/src/globals.css`. The class owns the stanza
(`display: inline-flex; align-items: center; min-height: var(--tugx-line-box)`);
the consumer owns the number, by setting `--tugx-line-box` to its own row height.
One mechanism, one number per row.

The primitive has **two sanctioned forms**, and the second is not a loophole:

1. **The class**, wherever this project writes the markup.
2. **A CSS rule that sets `--tugx-line-box` and re-declares the stanza**, at a
   site whose markup belongs to a foreign component. `.tool-call-header
   .tug-option-group` is such a site: it is a descendant selector against
   `TugOptionGroup`'s own class, and the header cannot reach inside another
   component's slot to add a class ([L20]). An exemption-free rule here would be
   unsatisfiable, so the guard accepts the declared-token form and refuses the
   silent re-derivation.

**Instrument.** `audit:type-alignment` rule 2, which fires on a re-derived stanza
that does *not* set `--tugx-line-box`.

### (iii) A nudge is not an alignment mechanism

No `position: relative` with `top` / `bottom`, no sub-pixel `translateY`, no
length `vertical-align`, for aligning text to text. **Keyword `vertical-align`
(`top`, `middle`, `baseline`, `text-bottom`) is untouched by this rule** — it
selects a box's alignment mode, which is a mechanism; a length is a correction
layered over one.

**The escape is real, and it is a comment.** An ornamental glyph whose optical
centre sits low in its own bounding box is a genuine correction, and this law
does not pretend otherwise. What it demands is that such a correction be *stated*:

```css
/* @tug-optical-nudge: the separator glyph's ink sits low in its em box */
transform: translateY(-0.05em);
```

The reason field carries what is being corrected. An empty reason does not count.
The point of the comment is not permission — it is that every remaining
correction in the tree is now greppable, countable, and readable as a claim
somebody made, rather than invisible among the mechanisms.

**Instrument.** `audit:type-alignment` rule 1 for what is provable from the CSS
text; the probe for whether the row it guards actually agrees.

### (iv) An inline SVG glyph takes its optical offset from one declared token

The token is `--tug-glyph-cap-offset`, and its calibration is `-0.15em` — the
value already in the tree, **adopted rather than re-derived by eye**. A glyph
inline in text may consume that token. It may not carry a length hand-tuned at
its use site.

**Why a token and not a computation.** There is no cap-height facility in this
tree to compute one from: `tugdeck/src/lib/font-metrics.ts` exports
`whenFaceLoaded` and `textMeasurer` and nothing else. A declared token is the
honest shape for a number nobody is computing.

**And `atomBaselineOffsetPx()` is not this rule's mechanism.** That function
(`tugdeck/src/lib/atom-register.ts`) computes a **baked** atom's box offset from
`atomRegisterMetrics()`, and its own docstring is explicit that only the baked
renderers take it — the live CSS pill needs no correction on top of it. The two
answers differ because the problems differ: a baked atom is an image whose
per-instance metrics are known at bake time, and an inline glyph is a vector in a
line box whose face is whatever the row is set in. `tuglaws/entity-presentation.md`
and `tug-atom-chip.css` are saying exactly this when they forbid a static
`vertical-align` beside a per-instance offset — a length there is a correction
layered over a lie.

**Instrument.** The probe is the wrong instrument for this rule and the law says
so plainly: a strut reads baselines, and a glyph whose baseline is right while its
optical centre is wrong reads as aligned. What would change `-0.15em` is a
measurement of ink against cap height, not a spread. Until somebody makes one,
the token is a single place to be wrong in, which is the whole of what this rule
buys.

### (v) A letterspaced uppercase micro-label compensates its trailing track

CSS puts a `letter-spacing` track after **every** glyph, including the last, with
nothing after it to absorb the track. A tracked run's box is therefore one track
wider than its glyphs, and centring that box puts the glyphs half a track left of
where they look centred.

Measured, on `.session-telemetry-endcap-label` — uppercase, `0.18em` at
`0.5625rem`:

```
rect 43.11px  vs  advance 35.10px
trailing track 1.62px   →   glyphs 0.81px left of true centre
```

**Mechanism.** The track is declared once as a component-scoped custom property
and handed back once, so the two numbers cannot drift apart:

```css
.session-telemetry-endcap-label {
  --tugx-endcap-label-track: 0.18em;
  letter-spacing: var(--tugx-endcap-label-track);
  margin-inline-end: calc(-1 * var(--tugx-endcap-label-track));
}
```

A negative trailing margin, rather than a `translateX` or a padding tweak,
because the *margin* box is what a flex or grid container centres — which is the
same reason the uncompensated track displaced anything in the first place.
Measured after: `centredBy` **0.81px → 0.00px**.

**One object, three copies, and only one of them centred — so a convention and
not a primitive.** This is `[Q02]`'s answer, and the reading that settled it is a
sweep of every positive `letter-spacing` in the tree. The `0.18em` instrument
legend — mono, `0.5625rem`, medium, uppercase, muted — is one recurring object:
it appears three times, verbatim, and the two copies in
`session-activity-card.css` say so in their own comments. It is also the heaviest
track in the tree by a wide margin; every other tracked label sits at `0.14em` or
below — and the one at `0.14em`, the masthead telemetry key, is not uppercase —
where half a track is a fifth of a pixel. But of the three copies **only
the endcap legend is centred** — the other two are left-aligned, one in a column
and one in a `space-between` head, where the trailing track falls into slack and
displaces nothing. A primitive owning tracking-plus-compensation would therefore
have applied a correction to two sites with nothing to correct, which is this
arc's own eye judgement running backwards. The shared *look* is real and worth
consolidating one day; that is a duplication finding rather than an alignment
one, and this law does not reach it.

**So a site on the signature either compensates or says why it does not**, with
an `@tug-track-uncompensated:` comment carrying the reason — the same bargain
rule (iii) strikes, for the same purpose: every remaining uncompensated track is
then a claim somebody made rather than an omission nobody noticed. An empty
reason does not count.

**The signature is the track's weight, not centring**, and that is deliberate:
the endcap label declares no `text-align: center` at all — its centring is the
flex container's, and no static read of one rule can see a container's decision.
A rule keyed on centring would never fire on the very case it exists for. Keyed
on `text-transform: uppercase` plus `letter-spacing >= 0.15em` it fires on
exactly the three legend copies and on nothing else in the tree, which is a guard
scoped by what the CSS text provably says.

**A second, unrelated nudge lived on this same rule, and the probe retired it.**
`transform: translateY(0.5px)`, whose comment read "nudges the label's optical
center onto the rule line" — a *text-to-rule* claim, which no spread can see and
which `trackCompensationJS` is the wrong axis for. `inkVsRuleJS` (the probe's
third builder) derives the cap band from the strut's baseline and the face
table's 698/1000 cap ratio, and reads it against the hairline's own box:

```
with the translate:     cap-band centre 0.73px below the rule
without it:             cap-band centre 0.23px below the rule
```

The nudge moved the label **away** from the thing its comment said it was seating
it on, by three times the distance that remained without it. The 0.23px residue
is a cap band that is not quite centred in an IBM Plex line box — real, smaller
than a device pixel, and not something half a pixel of translate was ever going
to fix. It is this law's opening complaint with a number attached: a correction
nobody measured, doing the opposite of what it claimed, for as long as nobody
looked.

**Instrument.** `audit:type-alignment` rule 3 for the signature;
`trackCompensationJS` (the probe's second builder) for the horizontal number,
since a strut cannot see a horizontal displacement at all; `inkVsRuleJS` (the
third) for a label seated on a rule rather than beside other text.

---

## The two instruments, and why neither is sufficient

**`audit:type-alignment`** (`tugdeck/scripts/audit-type-alignment.ts`, wired into
`just lint`) reads the CSS text. It can prove that a rule declares a micro offset
*and* a type property, which is a nudge on something that carries text. It cannot
prove text-carrying-ness in general — a selector it cannot resolve to a text slot
is outside its reach — and it cannot see a single pixel of what actually rendered.
Its own docstring says so, so that a green run is never read as "the app is
aligned".

**The probe** (`tests/app-test/baseline-probes.ts`, driven by
`at0625-type-baseline.test.ts`) reads the rendered DOM: a zero-height
`inline-block` strut seated in each run's inline context, reporting the baseline
its bottom margin edge lands on. It sees two runs in one row disagreeing, and it
sees the before/after of deleting an offset. It does **not** see an ornamental
glyph whose optical centre is wrong while its baseline is right (rule (iv)'s
domain), it does not see horizontal displacement (rule (v)'s, hence the second
builder), it does not see a label seated on a rule rather than beside other text
(rule (v)'s other half, hence the third), and it cannot see a row nobody mounted
— a surface not in a test is a surface not measured.

That the module has grown a builder per question rather than a mode per question
is the design and not sprawl: each one answers in a different axis, and a strut
that had been taught to also report widths and ink bands would be an instrument
whose reading you had to interpret before you could read it.

Two limits are worth knowing before reaching for the probe:

- **A strut has to land in an inline formatting context.** Inserted bare into an
  `inline-flex; align-items: center` box it becomes a flex item, gets centred,
  and reports the box's mid-line as a baseline with nothing in the number to say
  so. The probe wraps each text node before seating the strut, for that reason.
- **A nudge on an element with no text node is unmeasurable by it.** An SVG icon
  or an `<input>` has nothing for a strut to sit beside. Those are argued under
  rule (iv), or carry the escape comment.

Neither half is sufficient alone, and the division is not a shortcoming to be
engineered away. The static half is cheap, runs on every lint, and catches the
shape; the runtime half is expensive, runs on named surfaces, and catches the
result. A rule this law states without naming which half proves it would be a
preference, not a law.

---

## What this law does not govern

- **Boxes that are not text.** Absolutely-positioned hit areas, decorative
  grips, sliding indicators, dotted leaders (a `border-bottom` box with no text
  in it), and the standard `sup` / `sub` `line-height: 0` collapse all match the
  greps and none of them is this law's subject. Rule 1's requirement that the
  offending rule *also* declare a type property is what keeps the guard off them.
- **Keyword `vertical-align`.** See rule (iii).
- **The bundled faces.** See the metrics table above.
- **`tugdeck/src/spikes/`** and `tugdeck/src/fixtures/` — exploratory surfaces,
  outside the guard's scan roots.
