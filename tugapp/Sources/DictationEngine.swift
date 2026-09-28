import AVFoundation
import Foundation

/// A recogniser, as the engine needs one.
///
/// Two of these exist — `SpeechAnalyzerRecognizer` for macOS 26 and up,
/// `LegacySpeechRecognizer` below it — and the engine cannot tell them apart.
/// Both report the recogniser's *whole current reading* and a final flag, and
/// nothing else: the transcript arithmetic is `DictationTranscriptReducer`'s,
/// which is the one part of dictation a test can reach (Risk R01). An adapter
/// that computed its own deltas would be a second reducer nothing tests.
///
/// `prepare` fails with an `Error`. A `DictationRefusal` thrown as itself is a
/// condition the adapter recognised and mapped (Table T02); anything else is
/// an SDK error the engine reports as `refused { error }` with its
/// `localizedDescription`, which is Table T02's last row.
protocol DictationRecognizer: AnyObject {
    /// Get ready to listen. `progress(true)` says work is happening that the
    /// user should be told about — an asset download, in practice — and the
    /// engine turns it into a `preparing` event.
    func prepare(progress: @escaping (Bool) -> Void, completion: @escaping (Result<Void, Error>) -> Void)
    /// One buffer off the input tap.
    func append(_ buffer: AVAudioPCMBuffer)
    /// No more audio is coming. Late results are the engine's to drop.
    func finish()
    /// The whole current reading, and whether it is settled. Called on
    /// whatever queue the recogniser feels like; the engine hops.
    var onTranscript: ((_ cumulativeText: String, _ isFinal: Bool) -> Void)? { get set }
}

/// The one microphone, the one live dictation session, and the mapping from
/// what the host can fail at to what the deck's button can say.
///
/// One session at a time, ever. A second `start` supersedes the first rather
/// than queueing behind it or running beside it, because the deck's rule is
/// that one composer holds the mic and the host is where that is enforced —
/// a deck that lost track (a reload, a crashed card) must not be able to
/// leave two taps on the input node.
///
/// Every state mutation here happens on the main queue. `handle` is called
/// from the `WKScriptMessage` handler, which is main; the audio and recogniser
/// callbacks arrive on arbitrary queues and hop before they touch anything.
/// That is not tidiness: `emit` ends in `evaluateJavaScript`, which is main-only.
///
/// References: [P01] harness no-audio, [P02] one protocol, [P06] no automated
/// mic, Spec S01, Spec S02, Spec S03, Table T02, Risk R02, (#host-engine).
final class DictationEngine {
    /// True under the app-test harness, where the microphone is never
    /// engaged ([P01]). A `start` records its id and answers `ready`, a
    /// `stop` answers `ended { stopped }`, and a second `start` supersedes the
    /// first — so the ordering rules in Spec S03 are exercisable by a test
    /// that makes no sound and asks for no permission ([P06]).
    private let audioDisabled: Bool

    /// Where an event goes. `MainWindow` supplies the closure that pushes it
    /// across the bridge.
    private let emit: (DictationEvent) -> Void

    /// The session the engine is working on, from the moment `start` is
    /// accepted until its terminal event. Every asynchronous continuation
    /// guards on it: a permission sheet or an asset download that finishes
    /// after the session was superseded or stopped lands nowhere.
    private var liveId: String?

    /// The recogniser for `liveId`, or nil in no-audio mode and while the
    /// session is still being prepared.
    private var recognizer: DictationRecognizer?

    /// The transcript arithmetic for `liveId`. Reset at every accepted start.
    private var reducer = DictationTranscriptReducer()

    /// Built at the first real start and kept, because building one is not
    /// free and a user who dictates once will dictate again.
    private var audioEngine: AVAudioEngine?

    /// True while a tap is installed, so teardown removes it exactly once —
    /// `removeTap` on a bus with no tap is a no-op, but the bookkeeping is
    /// what tells `teardown` whether the engine is running at all.
    private var tapInstalled = false

    /// The route-change observation, alive only while a session is.
    private var configObserver: NSObjectProtocol?

    init(audioDisabled: Bool, emit: @escaping (DictationEvent) -> Void) {
        self.audioDisabled = audioDisabled
        self.emit = emit
    }

    // MARK: - The deck's two verbs

    /// Spec S01's message, arrived. An unreadable verb is logged and dropped
    /// rather than guessed at.
    func handle(verb: String, id: String) {
        switch verb {
        case "start":
            start(id)
        case "stop":
            stop(id)
        default:
            TugLog.warn("dictation", "unknown verb; ignoring", [
                TugLog.field("verb", verb),
                TugLog.field("id", id),
            ])
        }
    }

    /// Tear everything down without emitting. For `MainWindow`'s teardown,
    /// where the deck is going away and has nobody left to tell.
    func shutdown() {
        recognizer?.finish()
        teardown()
        liveId = nil
    }

    // MARK: - Starting

    private func start(_ id: String) {
        // The supersede rule first, and synchronously: A's terminal event is
        // on the wire before anything of B's, so the deck never sees two
        // sessions overlap even by one event.
        if let previous = liveId {
            recognizer?.finish()
            teardown()
            liveId = nil
            send(.ended(previous, .superseded))
        }

        liveId = id
        reducer = DictationTranscriptReducer()

        if audioDisabled {
            // No device, no permission, no recogniser. The session exists,
            // answers `ready`, and can be stopped or superseded — which is
            // the whole of what an automated test needs from it ([P01]).
            send(.plain(id, .ready))
            return
        }

        let engine = audioEngine ?? AVAudioEngine()
        audioEngine = engine

        // Before asking for permission, because a machine with no input at
        // all should say so rather than put up a sheet the user cannot make
        // useful.
        guard engine.inputNode.inputFormat(forBus: 0).channelCount > 0 else {
            refuse(id, .noInputDevice)
            return
        }

        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            DispatchQueue.main.async {
                guard let self, self.liveId == id else { return }
                guard granted else {
                    self.refuse(id, .microphonePermission)
                    return
                }
                self.prepareRecognizer(id)
            }
        }
    }

    private func prepareRecognizer(_ id: String) {
        let recognizer: DictationRecognizer
        if #available(macOS 26.0, *) {
            recognizer = SpeechAnalyzerRecognizer()
        } else {
            recognizer = LegacySpeechRecognizer()
        }
        self.recognizer = recognizer

        recognizer.onTranscript = { [weak self] cumulative, isFinal in
            DispatchQueue.main.async {
                self?.consume(id: id, cumulative: cumulative, isFinal: isFinal)
            }
        }

        recognizer.prepare(
            progress: { [weak self] busy in
                DispatchQueue.main.async {
                    guard let self, self.liveId == id, busy else { return }
                    self.send(.plain(id, .preparing))
                }
            },
            completion: { [weak self] result in
                DispatchQueue.main.async {
                    guard let self, self.liveId == id else { return }
                    switch result {
                    case .failure(let error):
                        let (refusal, message) = Self.refusal(from: error)
                        self.refuse(id, refusal, message: message)
                    case .success:
                        self.listen(id)
                    }
                }
            }
        )
    }

    /// Tap, run, and say so. The last step of a start, and the only one that
    /// can still fail after the recogniser said it was ready.
    private func listen(_ id: String) {
        guard let engine = audioEngine, let recognizer else {
            refuse(id, .unavailable)
            return
        }

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
            recognizer.append(buffer)
        }
        tapInstalled = true

        // A route change — headphones out, an interface unplugged — stops the
        // engine under us, and a tap on a dead node reports nothing forever.
        // Ending the session is the honest answer: the deck puts the button
        // back and the user can press it again on whatever device is now
        // there (Risk R02).
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: .main
        ) { [weak self] _ in
            guard let self, self.liveId == id else { return }
            self.recognizer?.finish()
            self.teardown()
            self.liveId = nil
            self.send(.ended(id, .deviceLost))
        }

        do {
            engine.prepare()
            try engine.start()
        } catch {
            refuse(id, .error, message: error.localizedDescription)
            return
        }

        send(.plain(id, .ready))
    }

    // MARK: - Running and stopping

    private func consume(id: String, cumulative: String, isFinal: Bool) {
        guard liveId == id else { return }
        for output in reducer.feed(cumulative: cumulative, isFinal: isFinal) {
            send(.text(id, output.kind, output.text))
        }
    }

    /// A `stop` for the live id. A `stop` for any other id is ignored — the
    /// deck posts one per session and a stale one must not reach a session
    /// that superseded it.
    private func stop(_ id: String) {
        guard liveId == id else { return }

        recognizer?.finish()
        _ = reducer.finish()
        teardown()
        liveId = nil
        send(.ended(id, .stopped))

        // Anything the recogniser reports after this arrives with `liveId`
        // already nil and is dropped, which is Spec S03 rule 5: a tail the
        // recogniser never called final is not text the user asked to keep,
        // and nothing may follow `ended` on the wire either way.
    }

    private func refuse(_ id: String, _ refusal: DictationRefusal, message: String? = nil) {
        recognizer?.finish()
        teardown()
        liveId = nil
        send(.refused(id, refusal, message: message))
    }

    /// Give the microphone back. Safe to call with nothing running.
    private func teardown() {
        if let configObserver {
            NotificationCenter.default.removeObserver(configObserver)
            self.configObserver = nil
        }
        if let audioEngine {
            if tapInstalled {
                audioEngine.inputNode.removeTap(onBus: 0)
                tapInstalled = false
            }
            if audioEngine.isRunning { audioEngine.stop() }
        }
        recognizer?.onTranscript = nil
        recognizer = nil
    }

    // MARK: - Plumbing

    /// Table T02's last row: a condition an adapter recognised travels as a
    /// `DictationRefusal`, and anything else is an SDK error the user is told
    /// about in its own words.
    private static func refusal(from error: Error) -> (DictationRefusal, String?) {
        if let refusal = error as? DictationRefusal { return (refusal, nil) }
        return (.error, error.localizedDescription)
    }

    /// Every event out of here goes through this, so every event is logged
    /// once and delivered on main. The log line is `dictation <id> <kind>`,
    /// which is what a session's whole lifecycle reads as in `tugapp.log` —
    /// and what Step 2's checkpoint reads to confirm a mere boot touches
    /// nothing.
    private func send(_ event: DictationEvent) {
        let emit = self.emit
        DispatchQueue.main.async {
            TugLog.debug("dictation", "\(event.id) \(event.kind.rawValue)")
            emit(event)
        }
    }
}
