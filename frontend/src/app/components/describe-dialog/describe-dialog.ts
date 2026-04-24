import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
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

export interface DescribeDialogData {
  filename: string;
  folder: string;
}

@Component({
  selector: 'pp-describe-dialog',
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatIconModule, MatProgressSpinnerModule],
  templateUrl: './describe-dialog.html',
  styleUrl: './describe-dialog.scss',
})
export class DescribeDialog {
  private data: DescribeDialogData = inject(MAT_DIALOG_DATA);
  private dialogRef = inject(MatDialogRef<DescribeDialog>);
  private photoService = inject(PhotoService);
  private snackBar = inject(MatSnackBar);
  private clipboard = inject(Clipboard);
  private connState = inject(ConnectionStateService);

  lmstudioUrl = '';
  model = localStorage.getItem('lmstudioModel') || '';
  prompt: string;
  availableModels: string[] = [];
  checkStatus: 'idle' | 'checking' | 'ok' | 'error' = 'idle';
  describing = false;
  description = '';
  saving = false;

  constructor() {
    this.lmstudioUrl = localStorage.getItem('lmstudioUrl') || '';
    this.prompt = this.connState.lastDescribePrompt;

    if (this.lmstudioUrl && this.connState.lmstudio.url === this.lmstudioUrl && this.connState.lmstudio.status === 'ok') {
      this.checkStatus = 'ok';
      this.availableModels = [...this.connState.lmstudio.models];
      if (this.availableModels.length && !this.model) {
        this.model = this.availableModels[0];
      }
    }

    if (!this.lmstudioUrl) {
      this.photoService.getConfig().subscribe(cfg => {
        if (!this.lmstudioUrl) this.lmstudioUrl = cfg.lmstudio_url;
      });
    }
  }

  onUrlChange(): void {
    if (this.lmstudioUrl !== this.connState.lmstudio.url) {
      this.checkStatus = 'idle';
    }
  }

  checkConnection(): void {
    this.checkStatus = 'checking';
    localStorage.setItem('lmstudioUrl', this.lmstudioUrl);
    this.connState.lmstudio.url = this.lmstudioUrl;
    this.connState.lmstudio.status = 'checking';
    this.photoService.checkLmStudio(this.lmstudioUrl).subscribe({
      next: (res) => {
        this.checkStatus = 'ok';
        this.connState.lmstudio.status = 'ok';
        this.availableModels = (res.data || []).map((m: any) => m.id);
        this.connState.lmstudio.models = [...this.availableModels];
        if (this.availableModels.length && !this.model) {
          this.model = this.availableModels[0];
        }
      },
      error: () => {
        this.checkStatus = 'error';
        this.connState.lmstudio.status = 'error';
      },
    });
  }

  describe(): void {
    localStorage.setItem('lmstudioUrl', this.lmstudioUrl);
    if (this.model) localStorage.setItem('lmstudioModel', this.model);
    this.connState.lastDescribePrompt = this.prompt;
    this.describing = true;
    this.description = '';
    const comfyUrl = localStorage.getItem('comfyUrl');
    const free$ = comfyUrl
      ? this.photoService.freeComfy(comfyUrl).pipe(catchError(() => of(null)))
      : of(null);
    free$.subscribe(() => this._doDescribe());
  }

  private _doDescribe(): void {
    this.photoService.describePhoto(
      this.data.filename, this.data.folder,
      this.lmstudioUrl, this.prompt, this.model
    ).subscribe({
      next: (res) => {
        this.describing = false;
        this.description = res.description;
      },
      error: (err) => {
        this.describing = false;
        const msg = err.error?.error || err.message || 'Failed to describe';
        this.snackBar.open(`Error: ${msg}`, '', { duration: 5000 });
      },
    });
  }

  copyDescription(): void {
    this.clipboard.copy(this.description);
    this.snackBar.open('Copied to clipboard', '', { duration: 2000 });
  }

  saveToFile(): void {
    this.saving = true;
    this.photoService.writeMeta(this.data.filename, this.data.folder, this.description).subscribe({
      next: () => {
        this.saving = false;
        this.snackBar.open('Description saved to file', '', { duration: 3000 });
      },
      error: (err) => {
        this.saving = false;
        const msg = err.error?.error || err.message || 'Failed to save';
        this.snackBar.open(`Error: ${msg}`, '', { duration: 5000 });
      },
    });
  }

  openGenerate(): void {
    this.dialogRef.close({ action: 'generate', prompt: this.description });
  }
}
