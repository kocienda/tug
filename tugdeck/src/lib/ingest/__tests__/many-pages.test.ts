/**
 * Several pages on one real tugcast.
 *
 * Every later rule tugcast keeps for many pages starts with knowing which
 * page is on each socket. These cases drive the deck's own `WireSocket`
 * against a real `tugcast --no-auth` (built and spawned by
 * `startRealTugcast`) with no host app: each page states its identity in its
 * hello, and tugcast lists, addresses and serves it by that identity.
 *
 * No claude session ever starts: the bridge is `/usr/bin/false`.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { BusOutbound } from "@tugproto/bus";
import { FeedId } from "@/protocol";
import { BUILD_TIMEOUT_MS, PageClient, startRealTugcast, type RealTugcast } from "../testing/real-tugcast";

/** `CLOSE_BAD_HANDSHAKE` in `tugcast-core/src/protocol.rs`. */
const CLOSE_BAD_HANDSHAKE = 4003;

interface ListedPage {
  client_id: number;
  role: string;
  page_id: string | null;
  card_id: string | null;
  sessions: string[] | null;
}

let tugcast: RealTugcast;
let clients: PageClient[] = [];

beforeAll(async () => {
  tugcast = await startRealTugcast();
}, BUILD_TIMEOUT_MS);

afterAll(async () => {
  await tugcast?.stop();
});

afterEach(() => {
  for (const client of clients) client.close();
  clients = [];
});

function page(hello: ConstructorParameters<typeof PageClient>[1] = null): PageClient {
  const client = new PageClient(tugcast.wsUrl, hello);
  clients.push(client);
  return client;
}

async function listedPages(): Promise<ListedPage[]> {
  const { status, body } = await tugcast.httpGet("/api/pages");
  expect(status).toBe(200);
  return (body as { pages: ListedPage[] }).pages;
}

/** The CONTROL payloads a page received with `action`. */
function controls(client: PageClient, action: string): Array<Record<string, unknown>> {
  return client.frames
    .filter((f) => f.feedId === FeedId.CONTROL && typeof f.json === "object" && f.json !== null)
    .map((f) => f.json as Record<string, unknown>)
    .filter((j) => j.action === action);
}

let markers = 0;

/**
 * The page-lane barrier: a `to: "all"` marker published after everything a
 * test sent before it, waited for at each page. Frames on one lane arrive in
 * publish order, so once a page has the marker it has every earlier lane
 * frame it was ever going to get.
 */
async function laneBarrier(...pages: PageClient[]): Promise<void> {
  const n = ++markers;
  const { status } = await tugcast.httpPost("/api/tell", { action: "tug-test-marker", to: "all", n });
  expect(status).toBe(200);
  await Promise.all(
    pages.map((p) => p.waitFor(() => controls(p, "tug-test-marker").some((m) => m.n === n), `marker ${n}`)),
  );
}

/** Wait until `/api/pages` satisfies `pred`, asking again between reads. */
async function pagesUntil(pred: (pages: ListedPage[]) => boolean, what: string): Promise<ListedPage[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const pages = await listedPages();
    if (pred(pages)) return pages;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(pages)}`);
    await Bun.sleep(50);
  }
}

describe("identity", () => {
  test("each page names itself in its hello and is listed by it", async () => {
    const shell = page({ role: "shell", page_id: "shell-page" });
    const body = page({ role: "body", page_id: "body-page", card_id: "c1" });
    const tool = page();

    const [shellReply, bodyReply, toolReply] = await Promise.all([shell.connect(), body.connect(), tool.connect()]);
    const ids = [shellReply.client_id, bodyReply.client_id, toolReply.client_id];
    expect(ids.every((id) => typeof id === "number")).toBe(true);
    expect(new Set(ids).size).toBe(3);
    expect(shellReply.page).toEqual({ role: "shell", page_id: "shell-page", card_id: null });
    expect(bodyReply.page).toEqual({ role: "body", page_id: "body-page", card_id: "c1" });
    expect(toolReply.page).toEqual({ role: "tool", page_id: null, card_id: null });

    const pages = (await listedPages()).filter((p) => ids.includes(p.client_id));
    expect(pages.map((p) => p.client_id)).toEqual([...(ids as number[])].sort((a, b) => a - b));
    const byId = new Map(pages.map((p) => [p.client_id, p]));
    expect(byId.get(shellReply.client_id as number)).toMatchObject({ role: "shell", page_id: "shell-page", card_id: null, sessions: null });
    expect(byId.get(bodyReply.client_id as number)).toMatchObject({ role: "body", page_id: "body-page", card_id: "c1" });
    expect(byId.get(toolReply.client_id as number)).toMatchObject({ role: "tool", page_id: null, card_id: null });

    body.close();
    await pagesUntil((ps) => !ps.some((p) => p.client_id === bodyReply.client_id), "the body to depart");
    const after = (await listedPages()).filter((p) => ids.includes(p.client_id));
    expect(after.map((p) => p.role).sort()).toEqual(["shell", "tool"]);
  });

  test("a body hello without a card is refused before the wire opens", async () => {
    const bad = page({ role: "body", page_id: "no-card" });
    bad.open();
    const closed = await bad.waitFor(() => bad.closes[0], "the server's close");
    expect(closed.closeCode).toBe(CLOSE_BAD_HANDSHAKE);
    expect(closed.closeReason).toBe("bad page identity: missing card_id");
    expect(bad.states.some((s) => s.state === "open")).toBe(false);
    bad.close();
  });
});

describe("addressed control", () => {
  test("a tell goes to the shell by default and to a card when it names one", async () => {
    const shell = page({ role: "shell", page_id: "shell-tell" });
    const body = page({ role: "body", page_id: "body-tell", card_id: "c1" });
    await Promise.all([shell.connect(), body.connect()]);

    expect((await tugcast.httpPost("/api/tell", { action: "tug-test-ping", n: 1 })).status).toBe(200);
    await shell.waitFor(() => controls(shell, "tug-test-ping").some((p) => p.n === 1), "the shell's ping");
    await laneBarrier(shell, body);
    expect(controls(body, "tug-test-ping")).toEqual([]);

    expect(
      (await tugcast.httpPost("/api/tell", { action: "tug-test-ping", n: 2, to: { card: "c1" } })).status,
    ).toBe(200);
    await body.waitFor(() => controls(body, "tug-test-ping").some((p) => p.n === 2), "the body's ping");
    await laneBarrier(shell, body);
    expect(controls(shell, "tug-test-ping").map((p) => p.n)).toEqual([1]);
  });
});

describe("eval", () => {
  test("an eval for a card is answered by that card's body alone", async () => {
    expect((await tugcast.httpPut("/api/defaults/diag/eval", { kind: "bool", value: true })).status).toBe(200);
    const shell = page({ role: "shell", page_id: "shell-eval" });
    const body = page({ role: "body", page_id: "body-eval", card_id: "c1" });
    await Promise.all([shell.connect(), body.connect()]);

    const reply = tugcast.httpPost("/api/eval", { code: "1+1", card: "c1" });
    const request = await body.waitFor(() => controls(body, "eval")[0], "the body's eval");
    expect(request.code).toBe("1+1");
    body.sendControl("eval-response", { requestId: request.requestId, result: 2 });
    const { status, body: answer } = await reply;
    expect(status).toBe(200);
    expect((answer as { result: unknown }).result).toBe(2);

    await laneBarrier(shell, body);
    expect(controls(shell, "eval")).toEqual([]);

    const missing = await tugcast.httpPost("/api/eval", { code: "1", card: "nobody" });
    expect(missing.status).toBe(503);
    expect((missing.body as { message: string }).message).toBe("no page answers card nobody");
  });
});

describe("session subscription", () => {
  test("a page subscribed to one session never receives another's frames", async () => {
    const a = page({ role: "shell", page_id: "shell-sessions" });
    const b = page({ role: "body", page_id: "body-sessions", card_id: "cB" });
    await Promise.all([a.connect(), b.connect()]);
    a.subscribe([FeedId.SESSION_STATE]);
    b.subscribe([FeedId.SESSION_STATE], ["s-b"]);

    const spawn = (card: string, session: string): void => {
      a.sendControl("spawn_session", {
        card_id: card,
        tug_session_id: session,
        project_dir: tugcast.repo,
        session_mode: "new",
        line_id: crypto.randomUUID(),
      });
    };
    const pending = (client: PageClient, session: string) => () =>
      client.frameOn(FeedId.SESSION_STATE, (j) => j.tug_session_id === session && j.state === "pending");

    // The session-feed barrier: both frames ride the one SESSION_STATE
    // channel, so once B has s-b's pending it has passed s-a's.
    spawn("cA", "s-a");
    await a.waitFor(pending(a, "s-a"), "s-a pending at A");
    spawn("cB", "s-b");
    await b.waitFor(pending(b, "s-b"), "s-b pending at B");
    expect(b.frameOn(FeedId.SESSION_STATE, (j) => j.tug_session_id === "s-a")).toBeUndefined();
    await a.waitFor(pending(a, "s-b"), "s-b pending at A, which takes every session");

    b.sendControl("feed_stats");
    const stats = await b.waitFor(
      () => b.frames.map((f) => f.json as Record<string, unknown> | undefined).find((j) => j?.type === "feed_stats"),
      "B's feed_stats",
    );
    expect(stats.sessions).toEqual(["s-b"]);
    const listed = await listedPages();
    expect(listed.find((p) => p.page_id === "body-sessions")?.sessions).toEqual(["s-b"]);
  });
});

/** The JSON of every frame a page received on `feed`. */
function jsonOn(client: PageClient, feed: number): Array<Record<string, unknown>> {
  return client.frames
    .filter((f) => f.feedId === feed && typeof f.json === "object" && f.json !== null)
    .map((f) => f.json as Record<string, unknown>);
}

/**
 * The socket-loop barrier: the router answers `feed_stats` on the same loop
 * that handled every frame the page sent before it, so once the reply is in
 * hand those frames have been forwarded — and any `input_claimed` they
 * earned has already arrived.
 */
async function socketBarrier(client: PageClient): Promise<void> {
  const before = jsonOn(client, FeedId.CONTROL).filter((j) => j.type === "feed_stats").length;
  client.sendControl("feed_stats");
  await client.waitFor(
    () => jsonOn(client, FeedId.CONTROL).filter((j) => j.type === "feed_stats").length > before || undefined,
    "the feed_stats reply",
  );
}

describe("replies", () => {
  test("each page receives only the answers to its own requests", async () => {
    const a = page({ role: "shell", page_id: "shell-replies" });
    const b = page({ role: "body", page_id: "body-replies", card_id: "cR" });
    await Promise.all([a.connect(), b.connect()]);

    const ask = async (client: PageClient, requestId: string): Promise<void> => {
      client.sendJson(FeedId.GIT_LOG_QUERY, { root: tugcast.repo, requestId });
      await client.waitFor(
        () => jsonOn(client, FeedId.GIT_LOG).find((j) => j.request_id === requestId),
        `the GIT_LOG answer to ${requestId}`,
      );
    };
    // The reply barrier: A's second answer was published after B's, on the
    // same lane, so once A has it A has passed every frame B's ask produced.
    await ask(a, "a-1");
    await ask(b, "b-1");
    await ask(a, "a-2");
    await Promise.all([socketBarrier(a), socketBarrier(b)]);

    expect(jsonOn(a, FeedId.GIT_LOG).map((j) => j.request_id)).toEqual(["a-1", "a-2"]);
    expect(jsonOn(b, FeedId.GIT_LOG).map((j) => j.request_id)).toEqual(["b-1"]);
    for (const client of [a, b]) {
      expect(client.frames.some((f) => (f.json as { type?: string } | undefined)?.type === "input_claimed")).toBe(false);
    }
  });

  test("a page's reset leaves another page's file watches in place", async () => {
    const a = page({ role: "shell", page_id: "shell-watch" });
    const b = page({ role: "body", page_id: "body-watch", card_id: "cW" });
    await Promise.all([a.connect(), b.connect()]);
    const fileA = join(tugcast.repo, "a.txt");
    const fileB = join(tugcast.repo, "b.txt");
    const framesFor = (client: PageClient, path: string) => jsonOn(client, FeedId.FILE_WATCH).filter((j) => j.path === path);

    a.sendJson(FeedId.FILE_WATCH_QUERY, { type: "watch", path: fileA });
    await a.waitFor(() => framesFor(a, fileA)[0], "A's answer for a.txt");
    b.sendJson(FeedId.FILE_WATCH_QUERY, { type: "watch", path: fileA });
    await b.waitFor(() => framesFor(b, fileA)[0], "B's answer for a.txt");
    b.sendJson(FeedId.FILE_WATCH_QUERY, { type: "reset" });
    await socketBarrier(b);
    const bSeenAtReset = framesFor(b, fileA).length;
    const aSeenBeforeWrite = framesFor(a, fileA).length;

    writeFileSync(fileA, "changed\n");
    await a.waitFor(() => framesFor(a, fileA).length > aSeenBeforeWrite || undefined, "A's frame for the write");
    // B's forced answer for b.txt is published on the FILE_WATCH lane after
    // A's a.txt frame, so once B has it B has passed anything for a.txt.
    b.sendJson(FeedId.FILE_WATCH_QUERY, { type: "watch", path: fileB });
    await b.waitFor(() => framesFor(b, fileB)[0], "B's answer for b.txt");
    expect(framesFor(b, fileA).length).toBe(bSeenAtReset);
  });
});

describe("render input", () => {
  test("each page owns RENDER_INPUT, is answered alone, and holds only its own renders", async () => {
    const a = page({ role: "shell", page_id: "shell-render" });
    const b = page({ role: "body", page_id: "body-render", card_id: "cRender" });
    await Promise.all([a.connect(), b.connect()]);
    const hellos = (client: PageClient) =>
      jsonOn(client, FeedId.RENDERED).filter(
        (j) => j.kind === "render-batch" && Array.isArray(j.sessions) && j.sessions.length === 0,
      );
    const resync = async (client: PageClient, count: number): Promise<void> => {
      client.sendJson(FeedId.RENDER_INPUT, { v: 1, kind: "resync" });
      await client.waitFor(() => hellos(client).length >= count || undefined, `hello ${count}`);
    };

    // The reply barrier, both ways: each page's later hello was published
    // after the other page's, on the same lane, so once a page has it the
    // page has passed any hello of the other's it was ever going to get.
    await resync(a, 1);
    await resync(b, 1);
    await resync(a, 2);
    await resync(b, 2);
    await Promise.all([socketBarrier(a), socketBarrier(b)]);
    expect(hellos(a).length).toBe(2);
    expect(hellos(b).length).toBe(2);
    for (const client of [a, b]) {
      expect(client.frames.some((f) => (f.json as { type?: string } | undefined)?.type === "input_claimed")).toBe(false);
    }

    // A holds its renders; B is still answered.
    a.sendJson(FeedId.RENDER_INPUT, { v: 1, kind: "motion", holder: "h1", held: true, capMs: 30_000 });
    await socketBarrier(a);
    await resync(b, 3);
    expect(hellos(b).length).toBe(3);
    expect(hellos(a).length).toBe(2);
  });
});

describe("seating", () => {
  test("a card's own page writes its session, across a reload, and another card's page does not", async () => {
    const shell = page({ role: "shell", page_id: "shell-seating" });
    await shell.connect();
    shell.subscribe([FeedId.SESSION_STATE]);
    shell.sendControl("spawn_session", {
      card_id: "cX",
      tug_session_id: "s-x",
      project_dir: tugcast.repo,
      session_mode: "new",
      line_id: crypto.randomUUID(),
    });
    await shell.waitFor(
      () => shell.frameOn(FeedId.SESSION_STATE, (j) => j.tug_session_id === "s-x" && j.state === "pending"),
      "s-x pending",
    );

    const refusals = (client: PageClient) =>
      client.frames
        .map((f) => f.json as { type?: string; detail?: string } | undefined)
        .filter(
          (j): j is { type?: string; detail?: string } =>
            j?.type === "input_claimed" || j?.detail === "session_not_owned",
        );
    // The admission answer, if any, is sent on the socket loop before the
    // feed_stats reply that follows it.
    const write = async (client: PageClient): Promise<void> => {
      client.sendJson(FeedId.CODE_INPUT, { tug_session_id: "s-x", type: "interrupt" });
      await socketBarrier(client);
    };

    const first = page({ role: "body", page_id: "body-seating-1", card_id: "cX" });
    await first.connect();
    await write(first);
    expect(refusals(first)).toEqual([]);
    first.close();

    const reloaded = page({ role: "body", page_id: "body-seating-2", card_id: "cX" });
    await reloaded.connect();
    await write(reloaded);
    expect(refusals(reloaded)).toEqual([]);

    const stranger = page({ role: "body", page_id: "body-seating-z", card_id: "cZ" });
    await stranger.connect();
    await write(stranger);
    expect(refusals(stranger).map((j) => j.detail)).toEqual(["session_not_owned"]);
  });
});

describe("bus", () => {
  test("a bus message reaches the pages its target names, stamped with its sender", async () => {
    const shell = page({ role: "shell", page_id: "shell-bus" });
    const b1 = page({ role: "body", page_id: "body-bus-1", card_id: "c1" });
    const b2 = page({ role: "body", page_id: "body-bus-2", card_id: "c2" });
    const tool = page();
    const all = [shell, b1, b2, tool];
    await Promise.all(all.map((p) => p.connect()));
    // A subscription that names no bus feed: addressing alone scopes DECK_BUS.
    for (const p of all) p.subscribe([FeedId.SESSION_STATE]);
    await Promise.all(all.map(socketBarrier));

    const bus = (p: PageClient) => jsonOn(p, FeedId.DECK_BUS);
    const refusals = (p: PageClient) =>
      jsonOn(p, FeedId.CONTROL).filter((j) => typeof j.detail === "string" && j.detail.startsWith("bus_"));
    const send = (p: PageClient, message: BusOutbound) => p.sendJson(FeedId.DECK_BUS, message);

    send(b1, {
      to: "shell",
      kind: "card-facts",
      payload: { title: "Dev", mastheadLine: null, activity: "idle", telemetry: {} },
    });
    const facts = await shell.waitFor(() => bus(shell).find((j) => j.kind === "card-facts"), "the shell's card-facts");
    expect(facts.from).toEqual({ pageId: "body-bus-1", role: "body", cardId: "c1" });

    send(shell, { to: { card: "c2" }, kind: "card-command", payload: { command: "focus-prompt" } });
    await b2.waitFor(() => bus(b2).find((j) => j.kind === "card-command"), "b2's card-command");

    send(shell, {
      to: "body",
      kind: "deck-facts",
      payload: { theme: "ironclad", zoom: 1, keyboardAccess: false, modifierLatch: [], appActive: true },
    });
    await Promise.all(
      [b1, b2].map((p) => p.waitFor(() => bus(p).find((j) => j.kind === "deck-facts"), "the bodies' deck-facts")),
    );

    await laneBarrier(...all);
    expect(bus(tool)).toEqual([]);
    expect(bus(shell).filter((j) => j.kind === "card-command")).toEqual([]);
    expect(bus(b1).filter((j) => j.kind === "card-command")).toEqual([]);

    send(tool, { to: "shell", kind: "card-advice", payload: { advice: "fold-guard", guarded: true } });
    await socketBarrier(tool);
    expect(refusals(tool).map((j) => j.detail)).toEqual(["bus_refused"]);

    send(b1, { to: { card: "nobody" }, kind: "card-command", payload: { command: "interrupt" } });
    await socketBarrier(b1);
    expect(refusals(b1)).toEqual([{ type: "error", detail: "bus_undeliverable", to: { card: "nobody" } }]);
  });
});
