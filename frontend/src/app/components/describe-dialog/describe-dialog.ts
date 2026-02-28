import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Clipboard } from '@angular/cdk/clipboard';
import { PhotoService } from '../../services/photo.service';

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
  private photoService = inject(PhotoService);
  private snackBar = inject(MatSnackBar);
  private clipboard = inject(Clipboard);

  lmstudioUrl = localStorage.getItem('lmstudioUrl') || 'http://localhost:1234/v1';
  model = localStorage.getItem('lmstudioModel') || '';
  prompt = 'Describe this image in detail.';
  availableModels: string[] = [];
  checkStatus: 'idle' | 'checking' | 'ok' | 'error' = 'idle';
  describing = false;
  description = '';
  saving = false;

  checkConnection(): void {
    this.checkStatus = 'checking';
    localStorage.setItem('lmstudioUrl', this.lmstudioUrl);
    this.photoService.checkLmStudio(this.lmstudioUrl).subscribe({
      next: (res) => {
        this.checkStatus = 'ok';
        this.availableModels = (res.data || []).map((m: any) => m.id);
        if (this.availableModels.length && !this.model) {
          this.model = this.availableModels[0];
        }
      },
      error: () => this.checkStatus = 'error',
    });
  }

  describe(): void {
    localStorage.setItem('lmstudioUrl', this.lmstudioUrl);
    if (this.model) localStorage.setItem('lmstudioModel', this.model);
    this.describing = true;
    this.description = '';
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
}
