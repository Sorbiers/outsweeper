import { Component, inject, signal } from '@angular/core';
import { CdkDrag, CdkDragHandle } from '@angular/cdk/drag-drop';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { EditableFields } from '../../models/photo.model';
import { PhotoService } from '../../services/photo.service';

export type MetadataEditDialogData =
  | { mode: 'single'; filename: string; folder: string }
  | { mode: 'batch'; filenames: string[]; folder: string };

/** Strict printable-ASCII test (codepoints 0x20–0x7E). */
function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7E) return false;
  }
  return true;
}

@Component({
  selector: 'pp-metadata-edit-dialog',
  imports: [
    CdkDrag,
    CdkDragHandle,
    FormsModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './metadata-edit-dialog.html',
  styleUrl: './metadata-edit-dialog.scss',
})
export class MetadataEditDialog {
  private data = inject<MetadataEditDialogData>(MAT_DIALOG_DATA);
  private dialogRef = inject(MatDialogRef<MetadataEditDialog>);
  private photoService = inject(PhotoService);
  private snackBar = inject(MatSnackBar);

  isBatch = this.data.mode === 'batch';
  title: string;

  loading = signal(this.data.mode === 'single');
  busy = signal(false);
  error = signal<string | null>(null);

  image_title = '';
  artist = '';
  description = '';
  document_name = '';
  copyright = '';
  user_comment = '';

  private get fieldValues(): Record<keyof EditableFields, string> {
    return {
      image_title: this.image_title,
      artist: this.artist,
      description: this.description,
      document_name: this.document_name,
      copyright: this.copyright,
      user_comment: this.user_comment,
    };
  }

  constructor() {
    if (this.data.mode === 'batch') {
      this.title = `Add metadata — ${this.data.filenames.length} file(s)`;
    } else {
      this.title = `Edit metadata — ${this.data.filename}`;
      this.photoService.getExiftoolMetadata(this.data.filename, this.data.folder).subscribe({
        next: meta => {
          const pick = (...keys: string[]): string => {
            for (const k of keys) {
              const v = meta[k];
              if (v != null && v !== '') return String(v);
            }
            return '';
          };
          this.image_title   = pick('ExifIFD:ImageTitle', 'EXIF:ImageTitle');
          this.artist        = pick('IFD0:Artist', 'EXIF:Artist');
          this.description   = pick('IFD0:ImageDescription', 'EXIF:ImageDescription');
          this.document_name = pick('IFD0:DocumentName', 'EXIF:DocumentName');
          this.copyright     = pick('IFD0:Copyright', 'EXIF:Copyright');
          this.user_comment  = pick('ExifIFD:UserComment', 'EXIF:UserComment');
          this.loading.set(false);
        },
        error: err => {
          this.error.set(err.error?.error || err.message || 'failed to read metadata');
          this.loading.set(false);
        },
      });
    }
  }

  invalid(field: string): boolean {
    const v = this.fieldValues[field as keyof EditableFields] ?? '';
    return !!v && !isAscii(v);
  }

  hasAnyInvalid(): boolean {
    return Object.values(this.fieldValues).some(v => !!v && !isAscii(v));
  }

  hasAnyValue(): boolean {
    return Object.values(this.fieldValues).some(v => v.trim() !== '');
  }

  canApply(): boolean {
    if (this.busy() || this.loading()) return false;
    if (this.hasAnyInvalid()) return false;
    return this.hasAnyValue();
  }

  private collectFields(): EditableFields {
    const result: EditableFields = {};
    for (const [key, val] of Object.entries(this.fieldValues) as [keyof EditableFields, string][]) {
      if (val.trim()) result[key] = val;
    }
    return result;
  }

  apply(): void {
    const fields = this.collectFields();
    if (!Object.keys(fields).length) return;
    this.busy.set(true);

    if (this.data.mode === 'single') {
      const { filename, folder } = this.data;
      this.photoService.editMetadata(filename, folder, fields).subscribe({
        next: () => {
          this.busy.set(false);
          this.snackBar.open('Metadata saved.', '', { duration: 3000 });
          this.dialogRef.close({ ok: true, refresh: true });
        },
        error: err => {
          this.busy.set(false);
          this.snackBar.open(`Save failed: ${err.error?.error || err.message}`, '', { duration: 6000 });
        },
      });
    } else {
      const { filenames, folder } = this.data;
      this.photoService.editMetadataBatch(filenames, folder, fields).subscribe({
        next: res => {
          this.busy.set(false);
          if (res.errors.length) {
            this.snackBar.open(
              `Updated ${res.count}, ${res.errors.length} error(s). First: ${res.errors[0].error}`,
              '', { duration: 6000 },
            );
          } else {
            this.snackBar.open(`Updated ${res.count} file(s).`, '', { duration: 3000 });
          }
          this.dialogRef.close({ ok: res.ok, refresh: res.count > 0 });
        },
        error: err => {
          this.busy.set(false);
          this.snackBar.open(`Save failed: ${err.error?.error || err.message}`, '', { duration: 6000 });
        },
      });
    }
  }
}
