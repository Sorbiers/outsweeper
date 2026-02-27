import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { Subscription } from 'rxjs';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { PhotoService } from './services/photo.service';
import { KeyboardService, PhotoAction } from './services/keyboard.service';
import { PhotoListItem, PhotoInfo } from './models/photo.model';
import { ImageStrip } from './components/image-strip/image-strip';
import { InfoPanel } from './components/info-panel/info-panel';
import { PreviewPanel } from './components/preview-panel/preview-panel';

@Component({
  selector: 'pp-root',
  imports: [MatSnackBarModule, ImageStrip, InfoPanel, PreviewPanel],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit, OnDestroy {
  private photoService = inject(PhotoService);
  private keyboard = inject(KeyboardService);
  private snackBar = inject(MatSnackBar);

  photos: PhotoListItem[] = [];
  currentIndex = 0;
  currentInfo: PhotoInfo | null = null;
  private sub!: Subscription;

  // Resizable layout percentages
  stripHeight = 25;
  previewWidth = 65;
  private dragging: 'h' | 'v' | null = null;
  private boundDrag = (e: MouseEvent) => this.onDrag(e);
  private boundDragEnd = () => this.onDragEnd();

  ngOnInit(): void {
    this.keyboard.init();
    this.loadPhotos();
    this.sub = this.keyboard.action$.subscribe(action => this.handleAction(action));
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  loadPhotos(): void {
    this.photoService.listPhotos().subscribe(res => {
      this.photos = res.photos;
      if (this.photos.length > 0) {
        this.selectPhoto(0);
      } else {
        this.currentInfo = null;
      }
    });
  }

  selectPhoto(index: number): void {
    if (index < 0 || index >= this.photos.length) return;
    this.currentIndex = index;
    const photo = this.photos[index];
    this.photoService.getInfo(photo.filename).subscribe(info => {
      this.currentInfo = info;
    });
  }

  onHDividerDown(e: MouseEvent): void {
    e.preventDefault();
    this.dragging = 'h';
    document.addEventListener('mousemove', this.boundDrag);
    document.addEventListener('mouseup', this.boundDragEnd);
  }

  onVDividerDown(e: MouseEvent): void {
    e.preventDefault();
    this.dragging = 'v';
    document.addEventListener('mousemove', this.boundDrag);
    document.addEventListener('mouseup', this.boundDragEnd);
  }

  private onDrag(e: MouseEvent): void {
    if (this.dragging === 'h') {
      const pct = (e.clientY / window.innerHeight) * 100;
      this.stripHeight = Math.min(50, Math.max(10, pct));
    } else if (this.dragging === 'v') {
      const pct = (e.clientX / window.innerWidth) * 100;
      this.previewWidth = Math.min(80, Math.max(20, pct));
    }
  }

  private onDragEnd(): void {
    this.dragging = null;
    document.removeEventListener('mousemove', this.boundDrag);
    document.removeEventListener('mouseup', this.boundDragEnd);
  }

  private handleAction(action: PhotoAction): void {
    switch (action) {
      case 'next':
        this.selectPhoto(this.currentIndex + 1);
        break;
      case 'prev':
        this.selectPhoto(this.currentIndex - 1);
        break;
      case 'first':
        this.selectPhoto(0);
        break;
      case 'last':
        this.selectPhoto(this.photos.length - 1);
        break;
      case 'select':
        this.moveCurrentPhoto('selected');
        break;
      case 'dust':
        this.moveCurrentPhoto('dust');
        break;
      case 'undo':
        this.undoLast();
        break;
    }
  }

  private moveCurrentPhoto(destination: 'selected' | 'dust'): void {
    if (!this.photos.length) return;
    const filename = this.photos[this.currentIndex].filename;
    const move$ = destination === 'selected'
      ? this.photoService.moveToSelected(filename)
      : this.photoService.moveToDust(filename);

    move$.subscribe(res => {
      if (res.ok) {
        this.photos.splice(this.currentIndex, 1);
        const label = destination === 'selected' ? 'Selected' : 'Dusted';
        this.snackBar.open(`${label}: ${filename}`, 'Undo', { duration: 3000 })
          .onAction().subscribe(() => this.undoLast());

        if (this.currentIndex >= this.photos.length) {
          this.currentIndex = Math.max(0, this.photos.length - 1);
        }
        if (this.photos.length > 0) {
          this.selectPhoto(this.currentIndex);
        } else {
          this.currentInfo = null;
        }
      }
    });
  }

  private undoLast(): void {
    this.photoService.undo().subscribe(res => {
      if (res.ok) {
        this.snackBar.open(`Restored: ${res.filename}`, '', { duration: 2000 });
        this.loadPhotos();
      } else {
        this.snackBar.open('Nothing to undo', '', { duration: 1500 });
      }
    });
  }
}
