import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { DialogTitleDirective } from '../../directives/dialog-title.directive';
import { ConnectionStateService } from '../../services/connection-state.service';
import { LmStudioConnectionService } from '../../services/lmstudio-connection.service';
import { PhotoService } from '../../services/photo.service';

export interface LmChatDialogData {
  lmUrl: string;
  /** Hand the reply back to the still-open Generate dialog's prompt field. */
  paste: (text: string) => void;
}

/**
 * One-shot chat with LM Studio from the Generate dialog: send a request, read the
 * reply, Paste it into the prompt. Calls LM Studio directly rather than queueing a
 * job — like the other interactive LM dialogs, the user is present and driving it.
 */
@Component({
  selector: 'pp-lm-chat-dialog',
  imports: [DialogTitleDirective, FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule,
    MatSelectModule, MatButtonModule, MatIconModule, MatProgressSpinnerModule, MatTooltipModule],
  templateUrl: './lm-chat-dialog.html',
  styleUrl: './lm-chat-dialog.scss',
})
export class LmChatDialog {
  private dialogRef = inject(MatDialogRef<LmChatDialog>);
  data: LmChatDialogData = inject(MAT_DIALOG_DATA);
  private photo = inject(PhotoService);
  private snackBar = inject(MatSnackBar);
  private connState = inject(ConnectionStateService);
  lms = inject(LmStudioConnectionService);

  message = this.connState.lastLmChat;
  response = '';
  asking = signal(false);
  ejecting = signal(false);
  /** What LM Studio reports as loaded; null until it answers (or if nothing is). */
  private loadedIds: { key: string | null; instance: string | null } | null = null;
  /** The user's own pick, which outranks the loaded model. */
  private picked = '';

  constructor() {
    this.dialogRef.disableClose = true;
    this.lms.init();
    if (!this.lms.availableModels.length && this.lms.lmstudioUrl) this.lms.checkConnection();

    this.photo.getLmStudioLoaded(this.data.lmUrl).subscribe({
      next: ids => this.loadedIds = ids,
      error: () => { /* unreachable, or too old for the native API — the last-used model stands */ },
    });
  }

  /** Id of the loaded model as the list names it. `/v1/models` lists model keys, but
   *  a model loaded twice has an instance id apart from its key — take whichever the
   *  list offers. Worked out on read, since the list and the answer race each other. */
  get loaded(): string | null {
    const ids = this.loadedIds;
    if (!ids) return null;
    return [ids.key, ids.instance].find(x => x && this.lms.availableModels.includes(x)) ?? null;
  }

  /** The user's pick, else the loaded model, else the last-used one. */
  get model(): string {
    return this.picked || this.loaded || this.lms.model;
  }

  set model(value: string) {
    this.picked = value;
  }

  get canAsk(): boolean {
    return !this.asking() && !this.ejecting() && !!this.model && !!this.message.trim();
  }

  /** Enabled even when nothing seems loaded: our view of LM Studio can be stale
   *  (a job may have loaded a model since), and unloading nothing is harmless. */
  get canEject(): boolean {
    return !this.asking() && !this.ejecting();
  }

  ask(): void {
    if (!this.canAsk) return;
    const model = this.model;
    this.connState.lastLmChat = this.message;
    this.lms.model = model;
    this.lms.saveModel();
    this.asking.set(true);
    this.photo.lmPrompt(this.data.lmUrl, this.message, model).subscribe({
      next: res => {
        this.asking.set(false);
        this.response = (res.description ?? '').trim();
        // LM Studio loads the model on demand to answer — it is the loaded one now.
        this.loadedIds = { key: model, instance: null };
      },
      error: err => {
        this.asking.set(false);
        this.snackBar.open(`LM Studio: ${err.error?.error || err.message || 'request failed'}`, 'Dismiss', { duration: 6000 });
      },
    });
  }

  /** Unload every LM Studio model to free VRAM (e.g. for ComfyUI) — the same call
   *  the job queue makes before a render. */
  eject(): void {
    if (!this.canEject) return;
    this.ejecting.set(true);
    this.photo.unloadLmStudio(this.data.lmUrl).subscribe({
      next: () => {
        this.ejecting.set(false);
        this.loadedIds = { key: null, instance: null };
        this.snackBar.open('LM Studio model ejected', '', { duration: 2000 });
      },
      error: err => {
        this.ejecting.set(false);
        this.snackBar.open(`Eject failed: ${err.error?.error || err.message || 'request failed'}`, 'Dismiss', { duration: 6000 });
      },
    });
  }

  paste(): void {
    const text = this.response.trim();
    if (!text) return;
    this.data.paste(text);
    this.snackBar.open('Pasted into the prompt', '', { duration: 2000 });
  }

  close(): void {
    this.dialogRef.close();
  }
}
