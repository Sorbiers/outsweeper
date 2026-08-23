/** Lifecycle of an internal job. `processed` = ComfyUI accepted the graphs but the
 *  images aren't rendered yet; `done` = they exist. */
export type JobStatus = 'queued' | 'running' | 'processed' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  kind: string;
  title: string;
  status: JobStatus;
  progress: { step?: string; pct?: number | null };
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  /** Number of prompts in this job. */
  count: number;
  /** Output filenames (capped) once done. */
  filenames: string[];
  cancel_requested: boolean;
}

export interface JobQueueState {
  jobs: Job[];
  paused: boolean;
}

/** One prompt in a job: a finished ComfyUI graph plus the patch points a
 *  multi-step runner needs to re-prompt / re-seed between iterations. */
export interface JobPrompt {
  workflow: Record<string, any>;
  promptNodeId?: string;
  seedNodeId?: string;
  /** LoadImage node in *this* graph to receive the uploaded source image. Per-prompt
   *  because injected LoRAs shift generated node ids between graphs. */
  uploadNodeId?: string;
  promptText?: string;
}

export interface JobPayload {
  prompts: JobPrompt[];
  copyResult?: boolean;
  /** Capture each sampler step and write a review sheet + animation. */
  recordSteps?: boolean;
  front?: boolean;
  /** LM Studio model for the LLM stages of composite jobs. */
  lmModel?: string;
  /** Source image uploaded to ComfyUI at execution time (so the operation no
   *  longer requires ComfyUI to be running when the dialog is used). */
  upload?: { path: string; nodeId?: string };

  // --- guided generation only -------------------------------------------
  /** The single graph the loop re-patches each iteration. */
  prompt?: JobPrompt;
  /** Original prompt — every iteration is judged against this, not the refined text. */
  basePrompt?: string;
  improve?: boolean;
  maxIterations?: number;
  /** Fresh random seed every N iterations (0 = keep the flow's seed). */
  randomizeEvery?: number;
}

/** A job is still occupying the queue in these states. */
export const JOB_ACTIVE: JobStatus[] = ['queued', 'running', 'processed'];

export function isJobActive(job: Job): boolean {
  return JOB_ACTIVE.includes(job.status);
}
