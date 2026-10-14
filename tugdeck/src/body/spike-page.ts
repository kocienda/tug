/**
 * The display-rate spike's child page (`/?body=spike`).
 *
 * The host places this page in a WKWebView of its own, beneath the deck, and
 * stalls the deck's main thread to see whether this page keeps its frames
 * (`tugapp/Sources/TestHarness/SpikeBodyHandlers.swift`, at0737). So it does
 * the two kinds of work a card does every frame — a compositor animation, and
 * main-thread paint (one log line appended per animation frame, the last 200
 * kept) — and records what it delivered:
 *
 * - `window.__tugBodySpike.start()` begins recording rAF times, in ms from the
 *   call; `stop()` ends it; `read()` returns `{ticks, pointerdowns}`.
 * - Every `pointerdown` on the page is counted, so a click the host passed
 *   through the deck's view can be seen to arrive.
 *
 * It posts `spikeReady` once it has painted, which is what the host times the
 * cold page by. It imports nothing from the deck: a body of this kind has no
 * card, no connection and no store, and the reading must carry none of their
 * cost.
 *
 * @module body/spike-page
 */

const LOG_LINES_KEPT = 200;

interface SpikeReading {
  ticks: number[];
  pointerdowns: number;
}

declare global {
  interface Window {
    __tugBodySpike?: {
      start(): void;
      stop(): void;
      read(): SpikeReading;
    };
  }
}

let recording = false;
let startedAt = 0;
let ticks: number[] = [];
let pointerdowns = 0;
let lineNumber = 0;

// A root of its own, beside a hidden `#deck-container`: whatever stylesheet
// the build attaches to the page paints the deck container with the canvas
// and its grid, and the spike's reading must be of the spike's own paint.
document.getElementById("deck-container")?.setAttribute("hidden", "");
const root = document.createElement("div");
root.className = "tug-spike-root";
document.body.appendChild(root);

const style = document.createElement("style");
style.textContent =
  "html,body{background:#1d2733!important}" +
  ".tug-spike-root{position:fixed;inset:0;overflow:hidden;font:12px/16px ui-monospace,monospace;color:#cfe3f5}" +
  "@keyframes tug-spike-slide{from{transform:translateX(0)}to{transform:translateX(480px)}}" +
  ".tug-spike-block{position:absolute;top:12px;left:12px;width:80px;height:80px;" +
  "background:#f2a541;border-radius:6px;animation:tug-spike-slide 900ms linear infinite alternate}" +
  ".tug-spike-log{position:absolute;top:104px;left:12px;right:12px;bottom:12px;overflow:hidden}";
document.head.appendChild(style);

const block = document.createElement("div");
block.className = "tug-spike-block";
const log = document.createElement("div");
log.className = "tug-spike-log";
root.append(block, log);

document.addEventListener(
  "pointerdown",
  () => {
    pointerdowns += 1;
  },
  true,
);

function frame(now: number): void {
  if (recording) ticks.push(now - startedAt);
  lineNumber += 1;
  const line = document.createElement("div");
  line.textContent = `frame ${lineNumber} at ${now.toFixed(1)} ms`;
  log.appendChild(line);
  while (log.childElementCount > LOG_LINES_KEPT) log.firstElementChild?.remove();
  log.scrollTop = log.scrollHeight;
  window.requestAnimationFrame(frame);
}

window.__tugBodySpike = {
  start() {
    ticks = [];
    startedAt = performance.now();
    recording = true;
  },
  stop() {
    recording = false;
  },
  read() {
    return { ticks: ticks.slice(), pointerdowns };
  },
};

window.requestAnimationFrame(frame);
// Painted: the second frame callback runs after the first frame was presented.
window.requestAnimationFrame(() => {
  window.requestAnimationFrame(() => {
    const webkit = (window as unknown as {
      webkit?: { messageHandlers?: { spikeReady?: { postMessage: (v: unknown) => void } } };
    }).webkit;
    webkit?.messageHandlers?.spikeReady?.postMessage({});
  });
});

export {};
