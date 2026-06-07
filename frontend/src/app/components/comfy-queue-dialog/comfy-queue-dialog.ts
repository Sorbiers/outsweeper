import { Component, inject } from '@angular/core';
import { CdkDrag, CdkDragHandle } from '@angular/cdk/drag-drop';
import { ComfyConnectionService } from '../../services/comfy-connection.service';
import { ComfyUrlRowComponent } from '../comfy-url-row/comfy-url-row';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { FormsModule } from '@angular/forms';
import { ComfyQueueJob } from '../../models/photo.model';
import { PhotoService } from '../../services/photo.service';

export interface ComfyQueueDialogData {
  comfyUrl?: string;
}

@Component({
  selector: 'pp-comfy-queue-dialog',
  imports: [
    CdkDrag,
    CdkDragHandle,
    FormsModule,
    MatDialogModule,
    ComfyUrlRowComponent,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
  templateUrl: './comfy-queue-dialog.html',
  styleUrl: './comfy-queue-dialog.scss',
})
export class ComfyQueueDialog {
  private photoService = inject(PhotoService);
  private snackBar = inject(MatSnackBar);
  private data: ComfyQueueDialogData = inject(MAT_DIALOG_DATA);
  comfy = inject(ComfyConnectionService);

  loading = false;
  running: ComfyQueueJob[] = [];
  pending: ComfyQueueJob[] = [];

  constructor() {
    this.comfy.init();
    if (this.comfy.checkStatus === 'ok') {
      this.fetchQueue();
    }
  }

  onConnected(): void {
    this.fetchQueue();
  }

  fetchQueue(): void {
    this.loading = true;
    this.photoService.getComfyQueue(this.comfy.comfyUrl).subscribe({
      next: (res) => {
        this.running = res.running;
        this.pending = res.pending;
        this.loading = false;
      },
      error: () => {
        this.loading = false;
      },
    });
  }

  removeJob(promptId: string): void {
    this.photoService.deleteComfyQueueJob(this.comfy.comfyUrl, promptId).subscribe({
      next: () => this.fetchQueue(),
      error: () => this.snackBar.open('Failed to remove job', '', { duration: 3000 }),
    });
  }

  moveToFront(promptId: string): void {
    this.photoService.moveComfyQueueJobToFront(this.comfy.comfyUrl, promptId).subscribe({
      next: () => this.fetchQueue(),
      error: (err) => this.snackBar.open(err.error?.error || 'Failed to move job', '', { duration: 3000 }),
    });
  }

  clearQueue(): void {
    this.photoService.clearComfyQueue(this.comfy.comfyUrl).subscribe({
      next: () => this.fetchQueue(),
      error: () => this.snackBar.open('Failed to clear queue', '', { duration: 3000 }),
    });
  }

  cancelRunning(): void {
    this.photoService.interruptComfy(this.comfy.comfyUrl).subscribe({
      next: () => setTimeout(() => this.fetchQueue(), 600),
      error: () => this.snackBar.open('Failed to cancel job', '', { duration: 3000 }),
    });
  }

  get isEmpty(): boolean {
    return !this.loading && this.running.length === 0 && this.pending.length === 0;
  }

  modelLabel(job: ComfyQueueJob): string {
    if (!job.model) return '—';
    return job.model.replace(/\.[^.]+$/, '');
  }
}
