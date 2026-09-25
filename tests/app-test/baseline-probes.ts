/**
 * baseline-probes.ts — the instrument the type-alignment tests read through.
 *
 * ## Why this exists
 *
 * "These two runs sit on one line" has been an eye judgement in this
 * codebase, and an eye judgement is what produced the hand-tuned
 * `position: relative; top: 1px` corpus — several of whose comments
 * contradict each other about which run is the one sitting high. A
 * deletion confirmed by eye is not confirmed, so the sweep needs a
 * number, and these builders are where it comes from.
 *
 * **The strut is the whole technique.** A zero-height `inline-block`
 * seats its bottom margin edge on the baseline of the inline context
 * holding it, and that is the one baseline measurement the DOM will
 * give up — there is no `getBaseline()`. So {@link rowBaselinesJS}
 * inserts such a span into each text run's own inline context, reads
 * `getBoundingClientRect().bottom`, and removes it. The working
 * instance of the same discipline is `BASELINES_JS` in
 * `at0512-commit-atom-surfaces.test.ts`, which measures a commit
 * pill's label against the sentence carrying it.
 *
 * **A strut has to land in an inline formatting context, and in this
 * app it often would not.** Half the header's runs live in elements
 * that are `display: inline-flex; align-items: center` — the layout
 * mechanism the header uses to seat a one-line box. A bare strut
 * inserted into one of those becomes a *flex item*, which
 * `align-items: center` centres: its bottom lands on the box's
 * mid-line and reads as a baseline several pixels below the text's,
 * with nothing in the number to say so. (It read 5.9px of spread on
 * the tool-call header, against 1–2px of real disagreement.) So every
 * run is measured by wrapping its own text node in a plain inline
 * `<span>` and putting the strut inside that: the wrapper is what the
 * flex container lays out, and inside it the strut and the text share
 * one inline context, which is the only arrangement where the number
 * means what it says. The wrapper is unwrapped before the read
 * returns.
 *
 * **What the strut cannot see** is as load-bearing as what it can. It
 * reads baselines, so it sees two runs in one row disagreeing, and it
 * sees the before/after of deleting an offset. It does *not* see an
 * ornamental glyph whose optical centre is wrong while its baseline is
 * right, and it does not see the horizontal displacement an
 * uncompensated trailing letter-spacing track produces — that is a
 * width question, which is why {@link trackCompensationJS} is a second
 * builder measuring a rect against a canvas advance rather than a
 * third mode of the strut. Nor does it see a label seated on a *rule*
 * rather than beside other text, which is a question about ink against
 * a hairline and no question about baselines at all — that one is
 * {@link inkVsRuleJS}, the third builder, which borrows the strut for
 * the baseline and then leaves baselines behind.
 *
 * **These builders return readings and never assert.** The numbers go
 * into the test's own `expect`s and into `note()`, so a nonsense
 * reading is visible in the report rather than absorbed by a helper
 * that decided what it meant.
 *
 * The module is test-side only (`[P01]`): no product code, no
 * `test-surface.ts` change, no `SURFACE_VERSION` bump. Its shape
 * follows `tests/app-test/find-probes.ts` — JS-source builders
 * consumed through `app.evalJS<string>()`.
 *
 * @module tests/app-test/baseline-probes
 */

/** One text run's reading, as {@link rowBaselinesJS} reports it. */
export interface RunBaseline {
  /** `data-slot`, else the first class name, else the tag — whatever names it. */
  slot: string;
  /** The run's text, trimmed and capped, so a reading is legible in the report. */
  text: string;
  /** Viewport-relative y of the run's baseline, in CSS px. */
  baseline: number;
  fontFamily: string;
  fontSize: string;
}

/** The whole reading {@link rowBaselinesJS} returns, once parsed. */
export interface RowBaselines {
  found: boolean;
  why?: string;
  runs?: RunBaseline[];
  /** `max(baseline) − min(baseline)`. Zero is the aligned row. */
  spread?: number;
}

/** What {@link trackCompensationJS} reports, once parsed. */
export interface TrackCompensation {
  found: boolean;
  why?: string;
  /** The run's laid-out width, per `getBoundingClientRect()`. */
  rectWidth?: number;
  /** The same string's canvas advance in the run's own face, tracking included. */
  advance?: number;
  /** The `letter-spacing` the last glyph carries with nothing after it. */
  trailingTrack?: number;
  /**
   * The run's own `margin-right`, which is how a compensated run gives the
   * trailing track back. Negative where the compensation is in place.
   */
  marginEnd?: number;
  /**
   * How far left of true centre the glyphs sit, when the run is centred
   * in its box — the margin box's centre minus the glyph band's, so a
   * positive number is glyphs sitting left of where the container put
   * their box.
   *
   * **Measured off the laid-out boxes, not computed from the track.** It
   * was `track / 2` once, which is the right answer for an uncompensated
   * run and an answer that could never change: a compensation that
   * worked and one that did nothing would report the same number, and
   * the test asserting on it would be asserting on its own arithmetic.
   */
  centredBy?: number;
}

/** What {@link inkVsRuleJS} reports, once parsed. */
export interface InkVsRule {
  found: boolean;
  why?: string;
  /** Viewport-relative y of the label's baseline, by the strut. */
  baseline?: number;
  /** The label's computed `font-size`, in px. */
  fontSize?: number;
  /** Viewport-relative y of the midpoint of the label's cap band. */
  inkCentre?: number;
  /** Viewport-relative y of the midpoint of the hairline rule's box. */
  ruleCentre?: number;
  /** `inkCentre − ruleCentre`. Positive is ink sitting below the rule. */
  offBy?: number;
}

/**
 * JS source reading every text run's baseline inside the first element
 * matching `rowSelector`.
 *
 * A "run" is an element with at least one non-whitespace text node of
 * its own — the granularity a stylesheet addresses, since that is what
 * a rule like `.tool-call-header-detail code` selects. Whitespace-only
 * nodes are skipped: they have no visible baseline to align.
 *
 * Every strut is removed before the read returns, including on the
 * error paths, and every wrapped text node is put back where it was —
 * a leaked zero-height span is invisible and permanent.
 */
export function rowBaselinesJS(rowSelector: string): string {
  return `JSON.stringify((function(){
  var row = document.querySelector(${JSON.stringify(rowSelector)});
  if (row === null) return { found: false, why: "no row for " + ${JSON.stringify(rowSelector)} };

  var strut = null;
  var wrap = null;
  // Wrap the text node, seat the strut beside it inside the wrapper, read,
  // and put the text node back. The strut goes FIRST so a run that wraps
  // onto a second line is read at its first line, and so a zero-width box
  // at a full line's end can never be pushed down a line of its own.
  function probeRun(node) {
    wrap = document.createElement("span");
    strut = document.createElement("span");
    strut.style.cssText =
      "display:inline-block;width:0;height:0;vertical-align:baseline;padding:0;margin:0;border:0;";
    node.parentNode.replaceChild(wrap, node);
    wrap.appendChild(strut);
    wrap.appendChild(node);
    var y = strut.getBoundingClientRect().bottom;
    strut.remove();
    strut = null;
    wrap.parentNode.replaceChild(node, wrap);
    wrap = null;
    return y;
  }

  function nameOf(el) {
    var slot = el.getAttribute("data-slot");
    if (slot !== null && slot !== "") return slot;
    if (el.classList.length > 0) return "." + el.classList[0];
    return el.tagName.toLowerCase();
  }

  try {
    var runs = [];
    var walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, null);
    var n = walker.nextNode();
    while (n !== null) {
      var text = (n.textContent || "");
      if (text.trim() !== "" && n.parentElement !== null) {
        var el = n.parentElement;
        var style = getComputedStyle(el);
        runs.push({
          slot: nameOf(el),
          text: text.trim().slice(0, 40),
          baseline: probeRun(n),
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
        });
      }
      n = walker.nextNode();
    }
    if (runs.length === 0) return { found: false, why: "no text runs in row" };

    var lo = runs[0].baseline;
    var hi = runs[0].baseline;
    for (var i = 1; i < runs.length; i += 1) {
      if (runs[i].baseline < lo) lo = runs[i].baseline;
      if (runs[i].baseline > hi) hi = runs[i].baseline;
    }
    return { found: true, runs: runs, spread: hi - lo };
  } finally {
    if (strut !== null) strut.remove();
    if (wrap !== null && wrap.parentNode !== null) {
      var stranded = wrap.firstChild;
      while (stranded !== null) {
        wrap.parentNode.insertBefore(stranded, wrap);
        stranded = wrap.firstChild;
      }
      wrap.remove();
    }
  }
})())`;
}

/**
 * JS source reporting the horizontal displacement a letterspaced run
 * carries, for the first element matching `selector`.
 *
 * CSS puts a `letter-spacing` track after *every* glyph including the
 * last, so a tracked run's box is one track wider than its glyphs, and
 * centring that box puts the glyphs half a track left of where they
 * look centred. The canvas context is built from the element's own
 * computed style the way `tugdeck/src/lib/font-metrics.ts`'s
 * `textMeasurer` builds its, so the advance and the rect cannot be
 * measuring two different faces.
 */
export function trackCompensationJS(selector: string): string {
  return `JSON.stringify((function(){
  var el = document.querySelector(${JSON.stringify(selector)});
  if (el === null) return { found: false, why: "no element for " + ${JSON.stringify(selector)} };
  var text = (el.textContent || "");
  if (text.trim() === "") return { found: false, why: "no text" };

  var ctx = document.createElement("canvas").getContext("2d");
  if (ctx === null) return { found: false, why: "no canvas context" };
  var style = getComputedStyle(el);
  ctx.font = style.fontStyle + " " + style.fontWeight + " " + style.fontSize +
    " " + style.fontFamily;

  var track = parseFloat(style.letterSpacing);
  if (!isFinite(track)) track = 0;
  // The rendered string, not the source: \`text-transform\` is applied by
  // layout, and an uppercased run has different advances.
  var shown = style.textTransform === "uppercase" ? text.toUpperCase()
    : style.textTransform === "lowercase" ? text.toLowerCase()
    : text;
  var advance = ctx.measureText(shown).width + track * shown.length;

  var rect = el.getBoundingClientRect();
  var num = function (v) { var n = parseFloat(v); return isFinite(n) ? n : 0; };
  var padL = num(style.paddingLeft), padR = num(style.paddingRight);
  var bL = num(style.borderLeftWidth), bR = num(style.borderRightWidth);
  var mL = num(style.marginLeft), mR = num(style.marginRight);

  // The glyph band is the content box less the track the last glyph
  // carries with nothing after it. Taken from the rect rather than from
  // the canvas advance, so this is the laid-out number and not a second
  // opinion about the face — \`advance\` above is the cross-check, and the
  // two agreed to 0.01px on the endcap label.
  var glyphW = rect.width - padL - padR - bL - bR - track;
  var glyphCentre = rect.left + bL + padL + glyphW / 2;
  // The MARGIN box is what a flex container centres, which is why a
  // negative trailing margin is a compensation at all.
  var boxCentre = ((rect.left - mL) + (rect.right + mR)) / 2;

  return {
    found: true,
    rectWidth: rect.width,
    advance: advance,
    trailingTrack: track,
    marginEnd: mR,
    centredBy: boxCentre - glyphCentre,
  };
})())`;
}

/**
 * JS source reporting where a label's ink sits against a hairline rule it
 * is supposed to be seated on.
 *
 * This is the one question the other two builders cannot answer, and the
 * `.session-telemetry-endcap-label` `transform: translateY(0.5px)` is why
 * it exists: that declaration's comment claimed it "nudges the label's
 * optical center onto the rule line", which is a **text-to-rule** claim
 * rather than a text-to-text one. A spread cannot see it — there is only
 * one text run in the apparatus — and the track builder is horizontal.
 *
 * The ink band is derived rather than measured, and the derivation is the
 * honest part: a strut gives the baseline, and `tuglaws/type-alignment.md`'s
 * face table gives the cap height as **698/1000 of the em on every bundled
 * IBM Plex face**, so the cap band runs from `baseline − 0.698 · size` to
 * the baseline and its midpoint is `baseline − 0.349 · size`. That is a
 * cap-band centre and not an optical one — a run of round letters would
 * overshoot it slightly — but the endcap legends are flat-topped uppercase
 * words, and a constant this rule shares with the law beats a constant
 * chosen by eye at the site.
 *
 * `ruleSelector` is resolved **within the label's own parent**, so a row
 * carrying several of these apparatuses reads the hairline belonging to
 * the label it is measuring rather than the first one in the document.
 */
export function inkVsRuleJS(labelSelector: string, ruleSelector: string): string {
  return `JSON.stringify((function(){
  var label = document.querySelector(${JSON.stringify(labelSelector)});
  if (label === null) return { found: false, why: "no label for " + ${JSON.stringify(labelSelector)} };
  var parent = label.parentElement;
  if (parent === null) return { found: false, why: "label has no parent to find the rule in" };
  var rule = parent.querySelector(${JSON.stringify(ruleSelector)});
  if (rule === null) return { found: false, why: "no rule for " + ${JSON.stringify(ruleSelector)} + " beside the label" };

  var node = null;
  var walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT, null);
  var n = walker.nextNode();
  while (n !== null && node === null) {
    if ((n.textContent || "").trim() !== "") node = n;
    n = walker.nextNode();
  }
  if (node === null) return { found: false, why: "label carries no text node" };

  // The same wrap-then-strut arrangement \`rowBaselinesJS\` uses, and for
  // the same reason: the label is a flex item, so a bare strut would be
  // laid out as one and report the box's mid-line.
  var wrap = document.createElement("span");
  var strut = document.createElement("span");
  strut.style.cssText =
    "display:inline-block;width:0;height:0;vertical-align:baseline;padding:0;margin:0;border:0;";
  try {
    node.parentNode.replaceChild(wrap, node);
    wrap.appendChild(strut);
    wrap.appendChild(node);
    var baseline = strut.getBoundingClientRect().bottom;
    var size = parseFloat(getComputedStyle(label).fontSize);
    if (!isFinite(size)) return { found: false, why: "label reports no font-size" };
    var inkCentre = baseline - 0.349 * size;
    var r = rule.getBoundingClientRect();
    var ruleCentre = r.top + r.height / 2;
    return {
      found: true,
      baseline: baseline,
      fontSize: size,
      inkCentre: inkCentre,
      ruleCentre: ruleCentre,
      offBy: inkCentre - ruleCentre,
    };
  } finally {
    if (strut.parentNode !== null) strut.remove();
    if (wrap.parentNode !== null) wrap.parentNode.replaceChild(node, wrap);
  }
})())`;
}
