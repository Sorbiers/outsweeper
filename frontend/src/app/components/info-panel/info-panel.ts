import { Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { DatePipe, KeyValuePipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatChipsModule } from '@angular/material/chips';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog } from '@angular/material/dialog';
import { PhotoInfo } from '../../models/photo.model';
import { GenerateDialog, DEFAULT_FLUX_WORKFLOW } from '../generate-dialog/generate-dialog';
import { DescribeDialog } from '../describe-dialog/describe-dialog';

/** PNG text chunk keys that are handled by the ComfyUI section */
const COMFYUI_KEYS = new Set(['prompt', 'workflow']);

@Component({
  selector: 'pp-info-panel',
  imports: [DatePipe, KeyValuePipe, MatCardModule, MatDividerModule, MatChipsModule, MatButtonModule, MatIconModule],
  templateUrl: './info-panel.html',
  styleUrl: './info-panel.scss',
})
export class InfoPanel {
  @Input() info: PhotoInfo | null = null;
  @Input() folder = 'source';
  @Output() move = new EventEmitter<'selected' | 'dust' | 'source'>();

  private dialog = inject(MatDialog);

  openDescribe(): void {
    if (!this.info) return;
    this.dialog.open(DescribeDialog, {
      data: { filename: this.info.filename, folder: this.folder },
      width: '90vw',
      maxWidth: '700px',
    }).afterClosed().subscribe(result => {
      if (result?.action === 'generate') {
        const workflow = this.info?.png_metadata?.['prompt']
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
    if (!this.info?.png_metadata?.['prompt']) return;
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
}
