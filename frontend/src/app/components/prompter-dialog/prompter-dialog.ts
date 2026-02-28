import { Component, inject } from '@angular/core';
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

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

@Component({
  selector: 'pp-prompter-dialog',
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatSelectModule, MatButtonModule, MatIconModule],
  templateUrl: './prompter-dialog.html',
  styleUrl: './prompter-dialog.scss',
})
export class PrompterDialog {
  private dialogRef = inject(MatDialogRef<PrompterDialog>);

  readonly ambienceList = AMBIENCE_PLACES;
  readonly characterList = CHARACTERS;
  readonly actionList = ACTIONS;
  readonly styleList = STYLES;

  ambience = randomItem(AMBIENCE_PLACES);
  character = randomItem(CHARACTERS);
  action = randomItem(ACTIONS);
  style = randomItem(STYLES);

  get composedPrompt(): string {
    return (
      `${this.ambience}, ${this.character} ${this.action}, ` +
      `realistic oil painting, ${this.style}, ` +
      'cinematic composition, dramatic natural lighting, ' +
      'detailed brushwork, realistic textures, masterpiece, high detail'
    );
  }

  randomizeAll(): void {
    this.ambience = randomItem(AMBIENCE_PLACES);
    this.character = randomItem(CHARACTERS);
    this.action = randomItem(ACTIONS);
    this.style = randomItem(STYLES);
  }

  randomize(field: 'ambience' | 'character' | 'action' | 'style'): void {
    const lists = { ambience: AMBIENCE_PLACES, character: CHARACTERS, action: ACTIONS, style: STYLES };
    this[field] = randomItem(lists[field]);
  }

  insert(): void {
    this.dialogRef.close(this.composedPrompt);
  }
}
