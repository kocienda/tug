import CoreGraphics
import Foundation

/// The geometry of a card the host moves as one view: which points of its
/// view are the card's, and where a drag or a grip resize the host tracks
/// takes it.
///
/// A card's view is its pane's rect outset by an apron on every side, so the
/// border, shadow and grips its page draws past the pane rect are not
/// clipped. Inside the pane rect a point is the card's; in the apron it is the
/// card's only along an edge the shell says the pane offers as a grip, and a
/// corner only where its own grip or both edges beside it are offered.
///
/// The drag and resize arithmetic are exact ports of the deck's own
/// (`snap.ts`'s `computeSnap`, `computeResizeSnap`, `computeEdgeVisibility`,
/// and `tug-pane.tsx`'s `clampedPosition` and `resizeDelta`), so a card the
/// host moves clamps and snaps exactly as one the shell moves does. Pure
/// arithmetic over rects in the shell's viewport points, Foundation and
/// CoreGraphics only, so `TugTests` compiles it.

/// An edge or corner a pane can be resized from: the shell's `ResizeEdge`.
enum ResizeEdge: String, CaseIterable, Codable {
    case n, s, e, w, nw, ne, sw, se

    var movesTop: Bool { rawValue.contains("n") }
    var movesBottom: Bool { rawValue.contains("s") }
    var movesLeft: Bool { rawValue.contains("w") }
    var movesRight: Bool { rawValue.contains("e") }
}

/// The deck's constants, as `snap.ts`, `tug-pane.tsx`, `press-travel.ts` and
/// `layout-imposer.ts` state them.
enum CardGeometry {
    /// How near an edge must come to another card's to snap to it.
    static let snapThreshold: CGFloat = 8
    /// How much of an edge must be visible for a snap to it to activate.
    static let snapVisibilityThreshold: CGFloat = 0.3
    /// How much of a title bar stays on the canvas across, and down.
    static let titleBarVisibleMinX: CGFloat = 100
    static let titleBarVisibleMinY: CGFloat = 36
    /// The canvas's inset, which a drag's top and a resize's every edge hold.
    static let canvasPadding: CGFloat = 2
    /// How far the pointer travels before a press is a drag.
    static let moveThreshold: CGFloat = 3
    /// The gap between imposed panes; a snap overlaps adjacent edges by its negation.
    static let impositionGap: CGFloat = 5
    /// How far a card's view reaches past its pane rect on every side.
    static let apron: CGFloat = 6
}

/// Which points of a card's view are the card's.
struct CardHitShape: Equatable {
    var paneRect: CGRect
    var apron: CGFloat = CardGeometry.apron
    var grips: Set<ResizeEdge>

    /// The card's view: the pane rect outset by the apron.
    var viewRect: CGRect { paneRect.insetBy(dx: -apron, dy: -apron) }

    func contains(_ point: CGPoint) -> Bool {
        if paneRect.contains(point) { return true }
        guard viewRect.contains(point) else { return false }
        let above = point.y < paneRect.minY
        let below = point.y >= paneRect.maxY
        let left = point.x < paneRect.minX
        let right = point.x >= paneRect.maxX
        let vertical: ResizeEdge? = above ? .n : below ? .s : nil
        let horizontal: ResizeEdge? = left ? .w : right ? .e : nil
        switch (vertical, horizontal) {
        case let (v?, h?):
            let corner = ResizeEdge(rawValue: v.rawValue + h.rawValue)!
            return grips.contains(corner) || (grips.contains(v) && grips.contains(h))
        case let (v?, nil):
            return grips.contains(v)
        case let (nil, h?):
            return grips.contains(h)
        case (nil, nil):
            return false
        }
    }
}

// MARK: - Snap

/// A snap guide: the axis, where it is drawn, and which edge of the card it
/// marks (`snap.ts`'s `GuidePosition`).
struct SnapGuide: Equatable {
    enum Axis: Equatable { case x, y }
    enum Edge: Equatable { case left, right, top, bottom }
    var axis: Axis
    var position: CGFloat
    var cardEdge: Edge
}

struct SnapResult: Equatable {
    var x: CGFloat?
    var y: CGFloat?
    var guides: [SnapGuide]
}

/// The edges a resize is moving, by absolute position, and where each snapped.
struct ResizeEdges: Equatable {
    var top: CGFloat?
    var bottom: CGFloat?
    var left: CGFloat?
    var right: CGFloat?
}

struct ResizeSnapResult: Equatable {
    var edges: ResizeEdges
    var guides: [SnapGuide]
}

extension CardGeometry {
    /// `computeSnap`: the moving rect's new origin per axis, snapped to the
    /// nearest edge of another within the threshold, or nil on an axis with
    /// none. A same-edge snap aligns; an adjacent-edge snap overlaps by
    /// `borderWidth`.
    static func computeSnap(
        moving: CGRect,
        others: [CGRect],
        validate: ((SnapGuide.Axis, CGFloat, CGRect, Int) -> Bool)? = nil,
        borderWidth: CGFloat = 0
    ) -> SnapResult {
        let movingLeft = moving.minX, movingRight = moving.minX + moving.width
        let movingTop = moving.minY, movingBottom = moving.minY + moving.height
        let bw = borderWidth
        typealias Candidate = (dist: CGFloat, delta: CGFloat, guide: CGFloat, edge: SnapGuide.Edge)
        var bestX: Candidate?
        var bestY: Candidate?
        for (index, other) in others.enumerated() {
            let otherLeft = other.minX, otherRight = other.minX + other.width
            let otherTop = other.minY, otherBottom = other.minY + other.height
            var xs: [Candidate] = []
            func addX(_ dist: CGFloat, _ delta: CGFloat, _ guide: CGFloat, _ edge: SnapGuide.Edge) {
                if dist <= snapThreshold { xs.append((dist, delta, guide, edge)) }
            }
            addX(abs(movingLeft - otherLeft), otherLeft - movingLeft, otherLeft, .left)
            addX(abs(movingLeft - otherRight), otherRight - movingLeft - bw, otherRight, .right)
            addX(abs(movingRight - otherLeft), otherLeft - movingRight + bw, otherLeft, .left)
            addX(abs(movingRight - otherRight), otherRight - movingRight, otherRight, .right)
            for c in xs where c.dist < (bestX?.dist ?? .infinity) {
                if let validate, !validate(.x, c.guide, other, index) { continue }
                bestX = c
            }
            var ys: [Candidate] = []
            func addY(_ dist: CGFloat, _ delta: CGFloat, _ guide: CGFloat, _ edge: SnapGuide.Edge) {
                if dist <= snapThreshold { ys.append((dist, delta, guide, edge)) }
            }
            addY(abs(movingTop - otherTop), otherTop - movingTop, otherTop, .top)
            addY(abs(movingTop - otherBottom), otherBottom - movingTop - bw, otherBottom, .bottom)
            addY(abs(movingBottom - otherTop), otherTop - movingBottom + bw, otherTop, .top)
            addY(abs(movingBottom - otherBottom), otherBottom - movingBottom, otherBottom, .bottom)
            for c in ys where c.dist < (bestY?.dist ?? .infinity) {
                if let validate, !validate(.y, c.guide, other, index) { continue }
                bestY = c
            }
        }
        var guides: [SnapGuide] = []
        if let bestX { guides.append(SnapGuide(axis: .x, position: bestX.guide, cardEdge: bestX.edge)) }
        if let bestY { guides.append(SnapGuide(axis: .y, position: bestY.guide, cardEdge: bestY.edge)) }
        return SnapResult(
            x: bestX.map { moving.minX + $0.delta },
            y: bestY.map { moving.minY + $0.delta },
            guides: guides
        )
    }

    /// `computeResizeSnap`: each edge being resized snapped on its own to the
    /// nearest edge of another within the threshold.
    static func computeResizeSnap(_ resizing: ResizeEdges, others: [CGRect], borderWidth: CGFloat = 0) -> ResizeSnapResult {
        let bw = borderWidth
        typealias Snap = (dist: CGFloat, value: CGFloat, guide: CGFloat, edge: SnapGuide.Edge)
        var left: Snap?, right: Snap?, top: Snap?, bottom: Snap?
        func consider(_ best: inout Snap?, _ position: CGFloat?, _ target: CGFloat, _ value: CGFloat, _ edge: SnapGuide.Edge) {
            guard let position else { return }
            let dist = abs(position - target)
            if dist <= snapThreshold && dist < (best?.dist ?? .infinity) { best = (dist, value, target, edge) }
        }
        for other in others {
            let otherLeft = other.minX, otherRight = other.minX + other.width
            let otherTop = other.minY, otherBottom = other.minY + other.height
            consider(&left, resizing.left, otherLeft, otherLeft, .left)
            consider(&left, resizing.left, otherRight, otherRight - bw, .right)
            consider(&right, resizing.right, otherLeft, otherLeft + bw, .left)
            consider(&right, resizing.right, otherRight, otherRight, .right)
            consider(&top, resizing.top, otherTop, otherTop, .top)
            consider(&top, resizing.top, otherBottom, otherBottom - bw, .bottom)
            consider(&bottom, resizing.bottom, otherTop, otherTop + bw, .top)
            consider(&bottom, resizing.bottom, otherBottom, otherBottom, .bottom)
        }
        var guides: [SnapGuide] = []
        if let left { guides.append(SnapGuide(axis: .x, position: left.guide, cardEdge: left.edge)) }
        if let right, !guides.contains(where: { $0.axis == .x && $0.position == right.guide }) {
            guides.append(SnapGuide(axis: .x, position: right.guide, cardEdge: right.edge))
        }
        if let top { guides.append(SnapGuide(axis: .y, position: top.guide, cardEdge: top.edge)) }
        if let bottom, !guides.contains(where: { $0.axis == .y && $0.position == bottom.guide }) {
            guides.append(SnapGuide(axis: .y, position: bottom.guide, cardEdge: bottom.edge))
        }
        return ResizeSnapResult(
            edges: ResizeEdges(top: top?.value, bottom: bottom?.value, left: left?.value, right: right?.value),
            guides: guides
        )
    }

    /// `computeEdgeVisibility`: the fraction of an edge segment no occluder covers.
    static func computeEdgeVisibility(
        edgePosition: CGFloat,
        rangeStart: CGFloat,
        rangeEnd: CGFloat,
        isVerticalEdge: Bool,
        occluders: [CGRect]
    ) -> CGFloat {
        let total = rangeEnd - rangeStart
        if total <= 0 { return 0 }
        var ranges: [(CGFloat, CGFloat)] = []
        for r in occluders {
            if isVerticalEdge {
                if r.minX < edgePosition && r.minX + r.width > edgePosition {
                    let s = max(rangeStart, r.minY), e = min(rangeEnd, r.minY + r.height)
                    if s < e { ranges.append((s, e)) }
                }
            } else if r.minY < edgePosition && r.minY + r.height > edgePosition {
                let s = max(rangeStart, r.minX), e = min(rangeEnd, r.minX + r.width)
                if s < e { ranges.append((s, e)) }
            }
        }
        if ranges.isEmpty { return 1 }
        ranges.sort { $0.0 < $1.0 }
        var merged = [ranges[0]]
        for range in ranges.dropFirst() {
            if range.0 <= merged[merged.count - 1].1 {
                merged[merged.count - 1].1 = max(merged[merged.count - 1].1, range.1)
            } else {
                merged.append(range)
            }
        }
        let occluded = merged.reduce(CGFloat(0)) { $0 + ($1.1 - $1.0) }
        return (total - occluded) / total
    }
}

// MARK: - Drag and resize

extension CardGeometry {
    /// `clampedPosition`: a drag's position, the card free to overhang any
    /// edge as long as enough of its title bar stays on the canvas, with each
    /// bound relaxed to where the card started. `pointer` and `startPointer`
    /// are viewport points; positions and sizes are the canvas's layout
    /// pixels; `canvasSize` is the canvas's viewport size.
    static func clampedPosition(
        pointer: CGPoint,
        startPointer: CGPoint,
        startPosition: CGPoint,
        canvasSize: CGSize?,
        frameSize: CGSize,
        zoom: CGFloat = 1
    ) -> CGPoint {
        var x = startPosition.x + (pointer.x - startPointer.x) / zoom
        var y = startPosition.y + (pointer.y - startPointer.y) / zoom
        if let canvasSize {
            let canvasWidth = canvasSize.width / zoom
            let canvasHeight = canvasSize.height / zoom
            let minX = min(startPosition.x, -(frameSize.width - titleBarVisibleMinX))
            let maxX = max(startPosition.x, canvasWidth - titleBarVisibleMinX)
            x = max(minX, min(x, maxX))
            let minY = min(startPosition.y, canvasPadding)
            let maxY = max(startPosition.y, canvasHeight - titleBarVisibleMinY)
            y = max(minY, min(y, maxY))
        }
        return CGPoint(x: x, y: y)
    }

    /// `resizeDelta`: the rect a resize from `edge` reaches, held between
    /// `minSize` and `maxSize` and, given the canvas, inside its padding.
    static func resizeDelta(
        pointer: CGPoint,
        startPointer: CGPoint,
        start: CGRect,
        edge: ResizeEdge,
        minSize: CGSize,
        canvasSize: CGSize?,
        maxSize: CGSize? = nil,
        zoom: CGFloat = 1
    ) -> CGRect {
        let dx = (pointer.x - startPointer.x) / zoom
        let dy = (pointer.y - startPointer.y) / zoom
        let startLeft = start.minX, startTop = start.minY, startW = start.width, startH = start.height
        var left = startLeft, top = startTop, width = startW, height = startH
        if edge.movesRight {
            width = max(minSize.width, startW + dx)
            if let maxSize { width = min(maxSize.width, width) }
        }
        if edge.movesLeft {
            var newW = max(minSize.width, startW - dx)
            if let maxSize { newW = min(maxSize.width, newW) }
            left = startLeft + (startW - newW)
            width = newW
        }
        if edge.movesBottom {
            height = max(minSize.height, startH + dy)
            if let maxSize { height = min(maxSize.height, height) }
        }
        if edge.movesTop {
            var newH = max(minSize.height, startH - dy)
            if let maxSize { newH = min(maxSize.height, newH) }
            top = startTop + (startH - newH)
            height = newH
        }
        if let canvasSize {
            let maxRight = canvasSize.width / zoom - canvasPadding
            let maxBottom = canvasSize.height / zoom - canvasPadding
            if left + width > maxRight {
                if edge.movesRight {
                    width = max(minSize.width, maxRight - left)
                } else if edge.movesLeft {
                    left = max(canvasPadding, left)
                    width = startLeft + startW - left
                    if width < minSize.width {
                        width = minSize.width
                        left = startLeft + startW - width
                    }
                }
            }
            if left < canvasPadding {
                let rightEdge = left + width
                left = canvasPadding
                width = max(minSize.width, rightEdge - left)
            }
            if top + height > maxBottom {
                if edge.movesBottom {
                    height = max(minSize.height, maxBottom - top)
                } else if edge.movesTop {
                    top = max(canvasPadding, top)
                    height = startTop + startH - top
                    if height < minSize.height {
                        height = minSize.height
                        top = startTop + startH - height
                    }
                }
            }
            if top < canvasPadding {
                let bottomEdge = top + height
                top = canvasPadding
                height = max(minSize.height, bottomEdge - top)
            }
        }
        return CGRect(x: left, y: top, width: width, height: height)
    }
}

/// One drag or grip resize the host tracks, from the press to the release.
///
/// Rects and points are in the shell's viewport points; the arithmetic runs
/// in the canvas's layout pixels, as the shell's own does, and comes back.
struct CardGestureTracker {
    enum Kind: Equatable {
        case move
        case resize(ResizeEdge)
    }

    let kind: Kind
    /// The pane's rect at the press.
    let startRect: CGRect
    let startPointer: CGPoint
    /// The canvas's rect, and the zoom its layout is drawn at.
    let canvas: CGRect
    let zoom: CGFloat
    /// The pane's resize floor and ceiling, layout pixels.
    let minSize: CGSize
    let maxSize: CGSize?
    /// Whether the pane is free: only a free pane snaps a drag.
    let free: Bool
    /// The other visible cards' pane rects, for the snap.
    let others: [CGRect]
    private(set) var moved = false

    init(
        kind: Kind, startRect: CGRect, startPointer: CGPoint, canvas: CGRect, zoom: CGFloat = 1,
        minSize: CGSize, maxSize: CGSize? = nil, free: Bool, others: [CGRect]
    ) {
        self.kind = kind
        self.startRect = startRect
        self.startPointer = startPointer
        self.canvas = canvas
        self.zoom = zoom > 0 ? zoom : 1
        self.minSize = minSize
        self.maxSize = maxSize
        self.free = free
        self.others = others
    }

    /// Where the pane stands after a step, and the snap that put it there.
    struct Step: Equatable {
        var rect: CGRect
        var moved: Bool
        var snapX: CGFloat?
        var snapY: CGFloat?
    }

    private func layout(_ r: CGRect) -> CGRect {
        CGRect(x: (r.minX - canvas.minX) / zoom, y: (r.minY - canvas.minY) / zoom, width: r.width / zoom, height: r.height / zoom)
    }

    private func viewport(_ r: CGRect) -> CGRect {
        CGRect(x: canvas.minX + r.minX * zoom, y: canvas.minY + r.minY * zoom, width: r.width * zoom, height: r.height * zoom)
    }

    /// The pane's rect at `pointer`. Below the move threshold it stays where
    /// it was pressed, and a press that never crosses it is a click.
    mutating func step(pointer: CGPoint, alt: Bool) -> Step {
        if !moved {
            if hypot(pointer.x - startPointer.x, pointer.y - startPointer.y) < CardGeometry.moveThreshold {
                return Step(rect: startRect, moved: false)
            }
            moved = true
        }
        let start = layout(startRect)
        let otherRects = others.map(layout)
        switch kind {
        case .move:
            var position = CardGeometry.clampedPosition(
                pointer: pointer, startPointer: startPointer, startPosition: start.origin,
                canvasSize: canvas.size, frameSize: start.size, zoom: zoom
            )
            var snapX: CGFloat?
            var snapY: CGFloat?
            if alt && free {
                let snap = CardGeometry.computeSnap(
                    moving: CGRect(origin: position, size: start.size), others: otherRects,
                    borderWidth: -CardGeometry.impositionGap
                )
                if let x = snap.x { position.x = x; snapX = canvas.minX + x * zoom }
                if let y = snap.y { position.y = y; snapY = canvas.minY + y * zoom }
            }
            return Step(rect: viewport(CGRect(origin: position, size: start.size)), moved: true, snapX: snapX, snapY: snapY)
        case .resize(let edge):
            var r = CardGeometry.resizeDelta(
                pointer: pointer, startPointer: startPointer, start: start, edge: edge,
                minSize: minSize, canvasSize: canvas.size, maxSize: maxSize, zoom: zoom
            )
            var snapX: CGFloat?
            var snapY: CGFloat?
            if alt {
                var resizing = ResizeEdges()
                if edge.movesTop { resizing.top = r.minY }
                if edge.movesBottom { resizing.bottom = r.minY + r.height }
                if edge.movesLeft { resizing.left = r.minX }
                if edge.movesRight { resizing.right = r.minX + r.width }
                let snapped = CardGeometry.computeResizeSnap(resizing, others: otherRects, borderWidth: -CardGeometry.impositionGap).edges
                var left = r.minX, top = r.minY, width = r.width, height = r.height
                if let s = snapped.left {
                    let newW = max(minSize.width, left + width - s)
                    left = left + width - newW
                    width = newW
                    snapX = canvas.minX + s * zoom
                }
                if let s = snapped.right {
                    width = max(minSize.width, s - left)
                    snapX = canvas.minX + s * zoom
                }
                if let s = snapped.top {
                    let newH = max(minSize.height, top + height - s)
                    top = top + height - newH
                    height = newH
                    snapY = canvas.minY + s * zoom
                }
                if let s = snapped.bottom {
                    height = max(minSize.height, s - top)
                    snapY = canvas.minY + s * zoom
                }
                r = CGRect(x: left, y: top, width: width, height: height)
            }
            return Step(rect: viewport(r), moved: true, snapX: snapX, snapY: snapY)
        }
    }
}
