import { ClipboardModule } from '@angular/cdk/clipboard';
import { DatePipe, KeyValuePipe } from '@angular/common';
import { Component, EventEmitter, Input, OnInit, Output, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatDialog } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { PhotoInfo } from '../../models/photo.model';
import { PhotoService } from '../../services/photo.service';
import { DescribeDialog } from '../describe-dialog/describe-dialog';
import { DEFAULT_FLUX_WORKFLOW, GenerateDialog } from '../generate-dialog/generate-dialog';
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
  @Input() info: PhotoInfo | null = null;
  @Input() folder = '';
  @Input() folderType = 'source';
  @Output() move = new EventEmitter<'selected' | 'dust' | 'source'>();
  @Output() metadataChanged = new EventEmitter<void>();

  private dialog = inject(MatDialog);
  private photoService = inject(PhotoService);
  private snackBar = inject(MatSnackBar);
  copyDoneIconActive = signal(false);
  exiftoolAvailable = signal(false);

  tools: string[] = [];

  ngOnInit(): void {
    this.photoService.getTools().subscribe(r => this.tools = r.tools);
    this.photoService.exiftoolCapabilities().subscribe({
      next: caps => this.exiftoolAvailable.set(caps.available),
      error: () => this.exiftoolAvailable.set(false),
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
    this.dialog.open(DescribeDialog, {
      data: { filename: this.info.filename, folder: this.folder },
      width: '90vw',
      maxWidth: '700px',
    }).afterClosed().subscribe(result => {
      if (result?.action === 'generate') {
        const workflow = this.info?.png_metadata['prompt']
          ? JSON.parse(this.info.png_metadata['prompt'])
          : JSON.parse(JSON.stringify(DEFAULT_FLUX_WORKFLOW));
        this.dialog.open(GenerateDialog, {
          data: { workflow, positivePromptOverride: result.prompt },
          width: '90vw',
          maxWidth: '800px',
        });
      }
    });
  }

  openGenerate(): void {
    if (!this.info?.png_metadata['prompt']) return;
    const workflow = JSON.parse(this.info.png_metadata['prompt']);
    this.dialog.open(GenerateDialog, {
      data: { workflow },
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
