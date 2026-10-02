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
// and two for the lead recorder `--tasks` reads (`tugdeck/index.html`), which
// has to be installed before the deck's bundle evaluates:
//
//   recorder — whether this page carries it
//   install  — flag it for this page session and reload the deck
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
//
// It is two tasks, as a hand's click is two input events: the press
// (`pointerdown`, `mousedown`) in one, and the release (`pointerup`,
// `mouseup`, `click`) in the next. Dispatched from one task, the press's work
// was counted in the click's task, and what the lead blocked on could not be
// told apart from what the release did. The recorder names them `press` and
// `click`; the click's time is the press's, since the gesture starts there.
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

  // Every selector query the deck makes while the recorder is installed, keyed
  // by method and selector: how many, how long, how many and how long inside
  // the lead, the longest single call, and the caller's stack from the first
  // call — a selector string usually names its caller, and the stack settles
  // it when it does not. The wrappers are installed just before the click and
  // always restored before the result is built, so the verb's own queries are
  // never counted and the deck is left exactly as it was found.
  function queryRecorder(leadMs) {
    var table = {};
    // Every call in order — [start, ms, method, selector] — so a long frame
    // can be asked which queries ran inside it.
    var calls = [];
    var origin = 0;
    var saved = [];
    var METHODS = [
      [Document.prototype, "Document", ["querySelector", "querySelectorAll"]],
      [Element.prototype, "Element", ["querySelector", "querySelectorAll", "closest", "matches"]],
    ];
    function callerStack() {
      var lines = String(new Error().stack || "").split("\n").slice(2, 6);
      return lines.map(function (l) {
        return l.replace(/https?:\/\/[^/]+\/(?:assets\/)?/, "");
      }).join(" < ");
    }
    function wrap(proto, owner, name) {
      var original = proto[name];
      saved.push([proto, name, original]);
      proto[name] = function (selector) {
        var t0 = performance.now();
        try {
          return original.apply(this, arguments);
        } finally {
          var t1 = performance.now();
          var key = owner + "." + name + "\u0000" + selector;
          var row = table[key];
          if (!row) {
            row = table[key] = {
              method: owner + "." + name, selector: String(selector),
              count: 0, ms: 0, leadCount: 0, leadMs: 0, maxMs: 0, stack: callerStack(),
            };
          }
          var d = t1 - t0;
          calls.push([t0, d, owner + "." + name, String(selector)]);
          row.count += 1;
          row.ms += d;
          if (d > row.maxMs) row.maxMs = d;
          if (origin > 0 && t0 - origin <= leadMs) {
            row.leadCount += 1;
            row.leadMs += d;
          }
        }
      };
    }
    return {
      install: function () {
        METHODS.forEach(function (m) {
          m[2].forEach(function (name) { wrap(m[0], m[1], name); });
        });
      },
      start: function (t) { origin = t; },
      restore: function () {
        saved.reverse().forEach(function (s) { s[0][s[1]] = s[2]; });
        saved = [];
      },
      rows: function () {
        return Object.keys(table).map(function (k) {
          var r = table[k];
          r.ms = Math.round(r.ms * 100) / 100;
          r.leadMs = Math.round(r.leadMs * 100) / 100;
          r.maxMs = Math.round(r.maxMs * 100) / 100;
          return r;
        });
      },
      calls: function () { return calls; },
    };
  }

  if (args.op === "census") return census();

  if (args.op === "recorder") return { installed: !!window.__tugLead };

  if (args.op === "install") {
    window.sessionStorage.setItem("tug-lead-recorder", "1");
    setTimeout(function () { window.location.reload(); }, 50);
    return { reloading: true };
  }

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
    // With the lead recorder installed the page's schedulers are wrapped, and
    // the verb's own heartbeat and frame chain must not be in what it records.
    var lead = window.__tugLead || null;
    if (args.tasks && !lead) {
      resolve({ error: "the lead recorder is not installed in this page" });
      return;
    }
    var setTimeout = lead ? lead.native.setTimeout : window.setTimeout.bind(window);
    var requestAnimationFrame = lead ? lead.native.requestAnimationFrame : window.requestAnimationFrame.bind(window);
    var MutationObserver = lead ? lead.native.MutationObserver : window.MutationObserver;
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
    var queries = args.queries ? queryRecorder(args.leadMs) : null;
    // Two frames of recorder, then `prerollMs` of heartbeat before the click:
    // the click lands into a chain that is already running rather than one it
    // starts, and the heartbeat's free-running cadence is measured before
    // anything happens, so blocking can be read as time beyond it.
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
          if (queries) {
            queries.install();
            queries.start(click);
          }
          var press = function () {
            target.dispatchEvent(new PointerEvent("pointerdown", o));
            target.dispatchEvent(new MouseEvent("mousedown", o));
          };
          var release = function () {
            var up = Object.assign({}, o, { buttons: 0 });
            target.dispatchEvent(new PointerEvent("pointerup", up));
            target.dispatchEvent(new MouseEvent("mouseup", up));
            target.dispatchEvent(new MouseEvent("click", up));
          };
          if (args.tasks) {
            lead.arm();
            lead.run("press", press);
            setTimeout(function () { lead.run("click", release); }, 0);
          } else {
            press();
            setTimeout(release, 0);
          }
          setTimeout(function () {
            done = true;
            observer.disconnect();
            if (queries) queries.restore();
            var tasks = args.tasks ? lead.disarm() : null;
            // Every store change React was told of, and every flushSync,
            // read right after the disarm that ended the recording.
            var tells = args.tasks ? lead.tells() : null;
            var rel = function (t) { return Math.round((t - click) * 10) / 10; };
            resolve({
              title: titleOf(row),
              // Strictly after: the page clock is coarse, so a frame that ran
              // just before the click can read the click's own time.
              frames: frames.filter(function (t) { return t > click; }).map(rel),
              beats: beats
                // Past the lead, so a gap straddling its end can be clipped.
                .filter(function (t) { return t >= click && t <= click + args.leadMs + 100; })
                .map(rel),
              preBeats: beats
                .filter(function (t) { return t < click && t >= click - args.prerollMs; })
                .map(rel),
              settle: marks.map(function (m) { return [rel(m[0]), m[1]]; }),
              moved: focusedPaneId() !== before,
              visibility: document.visibilityState,
              queries: queries ? queries.rows() : null,
              queryCalls: queries
                ? queries.calls().map(function (c) { return [rel(c[0]), Math.round(c[1] * 100) / 100, c[2], c[3]]; })
                : null,
              // Every callback the lead recorder saw run, in order, with
              // times relative to the click; `parent` indexes this list.
              tasks: tasks && tasks.map(function (e) {
                return {
                  kind: e.kind, name: e.name, stack: e.stack, parent: e.parent,
                  queued: e.queued === null ? null : rel(e.queued),
                  start: rel(e.start), end: rel(e.end),
                };
              }),
              tells: tells && tells.map(function (t) {
                return { t: rel(t.t), kind: t.kind, stack: t.stack, task: t.task };
              }),
              commits: tasks && window.__tugCommits
                ? window.__tugCommits.since(click).map(function (c) {
                    return {
                      t: rel(c.t), ms: Math.round(c.ms * 10) / 10, task: c.task,
                      fibers: c.fibers, performed: c.performed,
                      origins: c.origins, top: c.top, hooks: c.hooks,
                      // The first store read of the render, and the end of
                      // the commit's passive effects; either may be absent.
                      renderStart: c.renderStart == null ? null : rel(c.renderStart),
                      post: c.post == null ? null : rel(c.post),
                    };
                  })
                : null,
            });
          }, args.windowMs);
        }, args.prerollMs);
      });
    });
  });
})
