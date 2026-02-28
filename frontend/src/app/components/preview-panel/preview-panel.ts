import { Component, Input, ElementRef, ViewChild, OnChanges, SimpleChanges, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { PhotoInfo } from '../../models/photo.model';
import { PhotoService } from '../../services/photo.service';

const ZOOM_STEP = 1.15;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 20;

@Component({
  selector: 'pp-preview-panel',
  templateUrl: './preview-panel.html',
  styleUrl: './preview-panel.scss',
  imports: [MatButtonModule],
})
export class PreviewPanel implements OnChanges {
  @Input() info: PhotoInfo | null = null;
  @Input() folder = 'source';
  @ViewChild('container') containerRef!: ElementRef<HTMLDivElement>;
  @ViewChild('img') imgRef!: ElementRef<HTMLImageElement>;

  zoomMode: 'fit' | 'free' = 'fit';
  zoomLevel = 1;

  private photoService = inject(PhotoService);
  private panning = false;
  private panStartX = 0;
  private panStartY = 0;
  private scrollStartX = 0;
  private scrollStartY = 0;
  private boundPanMove = (e: MouseEvent) => this.onPanMove(e);
  private boundPanEnd = () => this.onPanEnd();

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['info']) {
      this.zoomMode = 'fit';
      this.zoomLevel = 1;
    }
  }

  get imageUrl(): string | null {
    return this.info ? this.photoService.getImageUrl(this.info.filename, this.folder) : null;
  }

  setFit() {
    this.zoomMode = 'fit';
    this.zoomLevel = 1;
  }

  setFull() {
    this.zoomMode = 'free';
    this.zoomLevel = 1;
  }

  get isFull(): boolean {
    return this.zoomMode === 'free' && this.zoomLevel === 1;
  }

  get scaledWidth(): number {
    const img = this.imgRef?.nativeElement;
    return img ? img.naturalWidth * this.zoomLevel : 0;
  }

  get scaledHeight(): number {
    const img = this.imgRef?.nativeElement;
    return img ? img.naturalHeight * this.zoomLevel : 0;
  }

  onWheel(event: WheelEvent) {
    event.preventDefault();
    const container = this.containerRef?.nativeElement;
    const img = this.imgRef?.nativeElement;
    if (!container || !img) return;

    // If currently in fit mode, compute the effective scale ratio as starting point
    if (this.zoomMode === 'fit') {
      const fitScale = Math.min(
        container.clientWidth / img.naturalWidth,
        container.clientHeight / img.naturalHeight,
        1,
      );
      this.zoomLevel = fitScale;
      this.zoomMode = 'free';
    }

    const oldZoom = this.zoomLevel;
    const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    this.zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, oldZoom * factor));

    // Zoom toward cursor position
    const rect = container.getBoundingClientRect();
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;

    const scrollX = container.scrollLeft;
    const scrollY = container.scrollTop;

    const ratio = this.zoomLevel / oldZoom;

    // After Angular re-renders, adjust scroll to keep cursor point stable
    requestAnimationFrame(() => {
      container.scrollLeft = (scrollX + cursorX) * ratio - cursorX;
      container.scrollTop = (scrollY + cursorY) * ratio - cursorY;
    });
  }

  onPanStart(event: MouseEvent) {
    if (this.zoomMode === 'fit') return;
    const container = this.containerRef?.nativeElement;
    if (!container) return;
    // Only pan if content overflows
    if (container.scrollWidth <= container.clientWidth && container.scrollHeight <= container.clientHeight) return;
    event.preventDefault();
    this.panning = true;
    this.panStartX = event.clientX;
    this.panStartY = event.clientY;
    this.scrollStartX = container.scrollLeft;
    this.scrollStartY = container.scrollTop;
    document.addEventListener('mousemove', this.boundPanMove);
    document.addEventListener('mouseup', this.boundPanEnd);
  }

  private onPanMove(event: MouseEvent) {
    if (!this.panning) return;
    const container = this.containerRef?.nativeElement;
    if (!container) return;
    container.scrollLeft = this.scrollStartX - (event.clientX - this.panStartX);
    container.scrollTop = this.scrollStartY - (event.clientY - this.panStartY);
  }

  private onPanEnd() {
    this.panning = false;
    document.removeEventListener('mousemove', this.boundPanMove);
    document.removeEventListener('mouseup', this.boundPanEnd);
  }
}
