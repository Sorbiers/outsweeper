import { CdkDrag, CdkDragHandle } from '@angular/cdk/drag-drop';
import { afterNextRender, Component, computed, effect, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatTree, MatTreeModule } from '@angular/material/tree';
import { Collection, PhotoInfo, PhotoListItem } from '../../models/photo.model';
import { PhotoService } from '../../services/photo.service';
import { STORAGE_KEYS } from '../../constants';
import { DEFAULT_FLUX_WORKFLOW, GenerateDialog } from '../generate-dialog/generate-dialog';
import { DescribeDialog } from '../describe-dialog/describe-dialog';

interface TreeNode {
  kind: 'collection' | 'set';
  name: string;
  collection: string;
  count: number;
  children?: TreeNode[];
}

@Component({
  selector: 'pp-collection-dialog',
  imports: [CdkDrag, CdkDragHandle, FormsModule, MatDialogModule, MatButtonModule, MatIconModule,
            MatChipsModule, MatTreeModule, MatProgressSpinnerModule, MatTooltipModule,
            MatFormFieldModule, MatInputModule, MatMenuModule],
  templateUrl: './collection-dialog.html',
  styleUrl: './collection-dialog.scss',
})
export class CollectionDialog {
  private photoService = inject(PhotoService);
  private dialog       = inject(MatDialog);
  private snackBar     = inject(MatSnackBar);

  private tree    = viewChild(MatTree);
  private content = viewChild('content', { read: ElementRef });

  collections = signal<Collection[]>([]);
  loading     = signal(true);

  // Resizable layout: column widths (px) and the preview's image/prompt split height (px).
  treeWidth        = signal(240);
  previewWidth     = signal(320);
  previewTopHeight = signal(240);

  private resizeKind: 'tree' | 'preview' | 'split' | null = null;
  private boundResize    = (e: MouseEvent) => this.onResize(e);
  private boundResizeEnd = () => this.onResizeEnd();

  treeData = computed<TreeNode[]>(() =>
    this.collections().map(c => ({
      kind: 'collection' as const,
      name: c.name,
      collection: c.name,
      count: c.sets.length,
      children: c.sets.map(s => ({
        kind: 'set' as const, name: s.name, collection: c.name, count: s.count,
      })),
    })),
  );

  childrenAccessor = (node: TreeNode) => node.children ?? [];
  hasChild = (_: number, node: TreeNode) => node.kind === 'collection';

  selectedCollection = signal('');
  selectedSet        = signal('');

  // Move-to-another-set: shared menu source + drag-and-drop state.
  moveSource    = signal<PhotoListItem | null>(null);
  dragging      = signal(false);
  dropTargetKey = signal<string | null>(null);
  private draggedPhoto: PhotoListItem | null = null;

  /** Every (collection, set) except the one currently shown — menu move targets. */
  moveTargets = computed(() => {
    const out: { key: string; collection: string; set: string }[] = [];
    for (const c of this.collections()) {
      for (const s of c.sets) {
        if (c.name === this.selectedCollection() && s.name === this.selectedSet()) continue;
        out.push({ key: `${c.name}/${s.name}`, collection: c.name, set: s.name });
      }
    }
    return out;
  });

  photos        = signal<PhotoListItem[]>([]);
  photosLoading = signal(false);
  selectedPhoto = signal<PhotoListItem | null>(null);
  selectedInfo  = signal<PhotoInfo | null>(null);
  infoLoading   = signal(false);

  /** PNG text-chunk key holding the alternative prompt template. */
  private static readonly ALT_KEY = 'alt_prompt';

  /** Alternative prompt stored on the selected image (empty when none). */
  altPrompt = computed(() => this.selectedInfo()?.png_metadata?.[CollectionDialog.ALT_KEY]?.trim() || '');

  editingAlt = signal(false);
  savingAlt  = signal(false);
  altDraft   = '';

  constructor() {
    this.reloadCollections();
    // Keep the tree expanded so sets are visible without an extra click.
    effect(() => {
      this.treeData();
      queueMicrotask(() => this.tree()?.expandAll());
    });
    // Restore the session's saved layout, else seed widths at the 20% minimum.
    afterNextRender(() => {
      const saved = this.loadLayout();
      if (saved) {
        this.treeWidth.set(saved.treeWidth);
        this.previewWidth.set(saved.previewWidth);
        this.previewTopHeight.set(saved.previewTopHeight);
      } else {
        const w = this.contentWidth();
        if (w) {
          this.treeWidth.set(w * 0.2);
          this.previewWidth.set(w * 0.2);
        }
      }
    });
  }

  private loadLayout(): { treeWidth: number; previewWidth: number; previewTopHeight: number } | null {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEYS.COLLECTION_LAYOUT);
      const v = raw ? JSON.parse(raw) : null;
      return v && typeof v.treeWidth === 'number' ? v : null;
    } catch {
      return null;
    }
  }

  private saveLayout(): void {
    sessionStorage.setItem(STORAGE_KEYS.COLLECTION_LAYOUT, JSON.stringify({
      treeWidth: this.treeWidth(),
      previewWidth: this.previewWidth(),
      previewTopHeight: this.previewTopHeight(),
    }));
  }

  private contentWidth(): number {
    // offsetWidth ignores the dialog's open-animation transform (scale), unlike
    // getBoundingClientRect, so the 20% seed is computed against the real width.
    return this.content()?.nativeElement.offsetWidth ?? 0;
  }

  reloadCollections(): void {
    this.loading.set(true);
    this.photoService.listCollections().subscribe({
      next: res => {
        this.collections.set(res.collections);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  private get folderPath(): string {
    return this.photoService.collectionPath(this.selectedCollection(), this.selectedSet());
  }

  isSetSelected(node: TreeNode): boolean {
    return node.collection === this.selectedCollection() && node.name === this.selectedSet();
  }

  selectSetNode(node: TreeNode): void {
    this.selectedCollection.set(node.collection);
    this.selectedSet.set(node.name);
    this.selectedPhoto.set(null);
    this.selectedInfo.set(null);
    this.loadPhotos();
  }

  private loadPhotos(): void {
    this.photosLoading.set(true);
    this.photoService.listPhotos(this.folderPath, { limit: 1000 }).subscribe({
      next: res => {
        this.photos.set(res.photos);
        this.photosLoading.set(false);
      },
      error: () => this.photosLoading.set(false),
    });
  }

  thumbUrl(photo: PhotoListItem): string {
    return this.photoService.getThumbnailUrl(photo.filename, this.folderPath, photo.modified_token);
  }

  imageUrl(photo: PhotoListItem): string {
    return this.photoService.getImageUrl(photo.filename, this.folderPath, photo.modified_token);
  }

  selectPhoto(photo: PhotoListItem): void {
    this.selectedPhoto.set(photo);
    this.selectedInfo.set(null);
    this.editingAlt.set(false);
    this.infoLoading.set(true);
    this.photoService.getInfo(photo.filename, this.folderPath).subscribe({
      next: info => {
        this.selectedInfo.set(info);
        this.infoLoading.set(false);
      },
      error: () => this.infoLoading.set(false),
    });
  }

  regenerate(photo: PhotoListItem): void {
    const cached = this.selectedInfo();
    if (this.selectedPhoto()?.filename === photo.filename && cached) {
      this.openGenerate(photo, cached);
      return;
    }
    this.photoService.getInfo(photo.filename, this.folderPath).subscribe({
      next: info => this.openGenerate(photo, info),
      error: () => this.snackBar.open('Failed to read image metadata', '', { duration: 3000 }),
    });
  }

  private openGenerate(photo: PhotoListItem, info: PhotoInfo, promptOverride?: string): void {
    const raw = info.png_metadata?.['prompt'];
    if (!raw) {
      this.snackBar.open('No embedded ComfyUI flow in this image', '', { duration: 3000 });
      return;
    }
    let workflow: Record<string, any>;
    try {
      workflow = JSON.parse(raw);
    } catch {
      this.snackBar.open('Embedded flow is not valid JSON', '', { duration: 3000 });
      return;
    }
    this.dialog.open(GenerateDialog, {
      data: { workflow, title: `Re-generate · ${photo.filename}`, positivePromptOverride: promptOverride },
      width: '90vw',
      maxWidth: '1500px',
    });
  }

  /** Parse the image's embedded flow, or fall back to the default Flux flow. */
  private workflowOrDefault(info: PhotoInfo | null): Record<string, any> {
    const raw = info?.png_metadata?.['prompt'];
    try {
      return raw ? JSON.parse(raw) : JSON.parse(JSON.stringify(DEFAULT_FLUX_WORKFLOW));
    } catch {
      return JSON.parse(JSON.stringify(DEFAULT_FLUX_WORKFLOW));
    }
  }

  /** Generate using a specific positive prompt (original or alternative template). */
  generateWith(prompt: string): void {
    const photo = this.selectedPhoto();
    if (!photo) return;
    this.dialog.open(GenerateDialog, {
      data: {
        workflow: this.workflowOrDefault(this.selectedInfo()),
        title: `Generate · ${photo.filename}`,
        positivePromptOverride: prompt || undefined,
      },
      width: '90vw',
      maxWidth: '1500px',
    });
  }

  /** Describe the image (LM Studio) then optionally generate from the result. */
  openDescribe(): void {
    const photo = this.selectedPhoto();
    if (!photo) return;
    const info = this.selectedInfo();
    this.dialog.open(DescribeDialog, {
      data: { filename: photo.filename, folder: this.folderPath, hasImageWorkflow: !!info?.png_metadata?.['prompt'] },
      width: '90vw',
      maxWidth: '700px',
    }).afterClosed().subscribe(result => {
      if (result?.prompt) this.generateWith(result.prompt);
    });
  }

  /** Open the Generate dialog in img2img "source image" mode for this image. */
  openGenerateFrom(): void {
    const photo = this.selectedPhoto();
    if (!photo) return;
    const info = this.selectedInfo();
    this.dialog.open(GenerateDialog, {
      data: {
        workflow: this.workflowOrDefault(info),
        title: `Generate from · ${photo.filename}`,
        sourceImage: {
          filename: photo.filename,
          folder: this.folderPath,
          width: info?.width ?? null,
          height: info?.height ?? null,
        },
      },
      width: '90vw',
      maxWidth: '1500px',
    });
  }

  startEditAlt(): void {
    // Seed a new template from the existing alternative or the original prompt.
    this.altDraft = this.altPrompt() || this.selectedInfo()?.comfyui?.prompt || '';
    this.editingAlt.set(true);
  }

  cancelEditAlt(): void {
    this.editingAlt.set(false);
  }

  saveAlt(): void {
    const photo = this.selectedPhoto();
    if (!photo) return;
    this.savingAlt.set(true);
    this.photoService.writeMeta(photo.filename, this.folderPath, this.altDraft.trim(), CollectionDialog.ALT_KEY)
      .subscribe({
        next: () => { this.savingAlt.set(false); this.editingAlt.set(false); this.refreshSelectedInfo(); },
        error: () => { this.savingAlt.set(false); this.snackBar.open('Failed to save prompt template', '', { duration: 3000 }); },
      });
  }

  deleteAlt(): void {
    const photo = this.selectedPhoto();
    if (!photo) return;
    this.photoService.writeMeta(photo.filename, this.folderPath, '', CollectionDialog.ALT_KEY).subscribe({
      next: () => this.refreshSelectedInfo(),
      error: () => this.snackBar.open('Failed to remove prompt template', '', { duration: 3000 }),
    });
  }

  private refreshSelectedInfo(): void {
    const photo = this.selectedPhoto();
    if (!photo) return;
    this.photoService.getInfo(photo.filename, this.folderPath).subscribe({
      next: info => this.selectedInfo.set(info),
    });
  }

  deletePhoto(photo: PhotoListItem): void {
    const col = this.selectedCollection();
    const set = this.selectedSet();
    this.photoService.deleteFromCollection(`${col}/${set}/${photo.filename}`).subscribe({
      next: () => {
        this.photos.update(list => list.filter(p => p.filename !== photo.filename));
        if (this.selectedPhoto()?.filename === photo.filename) {
          this.selectedPhoto.set(null);
          this.selectedInfo.set(null);
        }
        this.reloadCollections();
      },
      error: err => this.snackBar.open(err.error?.error || 'Failed to delete', '', { duration: 3000 }),
    });
  }

  loraName(name: string): string {
    return name.replace(/\.[^.]+$/, '').replace(/^.*[\\/]/, '');
  }

  // --- Move to another collection/set ---

  private nodeKey(node: TreeNode): string {
    return `${node.collection}/${node.name}`;
  }

  private isSourceSet(node: TreeNode): boolean {
    return node.kind === 'set'
      && node.collection === this.selectedCollection()
      && node.name === this.selectedSet();
  }

  /** A set node (not the source) is a valid drop target while dragging a photo. */
  canDrop(node: TreeNode): boolean {
    return node.kind === 'set' && !!this.draggedPhoto && !this.isSourceSet(node);
  }

  onDragStart(photo: PhotoListItem, e: DragEvent): void {
    this.draggedPhoto = photo;
    this.dragging.set(true);
    e.dataTransfer?.setData('text/plain', photo.filename);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  onDragEnd(): void {
    this.draggedPhoto = null;
    this.dragging.set(false);
    this.dropTargetKey.set(null);
  }

  onNodeDragOver(node: TreeNode, e: DragEvent): void {
    if (!this.canDrop(node)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    this.dropTargetKey.set(this.nodeKey(node));
  }

  onNodeDragLeave(node: TreeNode): void {
    if (this.dropTargetKey() === this.nodeKey(node)) this.dropTargetKey.set(null);
  }

  onNodeDrop(node: TreeNode, e: DragEvent): void {
    e.preventDefault();
    const photo = this.draggedPhoto;
    const valid = this.canDrop(node);
    this.onDragEnd();
    if (photo && valid) this.movePhotoToSet(photo, node.collection, node.name);
  }

  movePhotoToSet(photo: PhotoListItem | null, toCollection: string, toSet: string): void {
    if (!photo) return;
    const fromCol = this.selectedCollection();
    const fromSet = this.selectedSet();
    if (toCollection === fromCol && toSet === fromSet) return;
    this.photoService.moveBetweenCollections(photo.filename, fromCol, fromSet, toCollection, toSet).subscribe({
      next: res => {
        if (res.count > 0) {
          this.photos.update(list => list.filter(p => p.filename !== photo.filename));
          if (this.selectedPhoto()?.filename === photo.filename) {
            this.selectedPhoto.set(null);
            this.selectedInfo.set(null);
          }
          this.reloadCollections();
          this.snackBar.open(`Moved to ${toCollection} / ${toSet}`, '', { duration: 2500 });
        } else {
          this.snackBar.open(res.errors?.[0] || 'Move failed', '', { duration: 3000 });
        }
      },
      error: err => this.snackBar.open(err.error?.error || 'Move failed', '', { duration: 3000 }),
    });
  }

  startResize(e: MouseEvent, kind: 'tree' | 'preview' | 'split'): void {
    e.preventDefault();
    this.resizeKind = kind;
    document.addEventListener('mousemove', this.boundResize);
    document.addEventListener('mouseup', this.boundResizeEnd);
  }

  private onResize(e: MouseEvent): void {
    const rect = this.content()?.nativeElement.getBoundingClientRect();
    if (!rect) return;

    const minW = rect.width * 0.2; // each section keeps >= 20% of the visible width
    if (this.resizeKind === 'tree') {
      const max = rect.width - this.previewWidth() - minW; // leave 20% for the grid
      this.treeWidth.set(Math.min(max, Math.max(minW, e.clientX - rect.left)));
    } else if (this.resizeKind === 'preview') {
      const max = rect.width - this.treeWidth() - minW; // leave 20% for the grid
      this.previewWidth.set(Math.min(max, Math.max(minW, rect.right - e.clientX)));
    } else if (this.resizeKind === 'split') {
      this.previewTopHeight.set(Math.min(rect.height - 120, Math.max(120, e.clientY - rect.top)));
    }
  }

  private onResizeEnd(): void {
    this.resizeKind = null;
    document.removeEventListener('mousemove', this.boundResize);
    document.removeEventListener('mouseup', this.boundResizeEnd);
    this.saveLayout();
  }
}
