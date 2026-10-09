<!-- brief-skeleton v1 -->

# Loopback is not authentication: close the browser-origin hole in tugcast's HTTP API and the host's path bridge

**Purpose:** tugcast serves every `/api/*` route with `allow_origin(Any)` and no session check, so any web page open in the user's ordinary browser can read files and run JavaScript in the deck. The macOS host's `openPath`, `trashPath`, and `restorePath` message handlers act on any path the page names. Both rest on "it only binds to loopback", and loopback is a network fact, not a trust boundary.

---

## Purpose {#purpose}

Items 1 and 2 of `briefs/audit-punch-list.md`, from the 2026-10-09 360° audit:

> 1. Require the auth session on every `/api/*` route in `server.rs` and narrow CORS to the app's own origins. The deck's websocket already does this at `router.rs:390`.
> 2. Root-restrict `openPath`, `trashPath`, and `restorePath` in `MainWindow.swift` to the open project directories and the Tug data root.

The audit's theme was "loopback trusted as if it were authentication". The fix must keep every legitimate caller working: the deck in `WKWebView`, the Vite dev server, `tugtool` and its `deck motion` verbs posting to `/api/*` from a shell, the changes forwarder between instances, and the app-test harness.

---

## Evidence {#evidence}

**[F01] CORS is open on the whole router** — `tugrust/crates/tugcast/src/server.rs` at the router builder applies `CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any)` to every route. The comment above it says this is for `WKWebView` keepalive fetches during teardown and for the Vite dev port. Both of those are origins `AuthState::check_origin` already enumerates (`auth.rs`, the `http://127.0.0.1:{port}` and `localhost` pairs plus the dev port), so neither needs `Any`. **(verified)**

**[F02] Only the websocket handshake checks the session and origin** — `auth::validate_request_session` and `auth::check_request_origin` have exactly one production caller each, `router.rs:390` and `:394` in `ws_handler`. No HTTP route and no middleware calls either. **(verified)**

**[F03] The exposed routes are powerful** — `/api/eval` evaluates JavaScript inside the deck; `/api/fs/read`, `/api/fs/blob`, `/api/fs/bytes` serve any absolute path that passes `guard_absolute_path` in `fs_read.rs` (no `..`, secret filter); `/api/fs/mkdir`, `/api/fs/write`, `/api/changes-write`, `/api/arc`, `/api/session`, `/api/tell`, `/api/ask` mutate state. With `Any` CORS a page at any origin can `fetch("http://127.0.0.1:<port>/api/fs/read?path=…")` and read the body, or POST to `/api/eval`. The port is discoverable from the instance registry and is in a small range in any case. **(verified by reading; not reproduced in a browser)**

**[F04] Local processes call `/api/*` with no cookie and no Origin header** — `tugtool` reaches instances through `post_instance_api` in `tugrust/crates/tugtool/src/arc.rs` with a bare `ureq` agent (`/api/arc`, `/api/session`, `/api/tell`); the `deck motion` family and `tugtool deck` post to `/api/eval`; `ChangesForwarder::send` in `changes_writer.rs` posts to `/api/changes-write` on the owning instance. None of these send a session cookie, and a non-browser client sends no `Origin` header. A fix that requires the browser cookie on every route breaks all of them. **(verified)**

**[F05] Browsers always mark a cross-origin request** — every cross-origin `fetch`/XHR and every non-GET request carries an `Origin` header, and every modern engine including WebKit also sends `Sec-Fetch-Site` (`cross-site`, `same-site`, `same-origin`, `none`). A request with no `Origin` and no `Sec-Fetch-Site` did not come from a web page. This is the discriminator between [F03] and [F04]. **(standard behaviour; not measured here)**

**[F06] `--no-auth` exists and is a dev switch** — `main.rs:354` builds `new_shared_auth_state_no_auth` when `--no-auth` is passed, and `ProcessManager.swift:1006` passes it only when the tugbank key `dev.tugapp.app/no-auth` is set. In that mode both auth helpers return `true`. **(verified)**

**[F07] The host's path handlers validate shape only** — `tugapp/Sources/MainWindow.swift`, the `openPath`/`trashPath`/`restorePath` cases of the script message handler: each takes `body["path"]` (or `trashedPath` and `destination`), expands `~`, and acts. `openPath` with the default kind calls `fm.createFile` after `createDirectory(withIntermediateDirectories:)` when the file does not exist, so a page can mint any file at any path. `trashPath` recycles any path. `restorePath` moves any source to any destination. There is no `..` check, no root check, and no check that `trashedPath` is actually in the Trash. **(verified)**

**[F08] tugcast's own fs routes already have a guard the host lacks** — `guard_absolute_path` in `fs_read.rs` rejects relative paths, rejects any `..` component, expands `~` once, canonicalises, and refuses secret-filtered paths; `fs_write` additionally gates parent creation on a lexical `starts_with` against the Tug roots. The Swift bridge is the only path-taking surface without this. **(verified)**

**[F09] Legitimate `openPath` targets are not confined to the project** — the handler's own comment names Claude Code's memory files under `~/.claude/…` and `CLAUDE.md` as things that must open, and create if absent. "Open project directories" as the only root would break that. The host also does not hold the list of open project directories; tugcast does. **(verified)**

---

## Decisions {#decisions}

**[B01] Every `/api/*` route gets one gate, applied as a single `axum::middleware::from_fn` layer rather than per handler.** One place to read, one place to test, and no route can be added without passing through it. `/auth` and `/ws` keep their own handling.

**[B02] The gate classifies a request by whether a browser sent it, and only browser-sent requests need the deck's credentials.** If the request carries an `Origin` header or a `Sec-Fetch-Site` header other than `none`, it came from a page: the origin must pass `AuthState::check_origin` and the session cookie must pass `validate_session`, else 403. If it carries neither, it is a local process ([F04]) and passes as today. This keeps `tugtool`, the changes forwarder, and the harness working unchanged while closing [F03]. `--no-auth` ([F06]) short-circuits the gate exactly as it short-circuits the websocket today.

**[B03] CORS narrows to the origins `check_origin` already knows.** The `CorsLayer` reads its allow-list from the same `AuthState` so the two cannot drift, and keeps `allow_credentials` so the deck's cookie rides cross-port in dev. The teardown keepalive and Vite cases in the existing comment are both in that list ([F01]), so nothing the comment protects is lost.

**[B04] Loopback remains a precondition, not the boundary.** The existing `addr.ip().is_loopback()` checks in `attachments.rs` and elsewhere stay. They stop a LAN caller; the gate stops a browser page. Both are needed.

**[B05] The host's three path handlers adopt tugcast's guard rules in Swift, and each gets the narrowest root its job needs.** Common rules, mirroring [F08]: expand `~` once, require an absolute path, reject any `..` component, resolve symlinks before the root check. Then per handler: `openPath` may open any existing path (the user clicked it) but may only *create* a file under the user's home directory ([F09] rules out a project-only root); `trashPath` may only recycle a path under the user's home directory; `restorePath` requires `trashedPath` to resolve under the user's Trash directory (the host minted that URL, so nothing else is legitimate) and `destination` to resolve under the user's home. A refused request replies through the existing `replyToTrashRequest` callback with `ok: false` and a reason, so the deck settles rather than timing out.

**[B06] The host does not try to learn the open project directories.** The data lives in tugcast ([F09]), the handlers' legitimate inputs are wider than the project anyway, and the equivalent HTTP routes already use home-and-Tug-roots as their widest carve-out. Home is the consistent choice.

**[B07] Both halves land as one arc with two steps, tugcast first.** The tugcast gate is the fix that closes an exposure; the Swift hardening is defence in depth behind it. They share the finding and the test idea (a request from a foreign origin is refused, a request from a shell is not) but touch different build and test surfaces, which is why they are steps and not one change.

---

## Open Questions {#open-questions}

- Whether any first-party caller sends `Origin` without a cookie. The deck always holds the cookie after `/auth` because `/ws` already requires it, and the harness drives the deck through the same page. A one-line log in the gate during the arc's own app-test run would confirm before the 403 is turned on. This is a verification step, not a design fork.

---

## Non-goals {#non-goals}

- **Requiring a cookie or token on every `/api/*` request.** Rejected: it breaks `tugtool`, `deck motion`, and the changes forwarder ([F04]) and would need a token-distribution scheme the registry does not have. The browser-marker rule in [B02] closes the actual exposure without it.
- **Removing `/api/eval`.** It is the probe surface the memory and the `deck motion` verbs depend on. Gating it is enough.
- **Binding the host's handlers to the open projects.** See [B06].
- **A content-type gate on raw `Bytes` bodies.** Noted in the audit; once [B02] refuses cross-origin requests, the content-type of a same-origin or local body is not a boundary question.

---

## Exit {#exit}

An arc. First the tugcast gate: the `from_fn` middleware over the `/api` subtree, the narrowed `CorsLayer` fed from `AuthState`, unit tests in `server.rs` or `auth.rs` for the four cases (allowed origin with cookie, allowed origin without cookie, foreign origin, no origin at all), and a run of the app-test selection `@covers` derives for `server.rs` and `auth.rs` to confirm the deck and harness still pass. Then the Swift handlers: a small `BridgePathGuard` with the rules in [B05], the three cases rewritten to use it, and the `@covers`-derived selection for `MainWindow.swift` plus the attachment trash and restore tests.
