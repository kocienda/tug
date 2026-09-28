import AVFoundation
import Foundation
import Speech

/// The macOS 15 recogniser: `SFSpeechRecognizer` with on-device recognition
/// required and partial results asked for.
///
/// It exists because the bundle's `LSMinimumSystemVersion` is 15.0 and
/// `SpeechAnalyzer` is 26.0. On any machine that has the analyzer, this file
/// is never constructed.
///
/// `requiresOnDeviceRecognition = true` is not a preference. Dictation sends
/// the user's prompt text somewhere, and the only somewhere Tug is willing to
/// send it is this Mac; a recogniser that would fall back to a server is one
/// that refuses instead, through `supportsOnDeviceRecognition` below.
///
/// **[Q01] is deferred:** whether this path delivers partials on a real
/// macOS 15 machine, and how it paces them, is unknown — the arc ran on
/// macOS 27. The failure mode is benign either way. If partials never arrive
/// the user sees nothing until the recogniser finalizes, which is a worse
/// dictation rather than a broken one, and the deck side does not change
/// ([P02]).
///
/// References: [Q01], Table T02, (#host-engine).
final class LegacySpeechRecognizer: DictationRecognizer {
    var onTranscript: ((String, Bool) -> Void)?

    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    /// True once any result has arrived, so an error can be told apart from a
    /// failure to start: an error before the first result is a session that
    /// never worked, and one after it is a session that ended.
    private var sawResult = false

    func prepare(
        progress: @escaping (Bool) -> Void,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        guard let recognizer = SFSpeechRecognizer(locale: .current) else {
            completion(.failure(DictationRefusal.unavailable))
            return
        }
        guard recognizer.supportsOnDeviceRecognition else {
            completion(.failure(DictationRefusal.noModel))
            return
        }
        self.recognizer = recognizer

        // Unlike the analyzer path, this one has a documented authorization
        // gate and the usage string that goes with it, so it is asked for
        // here rather than left to fail later.
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else {
                    completion(.failure(DictationRefusal.speechPermission))
                    return
                }
                self.startTask(on: recognizer, completion: completion)
            }
        }
    }

    private func startTask(
        on recognizer: SFSpeechRecognizer,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        self.request = request

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                self.sawResult = true
                self.onTranscript?(result.bestTranscription.formattedString, result.isFinal)
                return
            }
            if let error, !self.sawResult {
                // Nothing has been reported and nothing will be. The engine
                // has already been told the session is ready, so this arrives
                // as a log line rather than a refusal — the user's recourse
                // is the button, which is still there.
                TugLog.warn("dictation", "legacy recognition failed before any result", [
                    TugLog.field("error", error.localizedDescription),
                ])
            }
        }

        completion(.success(()))
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        request?.append(buffer)
    }

    func finish() {
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
    }
}
