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
import { LmStudioConnectionService } from '../../services/lmstudio-connection.service';

export interface DescribeDialogData {
  filename: string;
  folder: string;
  hasImageWorkflow?: boolean;
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
  lms = inject(LmStudioConnectionService);

  prompt: string;
  describing = false;
  description = '';
  saving = false;

  constructor() {
    this.lms.init();
    this.prompt = this.connState.lastDescribePrompt;
  }

  describe(): void {
    this.connState.lmstudio.url = this.lms.lmstudioUrl;
    this.lms.saveModel();
    this.connState.lastDescribePrompt = this.prompt;
    this.describing = true;
    this.description = '';
    const comfyUrl = this.connState.comfy.url;
    const free$ = comfyUrl
      ? this.photoService.freeComfy(comfyUrl).pipe(catchError(() => of(null)))
      : of(null);
    free$.subscribe(() => this._doDescribe());
  }

  private _doDescribe(): void {
    this.photoService.describePhoto(
      this.data.filename, this.data.folder,
      this.lms.lmstudioUrl, this.prompt, this.lms.model,
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

  get hasImageWorkflow(): boolean {
    return !!this.data.hasImageWorkflow;
  }

  openGenerate(): void {
    this.dialogRef.close({ action: 'generate', prompt: this.description });
  }

  openRegenerate(): void {
    this.dialogRef.close({ action: 'regenerate', prompt: this.description });
  }
}
