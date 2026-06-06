import { Component, computed, inject, signal } from '@angular/core';
import { CdkDrag, CdkDragHandle } from '@angular/cdk/drag-drop';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { ExiftoolMetadata } from '../../models/photo.model';
import { PhotoService } from '../../services/photo.service';

export interface MetadataViewDialogData {
  filename: string;
  folder: string;
}

interface Group {
  name: string;
  rows: { key: string; value: string }[];
}

@Component({
  selector: 'pp-metadata-view-dialog',
  imports: [
    CdkDrag,
    CdkDragHandle,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatExpansionModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './metadata-view-dialog.html',
  styleUrl: './metadata-view-dialog.scss',
})
export class MetadataViewDialog {
  private data = inject<MetadataViewDialogData>(MAT_DIALOG_DATA);
  private photoService = inject(PhotoService);

  filename = this.data.filename;
  loading = signal(true);
  error = signal<string | null>(null);
  raw = signal<ExiftoolMetadata>({});

  groups = computed<Group[]>(() => {
    const meta = this.raw();
    const map = new Map<string, { key: string; value: string }[]>();
    for (const [k, v] of Object.entries(meta)) {
      const idx = k.indexOf(':');
      const group = idx > 0 ? k.slice(0, idx) : 'Other';
      const tag = idx > 0 ? k.slice(idx + 1) : k;
      if (!map.has(group)) map.set(group, []);
      map.get(group)!.push({ key: tag, value: String(v) });
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, rows]) => ({ name, rows: rows.sort((a, b) => a.key.localeCompare(b.key)) }));
  });

  constructor() {
    this.photoService.getExiftoolMetadata(this.data.filename, this.data.folder).subscribe({
      next: meta => { this.raw.set(meta); this.loading.set(false); },
      error: err => {
        this.error.set(err.error?.error || err.message || 'failed to read metadata');
        this.loading.set(false);
      },
    });
  }
}
