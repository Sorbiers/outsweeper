import { Component, inject } from '@angular/core';
import { CdkDrag, CdkDragHandle } from '@angular/cdk/drag-drop';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

const AMBIENCE_PLACES = [
  'foggy harbor at dawn',
  'abandoned railway station at night',
  'candlelit tavern interior',
  'rain-soaked city street',
  'lonely countryside road at dusk',
  'old apartment corridor under dim light',
  'snow-covered village square',
  'deserted coastal lighthouse',
  'industrial warehouse interior',
  'forest clearing in early morning mist',
];

const CHARACTERS = [
  'a lone watchman',
  'two exhausted detectives',
  'an elderly woman',
  'a railway worker',
  'a mysterious stranger',
  'a tired doctor',
  'a young woman in a dark coat',
  'a fisherman',
  'a soldier returning home',
  'a silent child',
];

const ACTIONS = [
  'standing motionless',
  'walking slowly through shadows',
  'examining an old letter',
  'waiting anxiously',
  'looking over their shoulder',
  'speaking quietly',
  'holding a lantern',
  'watching the distance',
  'opening a creaking door',
  'resting after a long journey',
];

const STYLES = [
  'Baroque dramatic lighting',
  'Dutch Golden Age realism',
  'Academic realism',
  'Romanticism oil painting',
  '19th century Realism',
  'Tonalism atmosphere',
  'Naturalism',
  'Classical Renaissance realism',
  'American Realism',
  'Contemporary figurative realism',
];

interface CameraPreset { name: string; prompt: string; description: string; }

const CAMERAS: CameraPreset[] = [
  { name: 'Eye Level',          prompt: 'eye-level camera angle',                                      description: 'Neutral natural perspective' },
  { name: 'Low Angle',          prompt: 'low-angle shot, camera positioned below the subject',          description: 'Makes subject appear powerful' },
  { name: 'High Angle',         prompt: 'high-angle shot, camera positioned above the subject',         description: 'Makes subject appear vulnerable' },
  { name: "Bird's-Eye View",    prompt: "bird's-eye view, top-down camera angle",                      description: 'Directly overhead perspective' },
  { name: "Worm's-Eye View",    prompt: "worm's-eye view, extreme low-angle perspective",              description: 'Extreme dramatic upward perspective' },
  { name: 'Dutch Angle',        prompt: 'dutch angle, tilted camera framing',                          description: 'Creates tension or unease' },
  { name: 'Over-the-Shoulder',  prompt: 'over-the-shoulder shot',                                      description: 'Camera behind another character' },
  { name: 'First Person',       prompt: 'first-person POV shot',                                       description: "Viewer sees through character's eyes" },
  { name: 'Third Person',       prompt: 'third-person perspective',                                    description: 'Detached observer perspective' },
  { name: 'Isometric',          prompt: 'isometric camera view',                                       description: 'Game-like angled orthographic perspective' },
  { name: 'Security Camera',    prompt: 'security camera perspective, ceiling-mounted surveillance angle', description: 'Static surveillance framing' },
  { name: 'Cinematic Wide',     prompt: 'cinematic wide-angle shot',                                   description: 'Large environmental framing' },
  { name: 'Close-Up',           prompt: 'close-up shot',                                               description: 'Focus on face or detail' },
  { name: 'Extreme Close-Up',   prompt: 'extreme close-up shot',                                       description: 'Very tight framing' },
  { name: 'Medium Shot',        prompt: 'medium shot',                                                 description: 'Waist-up framing' },
  { name: 'Full Body',          prompt: 'full-body shot',                                              description: 'Entire subject visible' },
  { name: 'Long Shot',          prompt: 'long shot, distant framing',                                  description: 'Subject small within environment' },
  { name: 'Macro',              prompt: 'macro photography perspective',                               description: 'Extreme detail close photography' },
  { name: 'Drone Shot',         prompt: 'aerial drone shot',                                           description: 'Modern aerial cinematic framing' },
  { name: 'Handheld',           prompt: 'handheld camera perspective',                                 description: 'Natural imperfect cinematic motion' },
  { name: 'Selfie',             prompt: 'selfie camera angle',                                         description: 'Front-facing handheld perspective' },
  { name: 'Webcam',             prompt: 'webcam perspective',                                          description: 'Centered computer-camera framing' },
  { name: 'Dashcam',            prompt: 'dashcam perspective from inside a vehicle',                   description: 'Vehicle-mounted viewpoint' },
  { name: 'Helmet Cam',         prompt: 'helmet camera POV',                                           description: 'Action camera attached to head' },
  { name: 'CCTV Corner',        prompt: 'CCTV corner-mounted surveillance perspective',                description: 'Wide distorted security framing' },
];

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

@Component({
  selector: 'pp-prompter-dialog',
  imports: [CdkDrag, CdkDragHandle, FormsModule, MatDialogModule, MatFormFieldModule, MatSelectModule, MatButtonModule, MatIconModule],
  templateUrl: './prompter-dialog.html',
  styleUrl: './prompter-dialog.scss',
})
export class PrompterDialog {
  private dialogRef = inject(MatDialogRef<PrompterDialog>);

  readonly ambienceList = AMBIENCE_PLACES;
  readonly characterList = CHARACTERS;
  readonly actionList = ACTIONS;
  readonly styleList = STYLES;
  readonly cameraList = CAMERAS;

  ambience = randomItem(AMBIENCE_PLACES);
  character = randomItem(CHARACTERS);
  action = randomItem(ACTIONS);
  style = randomItem(STYLES);
  camera: CameraPreset | null = randomItem(CAMERAS);

  get composedPrompt(): string {
    const cameraStr = this.camera ? `, ${this.camera.prompt}` : '';
    return (
      `${this.ambience}, ${this.character} ${this.action}, ` +
      `realistic oil painting, ${this.style}, ` +
      `cinematic composition${cameraStr}, dramatic natural lighting, ` +
      'detailed brushwork, realistic textures, masterpiece, high detail'
    );
  }

  randomizeAll(): void {
    this.ambience = randomItem(AMBIENCE_PLACES);
    this.character = randomItem(CHARACTERS);
    this.action = randomItem(ACTIONS);
    this.style = randomItem(STYLES);
    this.camera = randomItem(CAMERAS);
  }

  randomize(field: 'ambience' | 'character' | 'action' | 'style'): void {
    const lists = { ambience: AMBIENCE_PLACES, character: CHARACTERS, action: ACTIONS, style: STYLES };
    this[field] = randomItem(lists[field]);
  }

  randomizeCamera(): void {
    this.camera = randomItem(CAMERAS);
  }

  compareCamera(a: CameraPreset | null, b: CameraPreset | null): boolean {
    return a?.prompt === b?.prompt;
  }

  insert(): void {
    this.dialogRef.close(this.composedPrompt);
  }
}
