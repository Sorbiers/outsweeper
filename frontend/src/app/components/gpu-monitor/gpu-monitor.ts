import { Component, HostBinding, Input, Output, EventEmitter, OnInit, OnDestroy } from '@angular/core';
import { STORAGE_KEYS } from '../../constants';
import { DecimalPipe, NgClass } from '@angular/common';
import { SystemMetrics } from '../../models/metrics.model';

@Component({
  selector: 'pp-gpu-monitor',
  imports: [DecimalPipe, NgClass],
  templateUrl: './gpu-monitor.html',
  styleUrl: './gpu-monitor.scss',
})
export class GpuMonitorWidget implements OnInit, OnDestroy {
  @Input() metrics!: SystemMetrics;
  @Output() closed = new EventEmitter<void>();

  @HostBinding('style.left') get styleLeft() { return this.x + 'px'; }
  @HostBinding('style.top')  get styleTop()  { return this.y + 'px'; }

  private x = 0;
  private y = 8;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragOriginX = 0;
  private dragOriginY = 0;

  private boundMove = (e: MouseEvent) => this.onMouseMove(e);
  private boundUp   = ()              => this.onMouseUp();

  ngOnInit(): void {
    const saved = localStorage.getItem(STORAGE_KEYS.WIDGET_POS);
    if (saved) {
      try {
        const p = JSON.parse(saved);
        this.x = p.x;
        this.y = p.y;
      } catch { /* ignore */ }
    } else {
      this.x = window.innerWidth - 120;
      this.y = 8;
    }
  }

  ngOnDestroy(): void {
    document.removeEventListener('mousemove', this.boundMove);
    document.removeEventListener('mouseup', this.boundUp);
  }

  onHeaderMouseDown(e: MouseEvent): void {
    e.preventDefault();
    this.dragStartX  = e.clientX;
    this.dragStartY  = e.clientY;
    this.dragOriginX = this.x;
    this.dragOriginY = this.y;
    document.addEventListener('mousemove', this.boundMove);
    document.addEventListener('mouseup', this.boundUp);
  }

  private onMouseMove(e: MouseEvent): void {
    this.x = Math.max(0, Math.min(window.innerWidth  - 90, this.dragOriginX + e.clientX - this.dragStartX));
    this.y = Math.max(0, Math.min(window.innerHeight - 40, this.dragOriginY + e.clientY - this.dragStartY));
  }

  private onMouseUp(): void {
    document.removeEventListener('mousemove', this.boundMove);
    document.removeEventListener('mouseup', this.boundUp);
    localStorage.setItem(STORAGE_KEYS.WIDGET_POS, JSON.stringify({ x: this.x, y: this.y }));
  }

  cls(pct: number | null): string {
    if (pct == null) return '';
    return pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : '';
  }
}
