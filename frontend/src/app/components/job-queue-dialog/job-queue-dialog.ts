import { CdkDrag, CdkDragDrop, CdkDragHandle, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
import { Job } from '../../models/job.model';
import { JobQueueService } from '../../services/job-queue.service';
import { PhotoService } from '../../services/photo.service';
import { GuidedGenerationData, GuidedGenerationDialog } from '../guided-generation-dialog/guided-generation-dialog';

/** Manager for the internal queue: reorder what's waiting, cancel jobs, pause the
 *  worker, and choose whether to wait for ComfyUI's own queue or clear it. */
@Component({
  selector: 'pp-job-queue-dialog',
  imports: [CdkDrag, CdkDragHandle, CdkDropList, DatePipe, FormsModule, MatDialogModule,
            MatButtonModule, MatIconModule, MatCheckboxModule, MatTooltipModule],
  templateUrl: './job-queue-dialog.html',
  styleUrl: './job-queue-dialog.scss',
})
export class JobQueueDialog {
  private photo = inject(PhotoService);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);
  svc = inject(JobQueueService);

  forceClearComfy = signal(false);
  autoStart = signal(true);

  constructor() {
    this.photo.getConfig().subscribe(cfg => {
      this.forceClearComfy.set(!!cfg.queue?.force_clear_comfy);
      this.autoStart.set(cfg.queue?.auto_start !== false);
    });
  }

  /** Drag-reorder the waiting jobs, then tell the backend the new order. */
  drop(event: CdkDragDrop<Job[]>): void {
    const ids = this.svc.queued().map(j => j.id);
    if (event.previousIndex === event.currentIndex) return;
    moveItemInArray(ids, event.previousIndex, event.currentIndex);
    this.photo.reorderJobs(ids).subscribe({
      error: () => this.snackBar.open('Could not reorder the queue', '', { duration: 3000 }),
    });
  }

  cancel(job: Job): void {
    this.photo.cancelJob(job.id).subscribe();
  }

  /** Guided jobs record per-iteration results — re-attach the monitor to watch one. */
  canMonitor(job: Job): boolean {
    return job.kind === 'guided';
  }

  monitor(job: Job): void {
    this.dialog.open(GuidedGenerationDialog, {
      data: { jobId: job.id } satisfies GuidedGenerationData,
      width: '90vw', maxWidth: '960px', height: '80vh', maxHeight: '90vh',
    });
  }

  cancelAll(): void {
    this.photo.cancelAllJobs().subscribe(r => {
      if (r.cancelled) this.snackBar.open(`Cancelled ${r.cancelled} job(s)`, '', { duration: 3000 });
    });
  }

  togglePaused(): void {
    this.photo.setJobsPaused(!this.svc.paused()).subscribe();
  }

  clearFinished(): void {
    this.photo.clearFinishedJobs().subscribe();
  }

  onForceClearChange(value: boolean): void {
    this.forceClearComfy.set(value);
    this.photo.setJobSettings({ force_clear_comfy: value }).subscribe();
  }

  onAutoStartChange(value: boolean): void {
    this.autoStart.set(value);
    this.photo.setJobSettings({ auto_start: value }).subscribe();
  }

  statusClass(job: Job): string {
    switch (job.status) {
      case 'done':      return 'ok';
      case 'failed':    return 'err';
      case 'cancelled': return 'muted';
      case 'queued':    return 'wait';
      default:          return 'run';
    }
  }
}
