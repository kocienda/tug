/**
 * session-metadata-store unit tests.
 *
 * Tests cover:
 * - Store starts with null snapshot fields and empty slashCommands array.
 * - Subscribing to a FeedStore that emits a system_metadata payload updates the snapshot correctly.
 * - getCommandCompletionProvider() matches and ranks commands by query.
 * - Entries without a name string are skipped during parse.
 * - Subscribers are notified on metadata change; not notified on duplicate reference.
 */

import { describe, test, expect } from "bun:test";
import { SessionMetadataStore } from "../lib/session-metadata-store";
import type { SessionMetadataSnapshot } from "../lib/session-metadata-store";

// ---------------------------------------------------------------------------
// Mock FeedStore
// ---------------------------------------------------------------------------

/**
 * A minimal FeedStore-compatible mock.
 * Holds a Map<number, unknown> and notifies listeners on emit().
 */
class MockFeedStore {
  private _data: Map<number, unknown> = new Map();
  private _listeners: Array<() => void> = [];

  subscribe(listener: () => void): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  }

  getSnapshot(): Map<number, unknown> {
    return this._data;
  }

  /** Emit a new payload for the given feedId and notify all listeners. */
  emit(feedId: number, payload: unknown): void {
    const next = new Map(this._data);
    next.set(feedId, payload);
    this._data = next;
    for (const listener of this._listeners) {
      listener();
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FEED_ID = 0x40; // CODE_OUTPUT

function makeMetadataPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "system_metadata",
    session_id: "sess-abc-123",
    model: "claude-3-opus",
    // Wire emits camelCase per `tugcode/src/session.ts:498,517`.
    permissionMode: "default",
    cwd: "/home/user/project",
    version: "2.1.105",
    slash_commands: [
      { name: "help", description: "Show help", category: "local" },
      { name: "commit", description: "Commit changes", category: "local" },
    ],
    skills: [
      { name: "summarize", description: "Summarize content", category: "skill" },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: initial state
// ---------------------------------------------------------------------------

describe("SessionMetadataStore initial state", () => {
  test("starts with null snapshot fields and empty slashCommands", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    const snap = store.getSnapshot();
    expect(snap.sessionId).toBeNull();
    expect(snap.model).toBeNull();
    expect(snap.permissionMode).toBeNull();
    expect(snap.cwd).toBeNull();
    expect(snap.version).toBeNull();
    expect(snap.slashCommands).toEqual([]);

    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// Tests: payload parsing
// ---------------------------------------------------------------------------

describe("SessionMetadataStore payload parsing", () => {
  test("updates snapshot when FeedStore emits a system_metadata payload", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    feedStore.emit(FEED_ID, makeMetadataPayload());

    const snap: SessionMetadataSnapshot = store.getSnapshot();
    expect(snap.sessionId).toBe("sess-abc-123");
    expect(snap.model).toBe("claude-3-opus");
    expect(snap.permissionMode).toBe("default");
    expect(snap.cwd).toBe("/home/user/project");
    expect(snap.version).toBe("2.1.105");

    // slash_commands + skills merged
    expect(snap.slashCommands).toHaveLength(3);
    expect(snap.slashCommands[0].name).toBe("help");
    expect(snap.slashCommands[0].category).toBe("local");
    expect(snap.slashCommands[2].name).toBe("summarize");
    expect(snap.slashCommands[2].category).toBe("skill");

    store.dispose();
  });

  test("an empty-string model normalizes to null (not the 200K unknown default)", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    feedStore.emit(FEED_ID, makeMetadataPayload({ model: "" }));
    // Empty-string is "no signal", not a model — must read as null so the
    // CONTEXT denominator falls back honestly rather than resolving
    // `resolveModelContextMax("")` to 200K.
    expect(store.getSnapshot().model).toBeNull();

    store.dispose();
  });

  test("a later empty-model frame does NOT clobber a resolved model ([P06])", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    // The replay synth delivers the real active model…
    feedStore.emit(FEED_ID, makeMetadataPayload({ model: "claude-opus-4-8" }));
    expect(store.getSnapshot().model).toBe("claude-opus-4-8");

    // …then a live re-init (or stale durable replay) arrives with an empty
    // model. The resolved model must survive — the reconstructed/active model
    // wins over a blank one.
    feedStore.emit(FEED_ID, makeMetadataPayload({ model: "" }));
    expect(store.getSnapshot().model).toBe("claude-opus-4-8");

    store.dispose();
  });

  test("a real model change replaces (active = last real model, [P09])", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    // Mid-session switch opus → sonnet: each is a real model, so the latest
    // wins. The no-clobber rule only blocks BLANK incoming, never a real
    // change.
    feedStore.emit(FEED_ID, makeMetadataPayload({ model: "claude-opus-4-8" }));
    expect(store.getSnapshot().model).toBe("claude-opus-4-8");

    feedStore.emit(FEED_ID, makeMetadataPayload({ model: "claude-sonnet-4-6" }));
    expect(store.getSnapshot().model).toBe("claude-sonnet-4-6");

    store.dispose();
  });

  test("version is null when the payload carries no string version", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    feedStore.emit(FEED_ID, makeMetadataPayload({ version: 42 }));
    expect(store.getSnapshot().version).toBeNull();

    feedStore.emit(FEED_ID, makeMetadataPayload({ version: undefined }));
    expect(store.getSnapshot().version).toBeNull();

    store.dispose();
  });

  test("ignores payloads with type other than system_metadata", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    feedStore.emit(FEED_ID, { type: "other_event", session_id: "should-not-appear" });

    const snap = store.getSnapshot();
    expect(snap.sessionId).toBeNull();

    store.dispose();
  });

  test("entries without a name string are skipped during parse", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    feedStore.emit(FEED_ID, makeMetadataPayload({
      slash_commands: [
        { name: "valid", description: "ok" },
        { description: "no name" },        // missing name
        { name: "", description: "empty" }, // empty name
        { name: 42 },                        // non-string name
        null,                                // null entry
      ],
      skills: [],
    }));

    const snap = store.getSnapshot();
    expect(snap.slashCommands).toHaveLength(1);
    expect(snap.slashCommands[0].name).toBe("valid");

    store.dispose();
  });

  test("defaults category to local when absent or unrecognized", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    feedStore.emit(FEED_ID, makeMetadataPayload({
      slash_commands: [
        { name: "no-cat" },
        { name: "bad-cat", category: "unknown-value" },
      ],
      skills: [],
    }));

    const snap = store.getSnapshot();
    expect(snap.slashCommands[0].category).toBe("local");
    expect(snap.slashCommands[1].category).toBe("local");

    store.dispose();
  });

  // ── Bare string entries (real v2.1.105 payload shape) ──────────────────

  test("accepts bare string entries in slash_commands, skills, agents", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    feedStore.emit(FEED_ID, {
      type: "system_metadata",
      slash_commands: ["update-config", "commit"],
      skills: ["tugplug:plan", "tugplug:implement"],
      agents: ["tugplug:coder-agent", "statusline-setup"],
    });

    const snap = store.getSnapshot();
    const names = snap.slashCommands.map((c) => c.name).sort();
    expect(names).toEqual([
      "commit",
      "statusline-setup",
      "tugplug:coder-agent",
      "tugplug:implement",
      "tugplug:plan",
      "update-config",
    ]);

    store.dispose();
  });

  test("rejects empty-string entries", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    feedStore.emit(FEED_ID, {
      type: "system_metadata",
      slash_commands: ["", "valid", ""],
      skills: [],
      agents: [],
    });

    const snap = store.getSnapshot();
    expect(snap.slashCommands).toHaveLength(1);
    expect(snap.slashCommands[0].name).toBe("valid");

    store.dispose();
  });

  // ── Agents merge ───────────────────────────────────────────────────────

  test("merges agents[] with category 'agent'", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    feedStore.emit(FEED_ID, {
      type: "system_metadata",
      slash_commands: [],
      skills: [],
      agents: ["general-purpose", "tugplug:coder-agent"],
    });

    const snap = store.getSnapshot();
    const byName = new Map(snap.slashCommands.map((c) => [c.name, c]));
    expect(byName.get("general-purpose")?.category).toBe("agent");
    expect(byName.get("tugplug:coder-agent")?.category).toBe("agent");

    store.dispose();
  });

  // ── Dedup across slash_commands / skills / agents ──────────────────────

  test("dedupes by name; skill/agent categories win over local", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    // Mirrors the real v2.1.105 overlap: every tugplug skill appears in
    // both slash_commands (category "local") and skills (category "skill").
    feedStore.emit(FEED_ID, {
      type: "system_metadata",
      slash_commands: ["tugplug:plan", "commit"],
      skills: ["tugplug:plan"],
      agents: ["tugplug:coder-agent"],
    });

    const snap = store.getSnapshot();
    const byName = new Map(snap.slashCommands.map((c) => [c.name, c]));
    // Deduped — `tugplug:plan` appears exactly once.
    expect(snap.slashCommands).toHaveLength(3);
    // `tugplug:plan` inherits the skill category (richer than local).
    expect(byName.get("tugplug:plan")?.category).toBe("skill");
    // Entries that only appear once retain their source category.
    expect(byName.get("commit")?.category).toBe("local");
    expect(byName.get("tugplug:coder-agent")?.category).toBe("agent");

    store.dispose();
  });

  test("dedup preserves the first richer-category entry on ties", () => {
    // Skills and agents both rank above local; if both appear for the same
    // name, whichever is encountered first wins (skills[] is parsed before
    // agents[]). This is a defensive ordering note, not a product choice;
    // real payloads don't collide skill/agent on the same name.
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    feedStore.emit(FEED_ID, {
      type: "system_metadata",
      slash_commands: [],
      skills: ["thing"],
      agents: ["thing"],
    });

    const snap = store.getSnapshot();
    expect(snap.slashCommands).toHaveLength(1);
    expect(snap.slashCommands[0].category).toBe("skill");

    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// Tests: subscriber notifications
// ---------------------------------------------------------------------------

describe("SessionMetadataStore subscriber notifications", () => {
  test("notifies subscribers when metadata changes", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    let callCount = 0;
    store.subscribe(() => { callCount++; });

    feedStore.emit(FEED_ID, makeMetadataPayload());
    expect(callCount).toBe(1);

    store.dispose();
  });

  test("does not notify subscribers on duplicate reference", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    let callCount = 0;
    store.subscribe(() => { callCount++; });

    // Emit once — reference is new
    const payload = makeMetadataPayload();
    feedStore.emit(FEED_ID, payload);
    expect(callCount).toBe(1);

    // Manually trigger a listener call without changing the payload reference.
    // We simulate this by calling the feedStore emit with a different feedId
    // (so the CODE_OUTPUT entry in the map stays the same reference).
    feedStore.emit(0x99, { type: "irrelevant" });
    // The store reads feedId 0x40 — same payload reference as before — so no notify.
    expect(callCount).toBe(1);

    store.dispose();
  });

  test("unsubscribe stops notifications", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    let callCount = 0;
    const unsub = store.subscribe(() => { callCount++; });
    unsub();

    feedStore.emit(FEED_ID, makeMetadataPayload());
    expect(callCount).toBe(0);

    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// Tests: getCommandCompletionProvider
// ---------------------------------------------------------------------------

describe("SessionMetadataStore getCommandCompletionProvider", () => {
  test("returns empty array when no commands loaded", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);
    const provider = store.getCommandCompletionProvider();

    const results = provider("help");
    expect(results).toEqual([]);

    store.dispose();
  });

  test("returns all commands when query is empty string", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);
    feedStore.emit(FEED_ID, makeMetadataPayload());

    const provider = store.getCommandCompletionProvider();
    const results = provider("");
    expect(results).toHaveLength(3);

    store.dispose();
  });

  test("filters commands by case-insensitive substring match", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);
    feedStore.emit(FEED_ID, makeMetadataPayload());

    const provider = store.getCommandCompletionProvider();

    // "com" matches "commit"
    const results1 = provider("com");
    expect(results1).toHaveLength(1);
    expect(results1[0].label).toBe("commit");
    // The command's description rides the completion item so the popup can
    // render it in its second column.
    expect(results1[0].description).toBe("Commit changes");

    // "HELP" (uppercase) matches "help"
    const results2 = provider("HELP");
    expect(results2).toHaveLength(1);
    expect(results2[0].label).toBe("help");

    // "ize" matches "summarize"
    const results3 = provider("ize");
    expect(results3).toHaveLength(1);
    expect(results3[0].label).toBe("summarize");

    // "xyz" matches nothing
    const results4 = provider("xyz");
    expect(results4).toHaveLength(0);

    store.dispose();
  });

  test("ranks a prefix match above a word-boundary match", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);
    feedStore.emit(
      FEED_ID,
      makeMetadataPayload({
        slash_commands: [
          { name: "fewer-permission-prompts", description: "skill", category: "skill" },
          { name: "permissions", description: "rules", category: "local" },
        ],
      }),
    );

    const provider = store.getCommandCompletionProvider();
    const results = provider("permi");

    // Both match, but `permissions` is a prefix hit and must rank first —
    // not the alphabetically-earlier `fewer-permission-prompts`.
    expect(results.map((r) => r.label)).toEqual([
      "permissions",
      "fewer-permission-prompts",
    ]);
    // And the matched span is highlighted (mirrors the @-file popup).
    expect(results[0].matches).toEqual([[0, 5]]);

    store.dispose();
  });

  test("matches a non-contiguous subsequence (fzf-feel)", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);
    feedStore.emit(FEED_ID, makeMetadataPayload());

    const provider = store.getCommandCompletionProvider();
    // "smrz" is a subsequence of "summarize" but not a substring.
    const results = provider("smrz");
    expect(results.map((r) => r.label)).toEqual(["summarize"]);

    store.dispose();
  });

  test("completion items have atom.type = command", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);
    feedStore.emit(FEED_ID, makeMetadataPayload());

    const provider = store.getCommandCompletionProvider();
    const results = provider("help");
    expect(results).toHaveLength(1);
    expect(results[0].atom.type).toBe("command");
    expect(results[0].atom.kind).toBe("atom");

    store.dispose();
  });

  test("provider reads updated snapshot after metadata changes", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    const provider = store.getCommandCompletionProvider();

    // Before metadata arrives
    expect(provider("help")).toHaveLength(0);

    // After metadata arrives
    feedStore.emit(FEED_ID, makeMetadataPayload());
    expect(provider("help")).toHaveLength(1);

    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// Tests: wire-format key contract
// ---------------------------------------------------------------------------
//
// The merge that defends against replay-synthesized clobbering now
// lives in the Rust supervisor's bridge intercept — every outbound
// `system_metadata` line is merged against the persisted ledger row
// before reaching the client. Tugdeck wholesale-replaces from the
// wire because the wire is authoritative. The contract this end of
// the pipe has to honor is "the parser reads the keys Claude actually
// emits"; the no-downgrade behavior is pinned in Rust.

describe("SessionMetadataStore wire-key parsing", () => {
  test("captures permissionMode from the camelCase wire key", () => {
    // The wire emits `permissionMode` (camelCase) per
    // `tugcode/src/session.ts:498,517`. The parser previously read
    // `permission_mode` (snake_case) and silently returned null for
    // every live payload; that bug stayed latent for as long as no
    // consumer rendered the field. Pin the correct wire key.
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    feedStore.emit(FEED_ID, makeMetadataPayload({ permissionMode: "plan" }));

    expect(store.getSnapshot().permissionMode).toBe("plan");

    store.dispose();
  });
});

describe("SessionMetadataStore handshake command catalog (from the drop)", () => {
  // The turn-free `initialize` handshake (`session_capabilities`) carries the
  // command catalog as `commands` — available before any turn. Capturing it
  // is what makes the slash-command filter + unknown-command detection work
  // on the very first input ([#step-13a]), rather than waiting for a
  // post-turn `system_metadata`.
  test("session_capabilities `commands` populates slashCommands from the drop", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    feedStore.emit(FEED_ID, {
      type: "session_capabilities",
      models: [{ value: "default", displayName: "Default" }],
      commands: [
        { name: "init" },
        { name: "compact", description: "compact the context" },
        { name: "tugplug:commit" },
      ],
    });

    const snap = store.getSnapshot();
    expect(snap.slashCommands.map((c) => c.name)).toEqual([
      "init",
      "compact",
      "tugplug:commit",
    ]);
    // models captured in the same frame still land.
    expect(snap.models).toHaveLength(1);

    store.dispose();
  });

  test("session_capabilities `version` populates the badge version from the drop", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    // tugcode folds `claude --version` into the handshake so the Claude Code
    // badge reads a real version before any turn (instead of "?").
    feedStore.emit(FEED_ID, {
      type: "session_capabilities",
      models: [],
      commands: [],
      version: "2.1.195",
    });
    expect(store.getSnapshot().version).toBe("2.1.195");

    // The post-turn system_metadata version sharpens (wins over) the handshake
    // one once a turn confirms claude's own reported version.
    feedStore.emit(FEED_ID, {
      type: "system_metadata",
      version: "2.1.196",
    });
    expect(store.getSnapshot().version).toBe("2.1.196");

    store.dispose();
  });

  test("a later empty system_metadata does NOT wipe the handshake catalog", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    // Handshake lands first (from the drop).
    feedStore.emit(FEED_ID, {
      type: "session_capabilities",
      models: [],
      commands: [{ name: "init" }, { name: "loop" }],
    });
    expect(store.getSnapshot().slashCommands).toHaveLength(2);

    // An early/sparse system_metadata with no slash_commands must not clobber
    // the catalog we already have.
    feedStore.emit(FEED_ID, {
      type: "system_metadata",
      model: "claude-opus-4-8",
      slash_commands: [],
    });
    expect(store.getSnapshot().slashCommands.map((c) => c.name)).toEqual([
      "init",
      "loop",
    ]);
    // The richer model field from system_metadata still applies.
    expect(store.getSnapshot().model).toBe("claude-opus-4-8");

    store.dispose();
  });

  test("a non-empty system_metadata catalog refreshes the handshake one", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    feedStore.emit(FEED_ID, {
      type: "session_capabilities",
      models: [],
      commands: [{ name: "init" }],
    });
    // Post-turn system_metadata carries the authoritative (richer) list.
    feedStore.emit(FEED_ID, {
      type: "system_metadata",
      slash_commands: ["init", "loop", "compact"],
    });
    expect(store.getSnapshot().slashCommands.map((c) => c.name)).toEqual([
      "init",
      "loop",
      "compact",
    ]);

    store.dispose();
  });
});

describe("SessionMetadataStore catalog union (resumed card, stale system frame)", () => {
  // On a resumed card the system_metadata frame is the ledger's stored copy
  // from an earlier run, and the turn-free handshake is the only live source.
  // A project skill added between the two runs is reported by the handshake
  // and by nothing else. The catalog is the union by name — whichever order
  // the two frames land in — so the new skill is offered and the unknown-
  // command guard does not refuse the turn that would have refreshed the list.
  test("a command only the live handshake reports survives a stored system catalog", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    // Stored frame replayed at bind: the catalog as it was last run.
    feedStore.emit(FEED_ID, {
      type: "system_metadata",
      slash_commands: ["init", "spike-card", "tugplug:brief"],
    });
    // Live handshake from this spawn: a skill added since, plus the metadata
    // the system emitter never carries.
    feedStore.emit(FEED_ID, {
      type: "session_capabilities",
      models: [],
      commands: [
        { name: "init" },
        { name: "spike-card", argumentHint: "[what you want to explore]" },
        { name: "write-release-notes", description: "Draft the notes" },
      ],
    });

    const names = store.getSnapshot().slashCommands.map((c) => c.name);
    expect(names).toEqual([
      "init",
      "spike-card",
      "tugplug:brief",
      "write-release-notes",
    ]);
    // The stored entry is still backfilled from the handshake by name.
    expect(
      store.getSnapshot().slashCommands.find((c) => c.name === "spike-card")
        ?.argumentHint,
    ).toBe("[what you want to explore]");

    store.dispose();
  });

  test("the union holds in the other order too (handshake first, then system)", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    feedStore.emit(FEED_ID, {
      type: "session_capabilities",
      models: [],
      commands: [{ name: "init" }, { name: "write-release-notes" }],
    });
    feedStore.emit(FEED_ID, {
      type: "system_metadata",
      slash_commands: ["init", "tugplug:brief"],
    });

    expect(store.getSnapshot().slashCommands.map((c) => c.name)).toEqual([
      "init",
      "tugplug:brief",
      "write-release-notes",
    ]);

    store.dispose();
  });
});

describe("SessionMetadataStore reconciliation (optimistic overrides)", () => {
  // Optimistic overrides win until the authoritative frame that OWNS the field
  // lands and drops the override — proving the two sources reconcile through a
  // single precedence rule rather than racing to patch one snapshot.
  test("applyModel wins until a system_metadata lands and drops the override", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    store.applyModel("claude-sonnet-4-6");
    expect(store.getSnapshot().model).toBe("claude-sonnet-4-6");

    // The authoritative system_metadata (here carrying the live model) drops
    // the optimistic override and the reconciled snapshot reflects the wire.
    feedStore.emit(FEED_ID, {
      type: "system_metadata",
      model: "claude-opus-4-8",
    });
    expect(store.getSnapshot().model).toBe("claude-opus-4-8");

    store.dispose();
  });

  test("applyEffort wins until a fresh session_capabilities drops it", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    feedStore.emit(FEED_ID, {
      type: "session_capabilities",
      models: [],
      effort: "low",
      commands: [],
    });
    expect(store.getSnapshot().effort).toBe("low");

    store.applyEffort("high");
    expect(store.getSnapshot().effort).toBe("high");

    // A fresh handshake (owns effort) drops the optimistic override.
    feedStore.emit(FEED_ID, {
      type: "session_capabilities",
      models: [],
      effort: "medium",
      commands: [],
    });
    expect(store.getSnapshot().effort).toBe("medium");

    store.dispose();
  });

  test("a model override SURVIVES a system_metadata that omits model", () => {
    // A frame that carries no model says nothing about the model — the
    // turn-free synthetic session_init and sparse replay rows are exactly
    // such frames, and they land right after a fresh card's seed pick. If
    // they dropped the override, a just-picked model would flash and snap
    // back to the spawn model until the next real turn. Only a frame that
    // actually CARRIES a model supersedes the optimistic value.
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    store.applyModel("sonnet");
    feedStore.emit(FEED_ID, { type: "system_metadata", cwd: "/x" });
    expect(store.getSnapshot().model).toBe("sonnet");

    // A frame that DOES carry a model supersedes the override.
    feedStore.emit(FEED_ID, {
      type: "system_metadata",
      model: "claude-sonnet-4-6",
    });
    expect(store.getSnapshot().model).toBe("claude-sonnet-4-6");

    store.dispose();
  });

  test("a permission-mode override survives a mode-less system_metadata", () => {
    // Same only-if-carried rule as the model: a frame that omits (or blanks)
    // permissionMode must not clobber an optimistic Shift+Tab / sheet pick.
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    store.applyPermissionMode("acceptEdits");
    feedStore.emit(FEED_ID, { type: "system_metadata", cwd: "/x" });
    expect(store.getSnapshot().permissionMode).toBe("acceptEdits");

    feedStore.emit(FEED_ID, {
      type: "system_metadata",
      permissionMode: "plan",
    });
    expect(store.getSnapshot().permissionMode).toBe("plan");

    store.dispose();
  });

  test("a post-turn bare-string catalog keeps the handshake's argument hints", () => {
    // The from-the-drop handshake carries rich per-command metadata (tugcode
    // reads `argument-hint` from each plugin command's frontmatter); the first
    // turn's `system_metadata` then ships the same commands as bare strings.
    // The system list is authoritative for *which* commands exist, but its
    // sparse entries must not erase the hint — else a slot shown from the drop
    // regresses to the generic text on the next invocation.
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(feedStore as never, FEED_ID as never);

    feedStore.emit(FEED_ID, {
      type: "session_capabilities",
      models: [],
      effort: null,
      commands: [
        {
          name: "tugplug:devise",
          description: "Devise a plan",
          argumentHint: "[idea] [→ output-path]",
        },
      ],
    });
    expect(store.getSnapshot().slashCommands[0]?.argumentHint).toBe(
      "[idea] [→ output-path]",
    );

    // Post-turn frame: same command, now a bare string with no hint.
    feedStore.emit(FEED_ID, {
      type: "system_metadata",
      cwd: "/x",
      skills: ["tugplug:devise"],
    });
    const hit = store
      .getSnapshot()
      .slashCommands.find((c) => c.name === "tugplug:devise");
    expect(hit?.argumentHint).toBe("[idea] [→ output-path]");
    expect(hit?.description).toBe("Devise a plan");

    store.dispose();
  });
});

// ---------------------------------------------------------------------------
// Tests: session isolation guard ([D06]/[D11] defense in depth)
// ---------------------------------------------------------------------------

describe("SessionMetadataStore session isolation", () => {
  test("a payload tagged with a foreign tug_session_id is dropped", () => {
    // The per-card FeedStore filter is the primary gate; this guard keeps
    // the invariant local to the store. A foreign session's system_metadata
    // must not touch this card's model / mode / catalog.
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(
      feedStore as never,
      FEED_ID as never,
      "sess-mine",
    );

    feedStore.emit(
      FEED_ID,
      makeMetadataPayload({ tug_session_id: "sess-other" }),
    );
    expect(store.getSnapshot().model).toBeNull();
    expect(store.getSnapshot().slashCommands).toEqual([]);

    // A foreign session_capabilities is equally rejected.
    feedStore.emit(FEED_ID, {
      type: "session_capabilities",
      tug_session_id: "sess-other",
      models: [{ value: "sonnet", displayName: "Sonnet" }],
    });
    expect(store.getSnapshot().models).toEqual([]);

    store.dispose();
  });

  test("a foreign frame does not drop an optimistic override", () => {
    // A foreign session's system_metadata carries a model, and a frame that
    // carries a field normally supersedes the optimistic override for it —
    // the guard must reject the frame before that override logic runs, or
    // another card's traffic snaps a just-picked model back.
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(
      feedStore as never,
      FEED_ID as never,
      "sess-mine",
    );

    store.applyModel("claude-haiku-4-5");
    feedStore.emit(
      FEED_ID,
      makeMetadataPayload({
        tug_session_id: "sess-other",
        model: "claude-opus-4-8",
      }),
    );
    expect(store.getSnapshot().model).toBe("claude-haiku-4-5");

    store.dispose();
  });

  test("a payload tagged with the store's own tug_session_id is processed", () => {
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(
      feedStore as never,
      FEED_ID as never,
      "sess-mine",
    );

    feedStore.emit(
      FEED_ID,
      makeMetadataPayload({ tug_session_id: "sess-mine" }),
    );
    expect(store.getSnapshot().model).toBe("claude-3-opus");

    store.dispose();
  });

  test("an untagged payload is processed (test / fixture injection path)", () => {
    // `_ingestForTest`, gallery fixtures, and pre-splice synthetic payloads
    // carry no tug_session_id; absence is not a mismatch.
    const feedStore = new MockFeedStore();
    const store = new SessionMetadataStore(
      feedStore as never,
      FEED_ID as never,
      "sess-mine",
    );

    feedStore.emit(FEED_ID, makeMetadataPayload());
    expect(store.getSnapshot().model).toBe("claude-3-opus");

    store.dispose();
  });
});
