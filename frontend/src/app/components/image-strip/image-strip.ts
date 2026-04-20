import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  Output,
  inject
} from '@angular/core';
import { MatIconButton } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { PhotoListItem } from '../../models/photo.model';
import { PhotoService } from '../../services/photo.service';

const PAGINATOR_HEIGHT = 36;
const THUMB_GAP = 4;
const THUMB_BORDER = 4; // 2px border * 2 sides

@Component({
  selector: 'pp-image-strip',
  templateUrl: './image-strip.html',
  styleUrl: './image-strip.scss',
  imports: [MatIconButton, MatIconModule, MatProgressSpinnerModule],
})
export class ImageStrip implements AfterViewInit, OnDestroy {
  @Input() photos: PhotoListItem[] = [];
  @Input() currentIndex = 0;
  @Input() pageOffset = 0;
  @Input() totalPhotos = 0;
  @Input() folder = 'source';

  @Output() photoSelected = new EventEmitter<number>();
  @Output() pageChange = new EventEmitter<number>();
  @Output() pageSizeChange = new EventEmitter<number>();

  thumbSize = 100;
  pageCapacity = 0; // 0 means not yet measured

  private photoService = inject(PhotoService);
  private hostEl = inject(ElementRef);
  private resizeObserver: ResizeObserver | null = null;

  get totalPages(): number {
    const cap = this.pageCapacity > 0 ? this.pageCapacity : 1;
    return Math.ceil(this.totalPhotos / cap) || 1;
  }

  get currentPage(): number {
    const cap = this.pageCapacity > 0 ? this.pageCapacity : 1;
    return Math.floor(this.pageOffset / cap) + 1;
  }

  ngAfterViewInit(): void {
    this.resizeObserver = new ResizeObserver(() => this.recalculate());
    this.resizeObserver.observe(this.hostEl.nativeElement);
    // Delay initial calculation to ensure Angular output bindings are wired
    setTimeout(() => this.recalculate());
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  getThumbnailUrl(filename: string): string {
    return this.photoService.getThumbnailUrl(filename, this.folder);
  }

  onThumbClick(localIndex: number): void {
    this.photoSelected.emit(this.pageOffset + localIndex);
  }

  onImageLoad(photo: PhotoListItem): void {
    photo.loaded = true;
    //photo.loaded = true;
  }

  goToPage(pageIndex: number): void {
    if (pageIndex < 0 || pageIndex >= this.totalPages) return;
    this.pageChange.emit(pageIndex * this.pageCapacity);
  }

  private recalculate(): void {
    const el = this.hostEl.nativeElement as HTMLElement;
    const h = el.clientHeight;
    const w = el.clientWidth;
    if (h === 0 || w === 0) return;

    const availableHeight = h - PAGINATOR_HEIGHT;
    this.thumbSize = Math.max(40, availableHeight - THUMB_GAP * 2 - THUMB_BORDER);
    const cellSize = this.thumbSize + THUMB_GAP + THUMB_BORDER;
    const newCapacity = Math.max(1, Math.floor((w - THUMB_GAP) / cellSize));

    if (newCapacity !== this.pageCapacity) {
      this.pageCapacity = newCapacity;
      this.pageSizeChange.emit(newCapacity);
    }
  }
}
