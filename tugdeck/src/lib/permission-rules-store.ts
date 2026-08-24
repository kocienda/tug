/**
 * permission-rules-store.ts — the `/permissions` editor's data source.
 *
 * A small external store ([L02]) over tugcast's `/api/permissions` endpoint:
 * it loads every writable scope's rule buckets, exposes them as a
 * `PermissionsSnapshot`, and mutates one rule at a time (add / remove in a
 * scope + bucket). Mutations are optimistic — the local snapshot updates
 * immediately so the list reflects the change without waiting on the round
 * trip — then reconciled against a fresh `GET` (the authority). Claude Code
 * reloads `permissions` live, so a successful write is in effect for the
 * running session with no respawn (`dash/transport-exploration.md`).
 *
 * The store is created per editor-open, seeded with the session's `cwd` (the
 * project root the project/local scopes resolve under). A companion
 * {@link BucketDataSource} adapts one bucket of the snapshot to the
 * `TugListViewDataSource` contract so the rule lists window + filter through
 * the normal list-view machinery.
 *
 * @module lib/permission-rules-store
 */

import type { TugListViewDataSource } from "@/components/tugways/tug-list-view";
import {
  emptyPermissionsSnapshot,
  parsePermissionsResponse,
  resolveBucket,
  type BucketKey,
  type PermissionsSnapshot,
  type ResolvedRule,
  type RuleScope,
} from "@/lib/permission-rules";

/** Add or remove a rule. */
export type RuleOp = "add" | "remove";

/** Apply a single add/remove to a snapshot purely, returning a new snapshot. */
function applyLocal(
  snapshot: PermissionsSnapshot,
  scope: RuleScope,
  bucket: BucketKey,
  op: RuleOp,
  rule: string,
): PermissionsSnapshot {
  const current = snapshot.scopes[scope][bucket];
  let next: string[];
  if (op === "add") {
    next = current.includes(rule) ? current : [...current, rule];
  } else {
    next = current.filter((entry) => entry !== rule);
  }
  return {
    ...snapshot,
    scopes: {
      ...snapshot.scopes,
      [scope]: { ...snapshot.scopes[scope], [bucket]: next },
    },
  };
}

/**
 * External store over `/api/permissions` for one session's `cwd`. Holds the
 * current snapshot, notifies subscribers on every change, and performs
 * optimistic mutations reconciled against a fresh read.
 */
export class PermissionRulesStore {
  private snapshot: PermissionsSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.snapshot = emptyPermissionsSnapshot(cwd);
  }

  getSnapshot = (): PermissionsSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(next: PermissionsSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  /** Fetch every scope's buckets and publish the resulting snapshot. */
  async load(): Promise<void> {
    try {
      const res = await fetch(
        `/api/permissions?cwd=${encodeURIComponent(this.cwd)}`,
      );
      if (!res.ok) {
        console.warn(`[permission-rules] GET failed: ${res.status}`);
        return;
      }
      this.set(parsePermissionsResponse(await res.json()));
    } catch (err) {
      console.warn("[permission-rules] GET errored:", err);
    }
  }

  /**
   * Add or remove a rule in a scope + bucket. Optimistically updates the local
   * snapshot, POSTs the mutation, then reconciles against a fresh read. On
   * failure the snapshot is reloaded so the UI reverts to on-disk truth.
   * Resolves `true` when the write succeeded.
   */
  async mutate(
    scope: RuleScope,
    bucket: BucketKey,
    op: RuleOp,
    rule: string,
  ): Promise<boolean> {
    this.set(applyLocal(this.snapshot, scope, bucket, op, rule));
    try {
      const res = await fetch("/api/permissions/rule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: this.cwd, scope, bucket, op, rule }),
      });
      if (!res.ok) {
        console.warn(`[permission-rules] POST failed: ${res.status}`);
        await this.load();
        return false;
      }
    } catch (err) {
      console.warn("[permission-rules] POST errored:", err);
      await this.load();
      return false;
    }
    // Reconcile with on-disk truth (Claude Code may normalize / a concurrent
    // terminal edit may have landed).
    await this.load();
    return true;
  }
}

/**
 * Adapts one bucket of a {@link PermissionRulesStore}'s snapshot to the
 * `TugListViewDataSource` contract. Rules are recomputed lazily whenever the
 * store's snapshot reference changes, so `getVersion` (the snapshot ref) is the
 * single [L02] update signal and the enumeration always reflects the latest
 * load / mutation.
 */
export class BucketDataSource implements TugListViewDataSource {
  private rules: ResolvedRule[] = [];
  private cachedFor: PermissionsSnapshot | null = null;

  constructor(
    private readonly store: PermissionRulesStore,
    private readonly bucket: BucketKey,
  ) {}

  private ensureFresh(): void {
    const snapshot = this.store.getSnapshot();
    if (this.cachedFor !== snapshot) {
      this.rules = resolveBucket(snapshot, this.bucket);
      this.cachedFor = snapshot;
    }
  }

  /** The resolved rule at `index` — for the cell renderer. */
  ruleAt(index: number): ResolvedRule {
    this.ensureFresh();
    return this.rules[index];
  }

  numberOfItems(): number {
    this.ensureFresh();
    return this.rules.length;
  }

  idForIndex(index: number): string {
    this.ensureFresh();
    // The matcher string is the stable item identity (a rule keeps its raw
    // across loads), so reconciliation reuses cell instances.
    return this.rules[index].raw;
  }

  kindForIndex(): string {
    return "rule";
  }

  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener);
  }

  getVersion(): unknown {
    return this.store.getSnapshot();
  }
}
