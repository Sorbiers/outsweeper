import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { Subscription } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatFabButton } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDividerModule } from '@angular/material/divider';
import { MatDialog } from '@angular/material/dialog';
import { PhotoService } from './services/photo.service';
import { KeyboardService, PhotoAction } from './services/keyboard.service';
import { PhotoListItem, PhotoInfo } from './models/photo.model';
import { ImageStrip } from './components/image-strip/image-strip';
import { InfoPanel } from './components/info-panel/info-panel';
import { PreviewPanel } from './components/preview-panel/preview-panel';
import { GenerateDialog } from './components/generate-dialog/generate-dialog';

const DEFAULT_FLUX_WORKFLOW: Record<string, any> = {
  "1": {
    "class_type": "CheckpointLoaderSimple",
    "inputs": { "ckpt_name": "flux1-dev.safetensors" }
  },
  "2": {
    "class_type": "LoraLoader",
    "inputs": { "lora_name": "", "strength_model": 1.0, "strength_clip": 1.0, "model": ["1", 0], "clip": ["1", 1] }
  },
  "3": {
    "class_type": "LoraLoader",
    "inputs": { "lora_name": "", "strength_model": 1.0, "strength_clip": 1.0, "model": ["2", 0], "clip": ["2", 1] }
  },
  "4": {
    "class_type": "LoraLoader",
    "inputs": { "lora_name": "", "strength_model": 1.0, "strength_clip": 1.0, "model": ["3", 0], "clip": ["3", 1] }
  },
  "5": {
    "class_type": "CLIPTextEncode",
    "inputs": { "text": "", "clip": ["4", 1] }
  },
  "6": {
    "class_type": "CLIPTextEncode",
    "inputs": { "text": "", "clip": ["4", 1] }
  },
  "7": {
    "class_type": "EmptyLatentImage",
    "inputs": { "width": 1024, "height": 1024, "batch_size": 1 }
  },
  "8": {
    "class_type": "KSampler",
    "inputs": { "seed": 0, "steps": 20, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0, "model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["7", 0] }
  },
  "9": {
    "class_type": "VAEDecode",
    "inputs": { "samples": ["8", 0], "vae": ["1", 2] }
  },
  "10": {
    "class_type": "SaveImage",
    "inputs": { "filename_prefix": "flux", "images": ["9", 0] }
  }
};

@Component({
  selector: 'pp-root',
  imports: [MatSnackBarModule, MatFabButton, MatIconModule, MatMenuModule, MatProgressSpinnerModule, MatDividerModule, ImageStrip, InfoPanel, PreviewPanel],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit, OnDestroy {
  private photoService = inject(PhotoService);
  private keyboard = inject(KeyboardService);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);

  photos: PhotoListItem[] = [];
  currentIndex = 0;
  currentInfo: PhotoInfo | null = null;
  currentFolder: 'source' | 'selected' | 'dust' = 'source';
  sortBy: 'name' | 'modified' = 'name';
  sortAsc = true;
  loading = false;
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
    this.loading = true;
    this.photoService.listPhotos(this.currentFolder)
      .pipe(finalize(() => this.loading = false))
      .subscribe(res => {
        this.photos = res.photos;
        this.applySorting();
        if (this.photos.length > 0) {
          this.selectPhoto(0);
        } else {
          this.currentInfo = null;
        }
      });
  }

  setSort(by: 'name' | 'modified', asc: boolean): void {
    this.sortBy = by;
    this.sortAsc = asc;
    const currentFilename = this.photos[this.currentIndex]?.filename;
    this.applySorting();
    if (currentFilename) {
      const newIndex = this.photos.findIndex(p => p.filename === currentFilename);
      if (newIndex >= 0) this.currentIndex = newIndex;
    }
  }

  private applySorting(): void {
    const dir = this.sortAsc ? 1 : -1;
    if (this.sortBy === 'name') {
      this.photos.sort((a, b) => a.filename.localeCompare(b.filename) * dir);
    } else {
      this.photos.sort((a, b) => (a.modified < b.modified ? -1 : a.modified > b.modified ? 1 : 0) * dir);
    }
  }

  selectPhoto(index: number): void {
    if (index < 0 || index >= this.photos.length) return;
    this.currentIndex = index;
    const photo = this.photos[index];
    this.photoService.getInfo(photo.filename, this.currentFolder).subscribe(info => {
      this.currentInfo = info;
    });
  }

  openGenerator(): void {
    this.dialog.open(GenerateDialog, {
      data: { workflow: DEFAULT_FLUX_WORKFLOW },
      width: '90vw',
      maxWidth: '800px',
    });
  }

  switchFolder(folder: 'source' | 'selected' | 'dust'): void {
    if (folder === this.currentFolder) return;
    this.currentFolder = folder;
    this.loadPhotos();
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
        if (this.currentFolder === 'source') this.moveCurrentPhoto('selected');
        break;
      case 'dust':
        if (this.currentFolder === 'source') this.moveCurrentPhoto('dust');
        break;
      case 'undo':
        if (this.currentFolder === 'source') this.undoLast();
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
