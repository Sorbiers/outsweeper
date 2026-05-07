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
import { STORAGE_KEYS } from '../../constants';

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

  lmstudioUrl = '';
  model = localStorage.getItem(STORAGE_KEYS.LMS_MODEL) || '';
  prompt: string;
  availableModels: string[] = [];
  checkStatus: 'idle' | 'checking' | 'ok' | 'error' = 'idle';
  asking = false;
  result = '';
  hasRunLmstudioCommand = false;
  runTriggered = false;

  constructor() {
    this.lmstudioUrl = this.connState.lmstudio.url || '';
    this.prompt = this.connState.lastLmPrompt;

    if (this.lmstudioUrl && this.connState.lmstudio.status === 'ok') {
      this.checkStatus = 'ok';
      this.availableModels = [...this.connState.lmstudio.models];
      if (this.availableModels.length && !this.availableModels.includes(this.model)) {
        this.model = this.availableModels[0];
      }
    }

    this.photoService.getConfig().subscribe(cfg => {
      this.hasRunLmstudioCommand = !!cfg.has_run_lmstudio_command;
    });
  }

  onUrlChange(): void {
    if (this.lmstudioUrl !== this.connState.lmstudio.url) {
      this.checkStatus = 'idle';
    }
  }

  checkConnection(): void {
    this.checkStatus = 'checking';
    this.runTriggered = false;
    this.connState.lmstudio.url = this.lmstudioUrl;
    this.connState.lmstudio.status = 'checking';
    this.photoService.checkLmStudio(this.lmstudioUrl).subscribe({
      next: (res) => {
        this.checkStatus = 'ok';
        this.connState.lmstudio.status = 'ok';
        this.availableModels = (res.data || []).map((m: any) => m.id);
        this.connState.lmstudio.models = [...this.availableModels];
        if (this.availableModels.length && !this.availableModels.includes(this.model)) {
          this.model = this.availableModels[0];
        }
      },
      error: () => {
        this.checkStatus = 'error';
        this.connState.lmstudio.status = 'error';
      },
    });
  }

  ask(): void {
    this.connState.lmstudio.url = this.lmstudioUrl;
    if (this.model) localStorage.setItem(STORAGE_KEYS.LMS_MODEL, this.model);
    this.connState.lastLmPrompt = this.prompt;
    this.asking = true;
    this.result = '';
    this.photoService.lmPrompt(this.lmstudioUrl, this.prompt, this.model).subscribe({
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

  runService(): void {
    this.runTriggered = true;
    this.photoService.runCommand('lmstudio').subscribe({
      next: () => this.snackBar.open('Starting LM Studio...', '', { duration: 3000 }),
      error: () => { this.runTriggered = false; this.snackBar.open('Failed to run command', '', { duration: 3000 }); },
    });
  }

  openGenerate(): void {
    this.dialogRef.close({ action: 'generate', prompt: this.result });
  }
}
