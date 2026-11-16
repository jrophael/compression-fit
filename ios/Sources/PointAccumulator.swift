import ARKit
import Foundation
import simd

/// One LiDAR depth frame, copied out of the ARFrame so the frame can be released at once.
struct DepthSample {
    let width: Int
    let height: Int
    /// Row-major depth in metres along the camera axis.
    let depth: [Float32]
    /// Row-major ARConfidenceLevel raw values (0 low, 1 medium, 2 high).
    let confidence: [UInt8]
    /// Camera intrinsics for the captured image resolution (column-major).
    let intrinsics: simd_float3x3
    let imageResolution: CGSize
    let cameraTransform: simd_float4x4

    /// World position of a depth-map pixel (column, row may be fractional pixel centres).
    func unproject(column: Float, row: Float, depth d: Float) -> SIMD3<Float> {
        let fx = intrinsics[0][0], fy = intrinsics[1][1]
        let cx = intrinsics[2][0], cy = intrinsics[2][1]
        let u = column * Float(imageResolution.width) / Float(width)
        let v = row * Float(imageResolution.height) / Float(height)
        // ARKit camera space: x right, y up, looking down -z. Image rows run downwards.
        let camera = SIMD4<Float>((u - cx) / fx * d, -(v - cy) / fy * d, -d, 1)
        let world = cameraTransform * camera
        return SIMD3<Float>(world.x, world.y, world.z)
    }
}

extension DepthSample {
    init?(depthMap: CVPixelBuffer, confidenceMap: CVPixelBuffer, camera: ARCamera) {
        let width = CVPixelBufferGetWidth(depthMap)
        let height = CVPixelBufferGetHeight(depthMap)
        guard CVPixelBufferGetWidth(confidenceMap) == width,
              CVPixelBufferGetHeight(confidenceMap) == height else { return nil }
        CVPixelBufferLockBaseAddress(depthMap, .readOnly)
        CVPixelBufferLockBaseAddress(confidenceMap, .readOnly)
        defer {
            CVPixelBufferUnlockBaseAddress(depthMap, .readOnly)
            CVPixelBufferUnlockBaseAddress(confidenceMap, .readOnly)
        }
        guard let depthBase = CVPixelBufferGetBaseAddress(depthMap),
              let confidenceBase = CVPixelBufferGetBaseAddress(confidenceMap) else { return nil }
        let depthRowBytes = CVPixelBufferGetBytesPerRow(depthMap)
        let confidenceRowBytes = CVPixelBufferGetBytesPerRow(confidenceMap)
        var depth = [Float32](repeating: 0, count: width * height)
        var confidence = [UInt8](repeating: 0, count: width * height)
        for row in 0..<height {
            let depthRow = depthBase.advanced(by: row * depthRowBytes).assumingMemoryBound(to: Float32.self)
            let confidenceRow = confidenceBase.advanced(by: row * confidenceRowBytes).assumingMemoryBound(to: UInt8.self)
            for column in 0..<width {
                depth[row * width + column] = depthRow[column]
                confidence[row * width + column] = confidenceRow[column]
            }
        }
        self.init(width: width, height: height, depth: depth, confidence: confidence,
                  intrinsics: camera.intrinsics, imageResolution: camera.imageResolution,
                  cameraTransform: camera.transform)
    }
}

/// Accumulates LiDAR surface points around one leg into 4 mm voxels.
///
/// Coordinates are relative to `origin`: the floor point directly below the tapped cuff
/// point, y up. Not thread-safe: use it from one serial queue.
final class PointAccumulator {
    private struct VoxelKey: Hashable {
        let x: Int32
        let y: Int32
        let z: Int32
    }

    let origin: SIMD3<Float>
    let cuffHeight: Float
    private let voxelSize: Float = 0.004
    private let captureRadius: Float = 0.30
    private let depthRange: ClosedRange<Float> = 0.15...1.3
    private var voxels: [VoxelKey: SIMD4<Float>] = [:]
    private var floorHeights: [Float] = []

    var pointCount: Int { voxels.count }

    init(origin: SIMD3<Float>, cuffHeight: Float) {
        self.origin = origin
        self.cuffHeight = cuffHeight
    }

    func add(_ sample: DepthSample) {
        let top = cuffHeight + 0.08
        let radiusSquared = captureRadius * captureRadius
        for row in 0..<sample.height {
            for column in 0..<sample.width {
                let index = row * sample.width + column
                // High confidence only.
                guard sample.confidence[index] >= 2 else { continue }
                let d = sample.depth[index]
                guard depthRange.contains(d) else { continue }
                let p = sample.unproject(column: Float(column) + 0.5, row: Float(row) + 0.5, depth: d) - origin
                let horizontalSquared = p.x * p.x + p.z * p.z
                guard horizontalSquared < radiusSquared else { continue }
                // Floor samples away from the foot, used to refine the floor height.
                if abs(p.y) < 0.03 && horizontalSquared > 0.18 * 0.18 && floorHeights.count < 40_000 {
                    floorHeights.append(p.y)
                }
                guard p.y > 0.01, p.y < top else { continue }
                let key = VoxelKey(x: Int32((p.x / voxelSize).rounded(.down)),
                                   y: Int32((p.y / voxelSize).rounded(.down)),
                                   z: Int32((p.z / voxelSize).rounded(.down)))
                voxels[key, default: .zero] += SIMD4<Float>(p.x, p.y, p.z, 1)
            }
        }
    }

    /// Share of 10° sectors around the leg that contain points, at the ankle and calf.
    func coverage() -> (ankle: Double, calf: Double) {
        let points = voxels.values.map { SIMD3<Float>($0.x, $0.y, $0.z) / $0.w }
        func bandCoverage(_ low: Float, _ high: Float) -> Double {
            let band = points.filter { $0.y >= low && $0.y <= high }
            guard band.count > 50 else { return 0 }
            // Leg centre: points near the cuff point, then near their centroid.
            var centre = SIMD2<Float>(0, 0)
            for radius: Float in [0.14, 0.11] {
                let near = band.filter { simd_length(SIMD2($0.x, $0.z) - centre) < radius }
                guard !near.isEmpty else { return 0 }
                centre = near.reduce(SIMD2<Float>(0, 0)) { $0 + SIMD2($1.x, $1.z) } / Float(near.count)
            }
            var sectors = [Bool](repeating: false, count: 36)
            for p in band {
                let offset = SIMD2(p.x, p.z) - centre
                guard simd_length(offset) < 0.12 else { continue }
                let angle = atan2(offset.y, offset.x) + .pi
                sectors[min(35, Int(angle / (2 * .pi) * 36))] = true
            }
            return Double(sectors.filter { $0 }.count) / 36
        }
        return (bandCoverage(0.06, 0.16), bandCoverage(0.20, max(0.21, cuffHeight - 0.04)))
    }

    /// JSON scan object for the web app (`scan.js`, format version 1).
    func exportJSON(leg: String) -> String? {
        // Refine the floor from LiDAR floor samples, within ±2 cm of the ARKit plane.
        var floorOffset: Float = 0
        if floorHeights.count > 300 {
            let sorted = floorHeights.sorted()
            let median = sorted[sorted.count / 2]
            if abs(median) < 0.02 { floorOffset = median }
        }
        var values: [Int16] = []
        values.reserveCapacity(voxels.count * 3)
        for sum in voxels.values {
            let p = SIMD3<Float>(sum.x, sum.y - floorOffset * sum.w, sum.z) / sum.w
            for component in [p.x, p.y, p.z] {
                values.append(Int16(clamping: Int((component * 4000).rounded())))
            }
        }
        // iPhone is little-endian, matching Int16Array in the web app.
        let data = values.withUnsafeBufferPointer { Data(buffer: $0) }
        let scan: [String: Any] = [
            "version": 1,
            "leg": leg,
            "cuffHeight": Double(cuffHeight - floorOffset),
            "points": data.base64EncodedString(),
            "pointCount": voxels.count,
            "floorCorrection": Double(floorOffset),
            "source": "ios-lidar",
            "device": Self.deviceIdentifier(),
            "capturedAt": ISO8601DateFormatter().string(from: Date())
        ]
        guard let json = try? JSONSerialization.data(withJSONObject: scan) else { return nil }
        return String(data: json, encoding: .utf8)
    }

    private static func deviceIdentifier() -> String {
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { buffer in
            String(decoding: buffer.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
    }
}
