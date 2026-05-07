import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Clipboard } from '@angular/cdk/clipboard';
import { PhotoService } from '../../services/photo.service';
import { ConnectionStateService } from '../../services/connection-state.service';
import { LmStudioConnectionService } from '../../services/lmstudio-connection.service';

@Component({
  selector: 'pp-lm-prompt-dialog',
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatIconModule, MatProgressSpinnerModule],
  templateUrl: './lm-prompt-dialog.html',
  styleUrl: './lm-prompt-dialog.scss',
})
export class LmPromptDialog {
  private dialogRef = inject(MatDialogRef<LmPromptDialog>);
  private photoService = inject(PhotoService);
  private snackBar = inject(MatSnackBar);
  private clipboard = inject(Clipboard);
  private connState = inject(ConnectionStateService);
  lms = inject(LmStudioConnectionService);

  prompt: string;
  asking = false;
  result = '';

  constructor() {
    this.lms.init();
    this.prompt = this.connState.lastLmPrompt;
  }

  ask(): void {
    this.connState.lmstudio.url = this.lms.lmstudioUrl;
    this.lms.saveModel();
    this.connState.lastLmPrompt = this.prompt;
    this.asking = true;
    this.result = '';
    this.photoService.lmPrompt(this.lms.lmstudioUrl, this.prompt, this.lms.model).subscribe({
      next: (res) => {
        this.asking = false;
        this.result = res.description;
      },
      error: (err) => {
        this.asking = false;
        const msg = err.error?.error || err.message || 'Failed';
        this.snackBar.open(`Error: ${msg}`, '', { duration: 5000 });
      },
    });
  }

  copyResult(): void {
    this.clipboard.copy(this.result);
    this.snackBar.open('Copied to clipboard', '', { duration: 2000 });
  }

  openGenerate(): void {
    this.dialogRef.close({ action: 'generate', prompt: this.result });
  }
}
