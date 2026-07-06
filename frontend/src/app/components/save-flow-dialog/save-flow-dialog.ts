import { CdkDrag, CdkDragHandle } from '@angular/cdk/drag-drop';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatAutocompleteModule } from '@angular/material/autocomplete';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Collection } from '../../models/photo.model';
import { PhotoService } from '../../services/photo.service';

export interface SaveFlowDialogData {
  /** The { flow, dictionaries } document to write. */
  content: unknown;
  defaultName: string;
}

@Component({
  selector: 'pp-save-flow-dialog',
  imports: [CdkDrag, CdkDragHandle, FormsModule, MatDialogModule, MatButtonModule, MatIconModule,
            MatFormFieldModule, MatInputModule, MatAutocompleteModule],
  templateUrl: './save-flow-dialog.html',
  styleUrl: './save-flow-dialog.scss',
})
export class SaveFlowDialog {
  private dialogRef    = inject(MatDialogRef<SaveFlowDialog>);
  private data         = inject<SaveFlowDialogData>(MAT_DIALOG_DATA);
  private photoService = inject(PhotoService);
  private snackBar     = inject(MatSnackBar);

  collections    = signal<Collection[]>([]);
  collectionName = signal('');
  setName        = signal('');
  fileName       = signal(this.data.defaultName);
  saving = false;

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

  get canSave(): boolean {
    return !this.saving
      && this.collectionName().trim().length > 0
      && this.setName().trim().length > 0
      && this.fileName().trim().length > 0;
  }

  save(): void {
    if (!this.canSave) return;
    this.saving = true;
    const path = this.photoService.collectionPath(this.collectionName().trim(), this.setName().trim());
    this.photoService.saveFlowToCollection(path, this.fileName().trim(), this.data.content).subscribe({
      next: res => {
        this.saving = false;
        if (res.ok) {
          this.snackBar.open(`Saved ${res.filename}`, '', { duration: 2500 });
          this.dialogRef.close(true);
        } else {
          this.snackBar.open(res.error || 'Failed to save', '', { duration: 3000 });
        }
      },
      error: err => {
        this.saving = false;
        this.snackBar.open(err.error?.error || 'Failed to save', '', { duration: 3000 });
      },
    });
  }
}
