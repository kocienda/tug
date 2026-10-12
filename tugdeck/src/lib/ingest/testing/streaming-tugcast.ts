/**
 * A fake tugcast that streams on its own clock, run as its own process.
 *
 * `fake-tugcast` lives on the test's thread, so a test that makes the page
 * slow would slow the producer with it, and the queue it means to observe
 * would never form. This one runs in a child process: it answers the
 * handshake, then sends one DEFAULTS frame every `--interval-ms` for
 * `--duration-ms`, each carrying its send time (epoch milliseconds, from
 * `performance.timeOrigin`) as its payload, so the page can read each frame's
 * age when it arrives. It prints its port on the first line of stdout.
 *
 *   bun streaming-tugcast.ts --interval-ms 2 --duration-ms 1500
 */

import { FeedId, encodeFrame } from "@/protocol";

function arg(name: string, fallback: number): number {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? Number(process.argv[at + 1]) : fallback;
}

const intervalMs = arg("interval-ms", 2);
const durationMs = arg("duration-ms", 1500);
const now = (): number => performance.timeOrigin + performance.now();
const utf8 = new TextEncoder();

const server = Bun.serve({
  port: 0,
  fetch(req, srv) {
    if (srv.upgrade(req)) return undefined;
    return new Response("websocket only", { status: 400 });
  },
  websocket: {
    message(ws, message) {
      if (typeof message !== "string") return;
      ws.send(JSON.stringify({ protocol: "tugcast", version: 1, capabilities: [] }));
      const stop = now() + durationMs;
      const tick = (): void => {
        if (now() > stop) return;
        const payload = utf8.encode(String(now()));
        ws.sendBinary(new Uint8Array(encodeFrame({ feedId: FeedId.DEFAULTS, flags: 0, payload })));
        setTimeout(tick, intervalMs);
      };
      setTimeout(tick, intervalMs);
    },
  },
});

console.log(server.port);
