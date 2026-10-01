// The page half of `tugtool deck motion slide`, posted through `/api/eval`.
//
// It is one function over one argument object, so the shell end can generate
// the call with `JSON.stringify`d arguments and nothing in it is interpolated
// raw. Three ops:
//
//   census  — the deck's size, so a reading can be compared with another one
//   resolve — which Cards-card session rows a name matches
//   record  — one row click, recorded from before it to `windowMs` after it
//
// `record` returns RAW times, relative to the click: every animation frame,
// every zero-timer heartbeat in the lead, and every flip of the settle mark.
// The shell end reduces them, so the reduction is unit-tested in Rust rather
// than trusted to a string.
//
// The click is the one the hand-rolled re-reading dispatched — pointer and
// mouse events on the row's title block, ten pixels in — so the verb's numbers
// stay comparable with `[F13]`–`[F16]` of the remaining-costs brief. It is
// dispatched from a task (a zero timeout), never from inside a frame callback,
// because a click delivered during a rendering update is a different gesture.
(function (args) {
  "use strict";

  var ROWS = '[data-cards-row-group="sessions"]';
  var SETTLE = "data-imposer-settling";

  function titleOf(row) {
    var t = row.querySelector(".tug-list-row-title");
    return t ? t.textContent.trim() : "";
  }

  // Only the rows a user could click for this gesture: visible (a Workspaces
  // card in a parked layer keeps its rows in the DOM), and in the workspace on
  // screen (a row in another workspace is a workspace switch, not a slide).
  // Among those, an exact title (case-folded) wins outright; otherwise a
  // substring match.
  function findRows(name) {
    var rows = Array.prototype.slice.call(document.querySelectorAll(ROWS)).filter(function (r) {
      return !r.hasAttribute("data-cards-space-inactive") && r.checkVisibility();
    });
    var want = name.toLowerCase();
    var exact = rows.filter(function (r) { return titleOf(r).toLowerCase() === want; });
    var hits = exact.length > 0
      ? exact
      : rows.filter(function (r) { return titleOf(r).toLowerCase().indexOf(want) >= 0; });
    return { hits: hits, titles: rows.map(titleOf) };
  }

  function focusedPaneId() {
    var p = document.querySelector('.tug-pane[data-focused="true"]');
    return p ? p.getAttribute("data-pane-id") : null;
  }

  function census() {
    var layers = window.__tugMotion && window.__tugMotion.layers
      ? window.__tugMotion.layers()
      : {};
    var panes = Array.prototype.slice.call(document.querySelectorAll(".tug-pane")).map(function (p) {
      // A sidebar card's pane carries a title; a flow card names itself in
      // its title bar's label.
      var title = p.querySelector(".tug-pane-title") || p.querySelector(".tug-pane-title-bar .tug-label");
      return {
        title: title ? title.textContent.trim() : "",
        elements: p.querySelectorAll("*").length,
        focused: p.getAttribute("data-focused") === "true",
        // A pane in a parked workspace layer stays in the DOM, and in every
        // count above, but is not on screen.
        parked: !p.checkVisibility(),
      };
    });
    panes.sort(function (a, b) { return b.elements - a.elements; });
    return {
      elements: layers.elements || document.querySelectorAll("*").length,
      stackingContexts: layers.stackingContexts || 0,
      renderLayerCandidates: layers.renderLayerCandidates || 0,
      panes: panes,
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
    };
  }

  if (args.op === "census") return census();

  if (args.op === "resolve") {
    var found = findRows(args.name);
    return { matches: found.hits.map(titleOf), titles: found.titles };
  }

  if (args.op !== "record") return { error: "unknown op " + args.op };

  return new Promise(function (resolve) {
    var found = findRows(args.name);
    if (found.hits.length !== 1) {
      resolve({ error: "'" + args.name + "' matches " + found.hits.length + " session rows", titles: found.titles });
      return;
    }
    var row = found.hits[0];
    var target = row.querySelector(".tug-markdown-block") || row;
    var frames = [];
    var beats = [];
    var marks = [];
    var done = false;
    var click = 0;

    function frame() {
      frames.push(performance.now());
      if (!done) requestAnimationFrame(frame);
    }
    function beat() {
      beats.push(performance.now());
      if (!done) setTimeout(beat, 0);
    }
    var observer = new MutationObserver(function (records) {
      var now = performance.now();
      records.forEach(function (m) {
        marks.push([now, m.target.hasAttribute(SETTLE)]);
      });
    });
    observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: [SETTLE] });
    requestAnimationFrame(frame);
    beat();

    var before = focusedPaneId();
    // Two frames of recorder before the click, so the click lands into a chain
    // that is already running rather than one it starts.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        setTimeout(function () {
          var box = target.getBoundingClientRect();
          var o = {
            bubbles: true, cancelable: true, composed: true,
            clientX: box.left + 10, clientY: box.top + box.height / 2,
            button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true,
          };
          click = performance.now();
          target.dispatchEvent(new PointerEvent("pointerdown", o));
          target.dispatchEvent(new MouseEvent("mousedown", o));
          o.buttons = 0;
          target.dispatchEvent(new PointerEvent("pointerup", o));
          target.dispatchEvent(new MouseEvent("mouseup", o));
          target.dispatchEvent(new MouseEvent("click", o));
          setTimeout(function () {
            done = true;
            observer.disconnect();
            var rel = function (t) { return Math.round((t - click) * 10) / 10; };
            resolve({
              title: titleOf(row),
              // Strictly after: the page clock is coarse, so a frame that ran
              // just before the click can read the click's own time.
              frames: frames.filter(function (t) { return t > click; }).map(rel),
              beats: beats
                .filter(function (t) { return t >= click && t <= click + args.leadMs; })
                .map(rel),
              settle: marks.map(function (m) { return [rel(m[0]), m[1]]; }),
              moved: focusedPaneId() !== before,
              visibility: document.visibilityState,
            });
          }, args.windowMs);
        }, 0);
      });
    });
  });
})
