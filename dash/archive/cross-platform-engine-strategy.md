# Cross-Platform Engine Strategy

Date written: 2026-04-27
Last updated: 2026-04-28
Status: Direction — leaning toward Option C (native shell per platform, no shared shell framework). Options B and A retained as alternatives. Final commitment deferred until port timing arrives.

## Summary

Tug today is a SwiftUI/AppKit shell hosting a `WKWebView` that loads tugdeck. Cross-platform shipping (Linux, Windows) raises two distinct questions that are easy to conflate:

- **WKWebView dependence** — the macOS-specific embedding API.
- **WebKit (engine) dependence** — the renderer + JS engine itself.

The first is shallow in this codebase. The second is deeper but already partially paid for.

The architectural insight that emerged from working through the options: **the actual cross-platform codebase is `tugdeck/` and `tugrust/`. The shells are just adapters.** Each shell needs to host a webview, expose the same JS bridge contract to tugdeck, and spawn the same Rust binaries. The host language and framework are largely irrelevant as long as the contract holds. This reframes the framework choice from "what abstraction layer do we adopt" to "do we want a framework here at all."

**Current lean: Option C** — purpose-built native shell per platform, no shared shell framework. Options B (Tauri on Win/Linux, native Swift on Mac) and A (Tauri everywhere) remain as alternatives if the DIY pipeline cost turns out to be heavier than expected. Implementation timing and platform-specific details are deferred.

## Where the codebase actually is today

### Native bridge surface is small

`tugapp/Sources/MainWindow.swift` exposes 8 `WKScriptMessageHandler` endpoints:

- `sourceTree`, `setDevMode`, `getSettings`, `frontendReady`, `setTheme`, `devBadge`, `clipboardRead`, `cardList`

On the JS side, `window.webkit.messageHandlers` is referenced from:

- `src/main.tsx`
- `src/action-dispatch.ts`
- `src/deck-manager.ts`
- `src/contexts/theme-provider.tsx`
- `src/lib/tug-native-clipboard.ts` (and `isInsideWKWebView()`)

Porting this surface to WebView2's `chrome.webview.postMessage` or Tauri's `invoke()` is largely mechanical. The bridge is **not** the lock-in.

### Engine-specific code already exists

We have already eaten the cost of WebKit's quirks in several places:

- `src/components/tugways/internal/safari-focus-shift.ts` — explicit Safari/WebKit selection-focus shim.
- `src/lib/tug-native-clipboard.ts` — exists because Safari pops a permission UI on every `navigator.clipboard.readText` and `execCommand("paste")` in 16.4+.
- `MainWindow.swift` blob-download workaround in `decidePolicyFor navigationResponse`.

These are WebKit-engine consequences, not WKWebView consequences. They follow the engine, not the embedding API.

### CSS prefixes are not a portability blocker

`-webkit-line-clamp`, `-webkit-user-select`, `-webkit-appearance`, etc. are all supported by Blink because Blink forked from WebKit in 2013 and kept the prefixed names. Not a porting issue.

## Question-by-question

### Can Apple WebKit be hosted on Linux/Windows the way WKWebView is on macOS?

Practically, no.

- **WebKitGTK / WPE WebKit** are *the* upstream Linux ports of WebKit. Same JSC + WebCore, but a different platform layer (Cairo/Skia/GStreamer/libsoup vs CoreGraphics/CFNetwork). Feature parity lags Apple WebKit and stability complaints are frequent. Tauri uses WebKitGTK on Linux for this reason.
- **WebKit on Windows (WinCairo / Apple-port)** is largely abandoned for product use. iCloud for Windows has migrated off it to WebView2; only iTunes still ships it. WinCairo provides nightly "MiniBrowser" builds, but it is an embedding harness, not a production-shippable webview. As of Nov 2025 the Windows port team is still working on cross-compilation from Linux via WINE/Proton.

Net: WebKitGTK on Linux is feasible but introduces a third engine variant to test against. Production WebKit on Windows is not a credible option.

### Can we require WSL on Windows and ship Linux?

Technically yes. WSLg (Windows 11 22000+) ships out of the box, achieves ~80–90% native perf, and supports GPU acceleration. WSLg renders Wayland frames over RDP into Windows windows.

Why this is a stopgap, not a strategy:

- Requires Windows 11.
- Requires user to install WSL + a distro before our installer is even relevant.
- Tug.app is positioned as a polished native shell. Telling Windows users "install WSL first" is a credibility hit that will dog the product.
- It does not solve the engine question — we'd still be running WebKitGTK, just over RDP.

Use it as an internal "we got something running" milestone if needed; do not use it as a public Windows product story.

### Was building on WebKit a poor decision?

For the macOS-first phase, no. WKWebView gave us:

- Zero engine bundle (small distribution).
- Native trackpad/scroll/IME behavior, system text-selection menus.
- Immediate Apple-platform integration.
- Lower memory footprint than Electron-on-mac would have given us.

Those were the right things to optimize for in this phase.

For cross-platform inevitability, however, it's a bet against the dominant engine, with two specific costs:

1. **contenteditable.** Both engines have ugly contenteditable behavior, but Blink's is more battle-tested and more permissive. Safari has stricter selection validation, the caret-jumps-to-start-on-React-rerender bug, and divergent focus-on-Selection-API behavior. Every serious rich-text effort (ProseMirror, Slate, Lexical, etc.) talks about WebKit-specific workarounds. `safari-focus-shift.ts` is the canary.
2. **Engine fragmentation when going cross-platform.** WebKit-everywhere gives WebKitGTK divergence on Linux and nothing on Windows. Chromium-everywhere gives one engine to test against on every platform.

Conclusion: not a poor decision *yet*, but it's a decision with an expiration date if cross-platform is a real goal.

## The path forward — Option C (current lean)

### Option C — Native shell per platform, no shared shell framework

Each platform gets a purpose-built native host that speaks the same JS bridge contract to tugdeck. The shells share nothing structural with each other — only the bridge contract and the Rust binaries they spawn.

- **macOS:** Swift + AppKit + WKWebView (current `tugapp/`, unchanged).
- **Windows:** C++ / C# / Rust + Win32 + WebView2.
- **Linux:** C / Vala / Rust + GTK + WebKitGTK.

The cross-platform "shared codebase" is precisely what's in `tugdeck/` and `tugrust/`. The shells are honest, thin adapters: they host a webview, expose a bridge, spawn subprocesses, build menus. They don't pretend to be anything more.

The reasoning:

- **Tauri's "abstraction" is leaky in practice.** Real Tauri apps are full of `#[cfg(target_os = "...")]` blocks. The "one Rust API works on all three platforms" pitch is aspirational; the reality is "structured platform-specific code with shared API names." Menu construction has macOS vs Windows vs Linux quirks. Window decorations behave differently. WebView preferences leak through (`WebContext` is GTK-specific, user-agent semantics differ per platform). Clipboard plugin behavior on Wayland vs X11 diverges. If you're writing platform-specific code anyway, the framework tax buys you less than it claims.
- **The shells are small.** `tugapp/` is ~1,400 lines for the core three Swift files. A Win32+WebView2 host is in the same range. A GTK+WebKitGTK host is in the same range. We're not talking about a year of work per platform — a few weeks of competent platform-native code per platform, on a deferred timeline that already exists.
- **The actual cross-platform code is `tugdeck/` and `tugrust/`.** Every shell speaks the same JS bridge contract to the same React app and spawns the same Rust binaries. As long as the contract holds, the host language is irrelevant. This is *cleaner* architecture than "use Tauri" — the cross-platform-ness lives where it should (in the shared business logic), and the shells are honest about being platform-specific instead of pretending to be unified.
- **Each shell uses the language most natural for its platform.** Swift+AppKit is the right way to write a Mac app. Windows is best served by something that integrates with Win32 and the WebView2 SDK natively (C++ or C#, or Rust via `windows-rs` + `webview2-rs`). Linux is best served by GTK-native code. Each platform gets first-class treatment instead of a forced-uniform second-class abstraction.
- **AI-assisted coding has changed the calculus.** The historical argument for adopting a cross-platform framework was *"a small team can't possibly maintain three platform-specific codebases."* That argument was valid five years ago, and arguably even eighteen months ago. It is no longer load-bearing. LLM coding assistants can produce competent Win32+WebView2 hosts and GTK+WebKitGTK hosts in days, not months. MSI installer authoring, NSIS scripts, .deb/.rpm packaging, AppImage builders, Sparkle/WinSparkle integration — all the pipeline work that used to require a dedicated DevOps engineer or a framework's accumulated infrastructure — is now well within what an LLM can scaffold and maintain on demand. The reason to outsource pipeline work to a framework like Tauri was that doing it yourself was prohibitive. It isn't anymore. This is a recent and material change in the build-vs-adopt tradeoff.

The costs are real and worth naming honestly:

- **Three host codebases to maintain.** Mac (Swift, existing), Windows (TBD language), Linux (TBD language). No shared shell code; bug fixes and feature additions happen per-platform.
- **Three build/sign/package pipelines.** Notarization on Mac (existing), Authenticode + WiX/NSIS on Windows, .deb/.rpm/AppImage on Linux. Each is its own learning curve; AI assistance helps but doesn't eliminate.
- **Auto-updater per platform.** Sparkle on Mac, WinSparkle on Windows, AppImageUpdate or custom on Linux. Tug doesn't have an auto-updater on any platform today, so this work exists under any option — Option C just means doing it three times instead of once-via-framework.
- **Platform API churn over time.** Win32 SDK updates, WebView2 version bumps, GTK 4→5 migrations. Without a framework absorbing these, the team handles them directly (with AI assistance).
- **No plugin ecosystem.** Tauri's clipboard / shell / dialog / fs plugins don't exist for you. Equivalents are routine API calls on each platform, but they're still LOC.

Pros (the inverse of those costs being acceptable):

- **Maximum native polish on every platform.** Each shell uses its OS the way that OS wants to be used.
- **No framework abstraction tax.** No `cfg` blocks navigating around Tauri's opinions; just write the platform code directly. No Tauri release-cycle dependency.
- **Leanest possible result.** No Tauri runtime, no Wry layer, no Tao layer. Just your code calling system APIs.
- **Independent platform release cadences.** A Linux GTK regression doesn't block a Windows release; a WebView2 issue doesn't block Mac.
- **Philosophically aligned with the original architecture choices.** The reasons WKWebView was chosen on Mac (lean, native, OS-supplied engine, no framework freight) generalize naturally to "do the same thing on Win and Linux."

### Option B — Native Swift host on macOS, Tauri 2 on Windows and Linux (alternative)

Keep the existing `tugapp/` Swift+WKWebView host as-is on macOS. Use Tauri only on the platforms that don't have a working native shell yet.

- Pros vs C: Single language (Rust) for the two new shells. Tauri's bundler, signing pipeline, and auto-updater are wired in for Win/Linux. Tauri's plugin ecosystem (dialog, shell, clipboard, fs) provides cross-platform implementations. Less per-platform pipeline DIY.
- Cons vs C: Tauri's abstractions are leaky enough that you write platform-specific code anyway. Framework version churn (1.x→2.x was a substantial migration). Tauri's opinions on permissions/capabilities are imposed on a setup that doesn't need them. Win/Linux shells are mediated through a framework when they could be direct.

**Reconsider trigger from C → B:** if writing the Win/Linux shells from scratch turns out to be substantially harder than expected (e.g., MSI authoring, code signing, or AppImage builds become quagmires that AI assistance can't unblock cleanly), retreat to B.

### Option A — Tauri 2 on every platform (further alternative)

Tauri 2's default model: WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux. One Rust shell everywhere.

- Pros vs C and B: Single host codebase. Single build pipeline. Single test matrix on the native side. No drift risk between shells.
- Cons vs C and B: Throws away the working Swift host on Mac. Tauri-on-mac loses precise `NSApplicationDelegate` lifecycle semantics (the will/did pairs, NSApp hide/unhide) without per-platform AppKit shims. `TestHarnessBridge.swift` would need a Tauri-side rewrite. Mac becomes a Tauri target rather than a native target. Inherits all of Tauri's framework tax on the platform that already has a working native solution.

**Reconsider trigger from C/B → A:** if maintaining two or three separate host shells turns out to produce real user-visible bug drift across platforms (Mac-only or Win-only regressions piling up), revisit.

## Concrete actions for the next few weeks

These are cheap, do not yet commit to a port timeline, and apply equally well under any of the three options.

1. **Build an engine-portability scorecard against the three target engines.** For each major UI surface (prompt entry, tug-editor, tug-pane, gallery cards, contenteditable areas), note behavior on Apple WebKit (current Mac), Chromium (Windows via WebView2), and WebKitGTK (Linux). Treat the existing shim files as a first inventory of where Apple-WebKit quirks already bite. This becomes the migration risk doc.
2. **Sanity-check the frontend in Chrome and Edge today.** tugdeck is just a Vite app — point a browser at the dev server and capture regressions. That list is the "what would Win/Linux actually break" delta. Cheap, decisive data, and approximates WebView2 closely enough for first-pass triage.
3. **Draw a hard line around the bridge.** Funnel all `window.webkit.messageHandlers` references through one `nativeBridge.ts` module so each shell has exactly one JS-side file implementing the bridge contract. Right now it leaks into 4–5 files. Under Option C this is critical, not just nice — the contract is *the* cross-platform abstraction; it has to be explicit, named, and version-able.
4. **No new WebKit-only escape hatches without a Chromium / WebKitGTK plan.** Anything added that's Apple-WebKit-only (CSS feature with no Blink equivalent, an Apple-only API) gets called out and paid down or has a documented fallback for the other two engines.
5. **Defer the actual Win/Linux port work** until the macOS component library stabilizes. One more cycle of macOS feature-completeness, *then* port.

## Decisions still open

- **Port timing.** Win/Linux work is deferred until the macOS component library stabilizes. Trigger date is not set.
- **Final commitment between Options C, B, and A.** Lean is C, but the call gets revisited when the port actually starts. Build a Win shell prototype first (a few weeks of work) and let the actual experience inform whether to continue with C, retreat to B, or unify under A.
- **Host language(s) for Win/Linux under Option C.** Candidates: C++ + Win32 + WebView2 SDK (most direct, ugliest), C# + WinUI 3 + WebView2 (most idiomatic Windows, brings .NET runtime), Rust + `windows-rs` + `webview2-rs` (consistent with the rest of the stack, more verbose). Linux candidates: Rust + `gtk-rs` + `webkit2gtk-rs`, or C/Vala + GTK directly. Decision deferred until prototyping starts.
- **Linux distribution model** (Flatpak / AppImage / native `.deb` and `.rpm`).
- **Windows installer / signing strategy** (MSI vs MSIX, Authenticode certificate sourcing).
- **Auto-updater architecture.** Tug has none today. Will need one before public Win/Linux release. Sparkle on Mac is the obvious choice; Win/Linux choices depend on Option B vs C.
- **Tauri-side test harness shape (only relevant under Option A or B).** `TestHarnessBridge.swift` is Mac-only today; a Win/Linux equivalent for app-test parity needs designing but doesn't have to be Tauri-flavored — it can be a separate Rust crate called by every shell.
- **Bridge-rename cadence.** Whether to migrate JS callers off `window.webkit.messageHandlers` proactively (action item #3) before any other shell exists, or do it as part of the port itself.

These can be decided 3–6 months from now with much better information. The point of this doc is to keep those future decisions *cheap* by capping current lock-in and naming the architectural lean clearly so day-to-day work doesn't drift away from it.

## References

- [Tauri Webview Versions](https://v2.tauri.app/reference/webview-versions/)
- [Wry — Tauri's webview library](https://github.com/tauri-apps/wry)
- [Tauri vs Electron 2026](https://tech-insider.org/tauri-vs-electron-2026/)
- [DoltHub: Electron vs Tauri](https://www.dolthub.com/blog/2025-11-13-electron-vs-tauri/)
- [WebKit Windows port update — Nov 2025](https://iangrunert.com/2025/11/06/webkit-windows-port-update-november-2025)
- [WebKit Windows Port docs](https://docs.webkit.org/Ports/WindowsPort.html)
- [WebKit Ports overview](https://docs.webkit.org/Ports/Introduction.html)
- [WebKitGTK stability concerns (Tauri discussion #8524)](https://github.com/orgs/tauri-apps/discussions/8524)
- [WSLg 2.0 performance benchmarks](https://markaicode.com/wslg-2-ubuntu-gui-app-performance-benchmarks/)
- [Run Linux GUI apps with WSL — Microsoft Learn](https://learn.microsoft.com/en-us/windows/wsl/tutorials/gui-apps)
- [contenteditable in Safari/WebKit — caret bug](https://www.codegenes.net/blog/caret-position-reverts-to-start-of-contenteditable-span-on-re-render-in-react-in-safari-and-firefox/)
- [ContentEditable — The Good, the Bad and the Ugly](https://medium.com/content-uneditable/contenteditable-the-good-the-bad-and-the-ugly-261a38555e9c)
- [Browser Engines 2025: Blink, Gecko, WebKit](https://digitechbytes.com/tech-basics-evergreen-fundamentals/browser-engines-2025/)
