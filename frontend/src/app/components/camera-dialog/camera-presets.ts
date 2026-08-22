/**
 * Cheat-chart of camera language for t2i prompts.
 *
 * Every entry carries the snippet that goes in the prompt plus a `diagram`
 * describing how to *draw* it — the illustrations are generated from those
 * parameters (see camera-dialog.html), so a diagram can never drift from the
 * text it illustrates, and there are no image assets to ship.
 */

export type Diagram =
  /** Shot size: which vertical band of the figure fills the frame. */
  | { kind: 'frame'; from: number; to: number }
  /** Vertical camera angle in degrees: negative looks up, positive looks down. */
  | { kind: 'angle'; deg: number }
  /** Horizontal bearing around the subject, 0° = facing camera (top-down view). */
  | { kind: 'view'; deg: number; overShoulder?: boolean; pov?: boolean }
  /** Field of view for a focal length (half-angle in degrees). */
  | { kind: 'lens'; half: number }
  /** Depth of field: which distance band stays sharp. */
  | { kind: 'dof'; sharp: 'near' | 'all' | 'far' }
  /** Motion rendering: 0 = frozen, higher = more blur/streaking. */
  | { kind: 'motion'; streak: number }
  /** Frame rotation in degrees (dutch/canted angle). */
  | { kind: 'tilt'; deg: number }
  /** Compositional overlay with the subject placed accordingly. */
  | { kind: 'compose'; overlay: 'thirds' | 'center' | 'symmetry' | 'leading' | 'negative' };

export interface CameraPreset {
  id: string;
  label: string;
  /** Text inserted into the prompt. */
  text: string;
  /** One-line note on what it does to the image. */
  hint: string;
  diagram: Diagram;
}

export interface CameraGroup {
  name: string;
  presets: CameraPreset[];
}

export const CAMERA_GROUPS: CameraGroup[] = [
  {
    name: 'Shot size',
    presets: [
      { id: 'ecu', label: 'Extreme close-up', text: 'extreme close-up', hint: 'Eyes or a single detail fill the frame', diagram: { kind: 'frame', from: 10, to: 22 } },
      { id: 'cu', label: 'Close-up', text: 'close-up shot', hint: 'Head and chin — reads emotion', diagram: { kind: 'frame', from: 6, to: 30 } },
      { id: 'mcu', label: 'Medium close-up', text: 'medium close-up', hint: 'Head and shoulders; the interview framing', diagram: { kind: 'frame', from: 5, to: 46 } },
      { id: 'ms', label: 'Medium shot', text: 'medium shot, waist-up framing', hint: 'Waist up — gesture plus expression', diagram: { kind: 'frame', from: 4, to: 62 } },
      { id: 'cowboy', label: 'Cowboy shot', text: 'cowboy shot, mid-thigh framing', hint: 'Mid-thigh up — stance without losing the face', diagram: { kind: 'frame', from: 4, to: 78 } },
      { id: 'full', label: 'Full shot', text: 'full body shot', hint: 'Whole figure, head to feet', diagram: { kind: 'frame', from: 0, to: 104 } },
      { id: 'long', label: 'Long shot', text: 'long shot, full figure small in frame', hint: 'Figure small; setting matters', diagram: { kind: 'frame', from: -45, to: 150 } },
      { id: 'els', label: 'Extreme long shot', text: 'extreme long shot, establishing shot', hint: 'Landscape dominates; figure is a speck', diagram: { kind: 'frame', from: -160, to: 265 } },
    ],
  },
  {
    name: 'Camera height & angle',
    presets: [
      { id: 'eye', label: 'Eye level', text: 'eye-level shot', hint: 'Neutral — camera meets the subject head-on', diagram: { kind: 'angle', deg: 0 } },
      { id: 'low', label: 'Low angle', text: 'low angle shot, camera looking up at the subject', hint: 'Looks up — makes the subject dominant', diagram: { kind: 'angle', deg: -32 } },
      { id: 'worm', label: "Worm's eye", text: "worm's eye view, extreme low angle from the ground", hint: 'From the ground — towering, dramatic', diagram: { kind: 'angle', deg: -72 } },
      { id: 'high', label: 'High angle', text: 'high angle shot, camera looking down at the subject', hint: 'Looks down — makes the subject vulnerable', diagram: { kind: 'angle', deg: 32 } },
      { id: 'bird', label: "Bird's eye", text: "bird's eye view, from high above", hint: 'Far above — shows layout and scale', diagram: { kind: 'angle', deg: 68 } },
      { id: 'top', label: 'Overhead / flat lay', text: 'top-down overhead shot, flat lay', hint: 'Straight down — graphic, map-like', diagram: { kind: 'angle', deg: 90 } },
      { id: 'dutch', label: 'Dutch angle', text: 'dutch angle, canted camera tilt', hint: 'Tilted horizon — unease, tension', diagram: { kind: 'tilt', deg: 15 } },
    ],
  },
  {
    name: 'Camera position',
    presets: [
      { id: 'front', label: 'Front view', text: 'front view, subject facing the camera', hint: 'Direct and confrontational', diagram: { kind: 'view', deg: 0 } },
      { id: 'threeq', label: 'Three-quarter', text: 'three-quarter view', hint: 'The flattering default for faces', diagram: { kind: 'view', deg: 45 } },
      { id: 'profile', label: 'Profile', text: 'profile view, side view of the subject', hint: 'Pure silhouette of the face', diagram: { kind: 'view', deg: 90 } },
      { id: 'back', label: 'From behind', text: 'shot from behind, back view of the subject', hint: 'Anonymous; we follow the subject', diagram: { kind: 'view', deg: 180 } },
      { id: 'ots', label: 'Over the shoulder', text: 'over-the-shoulder shot', hint: 'Foreground shoulder frames the subject', diagram: { kind: 'view', deg: 160, overShoulder: true } },
      { id: 'pov', label: 'POV', text: 'first-person POV shot', hint: 'The camera is the character’s eyes', diagram: { kind: 'view', deg: 0, pov: true } },
    ],
  },
  {
    name: 'Lens / focal length',
    presets: [
      { id: 'fisheye', label: 'Fisheye', text: 'fisheye lens, 8mm, extreme barrel distortion', hint: 'Bulging circular distortion', diagram: { kind: 'lens', half: 82 } },
      { id: 'ultrawide', label: '14mm ultra-wide', text: 'shot on a 14mm ultra-wide lens', hint: 'Huge view, exaggerated perspective', diagram: { kind: 'lens', half: 57 } },
      { id: 'wide', label: '24mm wide', text: 'shot on a 24mm wide-angle lens', hint: 'Roomy; good for interiors and landscape', diagram: { kind: 'lens', half: 42 } },
      { id: 'normal', label: '50mm normal', text: 'shot on a 50mm lens', hint: 'Close to human vision — neutral', diagram: { kind: 'lens', half: 23 } },
      { id: 'portrait', label: '85mm portrait', text: 'shot on an 85mm portrait lens', hint: 'Flattering compression for faces', diagram: { kind: 'lens', half: 14 } },
      { id: 'tele', label: '200mm telephoto', text: 'shot on a 200mm telephoto lens, compressed perspective', hint: 'Flattens depth, isolates the subject', diagram: { kind: 'lens', half: 6 } },
      { id: 'macro', label: 'Macro', text: 'macro lens, extreme detail, 1:1 magnification', hint: 'Tiny subject, paper-thin focus', diagram: { kind: 'lens', half: 10 } },
      { id: 'tiltshift', label: 'Tilt-shift', text: 'tilt-shift lens, miniature faking effect', hint: 'Selective focus band; toy-like', diagram: { kind: 'dof', sharp: 'near' } },
    ],
  },
  {
    name: 'Aperture / depth of field',
    presets: [
      { id: 'shallow', label: 'f/1.4 — shallow', text: 'f/1.4, shallow depth of field, creamy bokeh background', hint: 'Subject sharp, background dissolved', diagram: { kind: 'dof', sharp: 'near' } },
      { id: 'mid', label: 'f/5.6 — balanced', text: 'f/5.6, moderate depth of field', hint: 'Subject sharp, background readable', diagram: { kind: 'dof', sharp: 'all' } },
      { id: 'deep', label: 'f/16 — deep focus', text: 'f/16, deep focus, everything sharp front to back', hint: 'Whole scene in focus', diagram: { kind: 'dof', sharp: 'all' } },
      { id: 'rack', label: 'Background focus', text: 'focus on the background, foreground out of focus', hint: 'Flips the emphasis backwards', diagram: { kind: 'dof', sharp: 'far' } },
    ],
  },
  {
    name: 'Shutter / motion',
    presets: [
      { id: 'freeze', label: 'Frozen motion', text: 'fast shutter speed, frozen motion, razor sharp', hint: 'Every droplet crisp', diagram: { kind: 'motion', streak: 0 } },
      { id: 'blur', label: 'Motion blur', text: 'slow shutter speed, motion blur', hint: 'Movement smears — speed and energy', diagram: { kind: 'motion', streak: 2 } },
      { id: 'longexp', label: 'Long exposure', text: 'long exposure, light trails, silky motion', hint: 'Trails and smooth water', diagram: { kind: 'motion', streak: 4 } },
      { id: 'panning', label: 'Panning', text: 'panning shot, sharp subject with streaked background', hint: 'Subject sharp, background streaked', diagram: { kind: 'motion', streak: 3 } },
    ],
  },
  {
    name: 'Composition',
    presets: [
      { id: 'thirds', label: 'Rule of thirds', text: 'rule of thirds composition', hint: 'Subject off-centre on a third line', diagram: { kind: 'compose', overlay: 'thirds' } },
      { id: 'center', label: 'Centered', text: 'centered composition', hint: 'Dead centre — formal, still', diagram: { kind: 'compose', overlay: 'center' } },
      { id: 'symmetry', label: 'Symmetrical', text: 'perfectly symmetrical composition', hint: 'Mirrored halves — order, calm', diagram: { kind: 'compose', overlay: 'symmetry' } },
      { id: 'leading', label: 'Leading lines', text: 'leading lines drawing the eye to the subject', hint: 'Lines funnel attention inward', diagram: { kind: 'compose', overlay: 'leading' } },
      { id: 'negative', label: 'Negative space', text: 'lots of negative space around the subject', hint: 'Emptiness isolates the subject', diagram: { kind: 'compose', overlay: 'negative' } },
    ],
  },
];
