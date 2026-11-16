import AppKit
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
/// - A notification asks macOS for permission the first time one is posted,
///   not at launch: a user who never turns the switch on is never asked.
///   Each card holds at most one notification per event — a newer one
///   replaces the older — and clicking one brings Tug forward and opens the
///   card through the shell's `focus-session-card` action, the same one a
///   Workspaces row sends.
final class SessionNotifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = SessionNotifier()

    /// The `userInfo` key carrying the card a notification opens.
    private static let cardIdKey = "cardId"

    /// Sends a control action to the shell; installed by `AppDelegate`.
    var sendControl: ((String, ControlParams) -> Void)?

    /// Whether a refusal has been logged, so a user who said no is not
    /// logged at on every event.
    private var loggedDenied = false

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
                        TugLog.info("notify", "macOS notifications not allowed", [
                            TugLog.field("error", error.map { String(describing: $0) } ?? "denied"),
                        ])
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
                center.add(request) { error in
                    guard let error else { return }
                    TugLog.info("notify", "notification post failed", [
                        TugLog.field("error", String(describing: error)),
                    ])
                }
            }
        }
    }

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
        let cardId = response.notification.request.content.userInfo[Self.cardIdKey] as? String
        DispatchQueue.main.async { [weak self] in
            NSApp.activate()
            if let cardId, response.actionIdentifier == UNNotificationDefaultActionIdentifier {
                self?.sendControl?("focus-session-card", ["cardId": cardId])
            }
            completionHandler()
        }
    }
}
