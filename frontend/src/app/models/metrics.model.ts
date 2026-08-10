export interface SystemMetrics {
  cpu: number;
  ram: number;
  gpu: number | null;
  temp: number | null;
  vram: number | null;
}

export interface ComfyQueueStatus {
  running: number;
  pending: number;
  done: number;
  progress: { value: number; max: number } | null;
}

export interface LmStudioActivity {
  /** null = not polled yet; else whether LM Studio answered the last check. */
  reachable: boolean | null;
  /** Loaded/active model id, or null if none is loaded. */
  model: string | null;
  /** 0..1 while a model is loading, else null. */
  model_load_progress: number | null;
  /** 0..1 while a prompt is processing, else null. */
  prompt_progress: number | null;
}
