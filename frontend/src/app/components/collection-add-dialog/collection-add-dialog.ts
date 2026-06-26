import { CdkDrag, CdkDragHandle } from '@angular/cdk/drag-drop';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Collection } from '../../models/photo.model';
import { PhotoService } from '../../services/photo.service';

export interface CollectionAddDialogData {
  filenames: string[];
  sourceFolder: string;
}

@Component({
  selector: 'pp-collection-add-dialog',
  imports: [CdkDrag, CdkDragHandle, FormsModule, MatDialogModule, MatButtonModule, MatIconModule,
            MatFormFieldModule, MatInputModule, MatAutocompleteModule, MatProgressSpinnerModule],
  templateUrl: './collection-add-dialog.html',
  styleUrl: './collection-add-dialog.scss',
})
export class CollectionAddDialog {
  private dialogRef    = inject(MatDialogRef<CollectionAddDialog>);
  private data         = inject<CollectionAddDialogData>(MAT_DIALOG_DATA);
  private photoService = inject(PhotoService);

  /** Only PNGs carry an embedded ComfyUI flow. */
  pngFilenames = this.data.filenames.filter(f => f.toLowerCase().endsWith('.png'));
  skipped      = this.data.filenames.length - this.pngFilenames.length;

  collections = signal<Collection[]>([]);
  collectionName = signal('');
  setName        = signal(''/*this.defaultSetName()*/);

  phase: 'select' | 'progress' | 'done' = 'select';
  resultMessage = '';

  collectionNames = computed(() => {
    const term = this.collectionName().toLowerCase();
    return this.collections().map(c => c.name).filter(n => n.toLowerCase().includes(term));
  });

  setNames = computed(() => {
    const col = this.collections().find(c => c.name === this.collectionName());
    const term = this.setName().toLowerCase();
    return (col?.sets ?? []).map(s => s.name).filter(n => n.toLowerCase().includes(term));
  });

  constructor() {
    this.photoService.listCollections().subscribe(res => this.collections.set(res.collections));
  }

  private defaultSetName(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `set_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }

  get canApply(): boolean {
    return this.phase === 'select'
      && this.pngFilenames.length > 0
      && this.collectionName().trim().length > 0
      && this.setName().trim().length > 0;
  }

  apply(): void {
    if (!this.canApply) return;
    this.phase = 'progress';
    this.photoService.addToCollection(
      this.pngFilenames, this.data.sourceFolder,
      this.collectionName().trim(), this.setName().trim(),
    ).subscribe({
      next: res => {
        this.phase = 'done';
        this.resultMessage = `Added ${res.count} image(s)` +
          (res.errors.length ? ` (${res.errors.length} error(s))` : '') + '.';
        if (res.ok) setTimeout(() => this.dialogRef.close({ ok: true }), 1200);
      },
      error: err => {
        this.phase = 'done';
        this.resultMessage = `Error: ${err.error?.error || 'Failed to add'}`;
      },
    });
  }
}
