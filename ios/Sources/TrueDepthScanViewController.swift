import AVFoundation
import CoreMotion
import UIKit

/// Face ID (TrueDepth) depth scan: TEST MODE, Ireland, UK and EU only.
///
/// Uses the front TrueDepth camera (structured light), which every Face ID iPhone has, so it
/// works without LiDAR. The phone is held about 40 cm from the bare lower leg with the screen
/// facing the leg, so the person holding it cannot see the screen: the app speaks and
/// vibrates to guide them.
///
/// Two captures: the front of the shin, then the outer side of the leg. Each is the average
/// of 12 steady depth frames, converted to points in the camera frame (metres, Int16 at
/// 0.25 mm, base64) and sent to the web app, which measures them (dist/truedepth.js).
/// Nothing is measured here.
final class TrueDepthScanViewController: UIViewController, AVCaptureDepthDataOutputDelegate {
    var onComplete: ((String) -> Void)?
    var onCancel: ((String) -> Void)?

    private enum Capture: String { case front, side }
    private enum Stage: Equatable { case ready, aiming(Capture), capturing(Capture), done }

    private let leg: String
    private let session = AVCaptureSession()
    private let depthOutput = AVCaptureDepthDataOutput()
    private let videoOutput = AVCaptureVideoDataOutput()
    private let depthQueue = DispatchQueue(label: "truedepth.depth")
    private let motion = CMMotionManager()
    private let speech = AVSpeechSynthesizer()
    private let panel = ARPanel()
    private let cancelButton = UIButton(type: .system)
    private let distanceLabel = UILabel()

    private var stage: Stage = .ready { didSet { publishStage(); updateUI() } }
    private var results: [Capture: String] = [:]
    // Depth averaging (depth queue only).
    private var sum: [Float] = []
    private var count: [UInt16] = []
    private var framesAveraged = 0
    private var mapSize = (width: 0, height: 0)
    private var intrinsics = (fx: Float(0), fy: Float(0), cx: Float(0), cy: Float(0))
    private var steadySince: Date?
    private var lastSpoken = ""
    private var lastSpokenAt = Date.distantPast

    /// Hold range (metres to the nearest surface at the centre of the view).
    private let nearLimit: Float = 0.28
    private let farLimit: Float = 0.50
    private let framesPerCapture = 12

    init(leg: String) {
        self.leg = leg == "right" ? "right" : "left"
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    static var isAvailable: Bool {
        AVCaptureDevice.default(.builtInTrueDepthCamera, for: .video, position: .front) != nil
    }

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.03, green: 0.1, blue: 0.11, alpha: 1)
        layout()
        panel.actionButton.addTarget(self, action: #selector(handleAction), for: .touchUpInside)
        panel.secondaryButton.addTarget(self, action: #selector(handleSecondary), for: .touchUpInside)
        updateUI()
        configureSession()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true
        motion.deviceMotionUpdateInterval = 1.0 / 30
        motion.startDeviceMotionUpdates()
        depthQueue.async { [session] in session.startRunning() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        UIApplication.shared.isIdleTimerDisabled = false
        motion.stopDeviceMotionUpdates()
        speech.stopSpeaking(at: .immediate)
        depthQueue.async { [session] in session.stopRunning() }
    }

    private func layout() {
        panel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(panel)
        distanceLabel.font = .monospacedDigitSystemFont(ofSize: 64, weight: .bold)
        distanceLabel.textColor = Hologram.cyan
        distanceLabel.textAlignment = .center
        distanceLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(distanceLabel)
        cancelButton.setTitle("Cancel", for: .normal)
        cancelButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        cancelButton.setTitleColor(.white, for: .normal)
        cancelButton.translatesAutoresizingMaskIntoConstraints = false
        cancelButton.addTarget(self, action: #selector(handleCancel), for: .touchUpInside)
        view.addSubview(cancelButton)
        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            cancelButton.topAnchor.constraint(equalTo: guide.topAnchor, constant: 8),
            cancelButton.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
            distanceLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            distanceLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -80),
            panel.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 12),
            panel.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -12),
            panel.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -12)
        ])
    }

    private func configureSession() {
        guard let device = AVCaptureDevice.default(.builtInTrueDepthCamera, for: .video, position: .front),
              let input = try? AVCaptureDeviceInput(device: device) else {
            onCancel?("This iPhone has no Face ID camera.")
            return
        }
        session.beginConfiguration()
        session.sessionPreset = .vga640x480
        guard session.canAddInput(input) else { session.commitConfiguration(); return }
        session.addInput(input)
        if session.canAddOutput(videoOutput) { session.addOutput(videoOutput) }
        guard session.canAddOutput(depthOutput) else { session.commitConfiguration(); return }
        session.addOutput(depthOutput)
        depthOutput.isFilteringEnabled = true   // fills holes and smooths edges
        depthOutput.setDelegate(self, callbackQueue: depthQueue)
        // Largest Float32 depth format.
        let formats = device.activeFormat.supportedDepthDataFormats.filter {
            CMFormatDescriptionGetMediaSubType($0.formatDescription) == kCVPixelFormatType_DepthFloat32
        }
        if let best = formats.max(by: {
            CMVideoFormatDescriptionGetDimensions($0.formatDescription).width < CMVideoFormatDescriptionGetDimensions($1.formatDescription).width
        }), (try? device.lockForConfiguration()) != nil {
            device.activeDepthDataFormat = best
            device.unlockForConfiguration()
        }
        session.commitConfiguration()
    }

    // MARK: - Guidance

    private func say(_ text: String, force: Bool = false) {
        guard force || text != lastSpoken || Date().timeIntervalSince(lastSpokenAt) > 4 else { return }
        lastSpoken = text
        lastSpokenAt = Date()
        speech.stopSpeaking(at: .word)
        speech.speak(AVSpeechUtterance(string: text))
    }

    private func updateUI() {
        let legName = leg
        switch stage {
        case .ready:
            panel.show(title: "Face ID depth scan (test)",
                       instruction: "A helper holds the phone about 40 cm in front of the bare \(legName) shin, screen facing the leg, upright, level with the middle of the calf. The phone speaks and vibrates to guide them. Two captures: front, then outer side.",
                       action: "Start", actionEnabled: true)
            distanceLabel.text = ""
        case .aiming(let capture):
            panel.show(title: capture == .front ? "1. Front of the shin" : "2. Outer side of the leg",
                       instruction: capture == .front
                        ? "Hold the phone upright about 40 cm in front of the shin, level with the middle of the calf, screen facing the leg. Keep the ankle and the knee in view."
                        : "Move round to the outer side of the \(legName) leg. Same distance and height, screen facing the leg.",
                       action: "Waiting for the leg…", actionEnabled: false, secondary: "Retake front")
            panel.secondaryButton.isHidden = capture == .front
            say(capture == .front ? "Hold the phone forty centimetres in front of the shin, screen facing the leg."
                                  : "Now move to the outer side of the leg. Same distance.", force: true)
        case .capturing(let capture):
            panel.show(title: "Capturing the \(capture.rawValue)…", instruction: "Hold still.",
                       action: "Capturing…", actionEnabled: false)
        case .done:
            panel.show(title: "Both captures done", instruction: "Sending them to Compression Fit to measure.",
                       action: "Send", actionEnabled: true, secondary: "Retake both")
            distanceLabel.text = "✓"
        }
    }

    @objc private func handleAction() {
        switch stage {
        case .ready: beginAiming(.front)
        case .done: finish()
        default: break
        }
    }

    @objc private func handleSecondary() {
        switch stage {
        case .aiming(.side): results[.front] = nil; beginAiming(.front)
        case .done: results = [:]; beginAiming(.front)
        default: break
        }
    }

    @objc private func handleCancel() {
        onCancel?("Face ID depth scan cancelled.")
    }

    private func beginAiming(_ capture: Capture) {
        depthQueue.async { [weak self] in self?.resetAverage() }
        steadySince = nil
        stage = .aiming(capture)
    }

    // MARK: - Depth (depth queue)

    private func resetAverage() {
        sum = []
        count = []
        framesAveraged = 0
    }

    func depthDataOutput(_ output: AVCaptureDepthDataOutput, didOutput depthData: AVDepthData,
                         timestamp: CMTime, connection: AVCaptureConnection) {
        let depth = depthData.depthDataType == kCVPixelFormatType_DepthFloat32
            ? depthData : depthData.converting(toDepthDataType: kCVPixelFormatType_DepthFloat32)
        let map = depth.depthDataMap
        CVPixelBufferLockBaseAddress(map, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
        let width = CVPixelBufferGetWidth(map), height = CVPixelBufferGetHeight(map)
        let rowFloats = CVPixelBufferGetBytesPerRow(map) / MemoryLayout<Float32>.size
        guard let base = CVPixelBufferGetBaseAddress(map)?.assumingMemoryBound(to: Float32.self) else { return }

        // Distance to the nearest surface in the central fifth of the view.
        var centre: [Float] = []
        for row in stride(from: height * 2 / 5, to: height * 3 / 5, by: 4) {
            for column in stride(from: width * 2 / 5, to: width * 3 / 5, by: 4) {
                let z = base[row * rowFloats + column]
                if z.isFinite && z > 0.1 { centre.append(z) }
            }
        }
        centre.sort()
        let nearest = centre.isEmpty ? Float.nan : centre[centre.count / 10]

        DispatchQueue.main.async { [weak self] in self?.guide(nearest: nearest) }

        guard case .capturing = currentStage() else { return }
        if sum.isEmpty || mapSize.width != width || mapSize.height != height {
            sum = [Float](repeating: 0, count: width * height)
            count = [UInt16](repeating: 0, count: width * height)
            mapSize = (width, height)
            // Intrinsics are given for a reference size; scale them to the depth map.
            if let calibration = depth.cameraCalibrationData {
                let k = calibration.intrinsicMatrix
                let scale = Float(width) / Float(calibration.intrinsicMatrixReferenceDimensions.width)
                intrinsics = (k.columns.0.x * scale, k.columns.1.y * scale, k.columns.2.x * scale, k.columns.2.y * scale)
            }
        }
        for row in 0..<height {
            for column in 0..<width {
                let z = base[row * rowFloats + column]
                guard z.isFinite, z > 0.1, z < 0.8 else { continue }
                sum[row * width + column] += z
                count[row * width + column] += 1
            }
        }
        framesAveraged += 1
        if framesAveraged >= framesPerCapture, intrinsics.fx > 0 {
            let encoded = encodeAverage()
            DispatchQueue.main.async { [weak self] in self?.captured(encoded) }
            resetAverage()
        }
    }

    private var stageSnapshot: Stage = .ready
    private let stageLock = NSLock()
    private func currentStage() -> Stage {
        stageLock.lock(); defer { stageLock.unlock() }
        return stageSnapshot
    }
    private func publishStage() {
        stageLock.lock(); stageSnapshot = stage; stageLock.unlock()
    }

    /// Averaged depth → points (pixels seen in at least half the frames), every second pixel.
    private func encodeAverage() -> String {
        let (width, height) = mapSize
        var ints: [Int16] = []
        ints.reserveCapacity(width * height / 4 * 3)
        let minimum = UInt16(framesPerCapture / 2)
        for row in stride(from: 0, to: height, by: 2) {
            for column in stride(from: 0, to: width, by: 2) {
                let i = row * width + column
                guard count[i] >= minimum else { continue }
                let z = sum[i] / Float(count[i])
                let x = (Float(column) - intrinsics.cx) * z / intrinsics.fx
                let y = (Float(row) - intrinsics.cy) * z / intrinsics.fy
                for value in [x, y, z] {
                    ints.append(Int16(clamping: Int((value * 4000).rounded())))
                }
            }
        }
        return ints.withUnsafeBufferPointer { Data(buffer: $0) }.base64EncodedString()
    }

    // MARK: - Steps (main thread)

    private func guide(nearest: Float) {
        publishStage()
        guard case .aiming(let capture) = stage else { return }
        guard nearest.isFinite else {
            distanceLabel.text = "–"
            say("Point the screen at the leg.")
            steadySince = nil
            return
        }
        distanceLabel.text = String(format: "%.0f cm", nearest * 100)
        if nearest < nearLimit {
            say("Move back a little."); steadySince = nil; return
        }
        if nearest > farLimit {
            say("Move closer."); steadySince = nil; return
        }
        let rotation = motion.deviceMotion?.rotationRate
        let still = rotation.map { abs($0.x) + abs($0.y) + abs($0.z) < 0.25 } ?? true
        guard still else { say("Hold still."); steadySince = nil; return }
        if steadySince == nil {
            steadySince = Date()
            say("Good. Hold still.")
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } else if let since = steadySince, Date().timeIntervalSince(since) > 1.0 {
            stage = .capturing(capture)
            publishStage()
        }
    }

    private func captured(_ encoded: String) {
        guard case .capturing(let capture) = stage else { return }
        results[capture] = encoded
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        if capture == .front {
            say("Front captured.", force: true)
            beginAiming(.side)
        } else {
            say("Side captured. Done.", force: true)
            stage = .done
        }
        publishStage()
    }

    private func finish() {
        guard let front = results[.front], let side = results[.side] else { return }
        let payload: [String: Any] = [
            "tool": "truedepth",
            "leg": leg,
            "captures": [["name": "front", "points": front], ["name": "side", "points": side]],
            "capturedAt": ISO8601DateFormatter().string(from: Date())
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else {
            onCancel?("The captures could not be saved. Please try again.")
            return
        }
        onComplete?(json)
    }
}
