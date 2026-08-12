import { computed, Injectable, signal } from '@angular/core';
import { isJobActive, Job } from '../models/job.model';

/** Live view of the backend job queue, fed by the `jobs:` SSE line in app.ts.
 *  The queue itself lives on the backend — this is only a mirror. */
@Injectable({ providedIn: 'root' })
export class JobQueueService {
  jobs = signal<Job[]>([]);
  paused = signal(false);

  /** Jobs still occupying the queue, in execution order. */
  active = computed(() => this.jobs().filter(isJobActive));
  running = computed(() => this.jobs().find(j => j.status === 'running' || j.status === 'processed') ?? null);
  queued = computed(() => this.jobs().filter(j => j.status === 'queued'));
  finished = computed(() => this.jobs().filter(j => !isJobActive(j)));
  doneCount = computed(() => this.jobs().filter(j => j.status === 'done').length);
  failedCount = computed(() => this.jobs().filter(j => j.status === 'failed').length);
}
