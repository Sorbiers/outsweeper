import { Injectable, signal } from '@angular/core';
import { ComfyQueueStatus } from '../models/metrics.model';

@Injectable({ providedIn: 'root' })
export class ComfyQueueService {
  status = signal<ComfyQueueStatus | null>(null);
}
