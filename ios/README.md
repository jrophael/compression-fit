# Compression Fit iPhone app (LiDAR scan)

A small iPhone app that shows the Compression Fit web app and adds a native LiDAR scan of the lower leg. The scan is a cloud of surface points, and it goes straight into the web page. `dist/scan.js` then measures ankle and calf circumference and floor-to-cuff length. The measurement maths is in the web app, so it is covered by `tests/scan.test.js` and can change without an app release.

**Status:** this code was written without access to Xcode or a device, so it has not been compiled or run yet. Expect a short round of build fixes. The ARKit depth handling follows Apple's "Displaying a point cloud using scene depth" sample conventions.

## Requirements

- A Mac with Xcode 15 or later.
- An iPhone with LiDAR: iPhone 12 Pro or Pro Max, or any later Pro or Pro Max. Other iPhones show the web app only.
- iOS 16 or later.
- An Apple Developer account for running on a device. A free personal team works for testing. TestFlight needs a paid membership.

## Build

```sh
brew install xcodegen
cd ios
xcodegen            # creates CompressionFit.xcodeproj from project.yml
open CompressionFit.xcodeproj
```

In Xcode, select the CompressionFit target. Under **Signing & Capabilities**, choose your team, and change the bundle ID if needed. Then run on a connected LiDAR iPhone.

Without XcodeGen: create a new iOS App project in Xcode (SwiftUI, Swift) named CompressionFit. Delete its generated `ContentView.swift` and app file, and add the four files in `Sources/`. Add the `NSCameraUsageDescription` key and the `arkit` required device capability to the Info settings.

## How it works

1. `WebViewController` loads https://jrophael.github.io/compression-fit/ in a WKWebView. It injects `window.compressionFitApp = {lidar: true}` when the phone has LiDAR, and redirects `window.print()` to iOS printing.
2. In **LiDAR scan** mode, the page's **Start LiDAR scan** button posts `{action: 'scan', leg}` to the app.
3. `ScanViewController` runs ARKit world tracking with scene depth:
   - **Floor:** uses the lowest horizontal plane classified as floor. The height is refined later from LiDAR floor points (±2 cm limit).
   - **Cuff point:** the operator taps the skin two finger widths below the knee crease. Its 3D position comes from the median LiDAR depth around the tap. Length = cuff height above the floor.
   - **Scan:** the operator walks around the leg. High-confidence depth pixels within 30 cm of the cuff point are averaged into 4 mm voxels. Frames are skipped while tracking is limited. **Finish** is enabled at 85% angular coverage at both the ankle and calf.
4. `PointAccumulator.exportJSON` sends `{version: 1, leg, cuffHeight, points}` to `window.receiveLidarScan(...)`. The points are base64 Int16 values in 0.25 mm units, relative to the floor below the cuff point, with y up.
5. The web app measures the scan. It fills the fields only when **two scans of the same leg agree within 1 cm** on ankle, calf and length, and then uses their average.

**Export last scan** shares the scan file for validation records. Exported files can be loaded in any browser with **Or load a scan file**.

## Privacy

Scans stay on the phone and in the page's memory. Nothing is uploaded. Scan files leave the phone only when the user taps Export.

## Accuracy target and validation

The target is agreement with an expert tape measurement within ±1 cm.

- **Synthetic legs:** `tests/scan.test.js` covers noise, strays, tilt, gaps, drift and a neighbouring leg. Errors stay within 0.4 cm.
- **Real legs:** not validated yet. Published work with an iPhone 15 Pro found LiDAR lower-leg circumferences agreed well with tape in lymphoedema patients. That does not validate this code.

Before any clinical use:

1. **Rigid forms:** scan cylinders or a leg form of known circumference, 10 repeats each, and confirm the bias and the 95% limits of agreement are within ±1 cm.
2. **Paired study:** compare LiDAR (two-scan mean) against two independent fitters' tape measurements, using the same landmarks. Report Bland–Altman bias and limits for ankle, calf and length. Report LiDAR repeatability separately.
3. **Systematic offset:** a tape compresses skin and LiDAR does not, so LiDAR may read slightly larger. If the paired study shows a consistent offset, apply it in `scan.js` and record the evidence.
4. Then reconsider the 1 cm cutoff buffer in `fit.js`.

## Known limits

- **Cuff tap:** length depends on where the operator taps. Tap precision of about 0.5 cm is realistic.
- **Legs too close:** if the legs touch at the calf, the leg cannot be separated. Ask the wearer to stand with feet hip-width apart.
- **Feet and the narrowest ankle:** the ankle search runs 5–22 cm above the floor. A minimum found at the edge of that range produces a warning.
- **Tracking drift:** fast walking or poor light can blur the point cloud. Repeat scans that disagree are rejected.
