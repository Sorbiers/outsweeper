import { Component, Input } from '@angular/core';
import { DecimalPipe, NgClass } from '@angular/common';
import { SystemMetrics } from '../../models/metrics.model';

@Component({
  selector: 'pp-gpu-monitor',
  imports: [DecimalPipe, NgClass],
  templateUrl: './gpu-monitor.html',
  styleUrl: './gpu-monitor.scss',
})
export class GpuMonitorWidget {
  @Input() metrics!: SystemMetrics;

  cls(pct: number | null): string {
    if (pct == null) return '';
    return pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : '';
  }
}
