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
- `dist/models.js` reads 3D models exported by free scanning apps (OBJ, GLB, glTF or ZIP, PLY, STL, XYZ). It detects units, the up axis, the floor and the leg, then passes them to `scan.js`.
- `ios/` is the iPhone app (WKWebView shell plus native ARKit LiDAR scanner). See `ios/README.md`.
- `tests/scan.test.js` and `tests/models.test.js` check measurement against synthetic legs of known size, the second through every supported export format. `tests/fixtures/` holds sample scans and models for the browser.

## How the pilot works

- All modes use the same provisional knee-high size chart. `chart` and `lengths` in `fit.js` define its ankle bands, calf cuts and lengths. Bounds are lower-inclusive and upper-exclusive. Ankle and calf are separate decisions.
- Tape mode takes three values per leg in centimetres. An ankle of 20 cm, calf of 43 cm and length of 36 cm should return **Small ankle · Wide calf · Short**.
- Assisted video uses a continuous front-to-side clip with the wearer stationary. Self-scan uses a propped phone with timed recording prompts while the wearer turns.
- The operator selects and annotates a front and a side frame. The outer corners of the printed 100 × 150 mm target define a planar homography for each frame. The target should be upright and at the same depth as the leg centre. Use actual-size printing and verify the dimensions with a ruler.
- The app estimates ankle and calf circumferences by modelling the two calibrated widths as the axes of an ellipse. It estimates floor-to-cuff length from the side frame. Video measurements within 1 cm of a chart cutoff prompt a tape check. That buffer is a pilot rule, not a measured accuracy bound.
- **LiDAR scan** works in two ways. The first, which works now, uses a scanning app: Scaniverse (free), Polycam (free plan exports glTF only) or 3d Scanner App (free trial, then subscription) on an iPhone 12 Pro or later Pro model. Upload the exported model, and enter the length by tape. The second is the Compression Fit iPhone app in `ios/`, which also captures the cuff point. Either way the scan is a 3D point cloud of the lower leg. `scan.js` fits a straight leg axis, cuts cross-sections perpendicular to it and measures each section's tape-equivalent circumference: the convex hull of a smooth outline fitted to the surface points. The ankle is the narrowest section 5–22 cm above the floor, the calf is the widest section above it, and the length is the height of the tapped cuff point (app) or the tape length (upload). Values are entered only when two scans of the same leg agree within 1 cm. The pilot's accuracy target is ±1 cm against tape. On synthetic legs with realistic noise the error is under 0.4 cm, but real legs are not validated yet.
- The app processes clips locally in the browser. It has no backend, media upload, analytics or persistent storage for measurements.

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
