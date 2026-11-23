# Compression Fit iPhone app (LiDAR scan and AR tape)

A small iPhone app that shows the Compression Fit web app and adds a native LiDAR scan of the lower leg and three AR tape tools (guide, length ruler, girth tape). The scan is a cloud of surface points, and it goes straight into the web page. `dist/scan.js` then measures ankle and calf circumference and floor-to-cuff length. The measurement maths is in the web app, so it is covered by `tests/scan.test.js` and can change without an app release.

**Status:** this code was written without access to Xcode or a device, so it has not been compiled or run yet. This includes the AR tape tools. Expect a short round of build fixes. The ARKit depth handling follows Apple's "Displaying a point cloud using scene depth" sample conventions.

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

Without XcodeGen: create a new iOS App project in Xcode (SwiftUI, Swift) named CompressionFit. Delete its generated `ContentView.swift` and app file, and add the seven Swift files in `Sources/`. Add the `NSCameraUsageDescription` key and the `arkit` required device capability to the Info settings.

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

## AR tape tools

The page's **AR tape** mode posts `{action: 'arTape', tool, leg, market}`.

- `ARSupport.swift`: shared LiDAR tap-to-surface point, floor finder, the bottom panel, and SceneKit drawing (rings, segmented coverage rings, the vertical centimetre tape, labels). The guides are drawn without depth testing so they stay visible through the leg.
- `ARTapeViewController.swift`, tools `guide` and `length`:
  1. Floor found as for the scanner. The operator taps the cuff point (15–80 cm up); a vertical virtual tape with centimetre ticks runs from the floor to it, and the length is shown.
  2. `length` returns `{tool: 'length', leg, length}`.
  3. `guide` continues: for the ankle (4–25 cm up) and the calf (15 cm to 2 cm below the cuff), the operator taps the front of the leg at the measuring point and an amber ring (4 or 6 cm radius, centred behind the tapped skin, away from the camera) shows where the tape goes. After wrapping a real tape, the operator taps the middle of the tape at the front (must be within 1 cm of the ring height) and at the side (within 1 cm of the front: level). The ring turns green and the tape reading is typed in (ankle 10–65 cm, calf 15–100 cm and more than the ankle).
  4. Returns `{tool: 'guide', leg, ankle, calf, length, guideHeights, placementChecks}`. Heights and errors are in centimetres.
  The camera and LiDAR only locate the floor, measure heights and draw the guides. They never measure a circumference, so this tool is the Australian route.
- **AR girth tape** (`tool: 'girth'`) is `ScanViewController`, now drawing two segmented virtual tapes at the ankle and calf band heights. Each 10° segment turns green when that sector has points (`PointAccumulator.bandCoverages()`), and the rings move to the leg centre as it is found. The scan returns to `window.receiveArTape({tool: 'girth', scan})`. `WebViewController` refuses it when `market` is `au`, as does the page.

**Holographic look** (`Hologram.swift`, visual only, nothing in it measures):

- All guides use a self-lit additive material drawn over the leg, so they read as light rather than solid objects.
- Virtual tapes are rings of segments with a soft halo. They wrap themselves onto the leg segment by segment (`wrap`), breathe while the app waits for the user (`pulse`), and turn green with a burst of sparks when the tape is confirmed or a girth sector band is complete (`sparkle`).
- The length tape grows up from the floor (`rise`) while a translucent disc sweeps up the leg (`sweep`).
- Results float beside the leg as camera-facing cards with a cyan rim (`card`): the length at the cuff point, each tape reading beside its ring, and a summary above the knee.
- When both tape readings are in, a holographic stocking slides onto the leg (`stocking`): 17 rings from the floor to the cuff, radius from the tape circumference ÷ 2π, shading strongest at the ankle, lime cuff ring. It uses the typed tape readings only.
- All motion is skipped when Reduce Motion is on in iOS Settings.

The web page's AR tape panel shows an animated SVG preview of the same look (CSS only; static when the browser asks for reduced motion).

Test on a device: check that the rings sit on the skin at the expected heights, that a tape placed 2 cm off the ring is rejected, and that the vertical tape's length matches a tape measure within 1 cm.

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
