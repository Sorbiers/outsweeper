import { AfterViewInit, Component, ElementRef, OnDestroy, OnInit, inject, signal, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { SystemMetrics } from '../../models/metrics.model';
import { PhotoListItem } from '../../models/photo.model';
import { ComfyQueueService } from '../../services/comfy-queue.service';
import { ConnectionStateService } from '../../services/connection-state.service';
import { PhotoService } from '../../services/photo.service';
import { ComfyQueueDialog } from '../comfy-queue-dialog/comfy-queue-dialog';
import { ConfirmDialog } from '../confirm-dialog/confirm-dialog';
import { FolderSelectDialog, FolderSelectResult } from '../folder-select-dialog/folder-select-dialog';
import { DEFAULT_FLUX_WORKFLOW, GenerateDialog } from '../generate-dialog/generate-dialog';
import { StateDialog } from '../state-dialog/state-dialog';

const PAGE_SIZE = 30;
/** Full-screen dialog config for the small-screen mobile page. */
const MOBILE_DIALOG = { width: '100vw', maxWidth: '100vw', height: '100dvh', maxHeight: '100dvh', panelClass: 'mobile-dialog' };

/** Mobile page: Instagram-style vertical feed of the working directory. */
@Component({
  selector: 'pp-mobile-feed',
  imports: [MatButtonModule, MatIconModule, MatMenuModule, MatDialogModule, MatProgressSpinnerModule],
  templateUrl: './mobile-feed.html',
  styleUrl: './mobile-feed.scss',
})
export class MobileFeed implements OnInit, AfterViewInit, OnDestroy {
  private photoService = inject(PhotoService);
  private dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);
  private connState = inject(ConnectionStateService);
  private comfyQueue = inject(ComfyQueueService);

  private feedEl   = viewChild.required<ElementRef<HTMLElement>>('feed');
  private sentinel = viewChild.required<ElementRef<HTMLElement>>('sentinel');

  photos  = signal<PhotoListItem[]>([]);
  total   = signal(0);
  loading = signal(false);
  currentPath = signal('');
  metrics = signal<SystemMetrics | null>(null);
  private eventSource: EventSource | null = null;

  // Fullscreen viewer state
  viewerPhoto = signal<PhotoListItem | null>(null);
  private scale = 1;
  private tx = 0;
  private ty = 0;
  transform = signal('translate(0px, 0px) scale(1)');

  private dustName = '__dust';
  private observer: IntersectionObserver | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchStart: { dist: number; scale: number; cx: number; cy: number } | null = null;
  private panStart: { x: number; y: number; tx: number; ty: number } | null = null;
  private lastTap = 0;

  ngOnInit(): void {
    this.photoService.getConfig().subscribe(cfg => {
      if (cfg.dust_name) this.dustName = cfg.dust_name;
      if (!this.connState.comfy.url) this.connState.comfy.url = cfg.comfy_url;
      if (!this.connState.lmstudio.url) this.connState.lmstudio.url = cfg.lmstudio_url;
    });
    this.eventSource = new EventSource('/api/events');
    this.eventSource.onmessage = (e) => {
      if (e.data.startsWith('metrics:')) this.metrics.set(JSON.parse(e.data.slice(8)));
      else if (e.data.startsWith('comfy_queue:')) this.comfyQueue.status.set(JSON.parse(e.data.slice(12)));
    };
    this.loadMore();
  }

  ngAfterViewInit(): void {
    this.observer = new IntersectionObserver(
      entries => { if (entries.some(e => e.isIntersecting)) this.loadMore(); },
      { root: this.feedEl().nativeElement, rootMargin: '600px' },
    );
    this.observer.observe(this.sentinel().nativeElement);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.eventSource?.close();
  }

  get hasMore(): boolean {
    return this.photos().length < this.total() || this.total() === 0;
  }

  loadMore(): void {
    if (this.loading()) return;
    const offset = this.photos().length;
    if (this.total() > 0 && offset >= this.total()) return;
    this.loading.set(true);
    this.photoService
      .listPhotos(this.currentPath(), { sortBy: 'modified', sortAsc: false, offset, limit: PAGE_SIZE })
      .subscribe({
        next: res => {
          this.photos.update(list => [...list, ...res.photos]);
          this.total.set(res.total);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  refresh(): void {
    this.photos.set([]);
    this.total.set(0);
    this.goTop(false);
    this.loadMore();
  }

  goTop(smooth = true): void {
    this.feedEl().nativeElement.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
  }

  thumbUrl(photo: PhotoListItem): string {
    return this.photoService.getThumbnailUrl(photo.filename, this.currentPath(), photo.modified_token);
  }

  imageUrl(photo: PhotoListItem): string {
    return this.photoService.getImageUrl(photo.filename, this.currentPath(), photo.modified_token);
  }

  confirmDelete(photo: PhotoListItem, event: Event): void {
    event.stopPropagation();
    this.dialog.open(ConfirmDialog, {
      data: { message: `Move ${photo.filename} to dust?`, confirmLabel: 'Delete' },
      maxWidth: '90vw',
    }).afterClosed().subscribe(yes => {
      if (yes) this.deletePhoto(photo);
    });
  }

  private deletePhoto(photo: PhotoListItem): void {
    const from = this.currentPath();
    const dest = from ? `${from}/${this.dustName}` : this.dustName;
    this.photoService.move(photo.filename, from, dest).subscribe({
      next: () => {
        this.photos.update(list => list.filter(p => p.filename !== photo.filename));
        this.total.update(t => Math.max(0, t - 1));
        if (this.viewerPhoto()?.filename === photo.filename) this.closeViewer();
        this.snackBar.open('Moved to dust', '', { duration: 2000 });
      },
      error: err => this.snackBar.open(err.error?.error || 'Failed to move', '', { duration: 3000 }),
    });
  }

  // --- Menu actions (workspace / queue / state) + Generate ---

  openWorkspace(): void {
    this.dialog.open(FolderSelectDialog, {
      width: '420px',
      maxWidth: '92vw',
      maxHeight: '80vh',
      data: { currentPath: this.currentPath() },
    }).afterClosed().subscribe((result: FolderSelectResult | undefined) => {
      if (result) {
        this.currentPath.set(result.path);
        this.refresh();
      }
    });
  }

  openQueue(): void {
    this.dialog.open(ComfyQueueDialog, { data: { comfyUrl: this.connState.comfy.url }, ...MOBILE_DIALOG });
  }

  openState(): void {
    this.dialog.open(StateDialog, { data: { metrics: this.metrics }, width: '92vw', maxWidth: '460px' });
  }

  /** Tap a card's file name → open Generate on that image's embedded flow. */
  openGenerate(photo: PhotoListItem, event: Event): void {
    event.stopPropagation();
    this.photoService.getInfo(photo.filename, this.currentPath()).subscribe({
      next: info => {
        const raw = info.png_metadata?.['prompt'];
        let workflow: Record<string, any>;
        try {
          workflow = raw ? JSON.parse(raw) : JSON.parse(JSON.stringify(DEFAULT_FLUX_WORKFLOW));
        } catch {
          workflow = JSON.parse(JSON.stringify(DEFAULT_FLUX_WORKFLOW));
        }
        this.dialog.open(GenerateDialog, {
          data: { workflow, title: `Re-generate · ${photo.filename}` },
          ...MOBILE_DIALOG,
        });
      },
      error: () => this.snackBar.open('Failed to read image metadata', '', { duration: 3000 }),
    });
  }

  // --- Fullscreen viewer with pinch-zoom / pan (Pointer Events) ---

  openViewer(photo: PhotoListItem): void {
    this.viewerPhoto.set(photo);
    this.resetTransform();
  }

  closeViewer(): void {
    this.viewerPhoto.set(null);
    this.resetTransform();
  }

  private resetTransform(): void {
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.applyTransform();
  }

  private applyTransform(): void {
    this.transform.set(`translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`);
  }

  onPointerDown(e: PointerEvent): void {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...this.pointers.values()];
    if (pts.length === 2) {
      this.pinchStart = {
        dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        scale: this.scale,
        cx: (pts[0].x + pts[1].x) / 2,
        cy: (pts[0].y + pts[1].y) / 2,
      };
      this.panStart = null;
    } else if (pts.length === 1) {
      this.panStart = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
    }
  }

  onPointerMove(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...this.pointers.values()];

    if (pts.length === 2 && this.pinchStart) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const next = Math.min(6, Math.max(1, this.pinchStart.scale * (dist / this.pinchStart.dist)));
      // Keep the pinch midpoint stationary while scaling around the viewport center.
      const cx = (pts[0].x + pts[1].x) / 2;
      const cy = (pts[0].y + pts[1].y) / 2;
      const ratio = next / this.scale;
      this.tx = cx - (cx - this.tx) * ratio;
      this.ty = cy - (cy - this.ty) * ratio;
      this.scale = next;
      if (this.scale === 1) { this.tx = 0; this.ty = 0; }
      this.applyTransform();
    } else if (pts.length === 1 && this.panStart && this.scale > 1) {
      this.tx = this.panStart.tx + (e.clientX - this.panStart.x);
      this.ty = this.panStart.ty + (e.clientY - this.panStart.y);
      this.applyTransform();
    }
  }

  onPointerUp(e: PointerEvent): void {
    const wasPinching = this.pointers.size === 2;
    const start = this.panStart;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchStart = null;
    if (this.pointers.size === 0) {
      // Tap detection: single pointer, no meaningful movement.
      const moved = start ? Math.hypot(e.clientX - start.x, e.clientY - start.y) : 99;
      this.panStart = null;
      if (!wasPinching && moved < 8) this.onTap(e);
    }
  }

  private onTap(e: PointerEvent): void {
    const now = Date.now();
    if (now - this.lastTap < 320) {
      // Double-tap: toggle 1x / 2.5x zoom around the tap point.
      if (this.scale > 1) {
        this.resetTransform();
      } else {
        const next = 2.5;
        this.tx = e.clientX - (e.clientX - this.tx) * next;
        this.ty = e.clientY - (e.clientY - this.ty) * next;
        this.scale = next;
        this.applyTransform();
      }
      this.lastTap = 0;
      return;
    }
    this.lastTap = now;
    // Single tap on the backdrop (not zoomed) closes the viewer.
    if (this.scale === 1 && (e.target as HTMLElement).classList.contains('viewer')) {
      this.closeViewer();
    }
  }
}
