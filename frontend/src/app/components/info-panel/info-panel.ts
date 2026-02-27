import { Component, Input } from '@angular/core';
import { DatePipe, KeyValuePipe } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatDividerModule } from '@angular/material/divider';
import { MatChipsModule } from '@angular/material/chips';
import { PhotoInfo } from '../../models/photo.model';

/** PNG text chunk keys that are handled by the ComfyUI section */
const COMFYUI_KEYS = new Set(['prompt', 'workflow']);

@Component({
  selector: 'pp-info-panel',
  imports: [DatePipe, KeyValuePipe, MatCardModule, MatDividerModule, MatChipsModule],
  templateUrl: './info-panel.html',
  styleUrl: './info-panel.scss',
})
export class InfoPanel {
  @Input() info: PhotoInfo | null = null;

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
