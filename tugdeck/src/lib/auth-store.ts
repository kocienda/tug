/**
 * App-level Claude login state — the single source of truth for the auth gate.
 *
 * Fed exclusively by `claude_auth_result` CONTROL frames (the deck sends
 * `check_auth` on connect / before the picker, and `claude_sign_in` from a
 * sign-in affordance; tugcast answers both with `claude_auth_result`). The
 * app-wide sign-in sheet, the session-picker gate, and the per-card auth
 * banner all read this one store, so a single result frame resolves every
 * surface at once.
 *
 * **Laws:** [L02] external state enters React through `useSyncExternalStore`
 * only — this store exposes `subscribe + getSnapshot` and is read via that
 * hook (see `useAuth`). The snapshot is replaced (never mutated in place) so
 * `useSyncExternalStore` sees a fresh reference on every change.
 */

import { useSyncExternalStore } from "@/lib/gesture-scope";


export interface AuthAccount {
  email: string | null;
  subscriptionType: string | null;
  authMethod: string | null;
}

/**
 * Why the user is signed out — drives which setup-checklist step is active:
 * `claude_missing` = the CLI isn't installed; `logged_out` = installed but not
 * signed in. `null` when logged in (or not yet probed).
 *
 * `probe_failed` is the odd one out and rides alongside `loggedIn: null`:
 * the probe ran and did not answer, so the login state is unknown rather than
 * signed out. `loggedIn: null` on its own already means "not yet probed"; the
 * reason is what tells "not yet" from "could not".
 */
export type AuthReason = "claude_missing" | "logged_out" | "probe_failed";

export interface AuthSnapshot {
  /**
   * `null` until the first probe answers, and again whenever a probe fails to
   * answer — `reason` says which. Only `true` and `false` are claims about
   * the user.
   */
  loggedIn: boolean | null;
  /** Which signed-out step is active, or `null` when logged in / unknown. */
  reason: AuthReason | null;
  /** Account details for display ("Signed in as … — Max"), when logged in. */
  account: AuthAccount | null;
  /** True between sending `claude_sign_in` and the next `claude_auth_result`. */
  signingIn: boolean;
  /**
   * True when a sign-in attempt resolved without logging in — the browser was
   * cancelled, closed, or never returned (the backend re-probes after the CLI
   * exits and there is no distinct failure reason on the wire, so this is the
   * only signal). Drives the wizard's "Sign-in didn't finish" recovery state.
   * Cleared when a new attempt starts or a later result logs in.
   */
  signInFailed: boolean;
  /** True between sending `claude_logout` and its `claude_logout_result`. */
  loggingOut: boolean;
  /**
   * Last logout error, or `null`. Set when `claude auth logout` failed or the
   * request timed out — the user is told it didn't work rather than being
   * silently left logged in. Cleared when the error is dismissed or a new
   * logout starts.
   */
  logoutError: string | null;
  /** True while a Tug-managed `install_claude` is running. */
  installing: boolean;
  /**
   * True while a stopped Claude Code download is holding its bytes ([B09]).
   * Unlike the update wizard's `paused`, this one really does keep them: the
   * partial file is on disk under Tug's own download directory, named for the
   * version it is bytes of, so it survives a tugcast restart and a relaunch.
   */
  downloadPaused: boolean;
  /** The version the bytes on disk are of, or `null` when there are none. */
  downloadVersion: string | null;
  /**
   * True when the running install is the official `curl | bash` script — the
   * fallback [B08] keeps for a release channel that cannot be read. There are
   * no bytes to count, so the row runs a barber pole and says less.
   */
  downloadFallback: boolean;
  /**
   * True when a resume came back at zero bytes. Either a newer release landed
   * while the download was stopped, or the server ignored the `Range` and sent
   * the whole file. Both mean the same thing to the person watching — it is
   * starting over — so the row says that rather than which.
   */
  downloadRestarted: boolean;
  /**
   * The transfer reached its last byte and what is running now is the
   * install itself — the checksum, then the binary's own `install`
   * subcommand. tugcast has let go of the download by then, so there is
   * nothing left for a Pause to stop; the row drops the Pause and goes back
   * to a barber pole and a sentence, which is what the script fallback shows
   * for the same reason.
   *
   * A render field rather than a painted one: it flips once per transfer,
   * not once per percent.
   */
  downloadComplete: boolean;
  /**
   * Bytes received and expected for the download in flight (or held by a
   * pause). They ride the `claude_install_progress` frames tugcast publishes
   * on a whole-percent change ([B06]), and they are **elided from
   * {@link AuthRenderSnapshot}** for the reason [L06] gives: a bar that moves
   * a hundred times is painted from a direct subscription, never re-rendered.
   */
  receivedBytes: number;
  expectedBytes: number;
  /**
   * True between a successful `claude_install_result` and the `claude_auth_result`
   * the backend re-probes with right after. The two arrive as separate frames,
   * so without this bridge the install step would flash back to "needs install"
   * (install done, but `reason` is still `claude_missing` until the re-probe
   * lands). Keeps the step "busy" forward through that gap. Cleared by the next
   * `claude_auth_result`.
   */
  verifyingInstall: boolean;
  /** Last install error, or `null`. Cleared when a new install starts. */
  installError: string | null;
}

const INITIAL: AuthSnapshot = {
  loggedIn: null,
  reason: null,
  account: null,
  signingIn: false,
  signInFailed: false,
  loggingOut: false,
  logoutError: null,
  installing: false,
  downloadPaused: false,
  downloadVersion: null,
  downloadFallback: false,
  downloadRestarted: false,
  downloadComplete: false,
  receivedBytes: 0,
  expectedBytes: 0,
  verifyingInstall: false,
  installError: null,
};

/**
 * What React sees: everything but the byte pair ([L06]). Its reference is held
 * stable across a bytes-only change, which is what makes
 * `useSyncExternalStore` bail out of the re-render — so a 90 MB download costs
 * the wizard nothing it did not already cost.
 */
export type AuthRenderSnapshot = Omit<
  AuthSnapshot,
  "receivedBytes" | "expectedBytes"
>;

/** Whether a render snapshot still describes this whole one. */
function rendersMatch(
  render: AuthRenderSnapshot,
  next: AuthSnapshot,
): boolean {
  const keys = Object.keys(render) as Array<keyof AuthRenderSnapshot>;
  return keys.every((key) => Object.is(render[key], next[key]));
}

function toRenderSnapshot(snapshot: AuthSnapshot): AuthRenderSnapshot {
  const { receivedBytes: _received, expectedBytes: _expected, ...rest } = snapshot;
  return rest;
}

class AuthStore {
  private _snapshot: AuthSnapshot = INITIAL;
  private _renderSnapshot: AuthRenderSnapshot = toRenderSnapshot(INITIAL);
  private _listeners: Array<() => void> = [];

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx >= 0) this._listeners.splice(idx, 1);
    };
  };

  /** The whole truth, read imperatively by whoever paints the bar. */
  getSnapshot = (): AuthSnapshot => this._snapshot;

  /** The render surface [L06] — no bytes, stable across a bytes-only change. */
  getRenderSnapshot = (): AuthRenderSnapshot => this._renderSnapshot;

  /** Mark a sign-in attempt in flight (the wizard shows "Waiting for browser sign-in…"). */
  setSigningIn(signingIn: boolean): void {
    // Starting an attempt clears any prior failure so the wizard returns to the
    // "Waiting…" state rather than the error.
    const nextFailed = signingIn ? false : this._snapshot.signInFailed;
    if (
      this._snapshot.signingIn === signingIn &&
      this._snapshot.signInFailed === nextFailed
    )
      return;
    this._snapshot = { ...this._snapshot, signingIn, signInFailed: nextFailed };
    this.notify();
  }

  /**
   * A sign-in attempt exceeded the wait budget (the browser never returned).
   * Ends the in-flight state and surfaces the recoverable failure. No-op if no
   * attempt is in flight (a late `claude_auth_result` already resolved it).
   */
  markSignInTimedOut(): void {
    if (!this._snapshot.signingIn) return;
    this._snapshot = { ...this._snapshot, signingIn: false, signInFailed: true };
    this.notify();
  }

  /**
   * Mark a Tug-managed install in flight (clears any prior install error).
   * A fresh install forgets any bytes a previous attempt was holding — it is
   * about to ask for a release from the top.
   */
  setInstalling(installing: boolean): void {
    this._snapshot = {
      ...this._snapshot,
      installing,
      installError: null,
      verifyingInstall: false,
      downloadPaused: false,
      downloadFallback: false,
      downloadRestarted: false,
      downloadComplete: false,
      receivedBytes: 0,
      expectedBytes: 0,
      downloadVersion: null,
    };
    this.notify();
  }

  /**
   * The Resume press. Unlike {@link setInstalling} this **keeps** the bytes,
   * so the row goes on saying how far it got until the first progress frame
   * of the resumed transfer replaces them.
   */
  setResuming(): void {
    this._snapshot = {
      ...this._snapshot,
      installing: true,
      downloadPaused: false,
      downloadComplete: false,
      installError: null,
    };
    this.notify();
  }

  /**
   * Apply a `claude_install_progress` frame. Ends a pause, because bytes are
   * arriving again.
   *
   * A frame that says zero when the store was holding more is a transfer that
   * started over — a newer release while it was stopped, or a server that
   * ignored the `Range` — and it is the only place that can be told, because
   * received bytes never otherwise run backwards.
   */
  applyDownloadProgress(
    received: number,
    expected: number,
    version: string | null,
  ): void {
    this._snapshot = {
      ...this._snapshot,
      installing: true,
      downloadPaused: false,
      downloadFallback: false,
      downloadRestarted:
        received === 0 && this._snapshot.receivedBytes > 0
          ? true
          : this._snapshot.downloadRestarted,
      // The last frame of a transfer is the one that says it is over:
      // tugcast reports once more after the stream ends, and lets go of the
      // download before the installer runs.
      downloadComplete: expected > 0 && received >= expected,
      receivedBytes: received,
      expectedBytes: expected,
      downloadVersion: version,
    };
    this.notify();
  }

  /**
   * Apply a `claude_download_stopped` frame. A pause holds its place — the
   * partial file is on disk and the row offers Resume; a cancel forgets it,
   * and the row goes back to its offer.
   */
  applyDownloadStopped(
    reason: "paused" | "cancelled",
    received: number,
    expected: number,
    version: string | null,
  ): void {
    this._snapshot =
      reason === "paused"
        ? {
            ...this._snapshot,
            installing: false,
            downloadPaused: true,
            downloadComplete: false,
            receivedBytes: received,
            expectedBytes: expected,
            downloadVersion: version,
          }
        : {
            ...this._snapshot,
            installing: false,
            downloadPaused: false,
            downloadRestarted: false,
            downloadComplete: false,
            receivedBytes: 0,
            expectedBytes: 0,
            downloadVersion: null,
          };
    this.notify();
  }

  /**
   * The release channel could not be read, so the official script is running
   * instead ([B08]). There are no bytes, and there is no Pause: the script
   * owns the transfer and Tug cannot stop it halfway.
   */
  markDownloadFallback(): void {
    this._snapshot = {
      ...this._snapshot,
      installing: true,
      downloadFallback: true,
      downloadPaused: false,
      downloadComplete: false,
      receivedBytes: 0,
      expectedBytes: 0,
      downloadVersion: null,
    };
    this.notify();
  }

  /**
   * End a download without an install result of its own: the Cancel press,
   * and the `claude_update_result` that finishes an update (which is reported
   * on the version store's frame rather than the install store's, so this is
   * what puts the auth store's half of the row down).
   */
  endDownload(): void {
    this._snapshot = {
      ...this._snapshot,
      installing: false,
      downloadPaused: false,
      downloadFallback: false,
      downloadRestarted: false,
      downloadComplete: false,
      receivedBytes: 0,
      expectedBytes: 0,
      downloadVersion: null,
    };
    this.notify();
  }

  /**
   * Apply a `claude_install_result`: ends the install, records any error. On
   * success the install isn't "done" yet — the backend re-probes next — so we
   * enter `verifyingInstall` to keep the step busy until that result lands,
   * rather than briefly reverting to "needs install".
   */
  applyInstallResult(ok: boolean, error: string | null): void {
    this._snapshot = {
      ...this._snapshot,
      installing: false,
      verifyingInstall: ok,
      installError: ok ? null : (error ?? "install failed"),
      // The download is over either way: on success the bytes became an
      // installed binary, and on failure they were discarded rather than kept
      // for a resume to continue something already known to be wrong.
      downloadPaused: false,
      downloadFallback: false,
      downloadRestarted: false,
      downloadComplete: false,
      receivedBytes: 0,
      expectedBytes: 0,
      downloadVersion: null,
    };
    this.notify();
  }

  /** Mark a logout attempt in flight (clears any prior logout error). */
  setLoggingOut(loggingOut: boolean): void {
    this._snapshot = {
      ...this._snapshot,
      loggingOut,
      logoutError: loggingOut ? null : this._snapshot.logoutError,
    };
    this.notify();
  }

  /**
   * Apply a `claude_logout_result`: ends the in-flight logout, and on failure
   * records the error so it can be surfaced (the login state itself is settled
   * by the `claude_auth_result` that follows).
   */
  applyLogoutResult(ok: boolean, error: string | null): void {
    this._snapshot = {
      ...this._snapshot,
      loggingOut: false,
      logoutError: ok ? null : (error ?? "logout failed"),
    };
    this.notify();
  }

  /** A logout attempt exceeded the wait budget (no result frame arrived). */
  markLogoutTimedOut(): void {
    if (!this._snapshot.loggingOut) return;
    this._snapshot = {
      ...this._snapshot,
      loggingOut: false,
      logoutError: "Logout timed out.",
    };
    this.notify();
  }

  /** Clear a surfaced logout error (the user dismissed it). */
  clearLogoutError(): void {
    if (this._snapshot.logoutError === null) return;
    this._snapshot = { ...this._snapshot, logoutError: null };
    this.notify();
  }

  /** Apply a `claude_auth_result`: records login state and clears `signingIn`. */
  applyResult(
    loggedIn: boolean | null,
    reason: AuthReason | null,
    account: AuthAccount | null,
  ): void {
    // A result that arrives while a sign-in was in flight but does not log in
    // means the attempt failed (cancelled / browser closed). A successful login
    // clears the flag; a plain probe (no attempt in flight) leaves it as-is.
    //
    // A probe that did not answer is not such a result: it says nothing about
    // the attempt, so it must not be read as one that failed. `signingIn` is
    // still cleared — the frame is the answer to the request that set it —
    // but `signInFailed` is left exactly as it was.
    const unanswered = loggedIn === null;
    const attempted = this._snapshot.signingIn && !unanswered;
    this._snapshot = {
      ...this._snapshot,
      loggedIn,
      reason: loggedIn === true ? null : reason,
      account: loggedIn === true ? account : null,
      signingIn: false,
      signInFailed:
        loggedIn === true ? false : attempted || this._snapshot.signInFailed,
      installing: false,
      // This result is the post-install re-probe (or any later probe): the
      // install step now resolves to its real state, so the bridge ends.
      verifyingInstall: false,
    };
    this.notify();
  }

  private notify(): void {
    // Recompute the render surface here rather than in every mutator, so a
    // field added later cannot forget to. A bytes-only change leaves the
    // reference exactly as it was, which is the whole point.
    if (!rendersMatch(this._renderSnapshot, this._snapshot)) {
      this._renderSnapshot = toRenderSnapshot(this._snapshot);
    }
    for (const listener of this._listeners) listener();
  }
}

export const authStore = new AuthStore();

/**
 * React read of the app auth state ([L02]).
 *
 * Carries no byte counts by construction — a download's progress is drawn
 * from {@link authStore}`.getSnapshot()` onto the bar and the detail line
 * through a direct subscription, never through a re-render ([L06]).
 */
export function useAuth(): AuthRenderSnapshot {
  return useSyncExternalStore(authStore.subscribe, authStore.getRenderSnapshot);
}

/**
 * Apply a `claude_auth_result` CONTROL payload to the store. Tolerant of the
 * wire shape (`loggedIn` plus optional `email`/`subscriptionType`/`authMethod`).
 */
export function applyAuthResultPayload(payload: Record<string, unknown>): void {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  const reason: AuthReason | null =
    payload.reason === "claude_missing"
      ? "claude_missing"
      : payload.reason === "logged_out"
        ? "logged_out"
        : payload.reason === "probe_failed"
          ? "probe_failed"
          : null;
  // Three-valued, matching the wire: `true`, `false`, and a `null` that says
  // the probe did not answer. Anything else the wire could carry is read as
  // unknown rather than as a signed-out claim.
  const loggedIn: boolean | null =
    payload.loggedIn === true ? true : payload.loggedIn === false ? false : null;
  authStore.applyResult(
    loggedIn,
    reason,
    loggedIn === true
      ? {
          email: str(payload.email),
          subscriptionType: str(payload.subscriptionType),
          authMethod: str(payload.authMethod),
        }
      : null,
  );
}

/** Apply a `claude_install_result` CONTROL payload (`{ok, error}`). */
export function applyInstallResultPayload(payload: Record<string, unknown>): void {
  authStore.applyInstallResult(
    payload.ok === true,
    typeof payload.error === "string" ? payload.error : null,
  );
}

/** A non-negative finite count, or 0 — the wire is not trusted to be either. */
function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/**
 * Apply a `claude_install_progress` CONTROL payload
 * (`{received, expected, version}`).
 */
export function applyDownloadProgressPayload(
  payload: Record<string, unknown>,
): void {
  authStore.applyDownloadProgress(
    nonNegative(payload.received),
    nonNegative(payload.expected),
    typeof payload.version === "string" && payload.version.length > 0
      ? payload.version
      : null,
  );
}

/**
 * Apply a `claude_download_stopped` CONTROL payload
 * (`{reason, received, expected, version}`). Anything but `paused` is read as
 * a cancel, because forgetting bytes Tug is not sure about is the safe half.
 */
export function applyDownloadStoppedPayload(
  payload: Record<string, unknown>,
): void {
  authStore.applyDownloadStopped(
    payload.reason === "paused" ? "paused" : "cancelled",
    nonNegative(payload.received),
    nonNegative(payload.expected),
    typeof payload.version === "string" && payload.version.length > 0
      ? payload.version
      : null,
  );
}

/** Apply a `claude_install_fallback` CONTROL payload (it carries nothing). */
export function applyDownloadFallbackPayload(): void {
  authStore.markDownloadFallback();
}

/** End a download the auth store carried but does not get a result frame for. */
export function applyDownloadEnded(): void {
  authStore.endDownload();
}

/** Apply a `claude_logout_result` CONTROL payload (`{ok, error}`). */
export function applyLogoutResultPayload(payload: Record<string, unknown>): void {
  authStore.applyLogoutResult(
    payload.ok === true,
    typeof payload.error === "string" ? payload.error : null,
  );
}
