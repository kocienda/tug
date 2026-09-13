import { describe, test, expect } from "bun:test";
import {
  CONTROL_ACTION_CLOSE_SESSION,
  CONTROL_ACTION_RESET_SESSION,
  CONTROL_ACTION_SPAWN_SESSION,
  FEED_ID_SESSION_STATE,
  FeedId,
  FrameFlags,
  HEADER_SIZE,
  MAX_PAYLOAD_SIZE,
  controlFrame,
  decodeFrame,
  encodeCloseSession,
  encodeCodeInput,
  encodeFrame,
  encodeOverviewInput,
  encodeResetSession,
  encodeSpawnSession,
  isControlFrame,
  normalizeSessionRow,
  parseActivityFrame,
  parseDigestFrame,
} from "../protocol";

const encode = (obj: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(obj));

describe("parseActivityFrame", () => {
  test("maps rate channels 1:1 and keeps the session id", () => {
    const f = parseActivityFrame(
      encode({
        tug_session_id: "sess-abc",
        channels: { text: 312, tokens: 47, tools: 1 },
      }),
    );
    expect(f).toEqual({
      tug_session_id: "sess-abc",
      channels: { text: 312, tokens: 47, tools: 1 },
    });
  });

  test("normalizes gauge wire keys and folds disk read+write", () => {
    const f = parseActivityFrame(
      encode({
        tug_session_id: "s",
        channels: {
          cpu_pct: 143.2,
          rss_bytes: 512_000_000,
          disk_read_bps: 1000,
          disk_write_bps: 250,
        },
      }),
    );
    expect(f?.channels).toEqual({
      cpu: 143.2,
      memory: 512_000_000,
      disk: 1250,
    });
  });

  test("rejects session-less, channel-less, and malformed frames", () => {
    expect(parseActivityFrame(encode({ channels: { text: 1 } }))).toBeNull();
    expect(
      parseActivityFrame(encode({ tug_session_id: "s", channels: {} })),
    ).toBeNull();
    expect(
      parseActivityFrame(encode({ tug_session_id: "s", channels: { text: "x" } })),
    ).toBeNull();
    expect(parseActivityFrame(new TextEncoder().encode("not json"))).toBeNull();
  });
});

describe("controlFrame", () => {
  test("restart produces correct feedId and payload", () => {
    const frame = controlFrame("restart");
    expect(frame.feedId).toBe(0xc0);
    const payload = JSON.parse(new TextDecoder().decode(frame.payload));
    expect(payload).toEqual({ action: "restart" });
  });

  test("reset produces correct feedId and payload", () => {
    const frame = controlFrame("reset");
    expect(frame.feedId).toBe(0xc0);
    const payload = JSON.parse(new TextDecoder().decode(frame.payload));
    expect(payload).toEqual({ action: "reset" });
  });

  test("round-trip restart through encode/decode", () => {
    const original = controlFrame("restart");
    const encoded = encodeFrame(original);
    const decoded = decodeFrame(encoded);
    expect(decoded.feedId).toBe(original.feedId);
    expect(decoded.flags).toBe(FrameFlags.DATA);
    expect(new TextDecoder().decode(decoded.payload)).toBe(
      new TextDecoder().decode(original.payload)
    );
  });
});

describe("wire format v1", () => {
  test("header size is 6 bytes", () => {
    expect(HEADER_SIZE).toBe(6);
  });

  test("max payload is 16 MB", () => {
    expect(MAX_PAYLOAD_SIZE).toBe(16 * 1024 * 1024);
  });

  test("golden: terminal output 'hello'", () => {
    const frame = {
      feedId: FeedId.TERMINAL_OUTPUT as (typeof FeedId)[keyof typeof FeedId],
      flags: FrameFlags.DATA,
      payload: new TextEncoder().encode("hello"),
    };
    const encoded = encodeFrame(frame);
    const bytes = new Uint8Array(encoded);
    // [0x00] FeedId  [0x00] flags  [0x00,0x00,0x00,0x05] length  "hello"
    expect(bytes).toEqual(
      new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f])
    );
  });

  test("golden: heartbeat empty", () => {
    const frame = {
      feedId: FeedId.HEARTBEAT as (typeof FeedId)[keyof typeof FeedId],
      flags: FrameFlags.DATA,
      payload: new Uint8Array(0),
    };
    const encoded = encodeFrame(frame);
    const bytes = new Uint8Array(encoded);
    // [0xFF] FeedId  [0x00] flags  [0x00,0x00,0x00,0x00] length
    expect(bytes).toEqual(new Uint8Array([0xff, 0x00, 0x00, 0x00, 0x00, 0x00]));
  });

  test("flags byte: data vs control", () => {
    expect(isControlFrame(FrameFlags.DATA)).toBe(false);
    expect(isControlFrame(FrameFlags.CONTROL)).toBe(true);
    // Unknown bits ignored for kind determination
    expect(isControlFrame(0xfe)).toBe(false); // bit 0 = 0
    expect(isControlFrame(0xff)).toBe(true);  // bit 0 = 1
  });

  test("decode preserves flags", () => {
    const frame = {
      feedId: FeedId.CODE_OUTPUT as (typeof FeedId)[keyof typeof FeedId],
      flags: FrameFlags.CONTROL,
      payload: new TextEncoder().encode('{"type":"lag_recovery"}'),
    };
    const encoded = encodeFrame(frame);
    const decoded = decodeFrame(encoded);
    expect(decoded.feedId).toBe(FeedId.CODE_OUTPUT);
    expect(decoded.flags).toBe(FrameFlags.CONTROL);
    expect(isControlFrame(decoded.flags)).toBe(true);
  });

  test("unknown FeedId round-trips", () => {
    const frame = {
      feedId: 0x99 as (typeof FeedId)[keyof typeof FeedId],
      flags: FrameFlags.DATA,
      payload: new TextEncoder().encode("opaque"),
    };
    const encoded = encodeFrame(frame);
    const decoded = decodeFrame(encoded);
    expect(decoded.feedId).toBe(0x99 as typeof decoded.feedId);
    expect(new TextDecoder().decode(decoded.payload)).toBe("opaque");
  });
});

describe("session protocol constants", () => {
  test("FEED_ID_SESSION_STATE is 0x52", () => {
    expect(FEED_ID_SESSION_STATE).toBe(0x52);
    expect(FeedId.SESSION_STATE).toBe(0x52);
  });

  test("CONTROL_ACTION_* names match supervisor expectations", () => {
    expect(CONTROL_ACTION_SPAWN_SESSION).toBe("spawn_session");
    expect(CONTROL_ACTION_CLOSE_SESSION).toBe("close_session");
    expect(CONTROL_ACTION_RESET_SESSION).toBe("reset_session");
  });
});

describe("encodeCodeInput", () => {
  test("injects tug_session_id as the first field of the JSON payload", () => {
    // Plan: the supervisor's dispatcher parses `tug_session_id` from the
    // CODE_INPUT payload to route the frame to the right per-session
    // worker. The field must be present on every CODE_INPUT emission —
    // tugcast's router hard-rejects missing-session payloads per Step 7
    // (`missing_tug_session_id` CONTROL error).
    const buffer = encodeCodeInput(
      { type: "user_text", text: "hi" },
      "abc-123",
    );
    const frame = decodeFrame(buffer);
    expect(frame.feedId).toBe(FeedId.CODE_INPUT);
    const jsonStr = new TextDecoder().decode(frame.payload);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.tug_session_id).toBe("abc-123");
    expect(parsed.type).toBe("user_text");
    expect(parsed.text).toBe("hi");

    // The spec says tug_session_id is the FIRST field of the payload.
    // Walk the stringified JSON to assert ordering (serde on the Rust
    // side doesn't care about order but some test-side assertions and
    // log inspections are friendlier when ordering is stable).
    const firstKeyMatch = /^\{"([^"]+)"/.exec(jsonStr);
    expect(firstKeyMatch).not.toBeNull();
    expect(firstKeyMatch![1]).toBe("tug_session_id");
  });
});

describe("session CONTROL frame builders", () => {
  function parsePayload(frame: { feedId: number; payload: Uint8Array }) {
    return JSON.parse(new TextDecoder().decode(frame.payload));
  }

  test("encodeSpawnSession produces a CONTROL frame with card_id, tug_session_id, project_dir, and session_mode (default new)", () => {
    const frame = encodeSpawnSession("card-1", "sess-1", "/work/alpha");
    expect(frame.feedId).toBe(FeedId.CONTROL);
    expect(frame.flags).toBe(FrameFlags.DATA);
    const payload = parsePayload(frame);
    expect(payload).toEqual({
      action: "spawn_session",
      card_id: "card-1",
      tug_session_id: "sess-1",
      project_dir: "/work/alpha",
      session_mode: "new",
    });
  });

  test("encodeSpawnSession with session_mode=resume emits the resume variant", () => {
    // Roadmap step 4.5.
    const frame = encodeSpawnSession("card-1", "sess-1", "/work/alpha", "resume");
    const payload = parsePayload(frame);
    expect(payload.session_mode).toBe("resume");
  });

  test("encodeSpawnSession forwards permission_mode when provided", () => {
    const frame = encodeSpawnSession("card-1", "sess-1", "/work/alpha", "new", "plan");
    const payload = parsePayload(frame);
    expect(payload.permission_mode).toBe("plan");
  });

  test("encodeSpawnSession omits permission_mode when not provided", () => {
    const frame = encodeSpawnSession("card-1", "sess-1", "/work/alpha");
    const payload = parsePayload(frame);
    expect("permission_mode" in payload).toBe(false);
  });

  test("encodeSpawnSession forwards tag when provided", () => {
    const frame = encodeSpawnSession(
      "card-1",
      "sess-1",
      "/work/alpha",
      "new",
      undefined,
      "azure-heron",
    );
    const payload = parsePayload(frame);
    expect(payload.tag).toBe("azure-heron");
  });

  test("encodeSpawnSession omits tag when not provided", () => {
    const frame = encodeSpawnSession("card-1", "sess-1", "/work/alpha");
    const payload = parsePayload(frame);
    expect("tag" in payload).toBe(false);
  });

  test("encodeCloseSession produces a CONTROL frame with card_id and tug_session_id", () => {
    const frame = encodeCloseSession("card-1", "sess-1");
    expect(frame.feedId).toBe(FeedId.CONTROL);
    const payload = parsePayload(frame);
    expect(payload).toEqual({
      action: "close_session",
      card_id: "card-1",
      tug_session_id: "sess-1",
    });
  });

  test("encodeResetSession produces a CONTROL frame with card_id and tug_session_id", () => {
    const frame = encodeResetSession("card-1", "sess-1");
    expect(frame.feedId).toBe(FeedId.CONTROL);
    const payload = parsePayload(frame);
    expect(payload).toEqual({
      action: "reset_session",
      card_id: "card-1",
      tug_session_id: "sess-1",
    });
  });

  test("encodeRequestReplay produces a CONTROL frame with tug_session_id only ([D12])", async () => {
    // request_replay is addressed by tug-side session id alone; no
    // card_id (the verb is dispatch-side bookkeeping) and no
    // project_dir (supervisor knows the workspace from the ledger).
    const { encodeRequestReplay, CONTROL_ACTION_REQUEST_REPLAY } = await import(
      "../protocol"
    );
    expect(CONTROL_ACTION_REQUEST_REPLAY).toBe("request_replay");
    const frame = encodeRequestReplay("sess-r1");
    expect(frame.feedId).toBe(FeedId.CONTROL);
    expect(frame.flags).toBe(FrameFlags.DATA);
    const payload = parsePayload(frame);
    expect(payload).toEqual({
      action: "request_replay",
      tug_session_id: "sess-r1",
    });
  });
});

describe("normalizeSessionRow tag", () => {
  const base = {
    session_id: "s1",
    workspace_key: "ws-1",
    project_dir: "/proj",
    created_at: 1,
    last_used_at: 2,
    turn_count: 0,
    last_user_prompt: null,
    state: "live" as const,
    card_id: null,
    name: null,
  };

  test("defaults tag to null when the field is absent", () => {
    expect(normalizeSessionRow(base).tag).toBe(null);
  });

  test("passes tag through when present", () => {
    expect(normalizeSessionRow({ ...base, tag: "azure-heron" }).tag).toBe("azure-heron");
  });
});

describe("session ledger CONTROL encoders / decoders", () => {
  function parsePayload(frame: { feedId: number; payload: Uint8Array }) {
    return JSON.parse(new TextDecoder().decode(frame.payload));
  }

  test("encodeListSessions produces a CONTROL frame with project_dir", async () => {
    const { encodeListSessions } = await import("../protocol");
    const frame = encodeListSessions("/proj/alpha");
    expect(frame.feedId).toBe(FeedId.CONTROL);
    const payload = parsePayload(frame);
    expect(payload).toEqual({
      action: "list_sessions",
      project_dir: "/proj/alpha",
    });
  });

  test("encodeTrashSession produces a CONTROL frame with session_id", async () => {
    const { encodeTrashSession } = await import("../protocol");
    const frame = encodeTrashSession("sess-abc");
    expect(frame.feedId).toBe(FeedId.CONTROL);
    const payload = parsePayload(frame);
    expect(payload).toEqual({
      action: "trash_session",
      session_id: "sess-abc",
    });
  });


  test("decodeSessionUpdated returns row payload for full update", async () => {
    const { decodeSessionUpdated } = await import("../protocol");
    const decoded = decodeSessionUpdated({
      action: "session_updated",
      session_id: "sess-abc",
      fields: {
        session_id: "sess-abc",
        line_id: "line-abc",
        workspace_key: "ws-1",
        project_dir: "/proj",
        created_at: 1,
        last_used_at: 2,
        turn_count: 0,
        last_user_prompt: null,
        state: "live",
        card_id: "card-1",
        name: null,
      },
    });
    expect(decoded).toEqual({
      session_id: "sess-abc",
      fields: {
        session_id: "sess-abc",
        line_id: "line-abc",
        workspace_key: "ws-1",
        project_dir: "/proj",
        created_at: 1,
        last_used_at: 2,
        turn_count: 0,
        last_user_prompt: null,
        state: "live",
        card_id: "card-1",
        name: null,
        // Bare ledger-row pushes never carry origin/terminal_live/file_size/
        // name_user_set/tag/lineage/synopsis/private/background; the decoder
        // normalizes them to the tug/not-live/no-size/not-user-set/no-tag/
        // root-session/no-description/public/deck-held defaults.
        origin: "tug",
        terminal_live: null,
        file_size: null,
        name_user_set: false,
        tag: null,
        synopsis: null,
        private: false,
        background: false,
      },
    });
  });

  test("decodeSessionUpdated preserves explicit origin and terminal_live", async () => {
    const { decodeSessionUpdated } = await import("../protocol");
    const decoded = decodeSessionUpdated({
      action: "session_updated",
      session_id: "sess-ext",
      fields: {
        session_id: "sess-ext",
        workspace_key: "ws-1",
        project_dir: "/proj",
        created_at: 1,
        last_used_at: 2,
        turn_count: 3,
        last_user_prompt: "hi",
        state: "closed",
        card_id: null,
        name: null,
        origin: "external",
        terminal_live: { status: "busy" },
      },
    });
    expect(decoded?.fields?.origin).toBe("external");
    expect(decoded?.fields?.terminal_live).toEqual({ status: "busy" });
  });

  test("decodeSessionUpdated returns removed marker for delete push", async () => {
    const { decodeSessionUpdated } = await import("../protocol");
    const decoded = decodeSessionUpdated({
      action: "session_updated",
      session_id: "sess-abc",
      removed: true,
    });
    expect(decoded).toEqual({ session_id: "sess-abc", removed: true });
  });

  test("decodeSessionUpdated returns null for wrong action", async () => {
    const { decodeSessionUpdated } = await import("../protocol");
    expect(decodeSessionUpdated({ action: "spawn_session_ok" })).toBeNull();
    expect(decodeSessionUpdated({ session_id: "sess-abc" })).toBeNull();
    expect(decodeSessionUpdated(null)).toBeNull();
    expect(decodeSessionUpdated({ action: "session_updated" })).toBeNull();
  });

  test("decodeResolveSessionsOk keys hits by the asked-for spelling", async () => {
    const { decodeResolveSessionsOk } = await import("../protocol");
    const full = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
    const decoded = decodeResolveSessionsOk({
      action: "resolve_sessions_ok",
      sessions: [
        {
          // A citation's 8-char token; the row it names is the full id.
          queried: "f6e43925",
          session: {
            session_id: full,
            workspace_key: "ws-1",
            project_dir: "/proj",
            created_at: 1,
            last_used_at: 2,
            turn_count: 3,
            last_user_prompt: null,
            state: "closed",
            card_id: null,
            name: null,
            tag: "stocky-pixie",
          },
        },
      ],
      unknown: ["0badf00d"],
    });
    expect(decoded?.found).toHaveLength(1);
    expect(decoded?.found[0]?.queried).toBe("f6e43925");
    expect(decoded?.found[0]?.session.session_id).toBe(full);
    expect(decoded?.found[0]?.session.tag).toBe("stocky-pixie");
    // Bare rows carry no origin/lineage/synopsis; the row normalizer fills the
    // same defaults it does for a listing.
    expect(decoded?.found[0]?.session.origin).toBe("tug");
    expect(decoded?.found[0]?.session.synopsis).toBeNull();
    // The miss is carried through — it is the answer that lets a caller stop
    // asking.
    expect(decoded?.unknown).toEqual(["0badf00d"]);
  });

  test("decodeResolveSessionsOk drops a bad entry rather than the whole frame", async () => {
    const { decodeResolveSessionsOk } = await import("../protocol");
    const decoded = decodeResolveSessionsOk({
      action: "resolve_sessions_ok",
      // No `queried`, no `session`, and a non-string miss: a partial answer
      // resolves what it can, because discarding every answer over one bad row
      // would leave every chip on the surface pending forever.
      sessions: [{ session: {} }, { queried: "abc" }, null],
      unknown: ["0badf00d", 7],
    });
    expect(decoded?.found).toEqual([]);
    expect(decoded?.unknown).toEqual(["0badf00d"]);
  });

  test("decodeResolveSessionsOk returns null for wrong action, and empty for a bare ok", async () => {
    const { decodeResolveSessionsOk } = await import("../protocol");
    expect(decodeResolveSessionsOk({ action: "session_updated" })).toBeNull();
    expect(decodeResolveSessionsOk(null)).toBeNull();
    expect(decodeResolveSessionsOk({ action: "resolve_sessions_ok" })).toEqual({
      found: [],
      unknown: [],
    });
  });
});

describe("parseDigestFrame", () => {
  const encode = (body: Record<string, unknown>): Uint8Array =>
    new TextEncoder().encode(JSON.stringify(body));

  test("a beat decodes with its scopes and counters", () => {
    const line = parseDigestFrame(
      encode({ type: "digest", text: "reading files", scopes: ["s1"], beat: 3, at: 9 }),
    );
    expect(line?.text).toBe("reading files");
    expect(line?.scopes).toEqual(["s1"]);
    expect(line?.beat).toBe(3);
  });

  test("a field the deck does not know is ignored, not fatal", () => {
    const line = parseDigestFrame(
      encode({ type: "digest", prophecy: "soon", text: "hm", scopes: [], beat: 0, at: 0 }),
    );
    expect(line?.text).toBe("hm");
    expect(line && "prophecy" in line).toBe(false);
  });

  test("the kind rides through — it is what tells an ask from a tool line", () => {
    const line = parseDigestFrame(
      encode({ type: "digest", kind: "ask", text: "asked: go", scopes: ["s1"], beat: 1, at: 2 }),
    );
    expect(line?.kind).toBe("ask");
    // Absent on a frame that carries none, rather than an empty string: the
    // store spreads it conditionally and an empty kind is not a kind.
    const bare = parseDigestFrame(
      encode({ type: "digest", text: "hm", scopes: [], beat: 0, at: 0 }),
    );
    expect(bare && "kind" in bare).toBe(false);
  });
});

describe("encodeOverviewInput", () => {
  const body = (frame: { payload: Uint8Array }): string =>
    new TextDecoder().decode(frame.payload);

  test("a question with no pictures and no atoms is the payload it always was", () => {
    expect(body(encodeOverviewInput("what landed", "req-1"))).toBe(
      JSON.stringify({ body: "what landed", requestId: "req-1" }),
    );
    // Explicit empties are the same frame — a composer that always passes both
    // arrays must not widen the wire.
    expect(body(encodeOverviewInput("what landed", "req-1", [], []))).toBe(
      JSON.stringify({ body: "what landed", requestId: "req-1" }),
    );
  });

  test("the files the asker pointed at ride beside the body", () => {
    const payload = JSON.parse(
      body(
        encodeOverviewInput("what does it say", "req-2", [], [
          { kind: "file", target: "tuglaws/design-decisions.md" },
        ]),
      ),
    );
    expect(payload.refs).toEqual([
      { kind: "file", target: "tuglaws/design-decisions.md" },
    ]);
    expect(payload.attachments).toBeUndefined();
  });

  test("pictures and atoms travel together without displacing each other", () => {
    const payload = JSON.parse(
      body(
        encodeOverviewInput(
          "what is this",
          "req-3",
          [{ mediaType: "image/png", data: "AAAA" }],
          [{ kind: "file", target: "a.txt" }],
        ),
      ),
    );
    expect(payload.attachments).toHaveLength(1);
    expect(payload.refs).toHaveLength(1);
  });
});
