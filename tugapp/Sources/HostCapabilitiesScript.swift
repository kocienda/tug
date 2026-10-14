import WebKit

/// Tells the shell page what this host can do before any of its script runs.
///
/// The shell decides at its first spawn whether a Session card becomes a body,
/// and its startup restore can reach that decision before any message the host
/// sends could land. So the answer is not a message: it is a `WKUserScript` at
/// `atDocumentStart`, the way `__tugTestMode` is injected, setting
/// `window.__tugHostCapabilities` before the page's first module evaluates.
/// Installed into the shell's configuration only; a body never decides.
enum HostCapabilitiesScript {
    static func install(into config: WKWebViewConfiguration, bodyViews: Bool) {
        let script = WKUserScript(
            source: "window.__tugHostCapabilities = Object.freeze({ bodyViews: \(bodyViews) });",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(script)
    }
}
