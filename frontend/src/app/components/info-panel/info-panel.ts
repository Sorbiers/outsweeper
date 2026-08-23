import { ClipboardModule } from '@angular/cdk/clipboard';
import { DatePipe, KeyValuePipe } from '@angular/common';
import { Component, EventEmitter, Input, OnInit, Output, inject, signal, computed } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { BgRemoveCapabilities, PhotoInfo, UpscaleCapabilities } from '../../models/photo.model';
import { ComfyConnectionService } from '../../services/comfy-connection.service';
import { PhotoService, SidecarFile, SidecarResponse } from '../../services/photo.service';
import { RemoveBgDialog, RemoveBgDialogData } from '../remove-bg-dialog/remove-bg-dialog';
import { UpscaleDialog, UpscaleDialogData, UpscaleMethod } from '../upscale-dialog/upscale-dialog';
import { CollectionAddDialog, CollectionAddDialogData } from '../collection-add-dialog/collection-add-dialog';
import { DescribeDialog } from '../describe-dialog/describe-dialog';
import { DEFAULT_FLUX_WORKFLOW, GenerateDialog, GenerateDialogData } from '../generate-dialog/generate-dialog';
import { OutpaintDialog, OutpaintDialogData } from '../outpaint-dialog/outpaint-dialog';
import type { InpaintDialogData } from '../inpaint-dialog/inpaint-dialog';
import type { KontextDialogData } from '../kontext-dialog/kontext-dialog';
import { MetadataEditDialog } from '../metadata-edit-dialog/metadata-edit-dialog';
import { MetadataStripDialog } from '../metadata-strip-dialog/metadata-strip-dialog';
import { MetadataViewDialog } from '../metadata-view-dialog/metadata-view-dialog';

/** PNG text chunk keys that are handled by the ComfyUI section */
const COMFYUI_KEYS = new Set(['prompt', 'workflow']);

@Component({
  selector: 'pp-info-panel',
  imports: [DatePipe, KeyValuePipe, MatCardModule, MatDividerModule, MatChipsModule, MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule, ClipboardModule, MatChipsModule],
  templateUrl: './info-panel.html',
  styleUrl: './info-panel.scss',
})
export class InfoPanel implements OnInit {
  @Input() set info(value: PhotoInfo | null) {
    this._info = value;
    this.loadSidecars();
  }
  get info(): PhotoInfo | null { return this._info; }
  private _info: PhotoInfo | null = null;
  @Input() folder = '';
  @Input() folderType = 'source';
  @Input() favorites: ReadonlySet<string> = new Set();
  @Output() move = new EventEmitter<'selected' | 'dust' | 'source'>();
  @Output() metadataChanged = new EventEmitter<void>();

  private dialog = inject(MatDialog);
  private photoService = inject(PhotoService);
  comfy = inject(ComfyConnectionService);
  private snackBar = inject(MatSnackBar);
  copyDoneIconActive = signal(false);
  exiftoolAvailable = signal(false);
  upscaleCaps = signal<UpscaleCapabilities | null>(null);
  bgRemoveCaps = signal<BgRemoveCapabilities | null>(null);

  /** Long enough that it never fires while skimming the menu. */
  readonly TOOLTIP_DELAY = 600;

  tools: string[] = [];

  /** Same-stem .txt / .json beside the image, for caption/tag datasets. */
  sidecars = signal<SidecarResponse | null>(null);
  /** Long captions are collapsed by default so they can't push the panel around. */
  sidecarExpanded = signal<Record<string, boolean>>({});

  /** Present sidecars as a typed list; the template can't index by a plain string. */
  readonly sidecarList = computed(() => {
    const s = this.sidecars();
    if (!s) return [];
    return ([['txt', s.txt], ['json', s.json]] as const)
      .filter((pair): pair is readonly ['txt' | 'json', SidecarFile] => !!pair[1])
      .map(([kind, file]) => ({ kind, file }));
  });

  private loadSidecars(): void {
    this.sidecars.set(null);
    this.sidecarExpanded.set({});
    const f = this._info?.filename;
    if (!f) return;
    this.photoService.getSidecars(f, this.folder).subscribe({
      next: r => this.sidecars.set(r.txt || r.json ? r : null),
      error: () => this.sidecars.set(null),
    });
  }

  toggleSidecar(kind: string): void {
    this.sidecarExpanded.update(m => ({ ...m, [kind]: !m[kind] }));
  }

  openIn(editor: 'paint' | 'photo_editor'): void {
    if (!this._info) return;
    this.photoService.openWith(editor, this._info.filename, this.folder).subscribe({
      error: err => this.snackBar.open(
        `Error: ${err.error?.error || err.message || 'could not open'}`, '', { duration: 5000 }),
    });
  }

  ngOnInit(): void {
    this.photoService.getTools().subscribe(r => this.tools = r.tools);
    this.photoService.exiftoolCapabilities().subscribe({
      next: caps => this.exiftoolAvailable.set(caps.available),
      error: () => this.exiftoolAvailable.set(false),
    });
    this.photoService.upscaleCapabilities().subscribe({
      next: caps => this.upscaleCaps.set(caps),
      error: () => this.upscaleCaps.set(null),
    });
    this.photoService.bgRemoveCapabilities().subscribe({
      next: caps => this.bgRemoveCaps.set(caps),
      error: () => this.bgRemoveCaps.set(null),
    });
  }

  /** Hint shown when neither background-removal engine is ready (disables the item). */
  get bgRemoveUnavailable(): string {
    const c = this.bgRemoveCaps();
    if (!c) return '';
    if (!c.rembg && !c.birefnet) return 'Install rembg or transformers+torch';
    return '';
  }

  openRemoveBg(): void {
    if (!this.info) return;
    this.dialog.open(RemoveBgDialog, {
      data: { filename: this.info.filename, folder: this.folder } satisfies RemoveBgDialogData,
      width: '90vw',
      maxWidth: '480px',
    });
  }

  /** Hint shown when the local spandrel upscaler isn't ready (disables the item). */
  get spandrelUnavailable(): string {
    const c = this.upscaleCaps();
    if (!c) return '';
    if (!c.spandrel) return 'Install torch + spandrel to enable';
    if (!c.models.length) return 'Set upscale_models_dir with model files';
    return '';
  }

  openUpscale(method: UpscaleMethod): void {
    if (!this.info) return;
    this.dialog.open(UpscaleDialog, {
      data: { filename: this.info.filename, folder: this.folder, method } satisfies UpscaleDialogData,
      width: '90vw',
      maxWidth: '560px',
    });
  }

  openMetadataView(): void {
    if (!this.info) return;
    this.dialog.open(MetadataViewDialog, {
      data: { filename: this.info.filename, folder: this.folder },
      width: '90vw',
      maxWidth: '820px',
    });
  }

  openMetadataEdit(): void {
    if (!this.info) return;
    this.dialog.open(MetadataEditDialog, {
      data: { mode: 'single', filename: this.info.filename, folder: this.folder },
      width: '90vw',
      maxWidth: '720px',
    }).afterClosed().subscribe(result => {
      if (result?.refresh) this.metadataChanged.emit();
    });
  }

  openMetadataStrip(): void {
    if (!this.info) return;
    this.dialog.open(MetadataStripDialog, {
      data: { filename: this.info.filename, folder: this.folder },
      width: '90vw',
      maxWidth: '640px',
    }).afterClosed().subscribe(result => {
      if (result?.refresh) this.metadataChanged.emit();
    });
  }

  runTool(name: string): void {
    if (!this.info) return;
    this.photoService.runTool(name, this.info.filename, this.folder).subscribe({
      next: res => {
        if (res.ok) {
          this.snackBar.open(`${name}: done`, '', { duration: 3000 });
        } else {
          this.snackBar.open(`${name} failed: ${res.stderr || res.error || 'error'}`, '', { duration: 5000 });
        }
      },
      error: err => this.snackBar.open(`${name}: ${err.error?.error || 'failed'}`, '', { duration: 5000 }),
    });
  }

  download(): void {
    if (!this.info) return;
    this.photoService.downloadFile(this.info.filename, this.folder);
  }

  locate(): void {
    if (!this.info) return;
    this.photoService.locate(this.info.filename, this.folder).subscribe({
      error: () => this.snackBar.open('Could not open Explorer', '', { duration: 3000 }),
    });
  }

  openDescribe(): void {
    if (!this.info) return;
    const hasImageWorkflow = !!this.info.png_metadata?.['prompt'];
    this.dialog.open(DescribeDialog, {
      data: { filename: this.info.filename, folder: this.folder, hasImageWorkflow },
      width: '90vw',
      maxWidth: '700px',
    }).afterClosed().subscribe(result => {
      if (!result?.prompt) return;
      if (result.action === 'generate') {
        this.dialog.open(GenerateDialog, {
          data: { workflow: JSON.parse(JSON.stringify(DEFAULT_FLUX_WORKFLOW)), positivePromptOverride: result.prompt },
          width: '90vw',
          maxWidth: '1500px',
        });
      } else if (result.action === 'regenerate') {
        const workflow = JSON.parse(this.info!.png_metadata['prompt']);
        this.dialog.open(GenerateDialog, {
          data: { workflow, positivePromptOverride: result.prompt, title: 'Re-generate' },
          width: '90vw',
          maxWidth: '1500px',
        });
      }
    });
  }

  openGenerate(): void {
    if (!this.info?.png_metadata['prompt']) return;
    const workflow = JSON.parse(this.info.png_metadata['prompt']);
    this.dialog.open(GenerateDialog, {
      data: { workflow, title: 'Re-generate' },
      width: '90vw',
      maxWidth: '1500px',
    });
  }

  extractWorkflow(): void {
    if (!this.info?.png_metadata['prompt']) return;
    const workflow = JSON.parse(this.info.png_metadata['prompt']);
    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.info.filename.replace(/\.[^.]+$/, '') + '_workflow.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  openGenerateFrom(): void {
    if (!this.info) return;
    const raw = this.info.png_metadata?.['prompt'];
    const workflow = raw ? JSON.parse(raw) : JSON.parse(JSON.stringify(DEFAULT_FLUX_WORKFLOW));
    this.dialog.open(GenerateDialog, {
      data: {
        workflow,
        title: `Generate from · ${this.info.filename}`,
        sourceImage: {
          filename: this.info.filename,
          folder: this.folder,
          width: this.info.width ?? null,
          height: this.info.height ?? null,
        },
      } satisfies GenerateDialogData,
      width: '90vw',
      maxWidth: '1500px',
    });
  }

  addToCollection(): void {
    if (!this.info) return;
    this.dialog.open(CollectionAddDialog, {
      data: {
        sourceFolder: this.folder,
        currentFilename: this.info.filename,
        favoriteFilenames: [...this.favorites],
        fromFavorites: false,
      } satisfies CollectionAddDialogData,
      width: '90vw',
      maxWidth: '480px',
    });
  }

  /** Filename whose ComfyUI fetch failed. Scoped to the file rather than a class
   *  on the element, so it clears when you move to another image instead of
   *  sticking for the rest of the session. */
  sourceImageError: string | null = null;

  /** Filename whose working-folder thumbnail 404'd, so the next attempt asks ComfyUI. */
  private sourceImageFellBack: string | null = null;

  /**
   * The source image, preferring the copy already in the working folder.
   *
   * It is normally sitting right there — a render's source is usually a previous
   * render — so this needs no ComfyUI at all and reuses the thumbnail cache. The
   * fallback covers what isn't: an inpaint mask lives in `__masks/`, and an
   * upload can come from outside the folder entirely.
   *
   * The fallback goes through the backend rather than pointing an <img> at
   * ComfyUI, because that is cross-site whenever the two are reached by different
   * host strings (`localhost` vs `127.0.0.1`) and ComfyUI answers 403.
   */
  sourceImageUrl(filename: string): string {
    if (this.sourceImageFellBack === filename) {
      const url = this.comfy.effectiveUrl;
      const q = url ? `&comfy_url=${encodeURIComponent(url)}` : '';
      return `/api/comfy/view?type=input&filename=${encodeURIComponent(filename)}${q}`;
    }
    return this.photoService.getThumbnailUrl(filename, this.folder);
  }

  onSourceImageError(filename: string): void {
    if (this.sourceImageFellBack !== filename) {
      this.sourceImageFellBack = filename;   // retry via ComfyUI
      return;
    }
    this.sourceImageError = filename;
  }

  onSourceImageLoad(): void {
    this.sourceImageError = null;
  }

  /** Loaded on demand, like the other generation dialogs. */
  async openKontext(): Promise<void> {
    if (!this.info) return;
    const { KontextDialog } = await import('../kontext-dialog/kontext-dialog');
    this.dialog.open(KontextDialog, {
      data: {
        filename: this.info.filename,
        folder: this.folder,
      } satisfies KontextDialogData,
      width: '94vw',
      maxWidth: '1100px',
      maxHeight: '92vh',
    });
  }

  /** Loaded on demand: the mask editor is bulky and most sessions never open it. */
  async openInpaint(): Promise<void> {
    if (!this.info) return;
    const { InpaintDialog } = await import('../inpaint-dialog/inpaint-dialog');
    this.dialog.open(InpaintDialog, {
      data: {
        filename: this.info.filename,
        folder: this.folder,
      } satisfies InpaintDialogData,
      width: '94vw',
      maxWidth: '1100px',
      maxHeight: '92vh',
    });
  }

  openOutpaint(): void {
    if (!this.info) return;
    this.dialog.open(OutpaintDialog, {
      data: {
        filename: this.info.filename,
        folder: this.folder,
      } satisfies OutpaintDialogData,
      width: '90vw',
      maxWidth: '800px',
    });
  }

  /** PNG text chunks that are NOT ComfyUI-related */
  get pngMeta(): Record<string, string> | null {
    const raw = this.info?.png_metadata;
    if (!raw) return null;
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!COMFYUI_KEYS.has(k)) {
        filtered[k] = v;
      }
    }
    return Object.keys(filtered).length ? filtered : null;
  }

  isLongValue(value: string): boolean {
    return value.length > 120;
  }

  onCopySuccess(): void {
    this.copyDoneIconActive.set(true);
    setTimeout(() => this.copyDoneIconActive.set(false), 2000);
  }

  getTags(): string[] {
    if (this.info?.tags) {
      return this.info.tags.split(',').map(e => `#${e.trim()}`);
    }
    return []
  }
}
