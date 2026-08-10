import { Injectable, signal } from '@angular/core';
import { LmStudioActivity } from '../models/metrics.model';

@Injectable({ providedIn: 'root' })
export class LmStudioActivityService {
  status = signal<LmStudioActivity | null>(null);
}
