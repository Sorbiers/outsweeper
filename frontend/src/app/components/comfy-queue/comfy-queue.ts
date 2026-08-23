import { Component, HostBinding, Output, EventEmitter, OnInit, OnDestroy, inject } from '@angular/core';
import { STORAGE_KEYS } from '../../constants';
import { DecimalPipe } from '@angular/common';
import { ComfyQueueService } from '../../services/comfy-queue.service';

/** How often the step preview refreshes while a render is running. */
const PREVIEW_REFRESH_MS = 700;

@Component({
  selector: 'pp-comfy-queue',
  imports: [DecimalPipe],
  templateUrl: './comfy-queue.html',
  styleUrl: './comfy-queue.scss',
})
export class ComfyQueueWidget implements OnInit, OnDestroy {
  @Output() closed = new EventEmitter<void>();

  @HostBinding('style.left') get styleLeft() { return this.x + 'px'; }
  @HostBinding('style.top')  get styleTop()  { return this.y + 'px'; }

  readonly svc = inject(ComfyQueueService);

  /** Hidden until a frame actually arrives: ComfyUI only streams previews when it
   *  was started with --preview-method, and an empty box would just look broken. */
  showPreview = false;
  /** Drives the preview's cache-busting URL. Ticks on its own timer rather than
   *  off the queue poll, which only broadcasts every 2s — far too coarse to watch
   *  a render evolve. */
  previewTick = 0;
  private previewTimer: ReturnType<typeof setInterval> | undefined;

  private x = 0;
  private y = 0;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragOriginX = 0;
  private dragOriginY = 0;

  private boundMove = (e: MouseEvent) => this.onMouseMove(e);
  private boundUp   = ()              => this.onMouseUp();

  ngOnInit(): void {
    const saved = localStorage.getItem(STORAGE_KEYS.COMFY_POS);
    if (saved) {
      try { const p = JSON.parse(saved); this.x = p.x; this.y = p.y; } catch { /* ignore */ }
    } else {
      this.x = window.innerWidth - 130;
      this.y = 160;
    }
    this.previewTimer = setInterval(() => {
      // Only while something is rendering: idle polling would fetch 204s forever.
      if (this.svc.status()?.progress) this.previewTick++;
    }, PREVIEW_REFRESH_MS);
  }

  /** A changing query string is what makes the browser refetch each frame. */
  previewUrl(tick: number): string {
    return `/api/comfy/preview?t=${tick}`;
  }

  onPreviewLoaded(): void {
    this.showPreview = true;
  }

  onPreviewMissing(): void {
    // 204 while previews are off, or between renders — stop showing a broken image
    // but keep trying on the next step, since it can start working mid-session.
    this.showPreview = false;
  }

  ngOnDestroy(): void {
    clearInterval(this.previewTimer);
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
    localStorage.setItem(STORAGE_KEYS.COMFY_POS, JSON.stringify({ x: this.x, y: this.y }));
  }
}
