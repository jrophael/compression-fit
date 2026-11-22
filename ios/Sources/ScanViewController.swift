import ARKit
import SceneKit
import UIKit

/// AR girth tape: full-screen LiDAR scan of one lower leg.
///
/// Steps: find the floor → tap the cuff point → walk around the leg → finish.
/// While scanning, two virtual tapes (rings of 36 segments) at the ankle and calf turn green
/// sector by sector as each side of the leg is captured.
/// Produces a JSON scan object (see PointAccumulator.exportJSON) for the web app, which
/// measures the circumferences. Not offered in Australia (see WebViewController).
final class ScanViewController: UIViewController, ARSessionDelegate {
    var onComplete: ((String) -> Void)?
    var onCancel: ((String) -> Void)?

    private enum Stage { case findingFloor, awaitingCuff, readyToScan, scanning, finishing }

    /// Both bands must reach this coverage before the scan can be finished.
    private let requiredCoverage = 0.85

    private let leg: String
    private let sceneView = ARSCNView(frame: .zero)
    private let titleLabel = UILabel()
    private let instructionLabel = UILabel()
    private let progressLabel = UILabel()
    private let actionButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)

    private var stage: Stage = .findingFloor { didSet { updateUI() } }
    private var floorY: Float?
    private var floorAnchorID: UUID?
    private var cuffPoint: SIMD3<Float>?
    private var cuffNode: SCNNode?
    private var accumulator: PointAccumulator?
    private let processingQueue = DispatchQueue(label: "compressionfit.scan", qos: .userInitiated)
    private var frameIndex = 0
    private var processing = false
    private var trackingNormal = false
    private var coverage: (ankle: Double, calf: Double) = (0, 0)
    private var pointCount = 0
    private var notice: String?
    private var ankleRing: SCNNode?
    private var calfRing: SCNNode?
    private var completedRings: Set<String> = []

    init(leg: String) {
        self.leg = leg
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

    // MARK: - Layout

    private func layout() {
        sceneView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(sceneView)

        let panel = UIView()
        panel.backgroundColor = UIColor(red: 0.09, green: 0.18, blue: 0.16, alpha: 0.88)
        panel.layer.cornerRadius = 18
        panel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(panel)

        titleLabel.font = .preferredFont(forTextStyle: .headline)
        instructionLabel.font = .preferredFont(forTextStyle: .subheadline)
        progressLabel.font = .monospacedDigitSystemFont(ofSize: 15, weight: .semibold)
        for label in [titleLabel, instructionLabel, progressLabel] {
            label.textColor = .white
            label.numberOfLines = 0
            label.adjustsFontForContentSizeCategory = true
        }

        actionButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        actionButton.backgroundColor = UIColor(red: 0.09, green: 0.36, blue: 0.29, alpha: 1)
        actionButton.setTitleColor(.white, for: .normal)
        actionButton.setTitleColor(UIColor(white: 1, alpha: 0.5), for: .disabled)
        actionButton.layer.cornerRadius = 12
        actionButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 50).isActive = true
        actionButton.addTarget(self, action: #selector(handleAction), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [titleLabel, instructionLabel, progressLabel, actionButton])
        stack.axis = .vertical
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        panel.addSubview(stack)

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
            panel.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -12),

            stack.topAnchor.constraint(equalTo: panel.topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: panel.bottomAnchor, constant: -16),
            stack.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -16)
        ])
    }

    private func updateUI() {
        let legName = leg == "right" ? "right" : "left"
        var progress = ""
        var buttonTitle = ""
        var buttonEnabled = false
        switch stage {
        case .findingFloor:
            titleLabel.text = "1. Find the floor"
            instructionLabel.text = "Point the phone at the floor beside the \(legName) foot and move it slowly from side to side."
            buttonTitle = "Finding the floor…"
        case .awaitingCuff:
            titleLabel.text = "2. Set the cuff point"
            instructionLabel.text = "Stand behind the \(legName) leg. Tap the skin two finger widths below the knee crease."
            buttonTitle = "Tap the cuff point"
        case .readyToScan:
            titleLabel.text = "3. AR girth tape: \(legName) leg"
            let height = cuffHeightCentimetres().map { String(format: "%.1f", $0) } ?? "–"
            instructionLabel.text = "Cuff point is \(height) cm above the floor. Tap again to move it. Then start, and walk slowly all the way around the leg at arm’s length, sweeping from the ankle to the knee. The virtual tapes at the ankle and calf turn green as each side is captured."
            buttonTitle = "Start scan"
            buttonEnabled = true
        case .scanning:
            titleLabel.text = "AR girth tape: \(legName) leg"
            instructionLabel.text = trackingNormal
                ? "Keep walking slowly around the leg until both virtual tapes are green all the way round, including between the legs."
                : "Tracking is limited. Move more slowly and keep the leg and floor in view."
            progress = String(format: "Ankle %ld%%  ·  Calf %ld%%  ·  %ld points",
                              Int(coverage.ankle * 100), Int(coverage.calf * 100), pointCount)
            buttonTitle = "Finish scan"
            buttonEnabled = coverage.ankle >= requiredCoverage && coverage.calf >= requiredCoverage && pointCount > 3000
        case .finishing:
            titleLabel.text = "Saving the scan"
            instructionLabel.text = "Measuring will take a moment."
            buttonTitle = "Saving…"
        }
        if let notice {
            instructionLabel.text = notice
        }
        progressLabel.text = progress
        progressLabel.isHidden = progress.isEmpty
        actionButton.setTitle(buttonTitle, for: .normal)
        actionButton.isEnabled = buttonEnabled
        actionButton.alpha = buttonEnabled ? 1 : 0.6
    }

    private func cuffHeightCentimetres() -> Float? {
        guard let cuffPoint, let floorY else { return nil }
        return (cuffPoint.y - floorY) * 100
    }

    // MARK: - Actions

    @objc private func handleCancel() {
        onCancel?("Scan cancelled.")
    }

    @objc private func handleAction() {
        switch stage {
        case .readyToScan:
            guard let cuffPoint, let floorY else { return }
            notice = nil
            accumulator = PointAccumulator(origin: SIMD3<Float>(cuffPoint.x, floorY, cuffPoint.z),
                                           cuffHeight: cuffPoint.y - floorY)
            coverage = (0, 0)
            pointCount = 0
            placeCoverageRings(origin: SIMD3<Float>(cuffPoint.x, floorY, cuffPoint.z), cuffHeight: cuffPoint.y - floorY)
            stage = .scanning
        case .scanning:
            finish()
        default:
            break
        }
    }

    private func finish() {
        guard let accumulator else { return }
        stage = .finishing
        let leg = self.leg
        processingQueue.async { [weak self] in
            let json = accumulator.exportJSON(leg: leg)
            DispatchQueue.main.async {
                guard let self else { return }
                if let json {
                    self.onComplete?(json)
                } else {
                    self.onCancel?("The scan could not be saved. Please try again.")
                }
            }
        }
    }

    @objc private func handleTap(_ gesture: UITapGestureRecognizer) {
        guard stage == .awaitingCuff || stage == .readyToScan,
              let floorY, let frame = sceneView.session.currentFrame else { return }
        guard let point = surfacePoint(at: gesture.location(in: sceneView), frame: frame) else {
            notice = "The depth could not be read there. Move a little closer and tap the skin again."
            updateUI()
            return
        }
        let height = point.y - floorY
        guard (0.15...0.80).contains(height) else {
            notice = String(format: "That point is %.0f cm above the floor. Tap the skin two finger widths below the knee crease.", height * 100)
            updateUI()
            return
        }
        notice = nil
        cuffPoint = point
        placeCuffMarker(at: point)
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        stage = .readyToScan
    }

    private func surfacePoint(at viewPoint: CGPoint, frame: ARFrame) -> SIMD3<Float>? {
        LiDAR.surfacePoint(at: viewPoint, in: sceneView, frame: frame)
    }

    /// Virtual tapes at the ankle and calf band heights; repositioned as the leg centre is found.
    private func placeCoverageRings(origin: SIMD3<Float>, cuffHeight: Float) {
        ankleRing?.removeFromParentNode()
        calfRing?.removeFromParentNode()
        let ankle = Hologram.tape(radius: 0.05, colour: ARDrawing.faint)
        let calf = Hologram.tape(radius: 0.07, colour: ARDrawing.faint)
        completedRings = []
        ankle.simdWorldPosition = origin + SIMD3<Float>(0, 0.11, 0)
        calf.simdWorldPosition = origin + SIMD3<Float>(0, (0.20 + max(0.21, cuffHeight - 0.04)) / 2, 0)
        sceneView.scene.rootNode.addChildNode(ankle)
        sceneView.scene.rootNode.addChildNode(calf)
        ankleRing = ankle
        calfRing = calf
        Hologram.wrap(ankle)
        Hologram.wrap(calf, duration: 1.1)
        Hologram.sweep(in: sceneView.scene.rootNode, at: origin, height: cuffHeight)
    }

    private func updateCoverageRings(_ bands: (ankle: PointAccumulator.BandCoverage, calf: PointAccumulator.BandCoverage),
                                     origin: SIMD3<Float>) {
        for (name, ring, band, radius) in [("ankle", ankleRing, bands.ankle, Float(0.05)), ("calf", calfRing, bands.calf, Float(0.07))] {
            guard let ring else { continue }
            if band.centre != .zero {
                ring.simdWorldPosition = origin + SIMD3<Float>(band.centre.x, band.height, band.centre.y)
            }
            ARDrawing.colourSegments(of: ring, covered: band.sectors)
            // When a tape is complete all the way round: green halo and a sparkle, once.
            if band.fraction >= requiredCoverage && !completedRings.contains(name) {
                completedRings.insert(name)
                if let halo = ring.childNode(withName: "halo", recursively: false) {
                    halo.geometry?.firstMaterial?.diffuse.contents = ARDrawing.lime.withAlphaComponent(0.25)
                    halo.geometry?.firstMaterial?.emission.contents = ARDrawing.lime.withAlphaComponent(0.25)
                }
                Hologram.sparkle(around: ring, radius: radius)
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
        }
    }

    private func placeCuffMarker(at point: SIMD3<Float>) {
        cuffNode?.removeFromParentNode()
        let sphere = SCNSphere(radius: 0.008)
        sphere.firstMaterial?.diffuse.contents = UIColor(red: 0.79, green: 1, blue: 0.51, alpha: 1)
        sphere.firstMaterial?.lightingModel = .constant
        let node = SCNNode(geometry: sphere)
        node.simdWorldPosition = point
        sceneView.scene.rootNode.addChildNode(node)
        cuffNode = node
    }

    // MARK: - ARSessionDelegate (called on the main thread)

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard stage == .scanning, trackingNormal, !processing, let accumulator else { return }
        frameIndex += 1
        guard frameIndex % 2 == 0 else { return }
        guard let depthData = frame.smoothedSceneDepth ?? frame.sceneDepth,
              let confidenceMap = depthData.confidenceMap,
              let sample = DepthSample(depthMap: depthData.depthMap, confidenceMap: confidenceMap, camera: frame.camera)
        else { return }
        processing = true
        let measureCoverage = frameIndex % 10 == 0
        processingQueue.async { [weak self] in
            accumulator.add(sample)
            let count = accumulator.pointCount
            let bands = measureCoverage ? accumulator.bandCoverages() : nil
            DispatchQueue.main.async {
                guard let self else { return }
                self.processing = false
                guard self.stage == .scanning else { return }
                self.pointCount = count
                if let bands {
                    self.coverage = (bands.ankle.fraction, bands.calf.fraction)
                    self.updateCoverageRings(bands, origin: accumulator.origin)
                }
                self.updateUI()
            }
        }
    }

    func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
        considerFloor(anchors, session: session)
    }

    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        considerFloor(anchors, session: session)
    }

    /// Uses the lowest horizontal plane classified as floor (or well below the phone).
    /// The floor height is frozen once the cuff point is set.
    private func considerFloor(_ anchors: [ARAnchor], session: ARSession) {
        guard stage == .findingFloor || stage == .awaitingCuff,
              let cameraY = session.currentFrame?.camera.transform.columns.3.y else { return }
        for case let plane as ARPlaneAnchor in anchors where plane.alignment == .horizontal {
            let y = plane.transform.columns.3.y
            var classifiedFloor = false
            if ARPlaneAnchor.isClassificationSupported, case .floor = plane.classification { classifiedFloor = true }
            guard classifiedFloor || y < cameraY - 0.5 else { continue }
            if plane.identifier == floorAnchorID {
                floorY = y
            } else if floorY == nil || y < (floorY ?? 0) - 0.01 {
                floorY = y
                floorAnchorID = plane.identifier
            }
        }
        if floorY != nil && stage == .findingFloor {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            stage = .awaitingCuff
        }
    }

    func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        if case .normal = camera.trackingState {
            trackingNormal = true
        } else {
            trackingNormal = false
        }
        updateUI()
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        onCancel?("The scan stopped: \(error.localizedDescription)")
    }

    func sessionWasInterrupted(_ session: ARSession) {
        if stage == .scanning {
            onCancel?("The scan was interrupted. Please scan again.")
        }
    }
}
