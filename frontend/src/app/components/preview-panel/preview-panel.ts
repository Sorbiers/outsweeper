import { Component, Input, inject } from '@angular/core';
import { PhotoInfo } from '../../models/photo.model';
import { PhotoService } from '../../services/photo.service';

@Component({
  selector: 'pp-preview-panel',
  templateUrl: './preview-panel.html',
  styleUrl: './preview-panel.scss',
})
export class PreviewPanel {
  @Input() info: PhotoInfo | null = null;

  private photoService = inject(PhotoService);

  get imageUrl(): string | null {
    return this.info ? this.photoService.getImageUrl(this.info.filename) : null;
  }
}
