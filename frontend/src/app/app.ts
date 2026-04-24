import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged, finalize } from 'rxjs/operators';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatFabButton, MatIconButton } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDividerModule } from '@angular/material/divider';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
import { PhotoService } from './services/photo.service';
import { KeyboardService, PhotoAction } from './services/keyboard.service';
import { PhotoListItem, PhotoInfo } from './models/photo.model';
import { ImageStrip } from './components/image-strip/image-strip';
import { InfoPanel } from './components/info-panel/info-panel';
import { PreviewPanel } from './components/preview-panel/preview-panel';
import { GenerateDialog, DEFAULT_FLUX_WORKFLOW } from './components/generate-dialog/generate-dialog';
import { FolderSelectDialog, FolderSelectResult } from './components/folder-select-dialog/folder-select-dialog';
import { FilterDialog, ActiveFilters, emptyFilters, hasActiveFilters } from './components/filter-dialog/filter-dialog';


@Component({
  selector: 'pp-root',
  imports: [MatSnackBarModule, MatFabButton, MatIconButton, MatIconModule, MatMenuModule, MatProgressSpinnerModule, MatDividerModule, MatTooltipModule, ImageStrip, InfoPanel, PreviewPanel],
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
  sourceFolderName = '';
  sortBy: 'name' | 'modified' = 'name';
  sortAsc = true;
  loading = false;
  private sub!: Subscription;
  private filterSub!: Subscription;
  private eventSource: EventSource | null = null;

  pendingRefresh = false;

  // Pagination
  totalPhotos = 0;
  pageOffset = 0;
  pageSize = 50; // default; updated by ImageStrip's pageSizeChange after layout

  // Filter
  filterText = '';
  activeFilters: ActiveFilters = emptyFilters();
  get hasActiveFilters(): boolean { return hasActiveFilters(this.activeFilters); }
  private filterSubject = new Subject<string>();

  // Resizable layout percentages
  stripHeight = 25;
  previewWidth = 65;
  private dragging: 'h' | 'v' | null = null;
  private boundDrag = (e: MouseEvent) => this.onDrag(e);
  private boundDragEnd = () => this.onDragEnd();

  ngOnInit(): void {
    // Restore sort from localStorage
    const savedSort = localStorage.getItem('pp_sortBy');
    if (savedSort === 'name' || savedSort === 'modified') this.sortBy = savedSort;
    const savedAsc = localStorage.getItem('pp_sortAsc');
    if (savedAsc !== null) this.sortAsc = savedAsc === 'true';

    this.keyboard.init();
    this.sub = this.keyboard.action$.subscribe(action => this.handleAction(action));
    this.eventSource = new EventSource('/api/events');
    this.eventSource.onmessage = (e) => {
      if (e.data === 'files_changed') this.pendingRefresh = true;
    };
    this.loadPhotos();

    this.filterSub = this.filterSubject
      .pipe(debounceTime(300), distinctUntilChanged())
      .subscribe(text => {
        this.filterText = text;
        this.pageOffset = 0;
        this.currentIndex = 0;
        this.loadPhotos();
      });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.filterSub?.unsubscribe();
    this.eventSource?.close();
  }

  loadPhotos(): void {
    if (this.pageSize <= 0) return;
    this.loading = true;
    this.photoService
      .listPhotos(this.currentFolder, {
        offset: this.pageOffset,
        limit: this.pageSize,
        sortBy: this.sortBy,
        sortAsc: this.sortAsc,
        filter: this.filterText,
        dateField: this.activeFilters.dateField,
        dateFrom: this.activeFilters.dateFrom,
        dateTo: this.activeFilters.dateTo,
        types: this.activeFilters.types,
        sizeMin: this.activeFilters.sizeMin,
        sizeMax: this.activeFilters.sizeMax,
      })
      .pipe(finalize(() => (this.loading = false)))
      .subscribe(res => {
        this.photos = res.photos;
        this.totalPhotos = res.total;
        this.pageOffset = res.offset;
        if (res.source_name) this.sourceFolderName = res.source_name;

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
      this.photoService.getInfo(photo.filename, this.currentFolder).subscribe(info => {
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
    this.currentIndex = newOffset; // select first on new page
    this.loadPhotos();
  }

  onPageSizeChange(newSize: number): void {
    if (newSize === this.pageSize) return;
    this.pageSize = newSize;
    // Recalculate pageOffset to align with new page size
    this.pageOffset = Math.floor(this.currentIndex / this.pageSize) * this.pageSize;
    this.loadPhotos();
  }

  setSort(by: 'name' | 'modified', asc: boolean): void {
    this.sortBy = by;
    this.sortAsc = asc;
    localStorage.setItem('pp_sortBy', by);
    localStorage.setItem('pp_sortAsc', String(asc));
    this.pageOffset = 0;
    this.currentIndex = 0;
    this.loadPhotos();
  }

  onFilterInput(value: string): void {
    this.filterSubject.next(value);
  }

  openFolderDialog(): void {
    this.dialog.open(FolderSelectDialog, {
      width: '420px', maxHeight: '80vh',
      data: { currentView: this.currentFolder },
    }).afterClosed().subscribe((result: FolderSelectResult | undefined) => {
      if (!result) return;
      if (result.kind === 'view') {
        this.switchFolder(result.folder);
      } else if (result.kind === 'change-comfy-output') {
        this.photoService.changeToComfyOutput().subscribe({
          next: res => {
            if (!res.ok) return;
            this.sourceFolderName = res.source_name;
            this.currentFolder = 'source';
            this.pageOffset = 0;
            this.currentIndex = 0;
            this.filterText = '';
            this.loadPhotos();
          },
          error: () => this.snackBar.open('Folder change not allowed', '', { duration: 3000 }),
        });
      } else {
        this.photoService.changeFolder(result.path).subscribe({
          next: res => {
            if (!res.ok) return;
            this.sourceFolderName = res.source_name;
            this.currentFolder = 'source';
            this.pageOffset = 0;
            this.currentIndex = 0;
            this.filterText = '';
            this.loadPhotos();
          },
          error: () => this.snackBar.open('Folder change not allowed', '', { duration: 3000 }),
        });
      }
    });
  }

  refresh(): void {
    this.pendingRefresh = false;
    this.photoService.refresh().subscribe(() => {
      this.pageOffset = 0;
      this.currentIndex = 0;
      this.loadPhotos();
    });
  }

  openFilterDialog(): void {
    this.photoService.getFileTypes().subscribe(res => {
      this.dialog.open(FilterDialog, {
        width: '380px',
        data: { current: this.activeFilters, availableTypes: res.types },
      }).afterClosed().subscribe((result: ActiveFilters | undefined) => {
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

  switchFolder(folder: 'source' | 'selected' | 'dust'): void {
    if (folder === this.currentFolder) return;
    this.currentFolder = folder;
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
        if (this.currentIndex + 1 < this.totalPhotos) {
          this.selectPhoto(this.currentIndex + 1);
        }
        break;
      case 'prev':
        if (this.currentIndex > 0) {
          this.selectPhoto(this.currentIndex - 1);
        }
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
        this.onPageChange(Math.min(next10, Math.floor((this.totalPhotos - 1) / this.pageSize) * this.pageSize));
        break;
      }
      case 'pageBackward10': {
        const prev10 = this.pageOffset - this.pageSize * 10;
        this.onPageChange(Math.max(0, prev10));
        break;
      }
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

  moveCurrentPhoto(destination: 'selected' | 'dust' | 'source'): void {
    if (!this.photos.length) return;
    const relIdx = this.currentIndex - this.pageOffset;
    const filename = this.photos[relIdx].filename;
    const move$ =
      destination === 'selected' ? this.photoService.moveToSelected(filename) :
      destination === 'dust'     ? this.photoService.moveToDust(filename) :
                                   this.photoService.moveToSource(filename, this.currentFolder);

    move$.subscribe(res => {
      if (res.ok) {
        const label = destination === 'selected' ? 'Selected' : destination === 'dust' ? 'Dusted' : 'Restored';
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
