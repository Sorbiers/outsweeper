import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { PhotoService } from '../../services/photo.service';

export interface GenerateDialogData {
  workflow: Record<string, any>;
}

interface WorkflowParams {
  seed: number | null;
  steps: number | null;
  cfg: number | null;
  batchSize: number | null;
  positivePrompt: string;
  negativePrompt: string;
}

@Component({
  selector: 'pp-generate-dialog',
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatIconModule],
  templateUrl: './generate-dialog.html',
  styleUrl: './generate-dialog.scss',
})
export class GenerateDialog {
  private dialogRef = inject(MatDialogRef<GenerateDialog>);
  private data: GenerateDialogData = inject(MAT_DIALOG_DATA);
  private photoService = inject(PhotoService);
  private snackBar = inject(MatSnackBar);

  comfyUrl = localStorage.getItem('comfyUrl') || 'http://127.0.0.1:8188';
  params: WorkflowParams;
  sending = false;
  checkStatus: 'idle' | 'checking' | 'ok' | 'error' = 'idle';

  constructor() {
    this.params = this.extractParams(this.data.workflow);
  }

  checkConnection(): void {
    this.checkStatus = 'checking';
    localStorage.setItem('comfyUrl', this.comfyUrl);
    this.photoService.checkComfy(this.comfyUrl).subscribe({
      next: () => this.checkStatus = 'ok',
      error: () => this.checkStatus = 'error',
    });
  }

  randomizeSeed(): void {
    this.params.seed = Math.floor(Math.random() * 2 ** 32);
  }

  send(): void {
    localStorage.setItem('comfyUrl', this.comfyUrl);
    const workflow = this.applyParams(this.data.workflow, this.params);
    this.sending = true;
    this.photoService.sendToComfy(this.comfyUrl, workflow).subscribe({
      next: () => {
        this.snackBar.open('Prompt queued successfully', '', { duration: 3000 });
        this.dialogRef.close(true);
      },
      error: (err) => {
        this.sending = false;
        const msg = err.error?.error || err.message || 'Failed to send prompt';
        this.snackBar.open(`Error: ${msg}`, '', { duration: 5000 });
      },
    });
  }

  private extractParams(workflow: Record<string, any>): WorkflowParams {
    const params: WorkflowParams = {
      seed: null,
      steps: null,
      cfg: null,
      batchSize: null,
      positivePrompt: '',
      negativePrompt: '',
    };

    for (const node of Object.values(workflow)) {
      const inputs = node.inputs || {};
      const classType = node.class_type || '';

      if ('steps' in inputs && 'cfg' in inputs) {
        params.steps = inputs.steps;
        params.cfg = inputs.cfg;
        if ('seed' in inputs) params.seed = inputs.seed;
      }

      if ('batch_size' in inputs) {
        params.batchSize = inputs.batch_size;
      }

      if (classType === 'CLIPTextEncode' && 'text' in inputs) {
        if (!params.positivePrompt) {
          params.positivePrompt = inputs.text;
        } else if (!params.negativePrompt) {
          params.negativePrompt = inputs.text;
        }
      }
    }

    return params;
  }

  private applyParams(workflow: Record<string, any>, params: WorkflowParams): Record<string, any> {
    const copy: Record<string, any> = JSON.parse(JSON.stringify(workflow));
    let positiveSet = false;
    let negativeSet = false;

    for (const node of Object.values(copy)) {
      const inputs = node.inputs || {};
      const classType = node.class_type || '';

      if ('steps' in inputs && 'cfg' in inputs) {
        if (params.steps != null) inputs.steps = params.steps;
        if (params.cfg != null) inputs.cfg = params.cfg;
        if ('seed' in inputs && params.seed != null) inputs.seed = params.seed;
      }

      if ('batch_size' in inputs && params.batchSize != null) {
        inputs.batch_size = params.batchSize;
      }

      if (classType === 'CLIPTextEncode' && 'text' in inputs) {
        if (!positiveSet) {
          inputs.text = params.positivePrompt;
          positiveSet = true;
        } else if (!negativeSet) {
          inputs.text = params.negativePrompt;
          negativeSet = true;
        }
      }
    }

    return copy;
  }
}
