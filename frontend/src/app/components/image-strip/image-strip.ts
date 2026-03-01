import { Component, Input, Output, EventEmitter, ViewChild, ElementRef, OnChanges, SimpleChanges, AfterViewInit, OnDestroy, inject } from '@angular/core';
import { PhotoListItem } from '../../models/photo.model';
import { PhotoService } from '../../services/photo.service';

@Component({
  selector: 'pp-image-strip',
  templateUrl: './image-strip.html',
  styleUrl: './image-strip.scss',
})
export class ImageStrip implements OnChanges, AfterViewInit, OnDestroy {
  @Input() photos: PhotoListItem[] = [];
  @Input() currentIndex = 0;
  @Input() folder = 'source';
  @Output() photoSelected = new EventEmitter<number>();

  @ViewChild('stripContainer') stripContainer!: ElementRef<HTMLDivElement>;

  private photoService = inject(PhotoService);
  private observer: IntersectionObserver | null = null;

  ngAfterViewInit(): void {
    this.setupObserver();
    this.observeImages();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['currentIndex']) {
      this.scrollToCenter();
    }
    if (changes['photos']) {
      // Re-observe after Angular renders new elements
      setTimeout(() => this.observeImages());
    }
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }

  getThumbnailUrl(filename: string): string {
    return this.photoService.getThumbnailUrl(filename, this.folder);
  }

  onThumbnailClick(index: number): void {
    this.photoSelected.emit(index);
  }

  private setupObserver(): void {
    const container = this.stripContainer?.nativeElement;
    if (!container) return;

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const img = entry.target as HTMLImageElement;
            const src = img.getAttribute('data-src');
            if (src && !img.src) {
              img.src = src;
            }
            this.observer?.unobserve(img);
          }
        }
      },
      { root: container, rootMargin: '0px 300px' }
    );
  }

  private observeImages(): void {
    if (!this.observer) return;
    const container = this.stripContainer?.nativeElement;
    if (!container) return;
    const imgs = container.querySelectorAll('img[data-src]:not([src])');
    imgs.forEach(img => this.observer!.observe(img));
  }

  private scrollToCenter(): void {
    setTimeout(() => {
      const container = this.stripContainer?.nativeElement;
      const active = container?.querySelector('.thumbnail.active') as HTMLElement;
      if (container && active) {
        const scrollLeft = active.offsetLeft - container.clientWidth / 2 + active.clientWidth / 2;
        container.scrollTo({ left: scrollLeft, behavior: 'smooth' });
      }
    });
  }
}
