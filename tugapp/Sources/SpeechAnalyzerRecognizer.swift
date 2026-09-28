import AVFoundation
import Foundation
import Speech

/// The macOS 26 recogniser: `SpeechAnalyzer` with a `SpeechTranscriber`
/// module, on device, with volatile results turned on.
///
/// This is the path almost every user takes, and it is the better one: the
/// older `SFSpeechRecognizer` is a single-utterance API that its own
/// documentation caps at about a minute, while an analyzer runs until it is
/// told to stop. `LegacySpeechRecognizer` exists for macOS 15, which the
/// bundle still supports (`LSMinimumSystemVersion` 15.0).
///
/// **Two shapes here are the SDK's rather than the plan's**, checked against
/// `Speech.swiftinterface` in the macOS 26.2 SDK before a line was written:
/// `bestAvailableAudioFormat(compatibleWith:)` is a static on `SpeechAnalyzer`
/// and not on `SpeechTranscriber`, and `isFinal` comes from an extension on
/// `SpeechModuleResult` rather than from `SpeechTranscriber.Result` itself.
///
/// References: [B01], [B02], [Q02], Table T02, (#host-engine).
@available(macOS 26.0, *)
final class SpeechAnalyzerRecognizer: DictationRecognizer {
    var onTranscript: ((String, Bool) -> Void)?

    private var transcriber: SpeechTranscriber?
    private var analyzer: SpeechAnalyzer?
    private var continuation: AsyncStream<AnalyzerInput>.Continuation?
    private var resultsTask: Task<Void, Never>?

    /// The format the analyzer wants, resolved during `prepare`. Nil means no
    /// conversion — hand the analyzer the tap's own buffers.
    private var analyzerFormat: AVAudioFormat?

    /// Built at the first buffer, because the tap's format is not known until
    /// one arrives and building a converter per buffer would be absurd.
    private var converter: AVAudioConverter?
    private var converterInputFormat: AVAudioFormat?

    /// Everything the transcriber has called final, spelled the way the
    /// reducer will spell it.
    ///
    /// The analyzer reports *per segment*, not cumulatively, so the cumulative
    /// string the reducer wants has to be assembled here. Assembling it with
    /// the same single-space rule the reducer applies is what keeps the two in
    /// step: if this said "helloworld" where the reducer committed "hello
    /// world", every later reading would miss the prefix and be re-derived
    /// past a word boundary instead of simply appended.
    private var finalized = ""

    /// **[Q02] is unresolved, and deliberately not resolved by a guess.**
    ///
    /// The question is whether this path needs `SFSpeechRecognizer.requestAuthorization`.
    /// The framework offers no authorization entry point of its own — the only
    /// one in `Speech` is `SFSpeechRecognizer`'s, and the SDK marks it neither
    /// deprecated nor required here — so the answer is visible only from a
    /// live utterance, which is the one thing no step of this arc performs
    /// ([P06]) and no unsigned command-line probe can stand in for.
    ///
    /// So nothing is requested here, and that is the conservative choice in
    /// the direction that matters: a preemptive request would show every user
    /// a Speech Recognition prompt whether or not the framework wanted one,
    /// while the failure mode of not asking is an error thrown from `start`
    /// that arrives as `refused { error }` with the system's own message on
    /// the button's tooltip. If that message turns out to be an authorization
    /// error, the fix is one call — `SFSpeechRecognizer.requestAuthorization`
    /// ahead of the asset check below, mapping anything but `.authorized` to
    /// `DictationRefusal.speechPermission`, exactly as the legacy adapter
    /// already does. The usage string is declared either way ([B09]).
    func prepare(
        progress: @escaping (Bool) -> Void,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        Task {
            do {
                guard SpeechTranscriber.isAvailable else {
                    throw DictationRefusal.unavailable
                }
                guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: .current)
                else {
                    throw DictationRefusal.noModel
                }

                let transcriber = SpeechTranscriber(
                    locale: locale,
                    transcriptionOptions: [],
                    reportingOptions: [.volatileResults],
                    attributeOptions: []
                )
                self.transcriber = transcriber

                // An asset install is the one part of preparing that can take
                // long enough to need saying. `progress(true)` is what turns
                // into the `preparing` event, and it is sent only when there
                // is actually something to download.
                if let request = try await AssetInventory.assetInstallationRequest(
                    supporting: [transcriber])
                {
                    progress(true)
                    try await request.downloadAndInstall()
                }

                self.analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
                    compatibleWith: [transcriber])

                let stream = AsyncStream<AnalyzerInput> { continuation in
                    self.continuation = continuation
                }

                let analyzer = SpeechAnalyzer(modules: [transcriber])
                self.analyzer = analyzer
                try await analyzer.start(inputSequence: stream)

                self.resultsTask = Task { [weak self] in
                    await self?.readResults(from: transcriber)
                }

                completion(.success(()))
            } catch {
                completion(.failure(error))
            }
        }
    }

    private func readResults(from transcriber: SpeechTranscriber) async {
        do {
            for try await result in transcriber.results {
                let text = String(result.text.characters)
                if result.isFinal {
                    appendFinalized(text)
                    onTranscript?(finalized, true)
                } else {
                    onTranscript?(joined(finalized, text), false)
                }
            }
        } catch {
            // The analyzer's stream failing is the session ending, and the
            // engine hears about that through its own route: a stream that
            // stops reporting is a session the user stops. Nothing is
            // reported as a transcript, because a partial reading is not a
            // thing to insert on the way out.
            TugLog.warn("dictation", "analyzer results failed", [
                TugLog.field("error", error.localizedDescription),
            ])
        }
    }

    func append(_ buffer: AVAudioPCMBuffer) {
        guard let continuation else { return }
        guard let converted = convert(buffer) else { return }
        continuation.yield(AnalyzerInput(buffer: converted))
    }

    func finish() {
        continuation?.finish()
        continuation = nil
        let analyzer = self.analyzer
        Task { try? await analyzer?.finalizeAndFinishThroughEndOfInput() }
        resultsTask?.cancel()
        resultsTask = nil
    }

    // MARK: - Format

    /// The tap's buffer in the analyzer's format, or the buffer itself when
    /// the analyzer asked for nothing in particular.
    private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let target = analyzerFormat else { return buffer }
        if buffer.format == target { return buffer }

        if converter == nil || converterInputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: target)
            converterInputFormat = buffer.format
        }
        guard let converter else { return nil }

        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
        guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
            return nil
        }

        var consumed = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if error != nil { return nil }
        return output.frameLength > 0 ? output : nil
    }

    // MARK: - Spacing

    private func appendFinalized(_ text: String) {
        finalized = joined(finalized, text)
    }

    /// The reducer's spacing rule, applied on this side too so the cumulative
    /// string the reducer receives has `committed` as a literal prefix.
    private func joined(_ head: String, _ tail: String) -> String {
        guard !head.isEmpty, !tail.isEmpty else { return head + tail }
        guard let last = head.last, let first = tail.first else { return head + tail }
        if last.isWhitespace || first.isWhitespace { return head + tail }
        return head + " " + tail
    }
}
