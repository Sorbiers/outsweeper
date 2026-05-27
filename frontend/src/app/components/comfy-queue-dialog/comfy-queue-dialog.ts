import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { FormsModule } from '@angular/forms';
import { ComfyQueueJob } from '../../models/photo.model';
import { PhotoService } from '../../services/photo.service';
import { ConnectionStateService } from '../../services/connection-state.service';

export interface ComfyQueueDialogData {
  comfyUrl?: string;
}

@Component({
  selector: 'pp-comfy-queue-dialog',
  imports: [
    FormsModule,
    MatDialogModule,
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
  private connState = inject(ConnectionStateService);
  private data: ComfyQueueDialogData = inject(MAT_DIALOG_DATA);

  comfyUrl = '';
  checkStatus: 'idle' | 'checking' | 'ok' | 'error' = 'idle';
  loading = false;

  running: ComfyQueueJob[] = [];
  pending: ComfyQueueJob[] = [];

  constructor() {
    this.comfyUrl = this.connState.comfy.url || this.data?.comfyUrl || '';
    if (this.comfyUrl && this.connState.comfy.status === 'ok') {
      this.checkStatus = 'ok';
      this.fetchQueue();
    }
  }

  onUrlChange(): void {
    if (this.comfyUrl !== this.connState.comfy.url) this.checkStatus = 'idle';
  }

  checkConnection(): void {
    this.checkStatus = 'checking';
    this.connState.comfy.url = this.comfyUrl;
    this.connState.comfy.status = 'checking';
    this.photoService.checkComfy(this.comfyUrl).subscribe({
      next: () => {
        this.checkStatus = 'ok';
        this.connState.comfy.status = 'ok';
        this.fetchQueue();
      },
      error: () => {
        this.checkStatus = 'error';
        this.connState.comfy.status = 'error';
      },
    });
  }

  fetchQueue(): void {
    this.loading = true;
    this.photoService.getComfyQueue(this.comfyUrl).subscribe({
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

  get isEmpty(): boolean {
    return !this.loading && this.running.length === 0 && this.pending.length === 0;
  }

  modelLabel(job: ComfyQueueJob): string {
    if (!job.model) return '—';
    // Strip file extension for cleaner display
    return job.model.replace(/\.[^.]+$/, '');
  }
}
