import { Component, Input, inject } from '@angular/core';
import { DatePipe, KeyValuePipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatChipsModule } from '@angular/material/chips';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatDialog } from '@angular/material/dialog';
import { PhotoInfo } from '../../models/photo.model';
import { GenerateDialog } from '../generate-dialog/generate-dialog';

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

  private dialog = inject(MatDialog);

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
