# Camera cheat chart — example photo prompts

The **Example** mode of the camera cheat chart (`frontend/src/app/components/camera-dialog/`)
shows one photograph per preset. Those photos are cut from seven contact sheets generated
with these prompts (Nano Banana / Gemini image), then sliced by:

```
python tools/slice_camera_examples.py [SOURCE_DIR]
```

The slicer matches a sheet by the digit its filename starts with, cuts on the white gutter,
and writes `frontend/public/charts/camera-examples/<preset id>.jpg`. Regenerating one sheet
and re-running the script replaces only that sheet's presets.

## What ships today

The examples currently in `camera-examples/` show **three people in an empty room**,
not the rubber ducks the prompts below describe. Ducks read well for shot size and
lighting but poorly for lens and portrait geometry — a human face is what these terms
were coined for. The prompts are kept verbatim because the *structure* is the reusable
part: grid, gutter, no captions, one variable per sheet, the same subject clause
repeated in every cell. Swap the subject clause and everything else still holds.

## Why the sheets are shaped this way

The chart's 42 presets are regrouped into seven **rectangular** grids — a 7-cell group would
force a ragged sheet. The only preset that moves is **Dutch angle**, which rides on the
composition sheet instead of leaving *Camera height & angle* at 7 cells. The grouping lives in
`SHEETS` in the slicer; the dialog's own grouping (`camera-presets.ts`) is untouched.

Every prompt repeats the same subject and lighting clause verbatim, so all seven sheets read as
one family and only the variable under test moves. No captions are burned in — the dialog renders
the label and hint under each card, and baked-in text would double it up.

## Cell → preset mapping

| Sheet | Grid | Cells in reading order |
|---|---|---|
| 1 Shot size | 4×2 | `ecu, cu, mcu, ms, cowboy, full, long, els` |
| 2 Height & angle | 3×2 | `eye, low, worm, high, bird, top` |
| 3 Position | 3×2 | `front, threeq, profile, back, ots, pov` |
| 4 Lens | 4×2 | `fisheye, ultrawide, wide, normal, portrait, tele, macro, tiltshift` |
| 5 Aperture | 2×2 | `shallow, mid, deep, rack` |
| 6 Motion | 2×2 | `freeze, blur, longexp, panning` |
| 7 Composition | 3×2 | `thirds, center, symmetry, leading, negative, dutch` |

## Known weakness

**Sheet 4 (lens) is the unreliable one.** The generator tends to read "change the focal length"
as "zoom in", so cells 2–5 come back nearly identical instead of showing the perspective
stretch/compression that actually distinguishes them, and tilt-shift rarely reads as tilt-shift.
The human version is better than the duck one — the background compression does shift — but
`tiltshift` still doesn't read, and `fisheye` comes back as a circular image on black.
If a regeneration comes back flat, generate the wide end (fisheye / 14mm / 24mm) as separate
single images and drop them into `camera-examples/` by hand — the dialog keys off the filename,
so hand-placed files work exactly like sliced ones.

---

## Sheet 1 — Shot size (4×2)

```
A photographic reference contact sheet, aspect ratio 2:1, laid out as a strict 4-column by 2-row grid of equal square cells separated by a 6px pure-white gutter, no outer margin, no border, no text, no numbers, no watermark. Read order left to right, top to bottom.

Every cell photographs the SAME scene with the SAME camera position unless stated: three rubber ducks on a pale oak tabletop against a plain warm beige wall — one large glossy yellow duck with an orange bill in front, a smaller yellow duck behind it to the left, a small pale-pink duck behind to the right. Identical ducks, identical table, identical soft natural daylight from the left, identical colour grading in every cell. Real photography, sharp and clean, not illustration.

Only the framing changes:
1. Extreme close-up — the big duck's eye and a sliver of orange bill fill the entire frame.
2. Close-up — the duck's head and bill fill the frame, body cropped away.
3. Medium close-up — head and the top of the body, cropped across the upper chest.
4. Medium shot — the top half of the duck, cropped across the middle of the body.
5. Wider medium — nearly the whole duck, cropped just above where it meets the table.
6. Full shot — the entire duck head to base with a small margin of table around it.
7. Long shot — all three ducks small in the frame, a wide expanse of tabletop and wall visible around them.
8. Extreme long shot — the room and table dominate the frame, the ducks tiny specks in the distance.
```

## Sheet 2 — Camera height & angle (3×2)

```
A photographic reference contact sheet, aspect ratio 3:2, laid out as a strict 3-column by 2-row grid of equal square cells separated by a 6px pure-white gutter, no outer margin, no border, no text, no numbers, no watermark. Read order left to right, top to bottom.

Every cell photographs the SAME scene at the SAME distance: three rubber ducks on a pale oak tabletop against a plain warm beige wall — one large glossy yellow duck with an orange bill in front, a smaller yellow duck behind to the left, a small pale-pink duck behind to the right. Identical ducks, identical table, identical soft natural daylight from the left, identical colour grading in every cell. Real photography, not illustration.

Only the camera height and tilt change:
1. Eye level — camera exactly level with the ducks, lens axis horizontal, neutral and head-on.
2. Low angle — camera dropped below the ducks looking up at them, so they loom over the viewer.
3. Worm's eye view — camera flat on the tabletop looking steeply up, the big duck towering against the wall and ceiling.
4. High angle — camera raised above the ducks looking down at them, making them look small.
5. Bird's eye view — camera high above looking steeply down, the tabletop filling most of the frame.
6. Top-down overhead flat lay — camera pointing straight down at 90 degrees, the ducks seen purely from above on the wood grain.
```

## Sheet 3 — Camera position (3×2)

```
A photographic reference contact sheet, aspect ratio 3:2, laid out as a strict 3-column by 2-row grid of equal square cells separated by a 6px pure-white gutter, no outer margin, no border, no text, no numbers, no watermark. Read order left to right, top to bottom.

Every cell photographs the SAME scene at eye level and the same distance: three rubber ducks on a pale oak tabletop against a plain warm beige wall — one large glossy yellow duck with an orange bill, a smaller yellow duck, and a small pale-pink duck. Identical ducks, identical table, identical soft natural daylight, identical colour grading in every cell. Real photography, not illustration.

Only where the camera stands around the subject changes:
1. Front view — the big duck facing the lens dead-on, bill pointing straight at the viewer.
2. Three-quarter view — the camera 45 degrees off the duck's front, showing the front and one side together.
3. Profile view — the camera exactly at the duck's side, a pure side-on silhouette of the head and bill.
4. From behind — the camera behind the ducks, seeing their backs and tails, the wall beyond them.
5. Over the shoulder — the camera just behind and above the pink duck, its blurred back filling the near right foreground, the big yellow duck sharp and facing us across the table.
6. First-person POV — the view from the big duck's own eyes: its own orange bill jutting into the bottom of the frame, the tabletop stretching ahead, the other two ducks looking back at the viewer.
```

## Sheet 4 — Lens / focal length (4×2)

```
A photographic reference contact sheet, aspect ratio 2:1, laid out as a strict 4-column by 2-row grid of equal square cells separated by a 6px pure-white gutter, no outer margin, no border, no text, no numbers, no watermark. Read order left to right, top to bottom.

Every cell photographs the SAME scene: three rubber ducks receding into depth along a pale oak tabletop against a plain warm beige wall — one large glossy yellow duck nearest the camera, a smaller yellow duck further back, a small pale-pink duck furthest away. Identical ducks, identical table, identical soft natural daylight from the left, identical colour grading in every cell. In every cell the big duck is kept roughly the same size in frame by moving the camera closer or further, so that only the perspective and background compression change. Real photography, not illustration.

The lens changes:
1. 8mm fisheye — extreme barrel distortion, the tabletop and wall bowing outward, the duck's bill exaggerated and huge.
2. 14mm ultra-wide — a vast sweep of table and wall, strongly stretched perspective, the near duck looming.
3. 24mm wide-angle — roomy framing, plenty of the table and wall visible, mild perspective exaggeration.
4. 50mm normal lens — natural, neutral perspective close to human vision.
5. 85mm portrait lens — flattering mild compression, the background softly simplified.
6. 200mm telephoto — heavily compressed perspective, the three ducks appearing stacked close together, the background flattened and blurred.
7. Macro lens at 1:1 magnification — the texture of the duck's glossy plastic and a dust mote on its bill in extreme detail, paper-thin plane of focus.
8. Tilt-shift lens — a narrow horizontal band of sharpness across the middle ducks with the near and far table blurred, making the scene look like a toy miniature.
```

## Sheet 5 — Aperture / depth of field (2×2)

```
A photographic reference contact sheet, aspect ratio 1:1, laid out as a strict 2-column by 2-row grid of equal square cells separated by a 6px pure-white gutter, no outer margin, no border, no text, no numbers, no watermark. Read order left to right, top to bottom.

Every cell photographs the SAME scene from the SAME camera position with an 85mm lens: three rubber ducks spaced far apart in depth down a pale oak tabletop against a plain warm beige wall with a small potted plant behind them — one large glossy yellow duck close to the camera, a smaller yellow duck in the middle distance, a small pale-pink duck far back. Identical ducks, identical spacing, identical soft natural daylight from the left, identical exposure and colour grading in every cell. Real photography, not illustration.

Only what is in focus changes:
1. f/1.4 — the near yellow duck razor sharp, everything behind it dissolved into creamy round bokeh, the plant an unrecognisable wash of green.
2. f/5.6 — the near duck sharp, the middle duck slightly soft, the far duck and plant still clearly readable.
3. f/16 — deep focus, every duck and the plant and the wood grain all sharp from front to back.
4. Focus pulled to the background — the far pale-pink duck and the plant crisply sharp while the large near duck is a soft out-of-focus blur in the foreground.
```

## Sheet 6 — Shutter / motion (2×2)

```
A photographic reference contact sheet, aspect ratio 1:1, laid out as a strict 2-column by 2-row grid of equal square cells separated by a 6px pure-white gutter, no outer margin, no border, no text, no numbers, no watermark. Read order left to right, top to bottom.

Every cell photographs the SAME action from the SAME camera position: a large glossy yellow rubber duck with an orange bill skidding fast across a wet pale oak tabletop from left to right, throwing up a spray of water droplets, against a plain warm beige wall with two small out-of-focus ducks in the background. Identical duck, identical table, identical soft natural daylight from the left, identical colour grading in every cell. Real photography, not illustration.

Only the shutter speed changes:
1. Fast shutter, frozen motion — the duck and every individual water droplet suspended in mid-air, razor sharp, no blur anywhere.
2. Slow shutter, motion blur — the duck smeared into a soft yellow streak across the frame, the droplets drawn into short comet tails.
3. Long exposure — the duck reduced to a silky ghosted trail of yellow, the water spray smoothed into a continuous glassy blur, the still background sharp.
4. Panning shot — the camera swung with the duck so the duck itself stays sharp and legible while the wall and background ducks streak horizontally into hard motion lines.
```

## Sheet 7 — Composition (3×2)

```
A photographic reference contact sheet, aspect ratio 3:2, laid out as a strict 3-column by 2-row grid of equal square cells separated by a 6px pure-white gutter, no outer margin, no border, no text, no numbers, no watermark. Read order left to right, top to bottom.

Every cell photographs the SAME subject with the SAME lens and lighting: a large glossy yellow rubber duck with an orange bill on a pale oak tabletop against a plain warm beige wall, soft natural daylight from the left, identical colour grading in every cell. Real photography, not illustration.

Only how the frame is composed changes:
1. Rule of thirds — the duck sitting on the left vertical third line, its eye on the upper intersection, open space to its right.
2. Centered composition — the duck dead centre in the frame, formal, still and symmetrical in placement.
3. Perfectly symmetrical composition — the duck centred and mirrored by its own reflection in a polished tabletop, the two halves of the frame matching exactly.
4. Leading lines — the wooden planks of the table converging as strong diagonals that funnel the eye straight to the duck sitting where they meet.
5. Negative space — the duck small in the lower left corner surrounded by a vast empty expanse of plain wall, isolated and quiet.
6. Dutch angle — the whole frame rotated about 15 degrees so the tabletop edge runs steeply diagonal, the horizon canted, uneasy and tense.
```
