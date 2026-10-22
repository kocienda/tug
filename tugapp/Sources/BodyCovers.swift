import CoreGraphics
import Foundation

/// An evicted card's last frame, kept for the body that brings it back: taken
/// at one point a pixel, a placeholder rather than a document.
struct BodyCover {
    let image: CGImage
    /// The size it was taken at, points: the card's view as it went.
    let size: CGSize
    /// The page's surface as it went, which the cover wears where its frame
    /// does not reach once the pane has grown.
    let surface: CGColor?
    /// The pane's insets within the view as it went.
    let insets: CardInsets?
    /// When it was taken, wall-clock ms, for its age.
    let takenAt: Double
    /// What it holds resident.
    var bytes: Int { image.bytesPerRow * image.height }
}

/// The last frame of each card evicted and not yet asked for again: the
/// cover its next body stands under.
///
/// The map is the covers' only owner. Nothing else holds a kept cover — the
/// aging timer holds when the cover was taken, never the cover — so a cover
/// the map drops, by budget, by age, by a card closed or by critical
/// pressure, frees its image there and then. A clear also refuses every
/// cover taken before it, so a snapshot still answering when critical
/// pressure empties the map cannot put one back.
final class BodyCovers {
    /// Why the map let a cover go on its own.
    enum Drop: String {
        /// The covers together held more than the budget; the oldest went.
        case budget
        /// No body asked for it within the delay it was kept for.
        case aged
    }

    /// What the covers may hold together, in pixel bytes.
    let budgetBytes: Int
    /// Told of each cover the map lets go on its own: its card and why.
    var onDrop: ((String, Drop) -> Void)?
    /// Bumped by every clear: a cover taken in an earlier generation is refused.
    private(set) var generation = 0
    private var held: [String: BodyCover] = [:]
    /// Runs the work after the delay in ms: the main queue in the app.
    private let after: (Double, @escaping () -> Void) -> Void

    init(
        budgetBytes: Int,
        after: @escaping (Double, @escaping () -> Void) -> Void = { ms, work in
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(ms.rounded())), execute: work)
        }
    ) {
        self.budgetBytes = budgetBytes
        self.after = after
    }

    /// The pixel bytes the covers hold together.
    var bytes: Int { held.values.reduce(0) { $0 + $1.bytes } }

    /// Whether `cardId` has a cover kept.
    func has(_ cardId: String) -> Bool { held[cardId] != nil }

    /// Hold `cover` for `cardId`'s next body, unless the map was cleared
    /// since it was taken in `generation`: the oldest covers go first past
    /// the budget, and this one goes once it is older than `agesAfterMs`, a
    /// card that long unasked-for being one the user has left. False when
    /// the cover was refused.
    @discardableResult
    func keep(_ cover: BodyCover, for cardId: String, takenIn generation: Int, agesAfterMs: Double?) -> Bool {
        guard generation == self.generation else { return false }
        held[cardId] = cover
        var total = bytes
        while total > budgetBytes, let oldest = held.min(by: { $0.value.takenAt < $1.value.takenAt }) {
            held.removeValue(forKey: oldest.key)
            total -= oldest.value.bytes
            onDrop?(oldest.key, .budget)
        }
        guard let ms = agesAfterMs else { return true }
        let takenAt = cover.takenAt
        after(ms) { [weak self] in
            guard let self, self.held[cardId]?.takenAt == takenAt else { return }
            self.held.removeValue(forKey: cardId)
            self.onDrop?(cardId, .aged)
        }
        return true
    }

    /// The cover kept for `cardId`, taken out of the map: its next body
    /// stands under it, and the map holds it no longer.
    func take(_ cardId: String) -> BodyCover? { held.removeValue(forKey: cardId) }

    /// Let `cardId`'s cover go: its card is closed.
    func drop(_ cardId: String) { held.removeValue(forKey: cardId) }

    /// Let every cover go, and refuse any taken before now.
    func clear() {
        held.removeAll()
        generation += 1
    }
}
