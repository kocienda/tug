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

describe("the docket-loop verbs", () => {
  test("keep going sends its frame and settles with the ideas it filed", async () => {
    const { connection, sent, reply } = fakeConnection();
    const verbs = docketVerbs(connection, fakeClock().clock, 1_000);
    const asked = verbs.keepGoing({ projectDir: HERE, arc: "rail", version: 2, docketId: "aaaa0001" });
    expect(sent[0]).toEqual({
      action: "arc_keep_going",
      project_dir: HERE,
      arc: "rail",
      version: 2,
      docket_id: "aaaa0001",
      request_id: sent[0].request_id,
    });
    reply({
      action: "arc_keep_going_ok",
      request_id: sent[0].request_id,
      arc: "rail",
      kept_through: 2,
      ideas: ["1a2b3c4d"],
    });
    const result = await asked;
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.reply).toEqual({
        verb: "arc_keep_going",
        requestId: sent[0].request_id as string,
        arc: "rail",
        keptThrough: 2,
        ideas: ["1a2b3c4d"],
      });
    }
    verbs.dispose();
  });

  test("a park answered parked carries the fork commit", async () => {
    const { connection, sent, reply } = fakeConnection();
    const verbs = docketVerbs(connection, fakeClock().clock, 1_000);
    const asked = verbs.park({ projectDir: HERE, arc: "rail", successor: "rail-v2", boundary: "step:1" });
    expect(sent[0]).toEqual({
      action: "arc_park",
      project_dir: HERE,
      arc: "rail",
      successor: "rail-v2",
      boundary: "step:1",
      request_id: sent[0].request_id,
    });
    reply({ action: "arc_park_ok", request_id: sent[0].request_id, arc: "rail", parked: true, from: "abc123" });
    const result = await asked;
    expect(result.kind === "ok" && result.reply).toMatchObject({ parked: true, from: "abc123", waiting: null });
    verbs.dispose();
  });

  test("a park still waiting says where, and a refusal says why", async () => {
    const { connection, sent, reply } = fakeConnection();
    const verbs = docketVerbs(connection, fakeClock().clock, 1_000);
    const waiting = verbs.park({ projectDir: HERE, arc: "rail", successor: "rail-v2", boundary: "tip" });
    reply({
      action: "arc_park_ok",
      request_id: sent[0].request_id,
      arc: "rail",
      parked: false,
      waiting: "implement · step 3",
    });
    const result = await waiting;
    expect(result.kind === "ok" && result.reply).toMatchObject({
      parked: false,
      from: null,
      waiting: "implement · step 3",
    });

    const refused = verbs.park({ projectDir: HERE, arc: "rail", successor: "rail-v2", boundary: "step:9" });
    reply({ action: "arc_park_err", request_id: sent[1].request_id, message: "Step 9 is not done." });
    expect(await refused).toEqual({ kind: "refused", message: "Step 9 is not done." });
    verbs.dispose();
  });

  test("accepting a follow-up sends its generation and docket, and settles with the idea", async () => {
    const { connection, sent, reply } = fakeConnection();
    const verbs = docketVerbs(connection, fakeClock().clock, 1_000);
    const created = "2026-11-01T00:00:00Z";
    const asked = verbs.followUpAccept({
      projectDir: HERE,
      arc: "rail",
      created,
      k: 2,
      docketId: "aaaa0001",
    });
    expect(sent[0]).toEqual({
      action: "follow_up_accept",
      project_dir: HERE,
      arc: "rail",
      created,
      k: 2,
      docket_id: "aaaa0001",
      request_id: sent[0].request_id,
    });
    reply({ action: "follow_up_accept_ok", request_id: sent[0].request_id, arc: "rail", k: 2, idea: "1a2b3c4d" });
    const result = await asked;
    expect(result.kind === "ok" && result.reply).toEqual({
      verb: "follow_up_accept",
      requestId: sent[0].request_id as string,
      arc: "rail",
      k: 2,
      idea: "1a2b3c4d",
    });
    verbs.dispose();
  });

  test("dismissing a follow-up sends no docket, and a refusal says why", async () => {
    const { connection, sent, reply } = fakeConnection();
    const verbs = docketVerbs(connection, fakeClock().clock, 1_000);
    const created = "2026-11-01T00:00:00Z";
    const asked = verbs.followUpDismiss({ projectDir: HERE, arc: "rail", created, k: 1 });
    expect(sent[0]).toEqual({
      action: "follow_up_dismiss",
      project_dir: HERE,
      arc: "rail",
      created,
      k: 1,
      request_id: sent[0].request_id,
    });
    reply({ action: "follow_up_dismiss_ok", request_id: sent[0].request_id, arc: "rail", k: 1 });
    expect((await asked).kind).toBe("ok");

    const again = verbs.followUpDismiss({ projectDir: HERE, arc: "rail", created, k: 1 });
    reply({
      action: "follow_up_dismiss_err",
      request_id: sent[1].request_id,
      message: "Follow-up 1 of rail was already answered.",
    });
    expect(await again).toEqual({ kind: "refused", message: "Follow-up 1 of rail was already answered." });
    verbs.dispose();
  });

  test("a revert sends its generation and dry run, and settles with what the join touched", async () => {
    const { connection, sent, reply } = fakeConnection();
    const verbs = docketVerbs(connection, fakeClock().clock, 1_000);
    const created = "2026-11-01T00:00:00Z";
    const asked = verbs.revert({ projectDir: HERE, arc: "rail", created, dryRun: true });
    expect(sent[0]).toEqual({
      action: "arc_revert",
      project_dir: HERE,
      arc: "rail",
      created,
      dry_run: true,
      request_id: sent[0].request_id,
    });
    reply({
      action: "arc_revert_ok",
      request_id: sent[0].request_id,
      arc: "rail",
      created,
      join: "abc1234def",
      paths: 3,
      later: [
        { sha: "fff0001", subject: "Oil the rail", arc: "oil" },
        { sha: "fff0002", subject: "Hand edit" },
      ],
    });
    const result = await asked;
    expect(result.kind === "ok" && result.reply).toEqual({
      verb: "arc_revert",
      requestId: sent[0].request_id as string,
      arc: "rail",
      join: "abc1234def",
      paths: 3,
      later: [
        { sha: "fff0001", subject: "Oil the rail", arc: "oil" },
        { sha: "fff0002", subject: "Hand edit", arc: null },
      ],
      reverted: null,
    });

    const real = verbs.revert({ projectDir: HERE, arc: "rail", created, dryRun: false });
    expect(sent[1].dry_run).toBe(false);
    reply({
      action: "arc_revert_err",
      request_id: sent[1].request_id,
      message: "The revert conflicts on a.txt; the base is as it was.",
    });
    expect(await real).toEqual({
      kind: "refused",
      message: "The revert conflicts on a.txt; the base is as it was.",
    });
    verbs.dispose();
  });
});

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

  test("each idea and sketch ask carries a request id and settles on its own answer", async () => {
    const { connection, sent, reply } = fakeConnection();
    const verbs = docketVerbs(connection, fakeClock().clock, 1_000);
    const created = verbs.ideaCreate({ projectDir: HERE, docketId: "aaaa0001", text: "An inbox" });
    const added = verbs.ideaAddSession({ projectDir: HERE, id: "1a2b3c4d", uuid: "u-1" });
    const read = verbs.sketchRead({ projectDir: HERE, id: "3f9a1c2e" });
    const edited = verbs.sketchEdit({ projectDir: HERE, id: "3f9a1c2e", text: "t", baseVersion: 2 });
    expect(sent.map((s) => s.action)).toEqual([
      "idea_create",
      "idea_add_session",
      "sketch_read",
      "sketch_edit",
    ]);
    for (const s of sent) expect(typeof s.request_id).toBe("string");
    expect(new Set(sent.map((s) => s.request_id)).size).toBe(4);
    expect(sent[3].base_version).toBe(2);
    reply({
      action: "idea_create_ok",
      request_id: sent[0].request_id,
      idea: { id: "1a2b3c4d", text: "An inbox" },
      outcome: { key: "idea:1a2b3c4d", outcome: "filed" },
    });
    reply({
      action: "idea_add_session_ok",
      request_id: sent[1].request_id,
      id: "1a2b3c4d",
      sessions: [{ uuid: "u-1", at: "2026-11-22T00:00:00Z" }],
    });
    reply({
      action: "sketch_read_ok",
      request_id: sent[2].request_id,
      id: "3f9a1c2e",
      version: 2,
      versions: [],
      briefs: [],
      text: "the sketch",
    });
    reply({
      action: "sketch_edit_err",
      request_id: sent[3].request_id,
      message: "The sketch moved to v3 while you were editing.",
    });
    const c = await created;
    expect(c.kind === "ok" && c.reply.idea.id).toBe("1a2b3c4d");
    const a = await added;
    expect(a.kind === "ok" && a.reply.sessions.map((s) => s.uuid)).toEqual(["u-1"]);
    const r = await read;
    expect(r.kind === "ok" && r.reply.text).toBe("the sketch");
    expect(await edited).toEqual({
      kind: "refused",
      message: "The sketch moved to v3 while you were editing.",
    });
    verbs.dispose();
  });

  test("an idea ask nobody answers settles unanswered at the deadline", async () => {
    const { connection, sent, reply } = fakeConnection();
    const { clock, advance, pending } = fakeClock();
    const verbs = docketVerbs(connection, clock, 1_000);
    const late: { kind: string }[] = [];
    const asked = verbs.ideaAddSession(
      { projectDir: HERE, id: "1a2b3c4d", uuid: "u-1" },
      { onLate: (result) => late.push(result) },
    );
    advance(1_000);
    expect(await asked).toEqual({ kind: "unanswered" });
    reply({
      action: "idea_add_session_ok",
      request_id: sent[0].request_id,
      id: "1a2b3c4d",
      sessions: [],
    });
    expect(late.map((r) => r.kind)).toEqual(["ok"]);
    expect(pending()).toBe(0);
    verbs.dispose();
  });
});
