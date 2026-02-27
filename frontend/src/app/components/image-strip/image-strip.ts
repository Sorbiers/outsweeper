import { Component, Input, Output, EventEmitter, ViewChild, ElementRef, OnChanges, SimpleChanges, inject } from '@angular/core';
import { PhotoListItem } from '../../models/photo.model';
import { PhotoService } from '../../services/photo.service';

@Component({
  selector: 'pp-image-strip',
  templateUrl: './image-strip.html',
  styleUrl: './image-strip.scss',
})
export class ImageStrip implements OnChanges {
  @Input() photos: PhotoListItem[] = [];
  @Input() currentIndex = 0;
  @Output() photoSelected = new EventEmitter<number>();

  @ViewChild('stripContainer') stripContainer!: ElementRef<HTMLDivElement>;

  private photoService = inject(PhotoService);

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['currentIndex']) {
      this.scrollToCenter();
    }
  }

  getThumbnailUrl(filename: string): string {
    return this.photoService.getThumbnailUrl(filename);
  }

  onThumbnailClick(index: number): void {
    this.photoSelected.emit(index);
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
