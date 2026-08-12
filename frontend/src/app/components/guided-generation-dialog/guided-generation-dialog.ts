import { CdkDrag, CdkDragHandle } from '@angular/cdk/drag-drop';
import { Component, inject, OnDestroy, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { LmStudioConnectionService } from '../../services/lmstudio-connection.service';
import { PhotoService } from '../../services/photo.service';

export interface GuidedGenerationData {
  lmUrl?: string;
  /** Positive prompt with {{tokens}} already substituted (concrete text). */
  basePrompt?: string;
  /** The single-image graph plus the node ids the backend patches per iteration. */
  prompt?: { workflow: Record<string, any>; promptNodeId?: string; seedNodeId?: string };
  copyResult?: boolean;
  /** Attach to an already-running guided job instead of configuring a new one. */
  jobId?: string;
}

/** One round recorded by the backend runner. */
interface Iteration {
  n: number;
  prompt: string;
  status: 'generating' | 'evaluating' | 'done';
  image?: string;
  match?: boolean;
  feedback?: string;
}

const MAX_ITERATIONS = 5;
const POLL_MS = 1500;

/**
 * Configure a guided run, hand it to the job queue, and watch it.
 *
 * The improve -> render -> judge -> refine loop itself runs on the backend, so
 * closing this dialog (or the whole tab) no longer stops the work — this is purely
 * a view over `job.result.iterations`.
 */
@Component({
  selector: 'pp-guided-generation-dialog',
  imports: [CdkDrag, CdkDragHandle, FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule,
            MatSelectModule, MatButtonModule, MatCheckboxModule, MatIconModule, MatProgressSpinnerModule],
  templateUrl: './guided-generation-dialog.html',
  styleUrl: './guided-generation-dialog.scss',
})
export class GuidedGenerationDialog implements OnDestroy {
  private dialogRef = inject(MatDialogRef<GuidedGenerationDialog>);
  data: GuidedGenerationData = inject(MAT_DIALOG_DATA);
  private photo = inject(PhotoService);
  private snackBar = inject(MatSnackBar);
  lms = inject(LmStudioConnectionService);

  improve = signal(true);
  maxIterations = MAX_ITERATIONS;
  /** Randomize the seed every N iterations (0 = keep the flow's seed fixed). */
  randomizeEvery = 0;

  jobId = signal<string | null>(null);
  status = signal('');
  jobStatus = signal<string>('');
  errorMsg = signal('');
  matched = signal(false);
  iterations = signal<Iteration[]>([]);

  private timer: any = null;

  constructor() {
    this.lms.init();
    if (!this.lms.availableModels.length && this.lms.lmstudioUrl) this.lms.checkConnection();
    if (this.data.jobId) {
      this.jobId.set(this.data.jobId);
      this.poll();
    }
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  /** True once a job exists — the dialog switches from config to monitor. */
  get monitoring(): boolean { return this.jobId() !== null; }

  get finished(): boolean {
    return ['done', 'failed', 'cancelled'].includes(this.jobStatus());
  }

  thumb(image: string): string {
    return this.photo.getThumbnailUrl(image, '');
  }

  close(): void {
    this.dialogRef.close();
  }

  /** Hand the run to the queue. It keeps going whether or not this stays open. */
  start(): void {
    const model = this.lms.model;
    if (!model) { this.snackBar.open('Select an LLM model first', '', { duration: 3000 }); return; }
    const spec = this.data.prompt;
    if (!spec) { this.snackBar.open('No workflow to run', '', { duration: 3000 }); return; }

    this.lms.saveModel();
    this.maxIterations = Math.max(1, Math.min(50, Math.floor(Number(this.maxIterations) || MAX_ITERATIONS)));
    this.randomizeEvery = Math.max(0, Math.floor(Number(this.randomizeEvery) || 0));

    this.photo.enqueueJob('guided', `Guided · ${this.shortPrompt()}`, {
      prompts: [],                       // guided carries a single `prompt` instead
      copyResult: true,                  // the evaluator needs the image on disk
      prompt: spec,
      basePrompt: this.data.basePrompt || '',
      lmModel: model,
      improve: this.improve(),
      maxIterations: this.maxIterations,
      randomizeEvery: this.randomizeEvery,
    }).subscribe({
      next: r => { this.jobId.set(r.id); this.poll(); },
      error: err => this.snackBar.open(
        `Could not queue: ${err?.error?.error || err?.message || 'failed'}`, 'Dismiss', { duration: 8000 }),
    });
  }

  /** Cancel the backend job (closing the dialog alone leaves it running). */
  cancel(): void {
    const id = this.jobId();
    if (id) this.photo.cancelJob(id).subscribe();
  }

  private poll(): void {
    this.stopPolling();
    const tick = () => {
      const id = this.jobId();
      if (!id) return;
      this.photo.getJob(id).subscribe({
        next: job => {
          this.jobStatus.set(job.status);
          this.status.set(job.progress?.step || '');
          this.errorMsg.set(job.error || '');
          this.iterations.set((job.result?.['iterations'] as Iteration[]) || []);
          this.matched.set(!!job.result?.['matched']);
          if (this.finished) this.stopPolling();
        },
        error: () => this.stopPolling(),
      });
    };
    tick();
    this.timer = setInterval(tick, POLL_MS);
  }

  private stopPolling(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private shortPrompt(): string {
    const p = (this.data.basePrompt || '').trim().replace(/\s+/g, ' ');
    return p.length > 50 ? p.slice(0, 50) + '…' : (p || 'untitled');
  }
}
