import { Component, Signal, inject } from '@angular/core';
import { DecimalPipe, NgClass } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { SystemMetrics } from '../../models/metrics.model';
import { ComfyQueueService } from '../../services/comfy-queue.service';

export interface StateDialogData {
  metrics: Signal<SystemMetrics | null>;
}

/** Mobile 'State' modal — combines the SYS (metrics) and COMFY (queue) widgets. */
@Component({
  selector: 'pp-state-dialog',
  imports: [DecimalPipe, NgClass, MatDialogModule, MatButtonModule, MatIconModule],
  templateUrl: './state-dialog.html',
  styleUrl: './state-dialog.scss',
})
export class StateDialog {
  private data = inject<StateDialogData>(MAT_DIALOG_DATA);
  queue = inject(ComfyQueueService);
  metrics = this.data.metrics;

  cls(pct: number | null | undefined): string {
    if (pct == null) return '';
    return pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : '';
  }
}
