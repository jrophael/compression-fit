import SceneKit
import UIKit

/// Holographic look and motion for the AR tapes: glowing additive materials, tapes that wrap
/// themselves onto the leg, a rising length tape with a scan sweep, pulsing while waiting,
/// floating result cards and a sparkle on success.
///
/// Purely visual: nothing here measures anything. Motion is skipped when the iPhone's
/// Reduce Motion setting is on.
enum Hologram {
    static let cyan = UIColor(red: 0.35, green: 0.93, blue: 1, alpha: 1)

    static var reduceMotion: Bool { UIAccessibility.isReduceMotionEnabled }

    // MARK: - Tapes

    /// A glowing virtual tape: a ring of segments plus a soft halo. Starts invisible;
    /// call `wrap(_:)` to draw it onto the leg.
    static func tape(radius: Float, colour: UIColor, segments: Int = 36) -> SCNNode {
        let node = ARDrawing.segmentedRing(radius: radius, count: segments)
        node.name = "hologram-tape"
        let halo = SCNTorus(ringRadius: CGFloat(radius), pipeRadius: 0.009)
        halo.firstMaterial = ARDrawing.material(colour.withAlphaComponent(0.18))
        let haloNode = SCNNode(geometry: halo)
        haloNode.name = "halo"
        haloNode.renderingOrder = 9
        node.addChildNode(haloNode)
        tint(node, colour)
        return node
    }

    /// Colours every segment and the halo of a tape.
    static func tint(_ tape: SCNNode, _ colour: UIColor) {
        for child in tape.childNodes {
            if child.name == "halo" {
                child.geometry?.firstMaterial?.diffuse.contents = colour.withAlphaComponent(0.18)
                child.geometry?.firstMaterial?.emission.contents = colour.withAlphaComponent(0.18)
            } else {
                child.geometry?.firstMaterial?.diffuse.contents = colour
                child.geometry?.firstMaterial?.emission.contents = colour
            }
        }
    }

    /// Draws the tape around the leg segment by segment, as if it were being wrapped.
    static func wrap(_ tape: SCNNode, duration: TimeInterval = 0.9) {
        let segments = tape.childNodes.filter { $0.name?.hasPrefix("segment-") == true }
            .sorted { index($0) < index($1) }
        guard !reduceMotion else { return }
        // Start at the sector facing the camera side (index 0) and go round.
        let step = duration / Double(max(1, segments.count))
        for (order, segment) in segments.enumerated() {
            segment.opacity = 0
            segment.runAction(.sequence([.wait(duration: step * Double(order)), .fadeIn(duration: 0.12)]))
        }
        if let halo = tape.childNode(withName: "halo", recursively: false) {
            halo.opacity = 0
            halo.runAction(.sequence([.wait(duration: duration), .fadeIn(duration: 0.3)]))
        }
    }

    private static func index(_ node: SCNNode) -> Int {
        Int(node.name?.split(separator: "-").last ?? "") ?? 0
    }

    /// Gentle breathing glow while the app waits for the user.
    static func pulse(_ node: SCNNode) {
        guard !reduceMotion else { return }
        node.removeAction(forKey: "pulse")
        let breathe = SCNAction.sequence([.fadeOpacity(to: 0.45, duration: 0.8), .fadeOpacity(to: 1, duration: 0.8)])
        breathe.timingMode = .easeInEaseOut
        node.runAction(.repeatForever(breathe), forKey: "pulse")
    }

    static func stopPulse(_ node: SCNNode) {
        node.removeAction(forKey: "pulse")
        node.runAction(.fadeOpacity(to: 1, duration: 0.15))
    }

    /// Grows a vertical tape up from the floor.
    static func rise(_ node: SCNNode, duration: TimeInterval = 0.7) {
        guard !reduceMotion else { return }
        node.scale = SCNVector3(1, 0.001, 1)
        let grow = SCNAction.customAction(duration: duration) { node, elapsed in
            let t = Float(elapsed) / Float(duration)
            let eased = 1 - pow(1 - t, 3)
            node.scale = SCNVector3(1, max(0.001, eased), 1)
        }
        node.runAction(grow)
    }

    /// A translucent disc that sweeps up the leg from the floor to `height`, then fades.
    static func sweep(in parent: SCNNode, at floorPoint: SIMD3<Float>, height: Float, colour: UIColor = cyan) {
        guard !reduceMotion, height > 0 else { return }
        let disc = SCNCylinder(radius: 0.11, height: 0.0015)
        disc.firstMaterial = ARDrawing.material(colour.withAlphaComponent(0.22))
        let node = SCNNode(geometry: disc)
        node.renderingOrder = 8
        node.simdWorldPosition = floorPoint
        parent.addChildNode(node)
        let duration = TimeInterval(0.4 + Double(height) * 1.6)
        let up = SCNAction.move(by: SCNVector3(0, height, 0), duration: duration)
        up.timingMode = .easeInEaseOut
        node.runAction(.sequence([up, .fadeOut(duration: 0.3), .removeFromParentNode()]))
    }

    /// A short burst of sparks around a tape when a step succeeds.
    static func sparkle(around tape: SCNNode, radius: Float, colour: UIColor = ARDrawing.lime) {
        guard !reduceMotion else { return }
        let sparks = SCNParticleSystem()
        sparks.birthRate = 0
        sparks.loops = false
        sparks.emissionDuration = 0.25
        sparks.particleLifeSpan = 0.6
        sparks.particleLifeSpanVariation = 0.2
        sparks.particleSize = 0.004
        sparks.particleColor = colour
        sparks.particleVelocity = 0.12
        sparks.particleVelocityVariation = 0.06
        sparks.spreadingAngle = 180
        sparks.blendMode = .additive
        sparks.isAffectedByGravity = false
        sparks.particleColorVariation = SCNVector4(0, 0.1, 0.1, 0)
        let ring = SCNTorus(ringRadius: CGFloat(radius), pipeRadius: 0.002)
        sparks.emitterShape = ring
        sparks.birthLocation = .surface
        sparks.birthRate = 900
        let emitter = SCNNode()
        emitter.addParticleSystem(sparks)
        tape.addChildNode(emitter)
        emitter.runAction(.sequence([.wait(duration: 1.2), .removeFromParentNode()]))
    }

    // MARK: - Floating cards

    /// A camera-facing holographic card: glowing text on a translucent panel with a cyan rim.
    static func card(_ lines: [String], textSize: Float = 0.016) -> SCNNode {
        let holder = SCNNode()
        holder.name = "hologram-card"
        let lineHeight = textSize * 1.5
        var widest: Float = 0
        let textNodes: [SCNNode] = lines.enumerated().map { offset, line in
            let geometry = SCNText(string: line, extrusionDepth: 0)
            geometry.font = UIFont.systemFont(ofSize: 10, weight: offset == 0 ? .bold : .semibold)
            geometry.flatness = 0.2
            geometry.firstMaterial = ARDrawing.material(offset == 0 ? .white : cyan)
            let node = SCNNode(geometry: geometry)
            let scale = textSize / 10
            node.simdScale = SIMD3<Float>(repeating: scale)
            let (minimum, maximum) = geometry.boundingBox
            let width = Float(maximum.x - minimum.x) * scale
            widest = max(widest, width)
            node.simdPosition = SIMD3<Float>(-width / 2, -Float(offset) * lineHeight - textSize / 2, 0.001)
            node.renderingOrder = 13
            return node
        }
        let padding: Float = 0.012
        let height = Float(lines.count) * lineHeight + padding
        let width = widest + padding * 2
        let panel = SCNPlane(width: CGFloat(width), height: CGFloat(height))
        panel.cornerRadius = 0.006
        panel.firstMaterial = ARDrawing.material(UIColor(red: 0.04, green: 0.25, blue: 0.3, alpha: 0.35))
        let panelNode = SCNNode(geometry: panel)
        panelNode.simdPosition = SIMD3<Float>(0, -height / 2 + lineHeight / 2, 0)
        panelNode.renderingOrder = 11
        let rim = SCNPlane(width: CGFloat(width + 0.003), height: CGFloat(height + 0.003))
        rim.cornerRadius = 0.007
        rim.firstMaterial = ARDrawing.material(cyan.withAlphaComponent(0.35))
        let rimNode = SCNNode(geometry: rim)
        rimNode.simdPosition = panelNode.simdPosition - SIMD3<Float>(0, 0, 0.0005)
        rimNode.renderingOrder = 10
        holder.addChildNode(rimNode)
        holder.addChildNode(panelNode)
        textNodes.forEach(holder.addChildNode)
        holder.constraints = [SCNBillboardConstraint()]
        if !reduceMotion {
            holder.opacity = 0
            holder.simdScale = SIMD3<Float>(repeating: 0.6)
            let appear = SCNAction.group([.fadeIn(duration: 0.25), .scale(to: 1, duration: 0.25)])
            appear.timingMode = .easeOut
            let bob = SCNAction.sequence([.moveBy(x: 0, y: 0.004, z: 0, duration: 1.2), .moveBy(x: 0, y: -0.004, z: 0, duration: 1.2)])
            bob.timingMode = .easeInEaseOut
            holder.runAction(.sequence([appear, .repeatForever(bob)]))
        }
        return holder
    }
}
