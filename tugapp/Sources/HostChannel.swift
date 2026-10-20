import Foundation
import WebKit

/// The page that posted a message, and the view an answer to it goes back to.
enum HostSender {
    case shell(WKWebView)
    case body(BodyViewController.Body)
    /// The overlay page above every card (`BodyViewController.overlayView`).
    case overlay(WKWebView)

    /// The body that posted, or nil for the shell.
    var body: BodyViewController.Body? {
        if case .body(let body) = self { return body }
        return nil
    }

    var replyView: WKWebView {
        switch self {
        case .shell(let view): return view
        case .body(let body): return body.webView
        case .overlay(let view): return view
        }
    }

    var isShell: Bool {
        if case .shell = self { return true }
        return false
    }

    var isOverlay: Bool {
        if case .overlay = self { return true }
        return false
    }
}

/// The one `WKScriptMessageHandler` every page's content controller carries,
/// the one reader of a message's body, and the one way the host calls into a
/// page.
///
/// A page posts the JSON string `postToHost` makes (`host/channel.ts`); its
/// UTF-8 is decoded once by `ToHost.decode(name:data:)`. A body WebKit hands
/// over as a dictionary — `PageFaultScript`'s injected post, or a test that
/// posts an object itself — is serialized once and decoded the same way. A
/// message that does not decode is logged by name and dropped, never
/// defaulted field by field.
///
/// The way back is `send`, which delivers a `ToPage` through its
/// `window.__tugBridge` member, and `call`, which awaits a `PageCall`'s reply
/// (`HostMessages.swift` renders both scripts). Nothing else in the host
/// evaluates script in a page, except to read one (`// host-channel:
/// diagnostic read`, and the harness).
///
/// Holds its window weakly: a content controller retains its handlers, and
/// the window owns the controllers.
final class HostChannel: NSObject, WKScriptMessageHandler {
    private weak var window: MainWindow?

    init(window: MainWindow) {
        self.window = window
    }

    /// Carry every page→host name on `controller`.
    func register(on controller: WKUserContentController) {
        for name in ToHostName.allCases {
            controller.add(self, name: name.rawValue)
        }
    }

    /// Take every page→host name back off `controller`.
    static func unregister(from controller: WKUserContentController) {
        for name in ToHostName.allCases {
            controller.removeScriptMessageHandler(forName: name.rawValue)
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let window else { return }
        // Every page posts to the same names; which page it was decides where
        // the answer goes. A message from a view that is neither the shell nor
        // a body (one already torn down) is dropped.
        guard let sender = window.hostSender(for: message.webView) else {
            NSLog("HostChannel: script message %@ from an unknown view; ignoring", message.name)
            return
        }
        let name = ToHostName(rawValue: message.name)
        if name?.shellOnly == true, !sender.isShell {
            TugLog.warn("bodies", "shell-only message from another page", [
                TugLog.field("name", message.name),
                TugLog.field("card", sender.body?.cardId ?? (sender.isOverlay ? "overlay" : "spare")),
            ])
            return
        }
        if name?.overlayOnly == true, !sender.isOverlay {
            TugLog.warn("bodies", "overlay-only message from another page", [TugLog.field("name", message.name)])
            return
        }
        switch Self.decode(name: message.name, body: message.body) {
        case .success(let decoded):
            window.receive(decoded, from: sender)
        case .failure(let error):
            TugLog.warn("host", "refused", [
                TugLog.field("name", message.name),
                TugLog.field("error", error.description),
            ])
        }
    }

    /// `body` as `name` decodes it. A string is the page's JSON; one that is
    /// not JSON at all is read as the bare string a hand-written post sends.
    static func decode(name: String, body: Any) -> Result<ToHost, HostDecodeError> {
        if let text = body as? String {
            let decoded = ToHost.decode(name: name, data: Data(text.utf8))
            guard case .failure(.notJSON) = decoded,
                  let quoted = try? JSONSerialization.data(withJSONObject: text, options: [.fragmentsAllowed])
            else { return decoded }
            return ToHost.decode(name: name, data: quoted)
        }
        guard let data = try? JSONSerialization.data(withJSONObject: body, options: [.fragmentsAllowed]) else {
            return .failure(.notJSON)
        }
        return ToHost.decode(name: name, data: data)
    }
}

// MARK: - Host → page

extension HostChannel {
    /// Deliver `message` to the page in `webView`. `completion` runs once the
    /// page's member has returned, whether or not the script ran.
    func send(_ message: ToPage, to webView: WKWebView, completion: (() -> Void)? = nil) {
        guard let script = message.script() else {
            TugLog.warn("host", "could not render a message", [TugLog.field("member", message.member.rawValue)])
            completion?()
            return
        }
        webView.evaluateJavaScript(script) { _, error in
            if let error {
                TugLog.warn("host", "send failed", [
                    TugLog.field("member", message.member.rawValue),
                    TugLog.field("error", error.localizedDescription),
                ])
            }
            completion?()
        }
    }

    /// Make `call` in the page in `webView` and await its reply. A page with
    /// no such member answers `.nothing`; a reply that does not decode is
    /// logged and fails as its `HostDecodeError`.
    func call(_ call: PageCall, in webView: WKWebView, completion: ((Result<PageReply, Error>) -> Void)? = nil) {
        guard let source = call.source() else {
            TugLog.warn("host", "could not render a call", [TugLog.field("member", call.member)])
            completion?(.failure(HostDecodeError.typed("could not render \(call.member)")))
            return
        }
        webView.callAsyncJavaScript(source, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let value):
                // WebKit hands the reply over as Foundation values; anything
                // that is not JSON is no reply at all.
                let data = (try? JSONEncoder().encode(JSONValue(any: value) ?? .null)) ?? Data("null".utf8)
                switch PageReply.decode(member: call.member, data: data) {
                case .success(let reply):
                    completion?(.success(reply))
                case .failure(let error):
                    TugLog.warn("host", "refused a reply", [
                        TugLog.field("member", call.member),
                        TugLog.field("reason", error.description),
                    ])
                    completion?(.failure(error))
                }
            case .failure(let error):
                TugLog.warn("host", "call failed", [
                    TugLog.field("member", call.member),
                    TugLog.field("error", error.localizedDescription),
                ])
                completion?(.failure(error))
            }
        }
    }
}
