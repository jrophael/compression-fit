import ARKit
import SceneKit
import UIKit

/// AR tape guide and AR length ruler.
///
/// - **Length ruler:** find the floor → tap the cuff point → a virtual vertical tape shows the
///   floor-to-cuff length.
/// - **Tape guide:** the length ruler, then for the ankle and the calf: tap the leg at the
///   measuring point → a virtual ring shows where to wrap a real tape → tap the middle of the
///   tape at the front and at the side to check its height and level → type in the tape reading.
///
/// The circumferences come only from the physical tape. The camera and LiDAR locate the floor,
/// measure heights (length and tape position) and draw the guides; they never measure girth.
final class ARTapeViewController: UIViewController, ARSessionDelegate {
    enum Tool: String { case guide, length }

    var onComplete: ((String) -> Void)?
    var onCancel: ((String) -> Void)?

    private enum Site: String { case ankle, calf }

    private enum Stage: Equatable {
        case findingFloor
        case awaitingCuff
        case lengthReady
        case awaitingMark(Site)
        case checkingFront(Site)
        case checkingSide(Site)
        case awaitingReading(Site)
        case done
    }

    /// Tape position tolerance against the ring, and front-to-side level tolerance (metres).
    private let heightTolerance: Float = 0.01
    private let levelTolerance: Float = 0.01

    private let tool: Tool
    private let leg: String
    private let sceneView = ARSCNView(frame: .zero)
    private let panel = ARPanel()
    private let cancelButton = UIButton(type: .system)

    private var stage: Stage = .findingFloor { didSet { updateUI() } }
    private var floor = FloorFinder()
    private var cuffPoint: SIMD3<Float>?
    private var notice: String?

    private var rulerNode: SCNNode?
    private var markerNode: SCNNode?
    private var ringNodes: [Site: SCNNode] = [:]
    private var ringHeights: [Site: Float] = [:]          // above the floor, metres
    private var frontTapHeights: [Site: Float] = [:]
    private var placement: [Site: (heightError: Float, levelError: Float)] = [:]
    private var readings: [Site: Double] = [:]            // centimetres, typed from the tape

    init(tool: Tool, leg: String) {
        self.tool = tool
        self.leg = leg == "right" ? "right" : "left"
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        layout()
        sceneView.session.delegate = self
        sceneView.automaticallyUpdatesLighting = true
        sceneView.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(handleTap(_:))))
        panel.actionButton.addTarget(self, action: #selector(handleAction), for: .touchUpInside)
        panel.secondaryButton.addTarget(self, action: #selector(handleSecondary), for: .touchUpInside)
        updateUI()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        sceneView.session.run(LiDAR.configuration(), options: [.resetTracking, .removeExistingAnchors])
        UIApplication.shared.isIdleTimerDisabled = true
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sceneView.session.pause()
        UIApplication.shared.isIdleTimerDisabled = false
    }

    private func layout() {
        sceneView.translatesAutoresizingMaskIntoConstraints = false
        panel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(sceneView)
        view.addSubview(panel)

        cancelButton.setTitle("Cancel", for: .normal)
        cancelButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        cancelButton.setTitleColor(.white, for: .normal)
        cancelButton.backgroundColor = UIColor(white: 0, alpha: 0.45)
        cancelButton.layer.cornerRadius = 10
        cancelButton.contentEdgeInsets = UIEdgeInsets(top: 8, left: 14, bottom: 8, right: 14)
        cancelButton.translatesAutoresizingMaskIntoConstraints = false
        cancelButton.addTarget(self, action: #selector(handleCancel), for: .touchUpInside)
        view.addSubview(cancelButton)

        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            sceneView.topAnchor.constraint(equalTo: view.topAnchor),
            sceneView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            sceneView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            sceneView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            cancelButton.topAnchor.constraint(equalTo: guide.topAnchor, constant: 8),
            cancelButton.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
            panel.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 12),
            panel.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -12),
            panel.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -12)
        ])
    }

    // MARK: - Panel text

    private func siteName(_ site: Site) -> String { site == .ankle ? "ankle" : "calf" }

    private func siteWhere(_ site: Site) -> String {
        site == .ankle ? "the narrowest point just above the ankle bone" : "the widest point of the calf"
    }

    private func updateUI() {
        let legName = leg
        let lengthText = lengthCentimetres().map { String(format: "%.1f cm", $0) } ?? "–"
        let title: String
        var instruction: String
        var progress = ""
        var action = ""
        var enabled = false
        var secondary: String?

        switch stage {
        case .findingFloor:
            title = "1. Find the floor"
            instruction = "Stand barefoot, legs a little apart. Point the phone at the floor beside the \(legName) foot and move it slowly from side to side."
            action = "Finding the floor…"
        case .awaitingCuff:
            title = "2. Length: tap the cuff point"
            instruction = "From behind the \(legName) leg, tap the skin two finger widths below the knee crease."
            action = "Tap the cuff point"
        case .lengthReady:
            title = "Length \(lengthText)"
            instruction = "The virtual tape runs from the floor to the cuff point. Tap the skin again to move the point."
            action = tool == .length ? "Use this length" : "Next: ankle"
            enabled = true
        case .awaitingMark(let site):
            title = "\(site == .ankle ? "3" : "4"). \(siteName(site).capitalized): place the guide"
            instruction = "Tap the front of the \(legName) leg at \(siteWhere(site)). A ring shows where the tape goes. Tap again to move it."
            action = "Tap the leg"
        case .checkingFront(let site):
            title = "Wrap the tape on the \(siteName(site)) ring"
            instruction = "Wrap a soft tape around the leg exactly on the ring, snug and level. Then tap the middle of the tape at the front of the leg."
            action = "Tap the tape at the front"
            secondary = "Move the ring"
        case .checkingSide(let site):
            title = "Check the \(siteName(site)) tape is level"
            instruction = "Now tap the middle of the tape on the outer side of the leg."
            action = "Tap the tape at the side"
            secondary = "Move the ring"
        case .awaitingReading(let site):
            title = "Tape is in place ✓"
            instruction = "Read the tape where it overlaps, without pulling it tight, and enter the \(siteName(site)) measurement."
            action = "Enter \(siteName(site)) reading"
            enabled = true
            secondary = "Move the ring"
        case .done:
            title = "Measurements ready"
            instruction = "Check the values, then send them to Compression Fit."
            action = "Send to Compression Fit"
            enabled = true
            secondary = "Re-measure the calf"
        }

        var parts: [String] = []
        if cuffPoint != nil && stage != .lengthReady && stage != .awaitingCuff { parts.append("Length \(lengthText)") }
        if let ankle = readings[.ankle] { parts.append(String(format: "Ankle %.1f cm", ankle)) }
        if let calf = readings[.calf] { parts.append(String(format: "Calf %.1f cm", calf)) }
        progress = parts.joined(separator: "  ·  ")
        if let notice { instruction = notice }
        panel.show(title: title, instruction: instruction, progress: progress,
                   action: action, actionEnabled: enabled, secondary: secondary)
    }

    private func lengthCentimetres() -> Float? {
        guard let cuffPoint, let floorY = floor.y else { return nil }
        return (cuffPoint.y - floorY) * 100
    }

    // MARK: - Actions

    @objc private func handleCancel() {
        onCancel?(tool == .length ? "AR length ruler cancelled." : "AR tape guide cancelled.")
    }

    @objc private func handleAction() {
        notice = nil
        switch stage {
        case .lengthReady:
            if tool == .length { finish() } else { stage = .awaitingMark(.ankle) }
        case .awaitingReading(let site):
            askForReading(site)
        case .done:
            finish()
        default:
            updateUI()
        }
    }

    @objc private func handleSecondary() {
        notice = nil
        switch stage {
        case .checkingFront(let site), .checkingSide(let site), .awaitingReading(let site):
            removeRing(site)
            stage = .awaitingMark(site)
        case .done:
            readings[.calf] = nil
            removeRing(.calf)
            stage = .awaitingMark(.calf)
        default:
            break
        }
    }

    @objc private func handleTap(_ gesture: UITapGestureRecognizer) {
        guard let floorY = floor.y, let frame = sceneView.session.currentFrame else { return }
        let tapStages: Bool
        switch stage {
        case .awaitingCuff, .lengthReady, .awaitingMark, .checkingFront, .checkingSide: tapStages = true
        default: tapStages = false
        }
        guard tapStages else { return }
        guard let point = LiDAR.surfacePoint(at: gesture.location(in: sceneView), in: sceneView, frame: frame) else {
            notice = "The depth could not be read there. Move a little closer and tap again."
            updateUI()
            return
        }
        let height = point.y - floorY
        notice = nil

        switch stage {
        case .awaitingCuff, .lengthReady:
            guard (0.15...0.80).contains(height) else {
                notice = String(format: "That point is %.0f cm above the floor. Tap the skin two finger widths below the knee crease.", height * 100)
                updateUI()
                return
            }
            cuffPoint = point
            placeRuler(cuff: point, floorY: floorY)
            haptic()
            stage = .lengthReady

        case .awaitingMark(let site):
            let range: ClosedRange<Float> = site == .ankle
                ? 0.04...0.25
                : 0.15...max(0.16, (lengthCentimetres() ?? 60) / 100 - 0.02)
            guard range.contains(height) else {
                notice = String(format: "That point is %.0f cm above the floor. Tap the leg at %@.", height * 100, siteWhere(site))
                updateUI()
                return
            }
            placeRing(site, at: point, height: height, camera: frame.camera)
            haptic()
            stage = .checkingFront(site)

        case .checkingFront(let site):
            guard let target = ringHeights[site] else { return }
            let error = height - target
            guard abs(error) <= heightTolerance else {
                notice = String(format: "The tape is %.1f cm too %@. Slide it %@ onto the ring, then tap the middle of the tape again.",
                                abs(error) * 100, error > 0 ? "high" : "low", error > 0 ? "down" : "up")
                updateUI()
                return
            }
            frontTapHeights[site] = height
            placement[site] = (heightError: error, levelError: 0)
            haptic()
            stage = .checkingSide(site)

        case .checkingSide(let site):
            guard let front = frontTapHeights[site], let target = ringHeights[site] else { return }
            let tilt = height - front
            guard abs(tilt) <= levelTolerance && abs(height - target) <= heightTolerance else {
                notice = String(format: "The tape is not level: the side is %.1f cm %@ than the front. Level it on the ring, then tap the side again.",
                                abs(tilt) * 100, tilt > 0 ? "higher" : "lower")
                updateUI()
                return
            }
            placement[site] = (heightError: placement[site]?.heightError ?? 0, levelError: tilt)
            if let ring = ringNodes[site] { recolour(ring, ARDrawing.lime) }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            stage = .awaitingReading(site)

        default:
            break
        }
    }

    private func askForReading(_ site: Site) {
        let alert = UIAlertController(title: "\(siteName(site).capitalized) tape reading",
                                      message: "Centimetres, as shown on the tape.", preferredStyle: .alert)
        alert.addTextField { field in
            field.keyboardType = .decimalPad
            field.placeholder = site == .ankle ? "e.g. 22.0" : "e.g. 38.5"
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Save", style: .default) { [weak self, weak alert] _ in
            guard let self else { return }
            let text = (alert?.textFields?.first?.text ?? "").replacingOccurrences(of: ",", with: ".")
            let limits: ClosedRange<Double> = site == .ankle ? 10...65 : 15...100
            guard let value = Double(text), limits.contains(value) else {
                self.notice = "Enter the \(self.siteName(site)) reading in centimetres, between \(Int(limits.lowerBound)) and \(Int(limits.upperBound))."
                self.updateUI()
                return
            }
            if site == .calf, let ankle = self.readings[.ankle], value <= ankle {
                self.notice = "The calf should measure more than the ankle. Check the tape and enter the calf again."
                self.updateUI()
                return
            }
            self.readings[site] = value
            self.notice = nil
            self.stage = site == .ankle ? .awaitingMark(.calf) : .done
        })
        present(alert, animated: true)
    }

    private func finish() {
        guard let length = lengthCentimetres() else { return }
        var result: [String: Any] = [
            "tool": tool.rawValue,
            "leg": leg,
            "length": (Double(length) * 10).rounded() / 10,
            "lengthSource": "ar-ruler",
            "capturedAt": ISO8601DateFormatter().string(from: Date())
        ]
        if tool == .guide {
            guard let ankle = readings[.ankle], let calf = readings[.calf] else { return }
            result["ankle"] = ankle
            result["calf"] = calf
            var heights: [String: Double] = [:]
            var checks: [String: [String: Double]] = [:]
            for site in [Site.ankle, .calf] {
                if let h = ringHeights[site] { heights[site.rawValue] = (Double(h) * 1000).rounded() / 10 }
                if let p = placement[site] {
                    checks[site.rawValue] = ["heightErrorCm": (Double(p.heightError) * 1000).rounded() / 10,
                                             "levelErrorCm": (Double(p.levelError) * 1000).rounded() / 10]
                }
            }
            result["guideHeights"] = heights
            result["placementChecks"] = checks
        }
        guard let data = try? JSONSerialization.data(withJSONObject: result),
              let json = String(data: data, encoding: .utf8) else {
            onCancel?("The measurements could not be saved. Please try again.")
            return
        }
        onComplete?(json)
    }

    // MARK: - Drawing

    private func placeRuler(cuff: SIMD3<Float>, floorY: Float) {
        rulerNode?.removeFromParentNode()
        markerNode?.removeFromParentNode()
        let height = cuff.y - floorY
        let ruler = ARDrawing.verticalTape(height: height)
        ruler.simdWorldPosition = SIMD3<Float>(cuff.x, floorY, cuff.z)
        sceneView.scene.rootNode.addChildNode(ruler)
        rulerNode = ruler

        let marker = SCNNode()
        let dot = SCNSphere(radius: 0.008)
        dot.firstMaterial = ARDrawing.material(ARDrawing.lime)
        marker.addChildNode(SCNNode(geometry: dot))
        let text = ARDrawing.label(String(format: "%.1f cm", height * 100))
        text.simdPosition = SIMD3<Float>(0, 0.03, 0)
        marker.addChildNode(text)
        marker.simdWorldPosition = cuff
        sceneView.scene.rootNode.addChildNode(marker)
        markerNode = marker
    }

    /// The ring is centred a typical half-depth behind the tapped skin, away from the camera.
    private func placeRing(_ site: Site, at point: SIMD3<Float>, height: Float, camera: ARCamera) {
        removeRing(site)
        let cameraPosition = SIMD3<Float>(camera.transform.columns.3.x, camera.transform.columns.3.y, camera.transform.columns.3.z)
        var away = point - cameraPosition
        away.y = 0
        let direction = simd_length(away) > 0.01 ? simd_normalize(away) : SIMD3<Float>(0, 0, -1)
        let radius: Float = site == .ankle ? 0.04 : 0.06
        let ring = ARDrawing.ring(radius: radius + 0.006, colour: ARDrawing.amber)
        ring.simdWorldPosition = point + direction * radius
        sceneView.scene.rootNode.addChildNode(ring)
        ringNodes[site] = ring
        ringHeights[site] = height
        frontTapHeights[site] = nil
        placement[site] = nil
    }

    private func removeRing(_ site: Site) {
        ringNodes[site]?.removeFromParentNode()
        ringNodes[site] = nil
        ringHeights[site] = nil
    }

    private func recolour(_ node: SCNNode, _ colour: UIColor) {
        node.geometry?.firstMaterial?.diffuse.contents = colour
    }

    private func haptic() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    // MARK: - ARSessionDelegate (called on the main thread)

    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) { considerFloor(anchors, session: session) }
    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) { considerFloor(anchors, session: session) }

    /// The floor height is frozen once the cuff point is set.
    private func considerFloor(_ anchors: [ARAnchor], session: ARSession) {
        guard stage == .findingFloor || stage == .awaitingCuff,
              let cameraY = session.currentFrame?.camera.transform.columns.3.y else { return }
        if floor.consider(anchors, cameraY: cameraY) && stage == .findingFloor {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            stage = .awaitingCuff
        }
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        onCancel?("The AR session stopped: \(error.localizedDescription)")
    }

    func sessionWasInterrupted(_ session: ARSession) {
        notice = "The camera was interrupted. Move the phone slowly until tracking recovers."
        updateUI()
    }
}
