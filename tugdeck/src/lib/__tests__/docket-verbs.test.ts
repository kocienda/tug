/**
 * The docket verb sender: an ask settles on the reply that echoes its id,
 * settles `unanswered` at its deadline, and still hears a late answer.
 */
import { describe, expect, test } from "bun:test";

import { FeedId } from "../../protocol";
import { docketVerbs, type DocketVerbClock, type DocketVerbConnection } from "../docket-verbs";

/** A connection that records what was sent and can play a reply back. */
function fakeConnection() {
  const sent: Record<string, unknown>[] = [];
  const listeners: ((payload: Uint8Array) => void)[] = [];
  const connection = {
    send(_feedId: number, payload: Uint8Array) {
      sent.push(JSON.parse(new TextDecoder().decode(payload)));
    },
    onFrame(feedId: number, callback: (payload: Uint8Array) => void) {
      expect(feedId).toBe(FeedId.CONTROL);
      listeners.push(callback);
      return () => {
        listeners.splice(listeners.indexOf(callback), 1);
      };
    },
  } as unknown as DocketVerbConnection;
  const reply = (body: Record<string, unknown>) => {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    for (const listener of [...listeners]) listener(bytes);
  };
  return { connection, sent, reply };
}

/** A clock that moves only when the test says so. */
function fakeClock() {
  let now = 0;
  let next = 1;
  let timers: { at: number; fn: () => void; handle: number }[] = [];
  const clock: DocketVerbClock = {
    setTimeout(fn, ms) {
      const handle = next++;
      timers.push({ at: now + ms, fn, handle });
      return handle;
    },
    clearTimeout(handle) {
      timers = timers.filter((t) => t.handle !== handle);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) return;
      timers = timers.filter((t) => t !== due);
      due.fn();
    }
  };
  return { clock, advance, pending: () => timers.length };
}

const HERE = "/u/src/tug";

describe("docketVerbs", () => {
  test("an ask answered first settles with its outcomes", async () => {
    const { connection, sent, reply } = fakeConnection();
    const verbs = docketVerbs(connection, fakeClock().clock, 1_000);
    const asked = verbs.file({
      projectDir: HERE,
      id: "aaaa0001",
      items: [{ kind: "commit", sha: "63de5762a" }],
    });
    expect(sent[0].action).toBe("docket_file");
    // Another page's answer, then this ask's own.
    reply({ action: "docket_file_ok", request_id: "someone-else", id: "aaaa0001", outcomes: [] });
    reply({
      action: "docket_file_ok",
      request_id: sent[0].request_id,
      id: "aaaa0001",
      outcomes: [{ key: "commit:63de5762a", outcome: "filed" }],
    });
    const result = await asked;
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.reply.outcomes.map((o) => o.outcome)).toEqual(["filed"]);
    }
    verbs.dispose();
  });

  test("a refusal settles with its sentence", async () => {
    const { connection, sent, reply } = fakeConnection();
    const verbs = docketVerbs(connection, fakeClock().clock, 1_000);
    const asked = verbs.create({ projectDir: HERE, name: "Rail work" });
    reply({
      action: "docket_create_err",
      request_id: sent[0].request_id,
      message: "A docket named Rail work already exists.",
    });
    expect(await asked).toEqual({
      kind: "refused",
      message: "A docket named Rail work already exists.",
    });
    verbs.dispose();
  });

  test("an unanswered ask settles at the deadline and still hears a late answer", async () => {
    const { connection, sent, reply } = fakeConnection();
    const { clock, advance, pending } = fakeClock();
    const verbs = docketVerbs(connection, clock, 1_000);
    const late: { kind: string }[] = [];
    let settled = false;
    const asked = verbs
      .retire(
        { projectDir: HERE, id: "aaaa0001", retired: true },
        { onLate: (result) => late.push(result) },
      )
      .then((result) => {
        settled = true;
        return result;
      });
    advance(999);
    await Promise.resolve();
    expect(settled).toBe(false);
    advance(1);
    expect(await asked).toEqual({ kind: "unanswered" });
    reply({
      action: "docket_retire_ok",
      request_id: sent[0].request_id,
      id: "aaaa0001",
      retired: true,
    });
    expect(late.map((r) => r.kind)).toEqual(["ok"]);
    expect(pending()).toBe(0);
    verbs.dispose();
  });

  test("a late answer is forgotten after one more deadline", async () => {
    const { connection, sent, reply } = fakeConnection();
    const { clock, advance, pending } = fakeClock();
    const verbs = docketVerbs(connection, clock, 1_000);
    const late: unknown[] = [];
    const asked = verbs.search(
      { projectDir: HERE, query: "rail" },
      { onLate: (result) => late.push(result) },
    );
    advance(1_000);
    expect(await asked).toEqual({ kind: "unanswered" });
    advance(1_000);
    expect(pending()).toBe(0);
    reply({ action: "search_dockets_ok", request_id: sent[0].request_id, dockets: [] });
    expect(late).toHaveLength(0);
    verbs.dispose();
  });
});
