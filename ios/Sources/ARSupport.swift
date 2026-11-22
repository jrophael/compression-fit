import ARKit
import SceneKit
import UIKit

/// Shared LiDAR helpers for the scanner and the AR tape tools.
enum LiDAR {
    /// World point on the surface under a screen point, from the median of nearby LiDAR depths.
    static func surfacePoint(at viewPoint: CGPoint, in sceneView: ARSCNView, frame: ARFrame) -> SIMD3<Float>? {
        guard let depthData = frame.smoothedSceneDepth ?? frame.sceneDepth,
              let confidenceMap = depthData.confidenceMap,
              let sample = DepthSample(depthMap: depthData.depthMap, confidenceMap: confidenceMap, camera: frame.camera)
        else { return nil }
        let size = sceneView.bounds.size
        guard size.width > 0, size.height > 0 else { return nil }
        let orientation = sceneView.window?.windowScene?.interfaceOrientation ?? .portrait
        // displayTransform maps normalised image coordinates to normalised view coordinates.
        let toImage = frame.displayTransform(for: orientation, viewportSize: size).inverted()
        let normalised = CGPoint(x: viewPoint.x / size.width, y: viewPoint.y / size.height).applying(toImage)
        let column = Int(normalised.x * CGFloat(sample.width))
        let row = Int(normalised.y * CGFloat(sample.height))
        guard (2..<(sample.width - 2)).contains(column), (2..<(sample.height - 2)).contains(row) else { return nil }
        var depths: [Float] = []
        for r in (row - 2)...(row + 2) {
            for c in (column - 2)...(column + 2) {
                let index = r * sample.width + c
                if sample.confidence[index] >= 1 && sample.depth[index] > 0.1 {
                    depths.append(sample.depth[index])
                }
            }
        }
        guard depths.count >= 5 else { return nil }
        depths.sort()
        return sample.unproject(column: Float(column) + 0.5, row: Float(row) + 0.5, depth: depths[depths.count / 2])
    }

    /// World tracking with scene depth, as used by every LiDAR screen in the app.
    static func configuration() -> ARWorldTrackingConfiguration {
        let configuration = ARWorldTrackingConfiguration()
        configuration.planeDetection = [.horizontal]
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) {
            configuration.frameSemantics.insert(.smoothedSceneDepth)
        }
        configuration.frameSemantics.insert(.sceneDepth)
        return configuration
    }
}

/// Finds the floor: the lowest horizontal plane classified as floor, or well below the phone.
struct FloorFinder {
    private(set) var y: Float?
    private var anchorID: UUID?

    /// Returns true when a floor height is known.
    @discardableResult
    mutating func consider(_ anchors: [ARAnchor], cameraY: Float) -> Bool {
        for case let plane as ARPlaneAnchor in anchors where plane.alignment == .horizontal {
            let planeY = plane.transform.columns.3.y
            var classifiedFloor = false
            if ARPlaneAnchor.isClassificationSupported, case .floor = plane.classification { classifiedFloor = true }
            guard classifiedFloor || planeY < cameraY - 0.5 else { continue }
            if plane.identifier == anchorID {
                y = planeY
            } else if y == nil || planeY < (y ?? 0) - 0.01 {
                y = planeY
                anchorID = plane.identifier
            }
        }
        return y != nil
    }
}

/// SceneKit nodes for the AR tapes. Units are metres.
enum ARDrawing {
    static let lime = UIColor(red: 0.79, green: 1, blue: 0.51, alpha: 1)
    static let faint = UIColor(white: 1, alpha: 0.35)
    static let amber = UIColor(red: 1, green: 0.76, blue: 0.29, alpha: 1)

    static func material(_ colour: UIColor) -> SCNMaterial {
        let material = SCNMaterial()
        material.diffuse.contents = colour
        material.lightingModel = .constant
        material.readsFromDepthBuffer = false   // stay visible through the leg
        return material
    }

    /// A horizontal ring (virtual tape) centred on `centre`.
    static func ring(radius: Float, colour: UIColor) -> SCNNode {
        let torus = SCNTorus(ringRadius: CGFloat(radius), pipeRadius: 0.003)
        torus.firstMaterial = material(colour)
        let node = SCNNode(geometry: torus)
        node.renderingOrder = 10
        return node
    }

    /// A ring of `count` segments whose colours show which sectors are covered.
    static func segmentedRing(radius: Float, count: Int = 36) -> SCNNode {
        let parent = SCNNode()
        let arc = Float.pi * 2 * radius / Float(count) * 0.85
        for index in 0..<count {
            // Sector index i covers atan2 angles from -π + i·10° (see PointAccumulator.bandCoverages).
            let angle = (Float(index) + 0.5) / Float(count) * 2 * .pi - .pi
            let box = SCNBox(width: CGFloat(arc), height: 0.006, length: 0.004, chamferRadius: 0)
            box.firstMaterial = material(faint)
            let segment = SCNNode(geometry: box)
            segment.name = "segment-\(index)"
            segment.simdPosition = SIMD3<Float>(radius * cos(angle), 0, radius * sin(angle))
            segment.eulerAngles.y = -(angle + .pi / 2)   // lie along the tangent
            segment.renderingOrder = 10
            parent.addChildNode(segment)
        }
        return parent
    }

    static func colourSegments(of ring: SCNNode, covered: [Bool]) {
        for (index, isCovered) in covered.enumerated() {
            ring.childNode(withName: "segment-\(index)", recursively: false)?
                .geometry?.firstMaterial?.diffuse.contents = isCovered ? lime : faint
        }
    }

    /// A vertical virtual tape from `floor` up `height` metres, with centimetre ticks.
    static func verticalTape(height: Float) -> SCNNode {
        let parent = SCNNode()
        let strip = SCNBox(width: 0.012, height: CGFloat(height), length: 0.001, chamferRadius: 0)
        strip.firstMaterial = material(UIColor(red: 1, green: 0.93, blue: 0.55, alpha: 0.85))
        let stripNode = SCNNode(geometry: strip)
        stripNode.simdPosition = SIMD3<Float>(0, height / 2, 0)
        stripNode.renderingOrder = 9
        parent.addChildNode(stripNode)
        let centimetres = Int((height * 100).rounded(.down))
        if centimetres > 0 {
            for cm in 0...centimetres {
                let major = cm % 5 == 0
                let tick = SCNBox(width: major ? 0.012 : 0.006, height: 0.0008, length: 0.0012, chamferRadius: 0)
                tick.firstMaterial = material(.black)
                let tickNode = SCNNode(geometry: tick)
                tickNode.simdPosition = SIMD3<Float>(major ? 0 : -0.003, Float(cm) / 100, 0.001)
                tickNode.renderingOrder = 11
                parent.addChildNode(tickNode)
                if cm % 10 == 0 && cm > 0 {
                    let number = label("\(cm)", size: 0.012)
                    number.simdPosition = SIMD3<Float>(0.014, Float(cm) / 100, 0)
                    parent.addChildNode(number)
                }
            }
        }
        // Always face the camera around the vertical axis.
        let billboard = SCNBillboardConstraint()
        billboard.freeAxes = .Y
        parent.constraints = [billboard]
        return parent
    }

    /// A camera-facing text label of roughly `size` metres cap height.
    static func label(_ text: String, size: Float = 0.018) -> SCNNode {
        let geometry = SCNText(string: text, extrusionDepth: 0)
        geometry.font = UIFont.systemFont(ofSize: 10, weight: .bold)
        geometry.flatness = 0.2
        geometry.firstMaterial = material(.white)
        let textNode = SCNNode(geometry: geometry)
        let scale = size / 10
        textNode.simdScale = SIMD3<Float>(repeating: scale)
        // Centre the text on its node.
        let (minimum, maximum) = geometry.boundingBox
        textNode.simdPosition = SIMD3<Float>(-Float(maximum.x - minimum.x) / 2 * scale, -Float(maximum.y - minimum.y) / 2 * scale, 0)
        textNode.renderingOrder = 12
        let holder = SCNNode()
        holder.addChildNode(textNode)
        holder.constraints = [SCNBillboardConstraint()]
        return holder
    }
}

/// The dark panel at the bottom of every LiDAR screen.
final class ARPanel: UIView {
    let titleLabel = UILabel()
    let instructionLabel = UILabel()
    let progressLabel = UILabel()
    let actionButton = UIButton(type: .system)
    let secondaryButton = UIButton(type: .system)

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = UIColor(red: 0.09, green: 0.18, blue: 0.16, alpha: 0.88)
        layer.cornerRadius = 18
        titleLabel.font = .preferredFont(forTextStyle: .headline)
        instructionLabel.font = .preferredFont(forTextStyle: .subheadline)
        progressLabel.font = .monospacedDigitSystemFont(ofSize: 15, weight: .semibold)
        for label in [titleLabel, instructionLabel, progressLabel] {
            label.textColor = .white
            label.numberOfLines = 0
            label.adjustsFontForContentSizeCategory = true
        }
        for (button, filled) in [(actionButton, true), (secondaryButton, false)] {
            button.titleLabel?.font = .preferredFont(forTextStyle: .headline)
            button.backgroundColor = filled ? UIColor(red: 0.09, green: 0.36, blue: 0.29, alpha: 1) : UIColor(white: 1, alpha: 0.12)
            button.setTitleColor(.white, for: .normal)
            button.setTitleColor(UIColor(white: 1, alpha: 0.5), for: .disabled)
            button.layer.cornerRadius = 12
            button.heightAnchor.constraint(greaterThanOrEqualToConstant: filled ? 50 : 42).isActive = true
        }
        let stack = UIStackView(arrangedSubviews: [titleLabel, instructionLabel, progressLabel, actionButton, secondaryButton])
        stack.axis = .vertical
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -16),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16)
        ])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func show(title: String, instruction: String, progress: String = "",
              action: String, actionEnabled: Bool, secondary: String? = nil) {
        titleLabel.text = title
        instructionLabel.text = instruction
        progressLabel.text = progress
        progressLabel.isHidden = progress.isEmpty
        actionButton.setTitle(action, for: .normal)
        actionButton.isEnabled = actionEnabled
        actionButton.alpha = actionEnabled ? 1 : 0.6
        secondaryButton.setTitle(secondary, for: .normal)
        secondaryButton.isHidden = secondary == nil
    }
}
