# Compression Fit — developer handoff

This ZIP contains the HTML, CSS and JavaScript from the deployed private pilot at commit `86532779cf4eb28f5a75047306805506951ebfe2`, tidied for handoff (see *Changes from the deployed commit*). Hosting and account configuration are excluded so this copy can run independently.

## Run locally

Extract the ZIP and open a terminal in the extracted `compression-fit` folder.

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory dist
```

Open http://localhost:8000. The project has no dependency install or build step. Live camera capture requires a browser secure context, such as localhost on the same device or an HTTPS deployment for a phone. An existing video can also be selected for testing.

## Hosting

Pushing to `main` runs `.github/workflows/pages.yml`, which checks the sizing logic and publishes `dist/` to GitHub Pages over HTTPS. HTTPS lets the live camera work on phones. The site is public to anyone with the link, but `noindex` keeps it out of search results.

## Source layout

- `dist/index.html` contains the tape and video screens, the fit form and the printable tape and calibration target.
- `dist/fit.css` controls screen and print layout.
- `dist/fit.js` contains the size matrix, matching logic, camera capture, frame annotation and measurement calculations.
- `dist/scan.js` measures LiDAR scans: leg axis, cross-section outlines, ankle and calf circumference, and length.
- `dist/viewer.js` shows the uploaded scan in 3D with its colour texture (three.js, vendored under `dist/vendor/three`, MIT). The red ring marks the length; tapping the cuff point sets floor-to-cuff length.
- `dist/models.js` reads 3D models exported by free scanning apps (OBJ, GLB, glTF or ZIP, PLY, STL, XYZ). It detects units, the up axis, the floor and the leg, then passes them to `scan.js`.
- `ios/` is the iPhone app (WKWebView shell, native ARKit LiDAR scanner and the AR tape tools). See `ios/README.md`.
- `tests/scan.test.js` and `tests/models.test.js` check measurement against synthetic legs of known size, the second through every supported export format. `tests/fixtures/` holds sample scans and models for the browser.

## How the pilot works

- All modes use the same provisional knee-high size chart. `chart` and `lengths` in `fit.js` define its ankle bands, calf cuts and lengths. Bounds are lower-inclusive and upper-exclusive. Ankle and calf are separate decisions.
- Tape mode takes three values per leg in centimetres. An ankle of 20 cm, calf of 43 cm and length of 36 cm should return **Small ankle · Wide calf · Short**.
- Assisted video uses a continuous front-to-side clip with the wearer stationary. Self-scan uses a propped phone with timed recording prompts while the wearer turns.
- The operator selects and annotates a front and a side frame. The outer corners of the printed 100 × 150 mm target define a planar homography for each frame. The target should be upright and at the same depth as the leg centre. Use actual-size printing and verify the dimensions with a ruler.
- The app estimates ankle and calf circumferences by modelling the two calibrated widths as the axes of an ellipse. It estimates floor-to-cuff length from the side frame. Video measurements within 1 cm of a chart cutoff prompt a tape check. That buffer is a pilot rule, not a measured accuracy bound.
- **LiDAR scan** works in two ways. The first, which works now, uses a scanning app: Scaniverse (free), Polycam (free plan exports glTF only) or 3d Scanner App (free trial, then subscription) on an iPhone 12 Pro or later Pro model. Upload the exported model. The length is found from the scan (the narrowing just below the knee, so scan to just above the knee with the knees apart), or taken from a tape value if one is entered. The second is the Compression Fit iPhone app in `ios/`, which also captures the cuff point. Either way the scan is a 3D point cloud of the lower leg. `scan.js` fits a straight leg axis, cuts cross-sections perpendicular to it and measures each section's tape-equivalent circumference: the convex hull of a smooth outline fitted to the surface points. The ankle is the narrowest section 5–22 cm above the floor, the calf is the widest section above it, the below-knee (top band) circumference is the mean of the sections in the 2.5 cm under the cuff level, and the length is the height of the tapped cuff point (app) or the tape length (upload). Values are entered only when two scans of the same leg agree within 1 cm. The pilot's accuracy target is ±1 cm against tape. On synthetic legs with realistic noise the error is under 0.4 cm, but real legs are not validated yet.
- The app processes clips locally in the browser. It has no backend, media upload, analytics or persistent storage for measurements.

## Market setting and AR tape

**Buying in** (Australia, or Ireland, UK or EU) sets which methods are offered. It defaults from the device time zone (`Australia/*` → Australia) and can be forced with `?market=au` or `?market=ie`. The rules are in `markets` in `fit.js` and tested by `tests/market.test.js`.

- **Australia:** Measure with tape and AR tape only. Ankle and calf come from a physical tape, typed in or placed with the AR tape guide. Camera, scan and AR results may fill the length only (`allowedFields`). The video and LiDAR modes are hidden, scan uploads and app scans are refused, and the iPhone app refuses the AR girth tape when `market` is `au`. Switching to Australia clears any camera- or scan-derived ankle and calf values.
- **Ireland, UK or EU:** every method, including the AR girth tape.

The reason is patent clearance: in Australia, ready-made garment selection from image-derived circumferences is claimed by a granted patent (see the freedom-to-operate notes). Do not loosen the Australian rules without a patent attorney's sign-off.

**AR tape** mode (iPhone app, LiDAR Pro models) offers three tools:

1. **AR tape guide:** finds the floor, the operator taps the cuff point and a virtual vertical tape shows the length; then for the ankle and calf the operator taps the measuring point, a ring shows where to wrap a real tape, and taps on the tape at the front and side check it is within 1 cm of the ring and level within 1 cm. The tape readings are typed in. Fields: ankle and calf labelled *Tape (AR-guided)*, length *AR length ruler*.
2. **AR length ruler:** the first part only. Fills the length.
3. **AR girth tape** (not in Australia): the LiDAR scanner with two virtual tapes at the ankle and calf that turn green sector by sector as each side is captured. Results go through the same two-scan agreement as LiDAR scan mode.

4. **Face ID depth scan (test, not in Australia):** for iPhones without LiDAR. Uses the front TrueDepth camera (structured light) on any Face ID iPhone. A helper holds the phone about 40 cm from the bare shin, screen facing the leg, guided by voice and vibration (they cannot see the screen): one capture from the front, one from the outer side, each the average of 12 steady depth frames. `dist/truedepth.js` measures them: leg axis by PCA; each 1 cm slice measured as an angle from the camera (immune to flying pixels at the edges); widths solved for an oval section from the slice's distance and the 80° edge-visibility limit, using the other view's depth; ankle = narrowest, calf = widest ≥ 8 cm above; circumference from the two diameters (Ramanujan). Fills ankle and calf (labelled *Face ID depth (test)*), not length. On synthetic legs with noise, flying pixels, tilt, a floor in view and misaligned captures it is within 0.3 cm (`tests/truedepth.test.js`); it has not been tested on a real leg.

The page calls the app with `{action: 'arTape', tool, leg, market}` and receives `window.receiveArTape(result)` (`{tool: 'guide'|'length', leg, ankle?, calf?, length, guideHeights?, placementChecks?}` or `{tool: 'girth', scan}`) or `window.arTapeCancelled(message)`. The AR length is treated as an estimate, so lengths within 1 cm of a cutoff prompt a tape check.

## Stocking-fit preview

When a size is found, the result shows a hologram of the leg drawn to the person's own measurements (4 px per cm; widths from circumference ÷ π), wearing the recommended stocking. Shading shows the graduated compression, firmest at the ankle and easing towards the knee, and gauges show where each measurement sits within its size range (`fitRanges`, `fitPreviewSVG`, tested by `tests/preview.test.js`). It is not shown when a measurement needs a tape check or is outside the chart.

In the iPhone app, the AR tape guide slides a holographic stocking onto the real leg once both tape readings are in: rings from the floor to the cuff, sized from the tape readings (not the camera), so it is the same in every market.

## Limits and next validation

Calibration and landmarks are currently marked by hand. Automatic frame selection, landmark detection and AI segmentation are future work. The camera method is a two-view approximation, not a 3D reconstruction. Perspective and depth mismatch, leg rotation, lens distortion and landmark placement can affect accuracy.

Validate first on rigid forms of known dimensions and then with paired video and repeat fitter measurements. Compare assisted and self-scan separately, including legs close to a cutoff. Confirm the actual product size matrix before using the app for purchasing recommendations. Real-world iPhone capture and sizing accuracy have not been validated.

## Changes from the deployed commit

- `index.html` and `fit.css` were reformatted from minified single lines into indented, commented source. Unused CSS left over from earlier prototypes (icons, volume grid, leg graphic, camera overlay and similar) was removed. Screen and print rendering was checked pixel-for-pixel against the deployed files at 1200 px and 390 px widths in all three modes.
- Added `<meta name="robots" content="noindex">` because this is a private pilot.
- The size chart header now reads Standard / Wide / Extra wide to match the result wording (previously Std / Wide / XL calf).
- The printed tape strips and 10 cm check bar are inset 4 mm so the 0 and 25 labels are no longer clipped. Tick spacing is unchanged.
- `fit.js` is otherwise unchanged. Sizing logic, calibration maths and capture flow are identical.

## Known issues to consider

- **Marking on a phone.** Landmarks are placed by a single tap on a scaled canvas with no zoom or drag-to-adjust, so precise placement on a small screen is hard. The canvas also has no keyboard alternative.
- **Small target and long leg.** The homography comes from a 100 × 150 mm target, but it is applied across roughly 40 cm of leg. Small corner-marking errors are magnified away from the target. A larger target (for example A4) or two targets at different heights would reduce this.
- **Self-scan timing.** The prompts allow about 3 s for the front hold (6–9 s) before the turn cue. Confirm this is long enough in testing.
- **Print scaling.** A US Letter paper setting or "fit to page" printing shrinks the target and tape by about 6%. The ruler check in the instructions catches this. Consider adding a short checkbox or confirmation step after printing.
- No favicon, so browsers log a harmless 404.
- **Untested iPhone build.** The iPhone app has not been compiled yet. See `ios/README.md`.

## Quick checks

```sh
node --check dist/fit.js
node -e "const {fitStocking}=require('./dist/fit.js'); console.log(fitStocking({ankle:20,calf:43,length:36}))"
node tests/scan.test.js
```

To try the LiDAR flow in a browser, choose **LiDAR scan** and load `tests/fixtures/synthetic-left-scan-1.json`, then `-2.json`. The synthetic leg is ankle 22.0 cm, calf 40.4 cm and length 40.0 cm. To test model upload, enter a Length of 40, then upload `synthetic-leg-scene.obj` and `synthetic-leg-scene-gltf.zip`.

## Shoe size (foot sizing)

An optional shoe size (AU men/women, UK, EU, US men/women) sizes the foot of the stocking. It is converted to EU via the standard last-length rules (last ≈ foot length + 1.5 cm; EU = 1.5 × last in cm; UK = 3 × last in inches − 25; US men = UK + 1; US and AU women = UK + 2) and matched to provisional foot sizes S 35–38, M 39–42, L 43–46, XL 47–50 (`footSizes` in `dist/fit.js`). Replace these with the chosen maker's chart. Tests: `node tests/fit.test.js`.

## Compression profile selector

Five questions (main reason, a safety screen, mobility, difficulty putting stockings on, ankle swelling) feed `recommendProfile(answers)` in `dist/fit.js`. It recommends one of these:

- **graduated**: firmest at the ankle;
- **progressive**: firmest at the calf;
- **either**;
- **refer**: see a clinician first;
- **urgent**: possible clot, see a doctor today.

Every retail answer is a below-knee, 15–20 mmHg stocking, with an evidence grade and its references. The rules apply in order and the safety screens come first. The size result shows the profile, and the hologram preview shades the stocking to match it (firmest at the ankle or at the calf). The rules and the evidence table are in the doc "Compression profile selector: logic and evidence". Tests: `tests/profile.test.js`.

## SleepFit (pillow fitting prototype, v0.3.1)

`dist/sleepfit/` (the old `/posture/` link redirects here). It combines the SleepFit journey (prepare → baseline photo → try a change → compare → fit profile) with the posture engine in `posture.js`:

- **Side sleepers**: signed measures from points marked on a rear photo (back of head, base of neck, waist, pelvis, two mattress points, optional A4 sheet) or from an optional side-only iPhone depth scan: head-and-neck angle (minus = head drops, so the pillow is too low), waist offset (sag or bow) and hip-vs-shoulder tilt. With the A4 sheet, results are in centimetres.
- **Back sleepers** (`analyseBack`): a side-on photo marking ear, outer eye, shoulder, hip and two mattress points. The ear–eye orientation is a visual proxy only, so the advice is driven by how the head feels (tucked or tipped back), not by a target angle.
- **Combination sleepers**: both positions are measured. The next setup follows the side measurement; if the two positions point in opposite directions, the layers stay the same and comfort decides.
- **Layer advice for an adjustable pillow** (`fitAdvice`): one layer at a time, then re-check. The provisional specification is 1.5 cm layers, up to 4 (`PILLOW` in `posture.js`). An optional loaded-height field records the pillow's measured height under the head.
- **Comfort diary**: seven nights, stored on the device (localStorage), alongside photo thumbnails for comparing setups.
- On-screen wording describes visible orientation (head appears raised or lowered); the signed numbers are kept in the CSV export.
- **Best setup so far**: the most comfortable setup (within one point), with the straightest head as the tie-break.
- **Plausibility checks** catch mis-tapped points (`LIMITS`).
- **Marking**: points can be dragged and placed with the keyboard. There's a clear hint when Record is disabled, a route back from the profile, and a CSV export that guards text against spreadsheet formulas.

Everything stays on the device. Tests: `tests/posture.test.js`.
