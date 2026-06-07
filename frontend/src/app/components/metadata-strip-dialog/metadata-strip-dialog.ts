import { Component, inject, signal } from '@angular/core';
import { CdkDrag, CdkDragHandle } from '@angular/cdk/drag-drop';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { StripGroup } from '../../models/photo.model';
import { PhotoService } from '../../services/photo.service';

export interface MetadataStripDialogData {
  filename: string;
  folder: string;
}

interface StripOption {
  id: StripGroup;
  label: string;
  hint: string;
}

const OPTIONS: StripOption[] = [
  { id: 'all',       label: 'All metadata',     hint: 'Removes EXIF, IPTC, XMP, ICC, GPS — everything writable.' },
  { id: 'sensitive', label: 'Sensitive only',   hint: 'GPS, camera/lens serials, owner name, software fingerprint.' },
  { id: 'icc',       label: 'ICC profile',      hint: 'Color profile only — image colors may shift.' },
  { id: 'exif',      label: 'EXIF data',        hint: 'Camera, lens, capture settings.' },
  { id: 'gps',       label: 'GPS coordinates',  hint: 'Location only.' },
];

@Component({
  selector: 'pp-metadata-strip-dialog',
  imports: [
    CdkDrag,
    CdkDragHandle,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatCheckboxModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './metadata-strip-dialog.html',
  styleUrl: './metadata-strip-dialog.scss',
})
export class MetadataStripDialog {
  private data = inject<MetadataStripDialogData>(MAT_DIALOG_DATA);
  private dialogRef = inject(MatDialogRef<MetadataStripDialog>);
  private photoService = inject(PhotoService);
  private snackBar = inject(MatSnackBar);

  readonly options = OPTIONS;
  filename = this.data.filename;
  selected = new Set<StripGroup>();
  acknowledged = signal(false);
  busy = signal(false);

  toggle(id: StripGroup, checked: boolean): void {
    if (checked) {
      if (id === 'all') this.selected.clear();
      else this.selected.delete('all');
      this.selected.add(id);
    } else {
      this.selected.delete(id);
    }
  }

  isChecked(id: StripGroup): boolean { return this.selected.has(id); }
  isDisabled(id: StripGroup): boolean { return id !== 'all' && this.selected.has('all'); }

  canApply(): boolean {
    return !this.busy() && this.acknowledged() && this.selected.size > 0;
  }

  apply(): void {
    const groups = [...this.selected];
    if (!groups.length || !this.acknowledged()) return;
    this.busy.set(true);
    this.photoService.stripMetadata(this.data.filename, this.data.folder, groups).subscribe({
      next: () => {
        this.busy.set(false);
        this.snackBar.open('Metadata stripped.', '', { duration: 3000 });
        this.dialogRef.close({ ok: true, refresh: true });
      },
      error: err => {
        this.busy.set(false);
        this.snackBar.open(`Strip failed: ${err.error?.error || err.message}`, '', { duration: 6000 });
      },
    });
  }
}
