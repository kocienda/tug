// tugembed — Tug's on-device sentence embedder.
//
// tugcast spawns one of these and speaks JSON lines to it over stdin and stdout.
// It is a helper rather than part of Tug.app because embedding is CPU work that
// must never ride the app's main process, and because headless tugcast and the
// test suites need embeddings with no app running. NaturalLanguage ships with
// macOS, so this adds no model bytes to the bundle and needs no account.
//
// One object per line, in each direction.
//
//   out, at start and whenever the live model changes:
//     {"event":"model","model":"nl-contextual-r1","dimensions":512}
//     {"event":"model"}                       no model on this machine
//   in:
//     {"id":1,"op":"embed","texts":["a sentence","another"]}
//   out, one per request, in order:
//     {"id":1,"model":"nl-contextual-r1","vectors":[[0.1,...],null]}
//     {"id":1,"error":"no embedding model is available"}
//
// A `null` vector is a text the model could not embed: an empty one, or one in a
// language the model does not cover. The tag names the model and no language,
// because each text's own language is detected here, and a text this is not sure
// of goes through with none rather than being refused.
// Every vector is unit length. A vector belongs to the model named beside it,
// and vectors from two models are not comparable: a caller that sees the model
// event change re-embeds what it holds.
//
// The contextual model is the better one. The static sentence model needs no
// assets, so it is what answers until the contextual assets arrive, if they are
// absent at start. `--static` stays on the static model. Its vectors keep the
// dimension of their language's model, so the `dimensions` announced is the
// English one, and a vector's own length is what says what it is.
//
// End of input ends the process, so a helper never outlives its parent.

import Foundation
import NaturalLanguage

/// How sure the recognizer must be before a language is acted on. Code and short
/// strings read low and wrong, a sha as Portuguese at 0.52, and real prose reads
/// 0.84 and up, so the line falls between them.
let confidentLanguage = 0.8

/// The text's language when the recognizer is sure of it, and nil when it is not.
func detectedLanguage(_ text: String) -> NLLanguage? {
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(text)
    guard let top = recognizer.languageHypotheses(withMaximum: 1).first,
        top.value >= confidentLanguage, top.key != .undetermined
    else { return nil }
    return top.key
}

protocol Embedder {
    var model: String { get }
    var dimensions: Int { get }
    /// The raw vector for one text, or nil when the model has none for it.
    func vector(for text: String) -> [Double]?
}

/// `NLContextualEmbedding`, mean-pooling the token vectors into one.
struct ContextualEmbedder: Embedder {
    let embedding: NLContextualEmbedding

    init?(_ embedding: NLContextualEmbedding) {
        guard embedding.hasAvailableAssets, (try? embedding.load()) != nil else { return nil }
        self.embedding = embedding
    }

    var model: String { "nl-contextual-r\(embedding.revision)" }
    var dimensions: Int { embedding.dimension }

    func vector(for text: String) -> [Double]? {
        let language = detectedLanguage(text)
        if let language, !embedding.languages.contains(language) { return nil }
        guard let result = try? embedding.embeddingResult(for: text, language: language) else {
            return nil
        }
        var sum = [Double](repeating: 0, count: embedding.dimension)
        var tokens = 0
        result.enumerateTokenVectors(in: text.startIndex..<text.endIndex) { vector, _ in
            for (index, value) in vector.enumerated() where index < sum.count {
                sum[index] += value
            }
            tokens += 1
            return true
        }
        guard tokens > 0 else { return nil }
        return sum.map { $0 / Double(tokens) }
    }
}

/// `NLEmbedding.sentenceEmbedding`, which is one call per text and one model per
/// language. A text with no language it is sure of reads as English.
final class StaticEmbedder: Embedder {
    let embedding: NLEmbedding
    private var byLanguage: [NLLanguage: NLEmbedding?]

    init?() {
        guard let embedding = NLEmbedding.sentenceEmbedding(for: .english) else { return nil }
        self.embedding = embedding
        self.byLanguage = [.english: embedding]
    }

    var model: String { "nl-sentence-r\(embedding.revision)" }
    var dimensions: Int { embedding.dimension }

    func vector(for text: String) -> [Double]? {
        model(for: detectedLanguage(text) ?? .english)?.vector(for: text)
    }

    private func model(for language: NLLanguage) -> NLEmbedding? {
        if let known = byLanguage[language] { return known }
        let found = NLEmbedding.sentenceEmbedding(for: language)
        byLanguage.updateValue(found, forKey: language)
        return found
    }
}

/// Scale to unit length. Nil for a vector with no direction to keep, which JSON
/// could not carry either if it held a non-finite value.
func unitLength(_ vector: [Double]) -> [Float]? {
    let norm = vector.reduce(0) { $0 + $1 * $1 }.squareRoot()
    guard norm > 0, norm.isFinite else { return nil }
    return vector.map { Float($0 / norm) }
}

struct Request: Decodable {
    let id: Int?
    let op: String
    let texts: [String]?
}

struct ModelEvent: Encodable {
    let event = "model"
    let model: String?
    let dimensions: Int?
}

struct Vectors: Encodable {
    let id: Int
    let model: String
    let vectors: [[Float]?]
}

struct Failure: Encodable {
    let id: Int?
    let error: String
}

/// Holds the live model and writes every outgoing line. All of it runs on one
/// serial queue, because the assets can arrive while a request is being read.
final class Service {
    private let queue = DispatchQueue(label: "dev.tugapp.tugembed")
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private var live: Embedder?

    func start(staticOnly: Bool) {
        queue.sync {
            live = chooseModel(staticOnly: staticOnly)
            announce()
        }
    }

    func handle(_ line: String) {
        queue.sync {
            autoreleasepool {
                answer(line)
            }
        }
    }

    private func chooseModel(staticOnly: Bool) -> Embedder? {
        guard !staticOnly, let contextual = NLContextualEmbedding(language: .english) else {
            return StaticEmbedder()
        }
        if let ready = ContextualEmbedder(contextual) {
            return ready
        }
        // A machine that has not fetched the assets answers on the static model
        // meanwhile, and moves when they land.
        contextual.requestAssets { [self] result, _ in
            guard result == .available else { return }
            queue.async { [self] in
                guard let ready = ContextualEmbedder(contextual) else { return }
                live = ready
                announce()
            }
        }
        return StaticEmbedder()
    }

    private func announce() {
        write(ModelEvent(model: live?.model, dimensions: live?.dimensions))
    }

    private func answer(_ line: String) {
        guard let request = try? decoder.decode(Request.self, from: Data(line.utf8)) else {
            write(Failure(id: nil, error: "not a request"))
            return
        }
        guard request.op == "embed", let id = request.id, let texts = request.texts else {
            write(Failure(id: request.id, error: "not an embed request with an id and texts"))
            return
        }
        guard let live else {
            write(Failure(id: id, error: "no embedding model is available"))
            return
        }
        let vectors = texts.map { live.vector(for: $0).flatMap(unitLength) }
        write(Vectors(id: id, model: live.model, vectors: vectors))
    }

    private func write(_ message: some Encodable) {
        guard var data = try? encoder.encode(message) else { return }
        data.append(0x0A)
        FileHandle.standardOutput.write(data)
    }
}

let service = Service()
service.start(staticOnly: CommandLine.arguments.contains("--static"))
while let line = readLine() {
    service.handle(line)
}
