import { Component, HostBinding, Output, EventEmitter, OnInit, OnDestroy, inject } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { STORAGE_KEYS } from '../../constants';
import { JobQueueService } from '../../services/job-queue.service';

/** Floating monitor for the internal job queue — the app's own queue, not ComfyUI's
 *  (that widget stays separate). Shows what's running, what's waiting, and the step
 *  the worker is on. */
@Component({
  selector: 'pp-job-queue',
  imports: [DecimalPipe],
  templateUrl: './job-queue.html',
  styleUrl: './job-queue.scss',
})
export class JobQueueWidget implements OnInit, OnDestroy {
  @Output() closed = new EventEmitter<void>();
  @Output() manage = new EventEmitter<void>();

  @HostBinding('style.left') get styleLeft() { return this.x + 'px'; }
  @HostBinding('style.top')  get styleTop()  { return this.y + 'px'; }

  readonly svc = inject(JobQueueService);

  private x = 0;
  private y = 0;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragOriginX = 0;
  private dragOriginY = 0;

  private boundMove = (e: MouseEvent) => this.onMouseMove(e);
  private boundUp   = ()              => this.onMouseUp();

  ngOnInit(): void {
    const saved = localStorage.getItem(STORAGE_KEYS.JOBS_POS);
    if (saved) {
      try { const p = JSON.parse(saved); this.x = p.x; this.y = p.y; } catch { /* ignore */ }
    } else {
      this.x = window.innerWidth - 160;
      this.y = 400;
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
    this.x = Math.max(0, Math.min(window.innerWidth  - 100, this.dragOriginX + e.clientX - this.dragStartX));
    this.y = Math.max(0, Math.min(window.innerHeight -  40, this.dragOriginY + e.clientY - this.dragStartY));
  }

  private onMouseUp(): void {
    document.removeEventListener('mousemove', this.boundMove);
    document.removeEventListener('mouseup', this.boundUp);
    localStorage.setItem(STORAGE_KEYS.JOBS_POS, JSON.stringify({ x: this.x, y: this.y }));
  }
}
