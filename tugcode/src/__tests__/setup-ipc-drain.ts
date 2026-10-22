/**
 * Test-only preload: no test ends with IPC writes still queued.
 *
 * `writeLine` chains each frame as `writeTail.then(() => Bun.write(...))`,
 * so `Bun.write` is looked up when the queued callback runs, not when the
 * frame was written. A test that emits real frames and never drains them
 * leaves callbacks on the tail; under load they run late — after a later
 * test's capture helper has swapped in its own `Bun.write` — and the
 * earlier test's frames land in that capture. `retract-prompt` failed that
 * way under `just ci`, catching a `session_init` that `wake-reinit` had
 * emitted and that test asserts it never sees.
 *
 * Draining after every test settles the tail while the real `Bun.write` is
 * back in place, so a frame is only ever captured by the test that wrote it.
 */
import { afterEach } from "bun:test";
import { drainPendingWrites } from "../ipc.ts";

afterEach(async () => {
  await drainPendingWrites();
});
