import { Component, DestroyRef, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatFabButton, MatIconButton } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged, finalize } from 'rxjs/operators';
import { BatchDialog } from './components/batch-dialog/batch-dialog';
import { ComfyQueueWidget } from './components/comfy-queue/comfy-queue';
import {
  ActiveFilters,
  emptyFilters,
  FilterDialog,
  hasActiveFilters,
} from './components/filter-dialog/filter-dialog';
import {
  FolderSelectDialog,
  FolderSelectResult,
} from './components/folder-select-dialog/folder-select-dialog';
import {
  DEFAULT_FLUX_WORKFLOW,
  GenerateDialog,
} from './components/generate-dialog/generate-dialog';
import { LmPromptDialog } from './components/lm-prompt-dialog/lm-prompt-dialog';
import { GpuMonitorWidget } from './components/gpu-monitor/gpu-monitor';
import { ImageStrip } from './components/image-strip/image-strip';
import { InfoPanel } from './components/info-panel/info-panel';
import { MetadataEditDialog } from './components/metadata-edit-dialog/metadata-edit-dialog';
import { PreviewPanel } from './components/preview-panel/preview-panel';
import { SystemMetrics } from './models/metrics.model';
import { PhotoInfo, PhotoListItem } from './models/photo.model';
import { ComfyQueueService } from './services/comfy-queue.service';
import { ConnectionStateService } from './services/connection-state.service';
import { FavoritesService } from './services/favorites.service';
import { KeyboardService, PhotoAction } from './services/keyboard.service';
import { PhotoService } from './services/photo.service';
import { SPECIAL_FOLDERS, STORAGE_KEYS } from './constants';

@Component({
  selector: 'pp-root',
  imports: [
    MatSnackBarModule,
    MatFabButton,
    MatIconButton,
    MatIconModule,
    MatMenuModule,
    MatProgressSpinnerModule,
    MatDividerModule,
    MatTooltipModule,
    ImageStrip,
    InfoPanel,
    PreviewPanel,
    GpuMonitorWidget,
    ComfyQueueWidget,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit, OnDestroy {
  private photoService = inject(PhotoService);
  private favoritesSvc = inject(FavoritesService);
  private keyboard = inject(KeyboardService);
  private snackBar = inject(MatSnackBar);
  private dialog = inject(MatDialog);
  private connState = inject(ConnectionStateService);
  private comfyQueue = inject(ComfyQueueService);
  private destroyRef = inject(DestroyRef);

  photos: PhotoListItem[] = [];
  currentIndex = 0;
  currentInfo: PhotoInfo | null = null;
  currentPath = '';
  selectedName: string = SPECIAL_FOLDERS.SELECTED;
  dustName: string = SPECIAL_FOLDERS.DUST;
  sourceFolderName = '';
  sortBy: 'name' | 'modified' = 'name';
  sortAsc = true;
  loading = false;
  private eventSource: EventSource | null = null;
  private sseClientId = '';

  metrics = signal<SystemMetrics | null>(null);
  sourceChangedPending = signal('');
  gpuMonitorEnabled = signal(false);
  widgetVisible = signal(true);
  comfyQueueEnabled = signal(false);
  comfyQueueVisible = signal(true);
  exiftoolAvailable = signal(false);

  // Pagination
  totalPhotos = 0;
  pageOffset = 0;
  pageSize = 0;
  stripCols = 1;

  // Filter
  filterText = '';
  activeFilters: ActiveFilters = emptyFilters();
  get hasActiveFilters(): boolean {
    return hasActiveFilters(this.activeFilters);
  }
  private filterSubject = new Subject<string>();

  // Favorites
  favorites = new Set<string>();
  get favoriteCount(): number {
    return this.favorites.size;
  }
  showFavoritesOnly = false;

  // Resizable layout percentages
  stripHeight = 25;
  previewWidth = 65;
  private dragging: 'h' | 'v' | null = null;
  private boundDrag = (e: MouseEvent) => this.onDrag(e);
  private boundDragEnd = () => this.onDragEnd();

  get folderType(): 'source' | 'selected' | 'dust' | 'sub' {
    if (!this.currentPath) return 'source';
    const last = this.currentPath.split('/').at(-1)!;
    if (last === this.selectedName) return 'selected';
    if (last === this.dustName) return 'dust';
    return 'sub';
  }

  ngOnInit(): void {
    const savedSort = localStorage.getItem(STORAGE_KEYS.SORT_BY);
    if (savedSort === 'name' || savedSort === 'modified') this.sortBy = savedSort;
    const savedAsc = localStorage.getItem(STORAGE_KEYS.SORT_ASC);
    if (savedAsc !== null) this.sortAsc = savedAsc === 'true';

    this.keyboard.init();
    this.keyboard.action$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((action) => this.handleAction(action));
    this.eventSource = new EventSource('/api/events');
    this.eventSource.onmessage = (e) => {
      if (e.data.startsWith('client_id:')) this.sseClientId = e.data.slice(10);
      else if (e.data.startsWith('metrics:')) this.metrics.set(JSON.parse(e.data.slice(8)));
      else if (e.data.startsWith('comfy_queue:'))
        this.comfyQueue.status.set(JSON.parse(e.data.slice(12)));
      else if (e.data.startsWith('source_changed:') && this.folderType === 'source')
        this.sourceChangedPending.set(e.data.slice('source_changed:'.length));
    };
    this.favorites = this.favoritesSvc.load(this.currentPath);
    this.loadPhotos();
    this.photoService.getConfig().subscribe((cfg) => {
      if (!this.connState.comfy.url) this.connState.comfy.url = cfg.comfy_url;
      if (!this.connState.lmstudio.url) this.connState.lmstudio.url = cfg.lmstudio_url;
      if (cfg.widgets?.gpu_monitor) this.gpuMonitorEnabled.set(true);
      if (cfg.widgets?.comfy_queue) this.comfyQueueEnabled.set(true);
      if (cfg.selected_name) this.selectedName = cfg.selected_name;
      if (cfg.dust_name) this.dustName = cfg.dust_name;
      if (cfg.thumbnails_name) this.photoService.thumbnailsName = cfg.thumbnails_name;
    });

    this.photoService.exiftoolCapabilities().subscribe({
      next: caps => this.exiftoolAvailable.set(caps.available),
      error: () => this.exiftoolAvailable.set(false),
    });

    this.filterSubject
      .pipe(debounceTime(300), distinctUntilChanged(), takeUntilDestroyed(this.destroyRef))
      .subscribe((text) => {
        this.filterText = text;
        this.pageOffset = 0;
        this.currentIndex = 0;
        this.loadPhotos();
      });
  }

  ngOnDestroy(): void {
    this.eventSource?.close();
  }

  loadPhotos(): void {
    if (this.pageSize <= 0) return;
    this.loading = true;
    const opts = {
      sortBy: this.sortBy,
      sortAsc: this.sortAsc,
      filter: this.filterText,
      dateField: this.activeFilters.dateField,
      dateFrom: this.activeFilters.dateFrom,
      dateTo: this.activeFilters.dateTo,
      types: this.activeFilters.types,
      sizeMin: this.activeFilters.sizeMin,
      sizeMax: this.activeFilters.sizeMax,
      widthMin: this.activeFilters.widthMin,
      widthMax: this.activeFilters.widthMax,
      heightMin: this.activeFilters.heightMin,
      heightMax: this.activeFilters.heightMax,
      tags: this.activeFilters.tags,
    };
    // When showing favorites only, fetch the whole list and paginate client-side.
    const fetchOpts = this.showFavoritesOnly
      ? { ...opts, offset: 0, limit: 999999 }
      : { ...opts, offset: this.pageOffset, limit: this.pageSize };

    this.photoService
      .listPhotos(this.currentPath, fetchOpts)
      .pipe(finalize(() => (this.loading = false)))
      .subscribe((res) => {
        if (res.source_name) this.sourceFolderName = res.source_name;
        if (this.showFavoritesOnly) {
          const filtered = res.photos.filter((p) => this.favorites.has(p.filename));
          this.totalPhotos = filtered.length;
          this.photos = filtered.slice(this.pageOffset, this.pageOffset + this.pageSize);
        } else {
          this.photos = res.photos;
          this.totalPhotos = res.total;
          this.pageOffset = res.offset;
        }

        if (this.totalPhotos > 0 && this.photos.length > 0) {
          const relIdx = this.currentIndex - this.pageOffset;
          if (relIdx >= 0 && relIdx < this.photos.length) {
            this.fetchInfo(relIdx);
          } else {
            this.currentIndex = this.pageOffset;
            this.fetchInfo(0);
          }
        } else {
          this.currentInfo = null;
        }
      });
  }

  private fetchInfo(relativeIndex: number): void {
    const photo = this.photos[relativeIndex];
    if (photo) {
      this.photoService.getInfo(photo.filename, this.currentPath).subscribe((info) => {
        this.currentInfo = info;
      });
    }
  }

  selectPhoto(absoluteIndex: number): void {
    if (absoluteIndex < 0 || absoluteIndex >= this.totalPhotos) return;

    const neededPage = Math.floor(absoluteIndex / this.pageSize) * this.pageSize;

    if (neededPage !== this.pageOffset) {
      this.currentIndex = absoluteIndex;
      this.pageOffset = neededPage;
      this.loadPhotos();
      return;
    }

    this.currentIndex = absoluteIndex;
    this.fetchInfo(absoluteIndex - this.pageOffset);
  }

  onPageChange(newOffset: number): void {
    this.pageOffset = newOffset;
    this.currentIndex = newOffset;
    this.loadPhotos();
  }

  onPageSizeChange(newSize: number): void {
    if (newSize === this.pageSize) return;
    this.pageSize = newSize;
    this.pageOffset = Math.floor(this.currentIndex / this.pageSize) * this.pageSize;
    this.loadPhotos();
  }

  setSort(by: 'name' | 'modified', asc: boolean): void {
    this.sortBy = by;
    this.sortAsc = asc;
    localStorage.setItem(STORAGE_KEYS.SORT_BY, by);
    localStorage.setItem(STORAGE_KEYS.SORT_ASC, String(asc));
    this.pageOffset = 0;
    this.currentIndex = 0;
    this.loadPhotos();
  }

  onFilterInput(value: string): void {
    this.filterSubject.next(value);
  }

  openFolderDialog(): void {
    this.dialog
      .open(FolderSelectDialog, {
        width: '420px',
        maxHeight: '80vh',
        data: { currentPath: this.currentPath },
      })
      .afterClosed()
      .subscribe((result: FolderSelectResult | undefined) => {
        if (!result) return;
        this.switchFolder(result.path);
      });
  }

  refresh(): void {
    this.sourceChangedPending.set('');
    this.photoService.refresh(this.currentPath).subscribe(() => {
      this.pageOffset = 0;
      this.currentIndex = 0;
      this.loadPhotos();
    });
  }

  openFilterDialog(): void {
    this.photoService.getFileTypes(this.currentPath).subscribe((res) => {
      this.dialog
        .open(FilterDialog, {
          width: '380px',
          data: { current: this.activeFilters, availableTypes: res.types },
        })
        .afterClosed()
        .subscribe((result: ActiveFilters | undefined) => {
          if (result === undefined) return;
          this.activeFilters = result;
          this.pageOffset = 0;
          this.currentIndex = 0;
          this.loadPhotos();
        });
    });
  }

  openGenerator(): void {
    this.dialog.open(GenerateDialog, {
      data: { workflow: DEFAULT_FLUX_WORKFLOW },
      width: '90vw',
      maxWidth: '800px',
    });
  }

  openLmPrompt(): void {
    this.dialog.open(LmPromptDialog, { width: '600px', maxWidth: '95vw' })
      .afterClosed()
      .subscribe(result => {
        if (result?.action === 'generate') {
          this.dialog.open(GenerateDialog, {
            data: { workflow: DEFAULT_FLUX_WORKFLOW, positivePromptOverride: result.prompt },
            width: '90vw',
            maxWidth: '800px',
          });
        }
      });
  }

  switchFolder(path: string): void {
    if (path === this.currentPath) return;
    this.currentPath = path;
    this.sourceChangedPending.set('');
    this.favorites = this.favoritesSvc.load(path);
    this.pageOffset = 0;
    this.currentIndex = 0;
    this.filterText = '';
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
      this.stripHeight = Math.min(80, Math.max(10, pct));
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
        if (this.currentIndex + 1 < this.totalPhotos) this.selectPhoto(this.currentIndex + 1);
        break;
      case 'prev':
        if (this.currentIndex > 0) this.selectPhoto(this.currentIndex - 1);
        break;
      case 'first':
        this.selectPhoto(0);
        break;
      case 'last':
        this.selectPhoto(this.totalPhotos - 1);
        break;
      case 'pageForward': {
        const nextPageStart = this.pageOffset + this.pageSize;
        if (nextPageStart < this.totalPhotos) this.onPageChange(nextPageStart);
        break;
      }
      case 'pageBackward': {
        const prevPageStart = this.pageOffset - this.pageSize;
        if (prevPageStart >= 0) this.onPageChange(prevPageStart);
        break;
      }
      case 'pageForward10': {
        const next10 = this.pageOffset + this.pageSize * 10;
        this.onPageChange(
          Math.min(next10, Math.floor((this.totalPhotos - 1) / this.pageSize) * this.pageSize),
        );
        break;
      }
      case 'pageBackward10': {
        const prev10 = this.pageOffset - this.pageSize * 10;
        this.onPageChange(Math.max(0, prev10));
        break;
      }
      case 'select':
        if (this.folderType === 'source' || this.folderType === 'sub')
          this.moveCurrentPhoto('selected');
        break;
      case 'dust':
        if (this.folderType === 'source' || this.folderType === 'sub')
          this.moveCurrentPhoto('dust');
        break;
      case 'undo':
        if (this.folderType === 'source' || this.folderType === 'sub') this.undoLast();
        break;
      case 'download':
        if (this.currentInfo) this.photoService.downloadFile(this.currentInfo.filename, this.currentPath);
        break;
      case 'toggleSelection':
        this.toggleFavoriteCurrent();
        break;
      case 'selectAll':
        this.toggleAllFavorites();
        break;
      case 'rowUp': {
        const upTarget = this.currentIndex - this.stripCols;
        if (this.pageSize > this.stripCols && upTarget >= 0) this.selectPhoto(upTarget);
        break;
      }
      case 'rowDown': {
        const downTarget = this.currentIndex + this.stripCols;
        if (this.pageSize > this.stripCols && downTarget < this.totalPhotos)
          this.selectPhoto(downTarget);
        break;
      }
      case 'selectSourceFolder': {
        console.log('Switching to source folder');
        this.openFolderDialog();
        break;
      }
    }
  }

  moveCurrentPhoto(action: 'selected' | 'dust' | 'source'): void {
    if (!this.photos.length) return;
    const relIdx = this.currentIndex - this.pageOffset;
    const filename = this.photos[relIdx].filename;

    let destPath: string;
    if (action === 'selected') {
      destPath = this.currentPath ? `${this.currentPath}/${this.selectedName}` : this.selectedName;
    } else if (action === 'dust') {
      destPath = this.currentPath ? `${this.currentPath}/${this.dustName}` : this.dustName;
    } else {
      const idx = this.currentPath.lastIndexOf('/');
      destPath = idx === -1 ? '' : this.currentPath.slice(0, idx);
    }

    this.photoService.move(filename, this.currentPath, destPath).subscribe((res) => {
      if (res.ok) {
        const label =
          action === 'selected' ? 'Selected' : action === 'dust' ? 'Dusted' : 'Restored';
        this.snackBar
          .open(`${label}: ${filename}`, 'Undo', { duration: 3000 })
          .onAction()
          .subscribe(() => this.undoLast());

        this.totalPhotos--;
        if (this.currentIndex >= this.totalPhotos) {
          this.currentIndex = Math.max(0, this.totalPhotos - 1);
        }
        if (this.pageOffset >= this.totalPhotos && this.totalPhotos > 0) {
          this.pageOffset = Math.floor((this.totalPhotos - 1) / this.pageSize) * this.pageSize;
        }
        this.loadPhotos();
      }
    });
  }

  onMetadataChanged(): void {
    // mtime changed → reload photos list (refreshes modified_token, which busts thumb cache)
    // and re-fetch the current photo's info.
    this.loadPhotos();
  }

  closeGpuWidget(): void {
    this.widgetVisible.set(false);
    this.photoService.setMetricsPaused(true, this.sseClientId).subscribe();
  }

  closeComfyQueueWidget(): void {
    this.comfyQueueVisible.set(false);
    this.photoService.setComfyQueuePaused(true, this.sseClientId).subscribe();
  }

  toggleGpuWidget(): void {
    const next = !this.widgetVisible();
    this.widgetVisible.set(next);
    this.photoService.setMetricsPaused(!next, this.sseClientId).subscribe();
  }

  toggleComfyQueueWidget(): void {
    const next = !this.comfyQueueVisible();
    this.comfyQueueVisible.set(next);
    this.photoService.setComfyQueuePaused(!next, this.sseClientId).subscribe();
  }

  private undoLast(): void {
    this.photoService.undo().subscribe((res) => {
      if (res.ok) {
        this.snackBar.open(`Restored: ${res.filename}`, '', { duration: 2000 });
        this.loadPhotos();
      } else {
        this.snackBar.open('Nothing to undo', '', { duration: 1500 });
      }
    });
  }

  toggleFavorite(filename: string): void {
    this.favorites = this.favoritesSvc.toggle(this.currentPath, filename);
  }

  private toggleFavoriteCurrent(): void {
    const rel = this.currentIndex - this.pageOffset;
    if (rel >= 0 && rel < this.photos.length) this.toggleFavorite(this.photos[rel].filename);
  }

  toggleAllFavorites(): void {
    if (this.favorites.size >= this.totalPhotos) {
      this.favoritesSvc.clear(this.currentPath);
      this.favorites = new Set();
    } else {
      this.photoService
        .listPhotos(this.currentPath, {
          offset: 0,
          limit: this.totalPhotos,
          sortBy: this.sortBy,
          sortAsc: this.sortAsc,
          filter: this.filterText,
          dateField: this.activeFilters.dateField,
          dateFrom: this.activeFilters.dateFrom,
          dateTo: this.activeFilters.dateTo,
          types: this.activeFilters.types,
          sizeMin: this.activeFilters.sizeMin,
          sizeMax: this.activeFilters.sizeMax,
          widthMin: this.activeFilters.widthMin,
          widthMax: this.activeFilters.widthMax,
          heightMin: this.activeFilters.heightMin,
          heightMax: this.activeFilters.heightMax,
          tags: this.activeFilters.tags,
        })
        .subscribe((res) => {
          const fns = res.photos.map((p) => p.filename);
          this.favorites = this.favoritesSvc.setAll(this.currentPath, fns, true);
        });
    }
  }

  clearFavorites(): void {
    this.favoritesSvc.clear(this.currentPath);
    this.favorites = new Set();
  }

  toggleFavoritesFilter(): void {
    this.showFavoritesOnly = !this.showFavoritesOnly;
    this.pageOffset = 0;
    this.currentIndex = 0;
    this.loadPhotos();
  }

  downloadFavorites(): void {
    if (!this.favorites.size) return;
    this.photoService.downloadZip([...this.favorites], this.currentPath, 'favorites.zip');
  }

  openBatchDialog(operation: 'copy' | 'move'): void {
    this.dialog
      .open(BatchDialog, {
        width: '420px',
        maxHeight: '80vh',
        data: { operation, filenames: [...this.favorites], sourceFolder: this.currentPath },
      })
      .afterClosed()
      .subscribe((result?: { ok: boolean }) => {
        if (!result?.ok) return;
        if (operation === 'move') {
          this.clearFavorites();
        }
        this.pageOffset = 0;
        this.currentIndex = 0;
        this.loadPhotos();
      });
  }

  openFavMetadata(): void {
    if (!this.favorites.size) return;
    this.dialog
      .open(MetadataEditDialog, {
        width: '90vw',
        maxWidth: '720px',
        data: { mode: 'batch', filenames: [...this.favorites], folder: this.currentPath },
      })
      .afterClosed()
      .subscribe((result?: { ok: boolean; refresh: boolean }) => {
        if (result?.refresh) this.loadPhotos();
      });
  }
}
