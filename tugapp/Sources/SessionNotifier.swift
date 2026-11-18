import AppKit
import Security
import UserNotifications

/// The host's half of the Session Notifications settings: the dock bounce
/// and the macOS notification for a session card the user is not watching.
///
/// The shell's watcher (`tugdeck/src/lib/session-notify.ts`) decides that a
/// card finished its turn or needs the user, reads the user's choices for
/// that event, and posts `sessionNotify`. This acts on it, and on one
/// condition of its own: **nothing happens while Tug is the frontmost app.**
/// Both answers are for a user who is somewhere else — AppKit ignores a
/// bounce from an active app anyway, and a banner over the window the user
/// is already reading says what the card's dot and dialog say.
///
/// - `continued` is `NSApp.requestUserAttention(.criticalRequest)`, which
///   bounces until the app is brought forward; `once` is
///   `.informationalRequest`, a single bounce.
/// - A notification asks macOS for permission when the user turns its switch
///   on (`check`, verb `authorize`), and again at a post as a fallback: a
///   user who never turns the switch on is never asked. Each card holds at
///   most one notification per event — a newer one replaces the older — and
///   clicking one brings Tug forward and opens the card through the shell's
///   `focus-session-card` action, the same one a Workspaces row sends.
///
/// **A notification that does not appear has to be explicable from the
/// Settings card.** macOS can accept a post and show nothing — the alert
/// style is None, a Focus is on — and reports neither. So `check` answers the
/// card with what macOS will say (`NotifyStatus`), its `test` verb posts a
/// notification the way a session's is posted and reports whether macOS
/// delivered it, and every post, real or test, writes one `notify` line
/// carrying the settings it was posted under.
///
/// **The test claims only what the host can read.** It goes out after a wait,
/// so the user can switch to another app, and it is held to the rule every
/// notification is: nothing is posted while Tug is frontmost. Whether a
/// banner drew is the user's to see and not something macOS reports, so the
/// answer says delivered or not and never guesses at why nothing appeared.
final class SessionNotifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = SessionNotifier()

    /// The `userInfo` key carrying the card a notification opens.
    private static let cardIdKey = "cardId"

    /// The `userInfo` key marking the Settings card's test notification.
    private static let testKey = "test"

    /// The test notification's identifier: one, so a newer test replaces
    /// the older.
    private static let testIdentifier = "session-test"

    /// How long a test waits before it is posted: the user's time to switch
    /// to another app. The Settings card says the same number.
    private static let testLead: TimeInterval = 5

    /// How long a test waits before asking macOS whether it was delivered.
    private static let testSettle: TimeInterval = 2

    /// Sends a control action to the shell; installed by `AppDelegate`.
    var sendControl: ((String, ControlParams) -> Void)?

    /// Whether a refusal has been logged, so a user who said no is not
    /// logged at on every event.
    private var loggedDenied = false

    /// Whether the test notification was clicked since it was posted. A
    /// clicked notification leaves the delivered list, and it was delivered.
    private var testClicked = false

    /// Become the notification center's delegate. Called at launch, so a
    /// click on a notification posted by an earlier run still reaches us.
    func install() {
        UNUserNotificationCenter.current().delegate = self
    }

    func handle(_ note: SessionNotify) {
        guard !NSApp.isActive else { return }
        switch note.bounce {
        case .continued: NSApp.requestUserAttention(.criticalRequest)
        case .once: NSApp.requestUserAttention(.informationalRequest)
        case .never: break
        }
        if note.notification { post(note) }
    }

    private func post(_ note: SessionNotify) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, error in
            DispatchQueue.main.async {
                guard let self else { return }
                guard granted else {
                    if !self.loggedDenied {
                        self.loggedDenied = true
                        self.log("macOS notifications not allowed", event: note.event.rawValue, error: error)
                    }
                    return
                }
                self.loggedDenied = false
                let content = UNMutableNotificationContent()
                content.title = note.title
                content.body = note.body
                content.sound = .default
                content.threadIdentifier = note.cardId
                content.userInfo = [Self.cardIdKey: note.cardId]
                let request = UNNotificationRequest(
                    identifier: "session-\(note.cardId)-\(note.event.rawValue)",
                    content: content,
                    trigger: nil
                )
                center.add(request) { [weak self] error in
                    self?.log(
                        error == nil ? "notification posted" : "notification post failed",
                        event: note.event.rawValue,
                        error: error
                    )
                }
            }
        }
    }

    // MARK: - The Settings card's questions

    /// Answer the Settings card. `reply` is called exactly once, on any queue.
    ///
    /// An app-test instance only ever reads: it asks macOS for nothing, posts
    /// nothing and opens nothing, so a test that turns a switch on raises no
    /// permission prompt on the machine it runs on.
    func check(_ request: NotifyCheck, reply: @escaping (NotifyStatus) -> Void) {
        let center = UNUserNotificationCenter.current()
        let id = request.requestId
        let verb = InstanceConfig.isAppTest ? .status : request.verb
        switch verb {
        case .status:
            readStatus(id, reply: reply)
        case .settings:
            DispatchQueue.main.async { Self.openSystemSettings() }
            readStatus(id, reply: reply)
        case .authorize:
            center.requestAuthorization(options: [.alert, .sound]) { [weak self] _, error in
                self?.log("permission asked", event: "authorize", error: error)
                self?.readStatus(id, reply: reply)
            }
        case .test:
            center.requestAuthorization(options: [.alert, .sound]) { [weak self] granted, error in
                guard let self else { return }
                guard granted else {
                    self.log("test refused", event: "test", error: error)
                    self.readStatus(id, test: .failed, error: "macOS does not allow notifications from Tug.", reply: reply)
                    return
                }
                self.postTest(id, reply: reply)
            }
        }
    }

    /// Wait out the lead, post the test notification unless Tug is still
    /// frontmost, wait for macOS to settle it, and report whether it was
    /// delivered.
    private func postTest(_ id: String, reply: @escaping (NotifyStatus) -> Void) {
        let center = UNUserNotificationCenter.current()
        let content = UNMutableNotificationContent()
        content.title = "Tug test notification"
        content.body = "This is how Tug tells you about a session."
        content.sound = .default
        content.userInfo = [Self.testKey: true]
        let request = UNNotificationRequest(identifier: Self.testIdentifier, content: content, trigger: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.testLead) { [weak self] in
            guard let self else { return }
            guard !NSApp.isActive else {
                self.log("test not posted: frontmost", event: "test", error: nil)
                self.readStatus(id, test: .frontmost, reply: reply)
                return
            }
            self.testClicked = false
            center.add(request) { [weak self] error in
                guard let self else { return }
                if let error {
                    self.log("test post failed", event: "test", error: error)
                    self.readStatus(id, test: .failed, error: error.localizedDescription, reply: reply)
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.testSettle) {
                    center.getDeliveredNotifications { delivered in
                        let listed = delivered.contains { $0.request.identifier == Self.testIdentifier }
                        DispatchQueue.main.async {
                            let outcome: NotifyStatus.Test = (listed || self.testClicked) ? .delivered : .dropped
                            self.log("test \(outcome.rawValue)", event: "test", error: nil)
                            self.readStatus(id, test: outcome, reply: reply)
                        }
                    }
                }
            }
        }
    }

    /// Read macOS's settings for Tug and answer with them.
    private func readStatus(
        _ id: String,
        test: NotifyStatus.Test = .none,
        error: String = "",
        reply: @escaping (NotifyStatus) -> Void
    ) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            reply(NotifyStatus(
                requestId: id,
                authorization: Self.authorization(settings.authorizationStatus),
                banners: Self.banners(alert: settings.alertSetting, style: settings.alertStyle),
                test: test,
                error: error
            ))
        }
    }

    /// Tug's pane in System Settings › Notifications.
    private static func openSystemSettings() {
        let id = Bundle.main.bundleIdentifier ?? ""
        guard let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)") else { return }
        NSWorkspace.shared.open(url)
    }

    // MARK: - What macOS says, in the card's words

    /// A provisional grant delivers, so it reads as authorized; a status this
    /// build does not know reads as not yet asked.
    static func authorization(_ status: UNAuthorizationStatus) -> NotifyStatus.Authorization {
        switch status {
        case .authorized, .provisional: return .authorized
        case .denied: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .notDetermined
        }
    }

    /// Whether a notification draws on screen: alerts on, and a style other
    /// than None.
    static func banners(alert: UNNotificationSetting, style: UNAlertStyle) -> Bool {
        alert == .enabled && style != .none
    }

    // MARK: - The log line

    /// One `notify` line: what happened, and the settings it happened under.
    private func log(_ message: String, event: String, error: Error?) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            var fields = [
                TugLog.field("event", event),
                TugLog.field("authorization", Self.authorization(settings.authorizationStatus).rawValue),
                TugLog.field("alert", Self.name(settings.alertSetting)),
                TugLog.field("style", Self.name(settings.alertStyle)),
                TugLog.field("center", Self.name(settings.notificationCenterSetting)),
                TugLog.field("sound", Self.name(settings.soundSetting)),
                TugLog.field("signing", Self.signing),
            ]
            if let error { fields.append(TugLog.field("error", String(describing: error))) }
            TugLog.info("notify", message, fields)
        }
    }

    private static func name(_ setting: UNNotificationSetting) -> String {
        switch setting {
        case .enabled: return "enabled"
        case .disabled: return "disabled"
        case .notSupported: return "notSupported"
        @unknown default: return "unknown"
        }
    }

    private static func name(_ style: UNAlertStyle) -> String {
        switch style {
        case .none: return "none"
        case .banner: return "banner"
        case .alert: return "alert"
        @unknown default: return "unknown"
        }
    }

    /// How the running bundle is signed: `adhoc` for a build with no
    /// identity, whose code identity changes at every rebuild; `identified`
    /// otherwise; `unknown` when the signature cannot be read.
    private static let signing: String = {
        var code: SecCode?
        guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return "unknown" }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return "unknown" }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let flags = (info as NSDictionary?)?[kSecCodeInfoFlags] as? NSNumber
        else { return "unknown" }
        return flags.uint32Value & SecCodeSignatureFlags.adhoc.rawValue != 0 ? "adhoc" : "identified"
    }()

    // MARK: - UNUserNotificationCenterDelegate

    /// A notification arriving while Tug is frontmost — the user came back
    /// between the post and its delivery — shows nothing: they are here.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([])
    }

    /// A click: bring Tug forward and open the card the notification names.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let cardId = userInfo[Self.cardIdKey] as? String
        let isTest = userInfo[Self.testKey] as? Bool == true
        DispatchQueue.main.async { [weak self] in
            if isTest { self?.testClicked = true }
            NSApp.activate()
            if let cardId, response.actionIdentifier == UNNotificationDefaultActionIdentifier {
                self?.sendControl?("focus-session-card", ["cardId": cardId])
            }
            completionHandler()
        }
    }
}
