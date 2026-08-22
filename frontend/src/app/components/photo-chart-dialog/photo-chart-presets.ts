/**
 * Photo reference charts — the labels and prompt snippets transcribed from the
 * contact sheets, paired with the tile cut out of each sheet by
 * `tools/sheet_slicer.py` (or `tools/import_chart_tiles.py` for tiles cut by hand).
 *
 * Groups exist only to break the grid into readable sections; selection is single
 * across the whole chart.
 */

export type ChartId = 'camera' | 'lighting' | 'style';

export interface ChartPreset {
  /** 1-based cell number on the source sheet — also the tile filename. */
  n: number;
  label: string;
  /** Text inserted into the prompt. */
  text: string;
}

export interface ChartSection {
  name: string;
  presets: ChartPreset[];
}

/**
 * One illustrated version of a chart. A chart can carry several — the same
 * presets photographed with different subjects — and the dialog offers a switch
 * whenever there is more than one.
 */
export interface ChartSet {
  id: string;
  label: string;
  /** Tiles live at `${dir}/NN.<ext>`, numbered by the preset's `n`. */
  dir: string;
  ext: 'jpg' | 'png';
}

export interface PhotoChart {
  id: ChartId;
  title: string;
  /** Illustration sets, most useful first — the first one is the default. */
  sets: ChartSet[];
  sections: ChartSection[];
}

export const CAMERA_CHART: PhotoChart = {
  id: 'camera',
  title: 'Camera reference',
  sets: [{ id: 'ducks', label: 'Ducks', dir: '/charts/camera', ext: 'png' }],
  sections: [
    {
      name: 'Shot size',
      presets: [
        { n: 1, label: 'Extreme close-up / ECU', text: 'extreme close-up, macro shot' },
        { n: 2, label: 'Close-up / CU', text: 'close-up shot' },
        { n: 3, label: 'Medium shot / MS', text: 'medium shot' },
        { n: 4, label: 'Full shot / FS', text: 'full-body shot, entire subject in frame' },
        { n: 5, label: 'Wide shot / LS', text: 'wide shot, subject shown in environment' },
        { n: 6, label: 'Extreme wide / EWS', text: 'extreme wide shot, subject tiny in the distance' },
      ],
    },
    {
      name: 'Angle',
      presets: [
        { n: 7, label: 'Eye-level', text: 'eye-level camera, straight-on angle' },
        { n: 8, label: 'High angle', text: 'high-angle shot, camera looking down' },
        { n: 9, label: 'Low angle', text: 'low-angle shot, camera looking up' },
        { n: 10, label: "Bird's-eye / top-down", text: "bird's-eye view, directly overhead" },
        { n: 11, label: "Worm's-eye", text: "worm's-eye view, ground-level looking up" },
        { n: 12, label: 'POV', text: "first-person POV shot, observer's perspective" },
      ],
    },
    {
      name: 'Position',
      presets: [
        { n: 13, label: 'Over-the-shoulder / OTS', text: 'over-the-shoulder shot' },
        { n: 14, label: 'Three-quarter view', text: 'three-quarter view, 45-degree angle' },
        { n: 15, label: 'Front view', text: 'front view, facing the camera' },
        { n: 16, label: 'Profile / side view', text: 'side profile, 90-degree side view' },
        { n: 17, label: 'Rear view', text: 'rear view, backs of the subjects' },
        { n: 18, label: 'POV looking forward', text: 'POV shot looking forward' },
      ],
    },
    {
      name: 'Lens',
      presets: [
        { n: 19, label: 'Ultra-wide (14mm)', text: 'ultra-wide-angle lens, 14mm, exaggerated perspective' },
        { n: 20, label: 'Wide-angle (24mm)', text: 'wide-angle lens, 24mm, enhanced perspective' },
        { n: 21, label: 'Normal (50mm)', text: '50mm lens, natural perspective' },
        { n: 22, label: 'Portrait (85mm)', text: '85mm lens, slight compression' },
        { n: 23, label: 'Telephoto (135mm)', text: '135mm lens, compressed perspective' },
        { n: 24, label: 'Fisheye', text: 'fisheye lens, extreme wide-angle distortion' },
      ],
    },
  ],
};

export const LIGHTING_CHART: PhotoChart = {
  id: 'lighting',
  title: 'Lighting reference',
  sets: [
    { id: 'set1', label: 'Set 1 · Ducks', dir: '/charts/lighting/set1', ext: 'jpg' },
    { id: 'set2', label: 'Set 2 · Photos', dir: '/charts/lighting/set2', ext: 'jpg' },
  ],
  sections: [
    {
      name: 'Daylight',
      presets: [
        { n: 1, label: 'Natural light', text: 'soft daylight from a window' },
        { n: 2, label: 'Overcast light', text: 'diffused, soft light with no shadows' },
        { n: 3, label: 'Direct sunlight', text: 'hard sunlight with strong shadows' },
        { n: 4, label: 'Golden hour', text: 'warm, low-angle sunlight' },
        { n: 5, label: 'Blue hour', text: 'cool, bluish ambient light' },
      ],
    },
    {
      name: 'Quality & direction',
      presets: [
        { n: 6, label: 'Hard light', text: 'single strong light source, sharp shadows' },
        { n: 7, label: 'Soft light', text: 'diffused light, soft shadows' },
        { n: 8, label: 'Backlight', text: 'light from behind the subject' },
        { n: 9, label: 'Silhouette', text: 'strong backlight, subject in silhouette' },
        { n: 10, label: 'Rim light', text: 'backlight creating a bright edge' },
      ],
    },
    {
      name: 'Portrait patterns',
      presets: [
        { n: 11, label: 'Side light', text: 'light from the side, creates depth' },
        { n: 12, label: 'Split lighting', text: 'split lighting, one side lit, other side in shadow' },
        { n: 13, label: 'Rembrandt lighting', text: 'Rembrandt lighting, soft light with a shadow triangle' },
        // The sheet's caption says "under beak" (it's a duck); generalised here.
        { n: 14, label: 'Butterfly lighting', text: 'butterfly lighting, frontal light, subtle shadow under the nose' },
        { n: 15, label: 'Top lighting', text: 'light from above, shadows directly below' },
      ],
    },
    {
      name: 'Key & colour',
      presets: [
        { n: 16, label: 'Low-key', text: 'low-key lighting, dark scene, high contrast' },
        { n: 17, label: 'High-key', text: 'high-key lighting, bright scene, low contrast' },
        { n: 18, label: 'Warm light', text: 'tungsten-like warm color temperature' },
        { n: 19, label: 'Cool light', text: 'cool, bluish color temperature' },
        { n: 20, label: 'Mixed lighting', text: 'combination of warm and cool light' },
      ],
    },
  ],
};

/**
 * Rendering styles. The tail of each snippet ("Highly detailed…", "8k.") is part
 * of the preset rather than something the dialog appends, because the painterly
 * styles and the graphic ones want different tails — the graphic ones drop the
 * realism clause that would fight the style.
 */
const REALISM = 'Highly detailed, highly realistic, high quality digital art. 8k.';
const GRAPHIC = 'High quality digital art. 8k.';

export const STYLE_CHART: PhotoChart = {
  id: 'style',
  title: 'Style reference',
  sets: [{ id: 'default', label: 'Styles', dir: '/charts/style', ext: 'jpg' }],
  sections: [
    {
      name: 'Historical painting',
      presets: [
        { n: 1, label: 'Baroque', text: `Baroque style. ${REALISM}` },
        { n: 2, label: 'Neoclassicism', text: `Neoclassicism style. ${REALISM}` },
        { n: 3, label: 'Classical Renaissance', text: `Classical Renaissance style. ${REALISM}` },
        { n: 4, label: 'Pre-Raphaelite', text: `Pre-raphaelite style. ${REALISM}` },
        { n: 7, label: 'Romanticism', text: `Romanticism style. ${REALISM}` },
      ],
    },
    {
      name: 'Realism',
      presets: [
        { n: 5, label: 'Contemporary Realism', text: `Contemporary Realism style. ${REALISM}` },
        { n: 6, label: 'Academic hyper-realism', text: `Academic hyper-realism style. ${REALISM}` },
        { n: 12, label: 'Realistic photo', text: 'Realistic Photo. High quality digital photo. 8k.' },
      ],
    },
    {
      name: 'Stylised',
      presets: [
        { n: 8, label: 'Surrealism', text: `Surrealism style. ${REALISM}` },
        { n: 9, label: 'Pin-up', text: `Pin-up style. ${GRAPHIC}` },
        { n: 10, label: 'Caricature', text: `Caricature style. ${GRAPHIC}` },
        { n: 11, label: 'Retro futurism', text: `Retro futurism style. ${GRAPHIC}` },
      ],
    },
  ],
};

export const PHOTO_CHARTS: Record<ChartId, PhotoChart> = {
  camera: CAMERA_CHART,
  lighting: LIGHTING_CHART,
  style: STYLE_CHART,
};
