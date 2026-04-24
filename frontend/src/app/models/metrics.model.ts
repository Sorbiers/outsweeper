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
