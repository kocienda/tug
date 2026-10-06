// The page half of `tugtool deck motion settle`, posted through `/api/eval`.
//
// One function over one argument object, like `deck_motion_slide.js`, whose
// `census`, `recorder` and `install` ops the shell end reuses. Three ops here:
//
//   where  — the active workspace and the focused card, so a repeated
//            `switch` or `flip` can go back where it came from, and with
//            `args.card` the slot of the pane holding it, so a repeated
//            `slot` can send the card home
//   rest   — the deck's at-rest reading beside the budget it is read against
//   record — one gesture, driven through `window.tugdeck.lab.drive`, recorded
//            from just before it until the settle mark has gone off and
//            `tailMs` more, or `capMs` if it never does
//
// `record` returns RAW times relative to the drive: every animation frame,
// every zero-timer heartbeat, every flip of the settle mark, every React
// commit the census walked, every `settle-beat` row the deck trace recorded
// (`settleBeats` — never `beats`, which is the heartbeat list), and with
// `chains` the chain probe's reading over the drive and each chain's paying
// read relative to the drive (`landChains`). The shell end finds the
// settle window and keeps the commits inside it, so that reduction is
// unit-tested in Rust.
//
// The drive is made from a task (a zero timeout), never from inside a frame
// callback, for the reason `slide` gives: a gesture delivered during a
// rendering update is a different gesture. With `tasks` it runs inside
// `lead.run("gesture", …)`, so the recorder names the gesture's own task.
(function (args) {
  "use strict";

  var SETTLE = "data-imposer-settling";
  // A settled still crossing's mark. The land is not over until every one has
  // come off, so each removal is recorded and the land reads two frames past
  // the last (set-up-and-go-fixups [B04]).
  var STILL_SETTLED = "data-still-settled";

  if (args.op === "where") {
    var diag = window.tugdeck && window.tugdeck.diag;
    if (!diag) return { error: "this deck has no window.tugdeck.diag" };
    var deck = diag.getDeckState();
    var pane = deck && deck.panes
      ? deck.panes.find(function (p) { return p.id === deck.activePaneId; })
      : null;
    var holder = deck && deck.panes && args.card
      ? deck.panes.find(function (p) { return p.cardIds.indexOf(args.card) >= 0; })
      : null;
    return {
      spaceId: diag.getSpaces().activeSpaceId,
      cardId: pane ? pane.activeCardId : null,
      cardSlot: holder && typeof holder.slot === "number" ? holder.slot : null,
    };
  }

  if (args.op === "rest") {
    var motion = window.__tugMotion;
    if (!motion) return { error: "this deck has no window.__tugMotion" };
    // The budget is the probe's calibrated at-rest reference; absent on a
    // deck that predates it, which the shell end reports as unknown.
    var budget = motion.probe ? motion.probe().restBudgetPerSecond : undefined;
    return motion.rest().then(function (rest) {
      return { rest: rest, budgetPerSecond: typeof budget === "number" ? budget : null };
    });
  }

  if (args.op !== "record") return { error: "unknown op " + args.op };

  return new Promise(function (resolve) {
    var lab = window.tugdeck && window.tugdeck.lab;
    if (!lab || typeof lab.drive !== "function") {
      resolve({ error: "this deck has no window.tugdeck.lab.drive — it predates the gesture door" });
      return;
    }
    var lead = window.__tugLead || null;
    if (args.tasks && !lead) {
      resolve({ error: "the lead recorder is not installed in this page" });
      return;
    }
    var trace = window.__deckTrace || null;
    var motion = window.__tugMotion || null;
    if (args.chains && !(motion && typeof motion.chains === "function")) {
      resolve({ error: "this deck has no window.__tugMotion.chains" });
      return;
    }
    // With the recorder installed the page's schedulers are wrapped, and the
    // verb's own chains must not be in what it records.
    var setTimeout = lead ? lead.native.setTimeout : window.setTimeout.bind(window);
    var requestAnimationFrame = lead ? lead.native.requestAnimationFrame : window.requestAnimationFrame.bind(window);
    var MutationObserver = lead ? lead.native.MutationObserver : window.MutationObserver;
    var frames = [];
    var beats = [];
    var marks = [];
    var sheds = [];
    var done = false;
    var t0 = 0;
    // The deck trace is enabled for the drive alone, so its `settle-beat` rows
    // are recorded, and put back as it was found.
    var traceWasOn = trace ? trace.isEnabled() : false;
    var traceMark = 0;
    var paneId = null;

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
        if (m.attributeName === STILL_SETTLED) {
          if (!m.target.hasAttribute(STILL_SETTLED)) sheds.push(now);
          return;
        }
        // The container's mark alone: each frame carries a copy, set and
        // cleared with it, and only the container's says when the settle is.
        if (m.target.classList.contains("tug-pane")) return;
        marks.push([now, m.target.hasAttribute(SETTLE)]);
      });
    });
    observer.observe(document.body, {
      attributes: true, subtree: true, attributeFilter: [SETTLE, STILL_SETTLED],
    });
    requestAnimationFrame(frame);
    beat();

    var rel = function (t) { return Math.round((t - t0) * 10) / 10; };

    // The shown frames' ids and rounded rects, as one string — the band the
    // verdict compares to tell a shrink, whose land is paid by ruling.
    function band() {
      return Array.prototype.map.call(
        document.querySelectorAll("[data-space-layer][data-space-shown] .tug-pane[data-pane-id]"),
        function (el) {
          var r = el.getBoundingClientRect();
          return el.getAttribute("data-pane-id") + "@" + Math.round(r.left) + "," +
            Math.round(r.top) + "+" + Math.round(r.width) + "x" + Math.round(r.height);
        }
      ).join(" ");
    }
    var bandBefore = "";

    function finish(error) {
      done = true;
      observer.disconnect();
      var tasks = args.tasks ? lead.disarm() : null;
      var tells = args.tasks ? lead.tells() : null;
      var chains = null;
      if (args.chains) {
        chains = motion.chains("read");
        motion.chains("disarm");
      }
      var settleBeats = trace
        ? trace.since(traceMark)
            .filter(function (e) { return e.kind === "settle-beat"; })
            .map(function (e) {
              return {
                recipe: e.recipe, targets: e.targets, durationMs: e.durationMs,
                startDelayMs: e.startDelayMs, declares: e.declares, landing: e.landing,
              };
            })
        : null;
      // The motion gate's edges, on the drive's clock: the last close before
      // the land is the motion's first frame (set-up-and-go [B05]).
      var gates = trace
        ? trace.since(traceMark)
            .filter(function (e) { return e.kind === "settle-gate"; })
            .map(function (e) { return [rel(e.timestamp), e.phase]; })
        : null;
      // The deck's own rows, written only while the record switch is on
      // (`__tugMotion.record`): the verdict's input. `null` when it is off,
      // which the shell end reports rather than reading as green.
      var engine = trace && trace.isKindEnabled("settle-frames")
        ? {
            frames: trace.since(traceMark).filter(function (e) { return e.kind === "settle-frames"; }),
            lands: trace.since(traceMark).filter(function (e) { return e.kind === "settle-land"; }),
            before: bandBefore,
            after: band(),
          }
        : null;
      if (trace) trace.enable(traceWasOn);
      if (error) {
        resolve({ error: error });
        return;
      }
      resolve({
        frames: frames.filter(function (t) { return t > t0; }).map(rel),
        beats: beats.filter(function (t) { return t >= t0; }).map(rel),
        settle: marks.map(function (m) { return [rel(m[0]), m[1]]; }),
        sheds: sheds.filter(function (t) { return t >= t0; }).map(rel),
        settleBeats: settleBeats,
        gates: gates,
        engine: engine,
        chains: chains,
        // Each chain's paying read, on the drive's clock, so the shell end can
        // place a chain in the land's frame.
        landChains: chains && chains.chainTimes
          ? chains.chainTimes.map(function (c) {
              return { t: rel(c.t), ms: c.ms, site: String(c.site || "").split("\n")[0].trim() };
            })
          : null,
        paneId: paneId,
        visibility: document.visibilityState,
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
        // The census walks every commit in test mode, and in a release deck
        // only while the recorder is armed — so without `tasks` a release
        // deck has none to give.
        commits: window.__tugCommits
          ? window.__tugCommits.since(t0).map(function (c) {
              return {
                t: rel(c.t), ms: Math.round(c.ms * 10) / 10, task: c.task,
                fibers: c.fibers, performed: c.performed, mounted: c.mounted,
                origins: c.origins, top: c.top, hooks: c.hooks, why: c.why,
                renderStart: c.renderStart == null ? null : rel(c.renderStart),
                post: c.post == null ? null : rel(c.post),
              };
            })
          : null,
      });
    }

    // The settle mark has been on and has since gone off.
    function settled() {
      var on = false;
      for (var i = 0; i < marks.length; i += 1) {
        if (marks[i][1]) on = true;
        else if (on) return true;
      }
      return false;
    }

    // Two frames of chain before the drive, so the gesture lands in a chain
    // that is already running rather than one it starts.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        setTimeout(function () {
          if (trace) {
            trace.enable(true);
            traceMark = trace.mark();
          }
          bandBefore = band();
          // Armed last, just before the drive, so the probe's log is the
          // gesture's own; `stacks: false` unless this is the census drive.
          if (args.chains) motion.chains("arm", { stacks: !!args.chainStacks });
          t0 = performance.now();
          var drive = function () { return lab.drive(args.gesture, args.args); };
          var outcome;
          if (args.tasks) {
            lead.arm();
            outcome = lead.run("gesture", drive);
          } else {
            outcome = drive();
          }
          if (outcome && outcome.error) {
            finish(outcome.error);
            return;
          }
          if (outcome && typeof outcome.paneId === "string") paneId = outcome.paneId;
          (function poll() {
            var elapsed = performance.now() - t0;
            if (args.fixedMs != null) {
              // A switch sets no settle mark; it is read over a fixed span.
              if (elapsed >= args.fixedMs) setTimeout(function () { finish(null); }, args.tailMs);
              else setTimeout(poll, 50);
            } else if (settled()) {
              setTimeout(function () { finish(null); }, args.tailMs);
            } else if (elapsed >= args.capMs) {
              finish(null);
            } else {
              setTimeout(poll, 50);
            }
          })();
        }, 0);
      });
    });
  });
})
