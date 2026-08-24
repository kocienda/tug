#!/usr/bin/env bash
# anim-island.sh — the animation-island meter (dash/animation-islands.md, Phase 0).
#
# Counts animation EVENTS, not animations: on a healthy deck the running glyphs
# are free and the standing counters read zero growth. Nonzero readings name the
# event channel — restarts (E1), writes reaching running glyph subtrees (E2),
# transitions outliving their resolved duration (E3).
#
# Usage: diag/anim-island.sh <command> [args]
#
# Commands (page-side, against a tugcast /api/eval port):
#   census <port>        one-shot: running animations by name+target, running
#                        transitions with age vs resolved duration
#   arm <port>           install the standing counters (idempotent; re-arming
#                        resets them)
#   read <port>          snapshot the counters; safe to call repeatedly
#   disarm <port>        remove listeners/observers and the ledger
#
# Commands (process-side):
#   pids                 list WebContent candidates (pick by RSS/start time —
#                        bundle-id matching is unreliable, see jul30 I4b)
#   walk <pid> [secs]    sample the WebContent process and report the walk
#                        (computeCompositingRequirements), updateRendering,
#                        and resolveStyle leading-sample counts
#
# Method rules (dash/animation-islands.md#artifact, jul30 D5): never probe
# through `!important` overlays — suppression sheets take a `:not(.probe-x)`
# exemption hole; an occluded window voids a walk run (check the rAF heartbeat
# in `read` output before trusting one).
set -euo pipefail

CMD="${1:-}"

ev() {
  local port="$1"
  python3 -c 'import json,sys; print(json.dumps({"code": sys.stdin.read()}))' \
    | curl -s -X POST "http://127.0.0.1:${port}/api/eval" \
        -H 'Content-Type: application/json' --data-binary @- \
    | python3 -c 'import json,sys
r = json.load(sys.stdin)
if r.get("status") != "ok":
    print(json.dumps(r), file=sys.stderr); sys.exit(1)
v = r.get("result")
try:
    print(json.dumps(json.loads(v), indent=1))
except Exception:
    print(v)'
}

case "$CMD" in

census)
  PORT="$2"
  ev "$PORT" <<'JS'
(function () {
  function path(el) {
    var out = [], n = el, i = 0;
    while (n && n.nodeType === 1 && i++ < 10) {
      var c = n.className && String(n.className).split(" ")[0];
      if (c) out.unshift(c);
      n = n.parentElement;
    }
    return out.slice(-6).join(">");
  }
  var anims = document.getAnimations();
  var byKey = {}, transitions = [];
  anims.forEach(function (a) {
    var t = a.effect && a.effect.target;
    if (a instanceof CSSTransition) {
      var timing = a.effect && a.effect.getComputedTiming();
      transitions.push({
        prop: a.transitionProperty, state: a.playState,
        ageMs: Math.round(a.currentTime || 0),
        durationMs: timing ? timing.duration : null,
        target: t ? path(t) : "?",
      });
      return;
    }
    var name = a.animationName || "waapi";
    var key = name + " @ " + (t ? path(t) : "?") + " [" + a.playState + "]";
    byKey[key] = (byKey[key] || 0) + 1;
  });
  return JSON.stringify({
    total: anims.length,
    running: anims.filter(function (a) { return a.playState === "running"; }).length,
    animations: byKey,
    transitions: transitions,
  });
})()
JS
  ;;

arm)
  PORT="$2"
  ev "$PORT" <<'JS'
(function () {
  if (window.__tugAnimIsland) window.__tugAnimIsland.disarm();
  function path(el) {
    var out = [], n = el, i = 0;
    while (n && n.nodeType === 1 && i++ < 10) {
      var c = n.className && String(n.className).split(" ")[0];
      if (c) out.unshift(c);
      n = n.parentElement;
    }
    return out.slice(-6).join(">");
  }
  var S = {
    armedAt: performance.now(),
    // element identity: stable id per node, so a remounted element (new node,
    // same place) gets a NEW id and its animationstart reads as a start on a
    // fresh key, while a restart on the SAME node increments an existing key.
    ids: new WeakMap(), nextId: 1,
    starts: {},          // "id:animName" -> {count, path}
    cancels: {},         // same keys; a cancel+start pair on one id = restart via remount-adjacent churn
    openTransitions: new Map(), // "id:prop" -> {ref, prop, path, startTs, budgetMs}
    agedTransitions: [], // closed-out violations, kept for the report
    glyphRoots: [],      // {ref, path} for every pulsing-dot root seen
    glyphWrites: 0,      // mutations landing inside running glyph subtrees
    glyphObservers: [],
    frames: 0, rafId: 0,
  };
  function idFor(el) {
    var id = S.ids.get(el);
    if (!id) { id = S.nextId++; S.ids.set(el, id); }
    return id;
  }
  S.onAnimStart = function (e) {
    var key = idFor(e.target) + ":" + e.animationName;
    var rec = S.starts[key] || (S.starts[key] = { count: 0, path: path(e.target) });
    rec.count++;
  };
  S.onAnimCancel = function (e) {
    var key = idFor(e.target) + ":" + e.animationName;
    var rec = S.cancels[key] || (S.cancels[key] = { count: 0, path: path(e.target) });
    rec.count++;
  };
  S.onTransRun = function (e) {
    var el = e.target;
    var cs = getComputedStyle(el);
    var ms = function (v) {
      var first = String(v).split(",")[0].trim();
      var n = parseFloat(first);
      if (!isFinite(n)) return 0;
      return first.endsWith("ms") ? n : n * 1000;
    };
    S.openTransitions.set(idFor(el) + ":" + e.propertyName, {
      ref: new WeakRef(el), prop: e.propertyName, path: path(el),
      startTs: performance.now(),
      budgetMs: ms(cs.transitionDuration) + ms(cs.transitionDelay) + 750,
    });
  };
  S.onTransDone = function (e) {
    S.openTransitions.delete(idFor(e.target) + ":" + e.propertyName);
  };
  document.addEventListener("animationstart", S.onAnimStart, true);
  document.addEventListener("animationcancel", S.onAnimCancel, true);
  document.addEventListener("transitionrun", S.onTransRun, true);
  document.addEventListener("transitionend", S.onTransDone, true);
  document.addEventListener("transitioncancel", S.onTransDone, true);
  // Glyph ledger + write-reach observers, refreshed at read time for glyphs
  // that mount later.
  S.trackGlyphs = function () {
    document.querySelectorAll(".tug-progress-pulsing-dot").forEach(function (g) {
      if (S.ids.has(g)) return;
      idFor(g);
      S.glyphRoots.push({ ref: new WeakRef(g), path: path(g), running: g.dataset.state === "running" });
      var mo = new MutationObserver(function (muts) { S.glyphWrites += muts.length; });
      mo.observe(g, { attributes: true, childList: true, subtree: true, characterData: true });
      S.glyphObservers.push(mo);
    });
  };
  S.trackGlyphs();
  // rAF heartbeat — the occlusion guard. A walk sample taken while this
  // reads ~0 fps is void.
  (function beat() { S.frames++; S.rafId = requestAnimationFrame(beat); })();
  S.disarm = function () {
    document.removeEventListener("animationstart", S.onAnimStart, true);
    document.removeEventListener("animationcancel", S.onAnimCancel, true);
    document.removeEventListener("transitionrun", S.onTransRun, true);
    document.removeEventListener("transitionend", S.onTransDone, true);
    document.removeEventListener("transitioncancel", S.onTransDone, true);
    S.glyphObservers.forEach(function (o) { o.disconnect(); });
    cancelAnimationFrame(S.rafId);
    delete window.__tugAnimIsland;
  };
  window.__tugAnimIsland = S;
  return JSON.stringify({ armed: true, glyphsTracked: S.glyphRoots.length });
})()
JS
  ;;

read)
  PORT="$2"
  ev "$PORT" <<'JS'
(function () {
  var S = window.__tugAnimIsland;
  if (!S) return JSON.stringify({ error: "not armed" });
  S.trackGlyphs();
  var now = performance.now();
  // Sweep open transitions: past budget and still open = aged (E3), whether
  // the element is still connected or the transition object leaked with it.
  S.openTransitions.forEach(function (rec, key) {
    if (now - rec.startTs > rec.budgetMs) {
      var el = rec.ref.deref();
      S.agedTransitions.push({
        prop: rec.prop, path: rec.path,
        ageMs: Math.round(now - rec.startTs), budgetMs: Math.round(rec.budgetMs),
        stillConnected: !!(el && document.contains(el)),
      });
      S.openTransitions.delete(key);
    }
  });
  var restarts = [], startsTotal = 0;
  Object.keys(S.starts).forEach(function (k) {
    startsTotal += S.starts[k].count;
    if (S.starts[k].count > 1) restarts.push({ path: S.starts[k].path, starts: S.starts[k].count });
  });
  var cancelsTotal = 0;
  Object.keys(S.cancels).forEach(function (k) { cancelsTotal += S.cancels[k].count; });
  var gone = 0, live = 0;
  S.glyphRoots.forEach(function (g) {
    var el = g.ref.deref();
    if (el && document.contains(el)) live++; else gone++;
  });
  var elapsed = (now - S.armedAt) / 1000;
  return JSON.stringify({
    windowSecs: Math.round(elapsed),
    fps: Math.round(S.frames / Math.max(elapsed, 0.001)),
    animationStarts: startsTotal,
    animationCancels: cancelsTotal,
    restarts: restarts.sort(function (a, b) { return b.starts - a.starts; }).slice(0, 20),
    glyphs: { tracked: S.glyphRoots.length, live: live, unmounted: gone },
    glyphSubtreeWrites: S.glyphWrites,
    openTransitions: S.openTransitions.size,
    agedTransitions: S.agedTransitions.slice(-20),
  });
})()
JS
  ;;

disarm)
  PORT="$2"
  ev "$PORT" <<'JS'
(function () {
  if (!window.__tugAnimIsland) return JSON.stringify({ armed: false });
  window.__tugAnimIsland.disarm();
  return JSON.stringify({ disarmed: true });
})()
JS
  ;;

pids)
  ps ax -o pid,%cpu,rss,lstart,command \
    | grep 'WebKit.WebContent.xpc' | grep -v grep \
    | awk '{printf "pid=%-7s cpu=%-6s rss=%.1fGB start=%s %s %s %s %s\n", $1, $2, $3/1048576, $4, $5, $6, $7, $8}' \
    | sort -t= -k3 -rn
  ;;

walk)
  PID="$2"
  SECS="${3:-5}"
  OUT="$(mktemp /tmp/anim-island-walk.XXXXXX)"
  sample "$PID" "$SECS" -file "$OUT" >/dev/null 2>&1
  python3 - "$OUT" "$SECS" <<'PY'
import re, sys
best = {
    "computeCompositingRequirements": 0,
    "Page::updateRendering": 0,
    "Document::resolveStyle": 0,
    "updateBackingAndHierarchy": 0,
}
for line in open(sys.argv[1]):
    m = re.match(r"^[ +!:|]*(\d+) (.*)$", line)
    if not m:
        continue
    n, name = int(m.group(1)), m.group(2)
    for k in best:
        if k in name:
            best[k] = max(best[k], n)
print("window=%ss  updateRendering=%d  resolveStyle=%d  walk=%d  backing=%d"
      % (sys.argv[2], best["Page::updateRendering"], best["Document::resolveStyle"],
         best["computeCompositingRequirements"], best["updateBackingAndHierarchy"]))
print("samples-file=%s" % sys.argv[1])
PY
  ;;

*)
  sed -n '2,26p' "$0"
  exit 1
  ;;
esac
