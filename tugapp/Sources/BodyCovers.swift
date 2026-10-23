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

    /// The same frame, taken as of `ms`: a cover kept again ages from its
    /// second keeping, and the first keeping's timer leaves it alone.
    func retaken(at ms: Double) -> BodyCover {
        BodyCover(image: image, size: size, surface: surface, insets: insets, takenAt: ms)
    }
}

/// Every cover a body can stand under, and the last frame of each card
/// evicted and not yet asked for again.
///
/// A cover is in one of two accounts of one budget. **Kept**: an evicted
/// card's last frame, waiting for the body that brings it back. The kept
/// map is that cover's only owner — the aging timer holds when the cover was
/// taken, never the cover — so a cover it drops, by budget, by age, by a
/// card closed or by critical pressure, frees its image there and then. A
/// clear also refuses every cover taken before it, so a snapshot still
/// answering when critical pressure empties the map cannot put one back.
///
/// **Standing**: a cover over a body, for one or both of the reasons a body
/// stands under one — brought back from an eviction until its page paints,
/// or carried through a crossing until its track lands. A body stands under
/// at most one cover whatever the reasons, so a crossing asked for on a body
/// already covered takes the standing cover rather than a second snapshot,
/// and the cover comes off at whichever of its ends is later. A standing
/// cover is on screen, so neither the budget nor a clear takes it; its bytes
/// still count, and a kept cover gives way to them.
final class BodyCovers {
    /// Why the map let a cover go on its own.
    enum Drop: String {
        /// The covers together held more than the budget; the oldest went.
        case budget
        /// No body asked for it within the delay it was kept for.
        case aged
    }

    /// Why a body stands under its cover.
    struct Kinds: OptionSet {
        let rawValue: Int
        /// Brought back from an eviction: off when its page paints.
        static let eviction = Kinds(rawValue: 1)
        /// Carried through a crossing: off when its track lands.
        static let crossing = Kinds(rawValue: 2)
    }

    /// The cover standing over one card's body, and why it stands. The body
    /// holds the same record, so what it reads of its cover is this account.
    final class Stand {
        let cover: BodyCover
        fileprivate(set) var kinds: Kinds
        fileprivate init(cover: BodyCover, kinds: Kinds) {
            self.cover = cover
            self.kinds = kinds
        }
    }

    /// Where a crossing's cover comes from.
    enum CrossingCover {
        /// The body stands under a cover already: the crossing takes it.
        case standing(Stand)
        /// The body has painted and stands under none: snapshot its frame.
        case snapshot
        /// The body has not painted and stands under none: a snapshot would
        /// hold nothing it ever showed, so the page is kept to the land.
        case keepsPage
    }

    /// What the covers may hold together, kept and standing, in pixel bytes.
    let budgetBytes: Int
    /// Told of each cover the map lets go on its own: its card and why.
    var onDrop: ((String, Drop) -> Void)?
    /// Bumped by every clear: a cover taken in an earlier generation is refused.
    private(set) var generation = 0
    private var held: [String: BodyCover] = [:]
    private var standing: [String: Stand] = [:]
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

    /// The pixel bytes the covers hold together, kept and standing.
    var bytes: Int { held.values.reduce(0) { $0 + $1.bytes } + standing.values.reduce(0) { $0 + $1.cover.bytes } }

    /// Hold `cover` for `cardId`'s next body, unless the map was cleared
    /// since it was taken in `generation`: the oldest covers go first past
    /// the budget, which counts the covers standing over bodies too, and this
    /// one goes once it is older than `agesAfterMs`, a card that long
    /// unasked-for being one the user has left. The body it was taken from
    /// is going, so a cover standing over it is let go. False when the cover
    /// was refused.
    @discardableResult
    func keep(_ cover: BodyCover, for cardId: String, takenIn generation: Int, agesAfterMs: Double?) -> Bool {
        guard generation == self.generation else { return false }
        standing.removeValue(forKey: cardId)
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

    /// Stand a cover over `cardId`'s body for `kind`, the one way any cover
    /// comes to stand. A body already under one keeps it, its reasons joined
    /// by `kind`; otherwise it stands under `fresh`, or, given none, the
    /// cover kept for its card, taken out of the kept map. Nil when there is
    /// nothing to stand.
    @discardableResult
    func standCover(for cardId: String, kind: Kinds, fresh: BodyCover? = nil) -> Stand? {
        if let stand = standing[cardId] {
            stand.kinds.insert(kind)
            return stand
        }
        guard let cover = fresh ?? held.removeValue(forKey: cardId) else { return nil }
        let stand = Stand(cover: cover, kinds: kind)
        standing[cardId] = stand
        return stand
    }

    /// Where `cardId`'s crossing takes its cover from. A body standing under
    /// one takes it now, the crossing joined to its reasons; one that has
    /// not painted is never snapshotted.
    func crossingCover(for cardId: String, painted: Bool) -> CrossingCover {
        if let stand = standCover(for: cardId, kind: .crossing) { return .standing(stand) }
        return painted ? .snapshot : .keepsPage
    }

    /// One reason `stand`, over `cardId`'s body, stood is over. True when
    /// none is left and the cover comes off; false while another still holds
    /// it, or when it did not stand for `kind`.
    func takeDown(_ stand: Stand, kind: Kinds, for cardId: String) -> Bool {
        guard stand.kinds.contains(kind) else { return false }
        stand.kinds.remove(kind)
        guard stand.kinds.isEmpty else { return false }
        release(stand, for: cardId)
        return true
    }

    /// Let `stand` go from `cardId`'s account: its body is gone. A newer
    /// body of the same card, under a cover of its own, keeps that one.
    func release(_ stand: Stand, for cardId: String) {
        if standing[cardId] === stand { standing.removeValue(forKey: cardId) }
    }

    /// Let `cardId`'s kept cover go: its card is closed.
    func drop(_ cardId: String) { held.removeValue(forKey: cardId) }

    /// Let every kept cover go, and refuse any taken before now. A cover
    /// standing over a body is on screen, and stays.
    func clear() {
        held.removeAll()
        generation += 1
    }
}
