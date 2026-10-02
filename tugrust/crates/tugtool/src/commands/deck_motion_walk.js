// The page half of `tugtool deck motion walk`, posted through `/api/eval`.
//
// It is one function over one argument object, like `deck_motion_slide.js`,
// so the shell end generates the call with `JSON.stringify`d arguments and
// nothing in it is interpolated raw. Three ops:
//
//   census  — the deck's populations, whole-document and per subject, so a
//             reading can be compared with another one
//   measure — one arm applied, the frame read undriven (the floor) and then
//             with one style write per frame (driven), the arm lifted again
//   restore — put back anything a measure that never reached its `finally`
//             left behind
//
// The walk is WebKit's compositing pass after a style change. A frame with
// nothing dirty runs no walk, so a still deck read as it stands reads the
// floor; the driver — a hidden fixed 1px element whose width (or transform)
// is toggled inside the frame callback — is what makes every sampled frame
// walk. `measure` returns RAW samples; the shell end reduces them, so the
// reduction is unit-tested in Rust rather than trusted to a string.
//
// Every arm is an inline-style write recorded on `window.__tugWalkPending`
// (prior value and priority) and restored exactly, in a `finally`, from a
// watchdog, or by `restore`. The deck is the user's; a reading that left it
// altered would be worse than none.
(function (args) {
  "use strict";

  var TOUCHED = "data-tug-walk-touched";
  var DRIVER = "data-tug-walk-driver";
  var WATCHDOG_MS = 20000;
  var HISTOGRAM_SHOWN = 12;
  // Mirror of `LOAD_OLDER_PX` in `tugdeck/src/lib/overview-store.ts`: a
  // column scrolled closer than this to its top asks the store for an older
  // page, which is a change to the user's Overview no restore can undo.
  var LOAD_OLDER_PX = 200;

  // Set by the watchdog. The frame chain it abandoned can wake later, once
  // the window is uncovered, and every step checks this first — so a chain
  // that outlived its reading cannot scroll a column, pause the deck's loops
  // or append a driver after the deck was put back.
  var stopped = false;
  function alive() {
    if (stopped) throw new Error("watchdog");
  }

  // ---- Populations ---------------------------------------------------------
  //
  // Mirrors of `establishesStackingContext` and `isRenderLayerCandidate` in
  // `tugdeck/src/lib/perf-monitor.ts`, because `__tugMotion.layers()` counts
  // only the whole document and an arm needs the count for a subtree. The
  // census compares this copy's whole-document counts against `layers()` and
  // the shell end warns past 1%, so a copy that has drifted from its source
  // says so rather than mispricing quietly.

  var CONTAINMENT_VALUES = ["paint", "layout", "strict", "content"];
  var LAYER_OVERFLOW_VALUES = { auto: true, scroll: true, hidden: true };

  function isRenderLayerCandidate(style) {
    if (style.display === "none") return false;
    if (style.position !== "static") return true;
    if (LAYER_OVERFLOW_VALUES[style.overflowX] || LAYER_OVERFLOW_VALUES[style.overflowY]) return true;
    if (style.transform !== "none") return true;
    if (style.willChange !== "auto" && style.willChange !== "") return true;
    return false;
  }

  function establishesStackingContext(element, style) {
    if (style.display === "none") return false;
    if (element === document.documentElement) return true;
    var position = style.position;
    if ((position === "absolute" || position === "relative") && style.zIndex !== "auto") return true;
    if (position === "fixed" || position === "sticky") return true;
    if (style.opacity !== "" && Number(style.opacity) < 1) return true;
    if (style.transform !== "none") return true;
    if (style.filter !== "none") return true;
    if (style.perspective !== "none") return true;
    if (style.mixBlendMode !== "normal") return true;
    if (style.isolation === "isolate") return true;
    if (style.willChange !== "auto" && style.willChange !== "") {
      var hinted = style.willChange.split(",").map(function (v) { return v.trim(); });
      var layered = ["transform", "opacity", "filter", "perspective"];
      if (hinted.some(function (v) { return layered.indexOf(v) >= 0; })) return true;
    }
    if (CONTAINMENT_VALUES.some(function (v) { return style.contain.indexOf(v) >= 0; })) return true;
    return false;
  }

  function bucketOf(element) {
    var classes = Array.prototype.slice.call(element.classList, 0, 2);
    return element.tagName.toLowerCase() + (classes.length > 0 ? "." + classes.join(".") : "");
  }

  function zero() {
    return { elements: 0, stackingContexts: 0, renderLayerCandidates: 0, sticky: 0 };
  }

  function add(into, from, sign) {
    into.elements += sign * from.elements;
    into.stackingContexts += sign * from.stackingContexts;
    into.renderLayerCandidates += sign * from.renderLayerCandidates;
    into.sticky += sign * from.sticky;
    return into;
  }

  function subtree(root) {
    return [root].concat(Array.prototype.slice.call(root.querySelectorAll("*")));
  }

  // A subtree's population, optionally bucketing its stacking contexts and
  // sticky elements by `tag.class.class` into the histograms given.
  function populationOf(root, histograms) {
    var p = zero();
    subtree(root).forEach(function (el) {
      var style = getComputedStyle(el);
      p.elements += 1;
      if (establishesStackingContext(el, style)) {
        p.stackingContexts += 1;
        if (histograms) bump(histograms.stacking, bucketOf(el));
      }
      if (isRenderLayerCandidate(style)) p.renderLayerCandidates += 1;
      if (style.position === "sticky") {
        p.sticky += 1;
        if (histograms) bump(histograms.sticky, bucketOf(el));
      }
    });
    return p;
  }

  function bump(table, key) {
    table[key] = (table[key] || 0) + 1;
  }

  function topOf(table) {
    return Object.keys(table)
      .map(function (k) { return [k, table[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, HISTOGRAM_SHOWN);
  }

  // ---- Subjects ------------------------------------------------------------

  function all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  // A column in a parked workspace layer belongs to `parked-absent`, so the
  // Overview arms take only shown columns: no layer ancestor, or a shown one.
  function inShownLayer(el) {
    var layer = el.closest(".tug-space-layer");
    return layer === null || layer.hasAttribute("data-space-shown");
  }

  function overviewColumns() {
    return all('[data-testid="overview-card"] .overview-transcript').filter(inShownLayer);
  }

  // Every post cell of every shown column except each column's last child —
  // the live edge the column follows, which the shipped rule leaves rendered.
  function overviewCells() {
    var cells = [];
    overviewColumns().forEach(function (column) {
      all(":scope > .overview-cell", column).forEach(function (cell) {
        if (cell !== column.lastElementChild) cells.push(cell);
      });
    });
    return cells;
  }

  function parkedLayers() {
    return all(".tug-space-layer:not([data-space-shown])");
  }

  function cellsOf(list) {
    return all(".tug-list-view-cell", list).filter(function (cell) {
      return cell.closest('[data-slot="tug-list-view"]') === list;
    });
  }

  // The largest Session transcript in the shown workspace, by cell count.
  function largestTranscript() {
    var best = null;
    var bestCells = -1;
    all('.tug-space-layer[data-space-shown] [data-slot="tug-list-view"][data-offscreen-skip]').forEach(function (list) {
      var n = cellsOf(list).length;
      if (n > bestCells) {
        best = list;
        bestCells = n;
      }
    });
    return best;
  }

  function paneTitle(el) {
    var pane = el.closest(".tug-pane");
    if (!pane) return "";
    var title = pane.querySelector(".tug-pane-title") || pane.querySelector(".tug-pane-title-bar .tug-label");
    return title ? title.textContent.trim() : "";
  }

  function describe(el) {
    var testid = el.getAttribute("data-testid");
    return bucketOf(el) + (testid ? '[data-testid="' + testid + '"]' : "");
  }

  // ---- census --------------------------------------------------------------

  function census() {
    var doc = zero();
    all("*").forEach(function (el) {
      var style = getComputedStyle(el);
      doc.elements += 1;
      if (establishesStackingContext(el, style)) doc.stackingContexts += 1;
      if (isRenderLayerCandidate(style)) doc.renderLayerCandidates += 1;
      if (style.position === "sticky") doc.sticky += 1;
    });

    var layers = null;
    if (window.__tugMotion && window.__tugMotion.layers) {
      var l = window.__tugMotion.layers();
      layers = {
        elements: l.elements,
        stackingContexts: l.stackingContexts,
        renderLayerCandidates: l.renderLayerCandidates,
      };
    }

    var columns = overviewColumns();
    var histograms = { stacking: {}, sticky: {} };
    var overviewPopulation = zero();
    var overviewCellCount = 0;
    columns.forEach(function (column) {
      add(overviewPopulation, populationOf(column, histograms), 1);
      overviewCellCount += all(":scope > .overview-cell", column).length;
    });

    var parked = parkedLayers();
    var parkedPopulation = zero();
    parked.forEach(function (layer) { add(parkedPopulation, populationOf(layer), 1); });

    var list = largestTranscript();
    var transcript = null;
    if (list) {
      var cells = cellsOf(list);
      transcript = {
        title: paneTitle(list),
        cells: cells.length,
        skippedCells: cells.filter(function (c) { return c.hasAttribute("data-cv-skipped"); }).length,
        population: populationOf(list),
      };
    }

    var panes = all(".tug-pane").map(function (p) {
      return {
        title: paneTitle(p),
        elements: p.querySelectorAll("*").length,
        focused: p.getAttribute("data-focused") === "true",
        parked: !p.checkVisibility(),
      };
    });
    panes.sort(function (a, b) { return b.elements - a.elements; });

    return {
      document: doc,
      layers: layers,
      subjects: {
        overview: {
          columns: columns.length,
          cells: overviewCellCount,
          population: overviewPopulation,
          stackingHistogram: topOf(histograms.stacking),
          stickyHistogram: topOf(histograms.sticky),
        },
        parked: { layers: parked.length, population: parkedPopulation },
        transcript: transcript,
      },
      panes: panes,
      visibility: document.visibilityState,
      touched: all("[" + TOUCHED + "]").length,
      pending: !!window.__tugWalkPending,
    };
  }

  // ---- Writes and their undoing --------------------------------------------

  function write(pending, el, prop, value) {
    pending.writes.push({
      el: el,
      prop: prop,
      value: el.style.getPropertyValue(prop),
      priority: el.style.getPropertyPriority(prop),
      hadStyle: el.hasAttribute("style"),
    });
    el.setAttribute(TOUCHED, "");
    el.style.setProperty(prop, value);
  }

  // Undo every write, newest first, so two writes to one property unwind to
  // the value the deck had. An element that had no `style` attribute before
  // and has an empty one after gets none again.
  function unwrite(pending) {
    var n = pending.writes.length;
    for (var i = n - 1; i >= 0; i -= 1) {
      var w = pending.writes[i];
      if (w.value === "") w.el.style.removeProperty(w.prop);
      else w.el.style.setProperty(w.prop, w.value, w.priority);
      if (!w.hadStyle && w.el.getAttribute("style") === "") w.el.removeAttribute("style");
    }
    pending.writes = [];
    return n;
  }

  // Play exactly the animations this op paused, and only while they are still
  // paused: one a re-render cancelled meanwhile is not restarted.
  function unquiet(pending) {
    var n = 0;
    pending.quieted.forEach(function (a) {
      if (a.playState === "paused") {
        a.play();
        n += 1;
      }
    });
    pending.quieted = [];
    return n;
  }

  function unlisten(pending) {
    pending.listeners.forEach(function (l) { l[0].removeEventListener(l[1], l[2]); });
    pending.listeners = [];
  }

  function removeDrivers() {
    var drivers = all("[" + DRIVER + "]");
    drivers.forEach(function (d) { d.remove(); });
    return drivers.length;
  }

  function removeMarks() {
    var marks = all("[" + TOUCHED + "]");
    marks.forEach(function (m) { m.removeAttribute(TOUCHED); });
    return marks.length;
  }

  // Run `fn` with every parked layer that holds a scroll subject lifted to
  // `content-visibility: visible`. A parked layer is `content-visibility:
  // hidden`, which skips its layout, so a `scrollTop` written into it after
  // `parked-absent`'s re-show has no box to land in and reads back 0. The
  // layer stays `visibility: hidden` throughout, so nothing shows; the lift is
  // put back in the same turn, and `hidden` keeps the layout it was given.
  function withParkedLifted(pending, fn) {
    var lifted = [];
    pending.scrolls.forEach(function (s) {
      var layer = s.el.closest(".tug-space-layer:not([data-space-shown])");
      if (layer && lifted.indexOf(layer) < 0) lifted.push(layer);
    });
    var prior = lifted.map(function (layer) {
      var p = [layer.style.getPropertyValue("content-visibility"), layer.style.getPropertyPriority("content-visibility"), layer.hasAttribute("style")];
      layer.style.setProperty("content-visibility", "visible");
      return p;
    });
    try {
      return fn();
    } finally {
      lifted.forEach(function (layer, i) {
        if (prior[i][0] === "") layer.style.removeProperty("content-visibility");
        else layer.style.setProperty("content-visibility", prior[i][0], prior[i][1]);
        if (!prior[i][2] && layer.getAttribute("style") === "") layer.removeAttribute("style");
      });
    }
  }

  function writeScrolls(pending) {
    withParkedLifted(pending, function () {
      pending.scrolls.forEach(function (s) {
        s.el.scrollTop = s.top;
        s.el.scrollLeft = s.left;
      });
    });
  }

  // Which scroll subjects did not come back: an offset more than a pixel off,
  // or an Overview column whose follow-state (`data-tug-scroll-state`, written
  // by `setFollowing` in `overview-card.tsx`) is not what it was.
  function scrollMismatches(pending) {
    return withParkedLifted(pending, function () {
      var missed = [];
      pending.scrolls.forEach(function (s) {
        var off = Math.abs(s.el.scrollTop - s.top) > 1 || Math.abs(s.el.scrollLeft - s.left) > 1;
        var follow = s.follow !== null && s.el.hasAttribute("data-tug-scroll-state") !== s.follow;
        if (off || follow) missed.push(describe(s.el));
      });
      return missed;
    });
  }

  // Everything that can be put back synchronously. Idempotent: the `finally`,
  // the watchdog and `restore` all run it.
  function restoreNow(pending) {
    removeDrivers();
    var replayed = unquiet(pending);
    unlisten(pending);
    replayed += unwrite(pending);
    return replayed;
  }

  // ---- Frames --------------------------------------------------------------

  // `sampleFrame()` in `render-cost-probe.ts`: wait out the frame we are in,
  // then time from inside the next frame callback to the first task after its
  // rendering update. `drive`, when given, writes the driver's one style
  // change inside that callback before the clock starts, so the update it
  // times carries a style change and therefore a compositing walk.
  function sampleFrame(drive) {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (drive && !stopped) drive();
          var start = performance.now();
          setTimeout(function () { resolve(performance.now() - start); }, 0);
        });
      });
    });
  }

  function burst(n, drive) {
    var out = [];
    function next() {
      if (out.length >= n) return Promise.resolve(out);
      if (stopped) return Promise.reject(new Error("watchdog"));
      return sampleFrame(drive).then(function (ms) {
        out.push(ms);
        return next();
      });
    }
    return next();
  }

  function frame() {
    return new Promise(function (resolve) { requestAnimationFrame(function () { resolve(); }); });
  }

  function makeDriver(kind) {
    var d = document.createElement("div");
    d.setAttribute(DRIVER, "");
    d.style.cssText = "position: fixed; left: 0; top: 0; width: 1px; height: 1px; visibility: hidden; pointer-events: none;";
    var flip = false;
    return {
      node: d,
      drive: function () {
        flip = !flip;
        if (kind === "transform") d.style.transform = flip ? "translateX(1px)" : "translateX(0px)";
        else d.style.width = flip ? "2px" : "1px";
      },
    };
  }

  // ---- Arms ----------------------------------------------------------------

  // For a `display: none` arm: every offset in the subject's subtree, and the
  // follow-state of every Overview column among them, recorded before the
  // write so the re-show can put them back.
  function recordScrolls(pending, subjects) {
    subjects.forEach(function (root) {
      subtree(root).forEach(function (el) {
        var isColumn = el.classList.contains("overview-transcript");
        if (el.scrollTop === 0 && el.scrollLeft === 0 && !isColumn) return;
        pending.scrolls.push({
          el: el,
          top: el.scrollTop,
          left: el.scrollLeft,
          follow: isColumn ? el.hasAttribute("data-tug-scroll-state") : null,
        });
      });
    });
  }

  function hide(pending, subjects, removed) {
    recordScrolls(pending, subjects);
    subjects.forEach(function (s) { add(removed, populationOf(s), 1); });
    subjects.forEach(function (s) { write(pending, s, "display", "none"); });
  }

  // Carry each column's cells through the viewport once, a viewport a step,
  // and put the column back where it was. On this WebKit a
  // `content-visibility: auto` element changes state only when its proximity
  // to the viewport does: a cell that turns `auto` while already far
  // off-screen stays rendered until a scroll carries it in and out again. A
  // reader's column does exactly that as posts arrive — each row is rendered
  // where it lands and scrolls away — so the sweep stands the arm where the
  // shipped rule would be after use, rather than where a fresh write leaves
  // it. The offsets and follow-state were recorded first and are checked at
  // the end like any other arm's. The sweep never comes within
  // `LOAD_OLDER_PX` of the top: the card would page older history in, and the
  // cells above that line are near enough to the viewport at its first stop
  // to change state as the sweep carries them away.
  function sweep(columns) {
    var chain = Promise.resolve();
    columns.forEach(function (column) {
      var top = column.scrollTop;
      var step = Math.max(1, column.clientHeight);
      var end = column.scrollHeight;
      for (var pos = LOAD_OLDER_PX + 1; pos <= end; pos += step) {
        (function (at) {
          chain = chain.then(function () {
            alive();
            column.scrollTop = at;
            return frame().then(frame);
          });
        })(pos);
      }
      chain = chain.then(function () {
        alive();
        column.scrollTop = top;
        return frame().then(frame);
      });
    });
    return chain;
  }

  // Apply an arm. Returns how many subjects it acted on, what it found
  // already skipped, a function that yields the population it removed once
  // the settle is over (the skip arm's is only known then), and `prepare`,
  // the frames the arm needs before it is settled (the skip arm's sweep).
  function applyArm(pending, arm) {
    var removed = zero();
    var done = function () { return removed; };
    var ready = function () { return Promise.resolve(); };
    if (arm === "baseline") return { subjects: 0, alreadySkipped: 0, removed: done, prepare: ready };

    if (arm === "overview-skip") {
      var cells = overviewCells();
      var already = cells.filter(function (c) { return c.hasAttribute("data-cv-ready"); });
      var fresh = cells.filter(function (c) { return !c.hasAttribute("data-cv-ready"); });
      // Every read before any write, so the heights are the laid-out ones.
      var measured = fresh.map(function (c) {
        return { cell: c, height: c.getBoundingClientRect().height, population: populationOf(c) };
      });
      var skipped = [];
      measured.forEach(function (m, i) {
        var listener = function (e) { skipped[i] = e.skipped; };
        m.cell.addEventListener("contentvisibilityautostatechange", listener);
        pending.listeners.push([m.cell, "contentvisibilityautostatechange", listener]);
      });
      measured.forEach(function (m) {
        write(pending, m.cell, "contain-intrinsic-size", "auto " + m.height + "px");
        write(pending, m.cell, "content-visibility", "auto");
      });
      var columns = overviewColumns();
      recordScrolls(pending, columns);
      return {
        subjects: fresh.length,
        alreadySkipped: already.length,
        prepare: function () { return sweep(columns); },
        removed: function () {
          measured.forEach(function (m, i) { if (skipped[i]) add(removed, m.population, 1); });
          return removed;
        },
      };
    }

    var subjects = [];
    if (arm === "overview-absent") subjects = overviewColumns();
    else if (arm === "parked-absent") subjects = parkedLayers();
    else if (arm === "transcript-absent") {
      var list = largestTranscript();
      subjects = list ? [list] : [];
    } else if (arm === "transcript-unskipped") {
      // Selected afresh on every measure: `TugListView` re-marks its cells
      // from `contentvisibilityautostatechange` as this arm lands and lifts.
      var t = largestTranscript();
      var unskip = t ? cellsOf(t).filter(function (c) { return c.hasAttribute("data-cv-skipped"); }) : [];
      // Rendering these cells ADDS them to the walk: their population is
      // removed with a negative sign.
      unskip.forEach(function (c) { add(removed, populationOf(c), -1); });
      unskip.forEach(function (c) { write(pending, c, "content-visibility", "visible"); });
      return { subjects: unskip.length, alreadySkipped: 0, removed: done, prepare: ready };
    } else {
      throw new Error("unknown arm '" + arm + "'");
    }
    hide(pending, subjects, removed);
    return { subjects: subjects.length, alreadySkipped: 0, removed: done, prepare: ready };
  }

  // ---- measure -------------------------------------------------------------

  function measure() {
    if (window.__tugWalkPending) {
      return { error: "a walk reading is still pending on this deck; run 'tugtool deck motion walk --restore'" };
    }
    var pending = { writes: [], quieted: [], listeners: [], scrolls: [] };
    window.__tugWalkPending = pending;

    return new Promise(function (resolve) {
      var finished = false;
      var watchdog = setTimeout(function () {
        if (finished) return;
        finished = true;
        stopped = true;
        // Timers still fire when rAF is suspended, so this is the path that
        // runs behind an occluded window. Scroll offsets go back at once:
        // there may be no frame to wait for.
        restoreNow(pending);
        writeScrolls(pending);
        removeMarks();
        delete window.__tugWalkPending;
        resolve({ error: "watchdog" });
      }, WATCHDOG_MS);

      var applied;
      var result = { arm: args.arm, quieted: 0 };
      var driver = makeDriver(args.driver);

      new Promise(function (ok) {
        applied = applyArm(pending, args.arm);
        ok();
      })
        .then(function () {
          alive();
          return applied.prepare();
        })
        .then(function () {
          alive();
          // Quiet the deck's running loops for the burst, the way `bisect`
          // does: exactly the running ones, down in one turn, so a loop that
          // dirties style every frame does not make the floor walk too.
          pending.quieted = document.getAnimations().filter(function (a) { return a.playState === "running"; });
          pending.quieted.forEach(function (a) { a.pause(); });
          result.quieted = pending.quieted.length;
        })
        .then(function () { return burst(args.settle); })
        .then(function () { return burst(args.frames); })
        .then(function (floor) {
          alive();
          result.floor = floor;
          document.body.appendChild(driver.node);
          return burst(args.frames, driver.drive);
        })
        .then(function (driven) {
          result.driven = driven;
          result.subjects = applied.subjects;
          result.alreadySkipped = applied.alreadySkipped;
          result.removed = applied.removed();
        })
        .catch(function (e) {
          result.error = String(e && e.message ? e.message : e);
        })
        .then(function () {
          if (finished) return null;
          restoreNow(pending);
          if (pending.scrolls.length === 0) return null;
          // Two frames after the re-show, so the Overview's own follow
          // `ResizeObserver` has delivered both the 0×0 box and the re-shown
          // one before the offsets go back over them.
          return frame().then(frame).then(function () {
            writeScrolls(pending);
            return frame().then(frame);
          });
        })
        .then(function () {
          if (finished) return;
          finished = true;
          clearTimeout(watchdog);
          result.scrollMismatches = scrollMismatches(pending);
          removeMarks();
          delete window.__tugWalkPending;
          resolve(result);
        });
    });
  }

  // ---- restore -------------------------------------------------------------

  function restore() {
    var pending = window.__tugWalkPending;
    var replayed = 0;
    if (pending) {
      replayed = restoreNow(pending);
      writeScrolls(pending);
      delete window.__tugWalkPending;
    }
    return { replayed: replayed, marks: removeMarks(), drivers: removeDrivers() };
  }

  if (args.op === "census") return census();
  if (args.op === "measure") return measure();
  if (args.op === "restore") return restore();
  return { error: "unknown op '" + args.op + "'" };
})
