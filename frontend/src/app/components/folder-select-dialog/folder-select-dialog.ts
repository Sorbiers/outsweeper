import { Component, inject, OnInit } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDividerModule } from '@angular/material/divider';
import { PhotoService } from '../../services/photo.service';

export type FolderSelectResult = { kind: 'navigate'; path: string };

export interface FolderSelectData {
  currentPath: string;
}

@Component({
  selector: 'pp-folder-select-dialog',
  imports: [MatDialogModule, MatButtonModule, MatIconModule, MatProgressSpinnerModule, MatDividerModule],
  templateUrl: './folder-select-dialog.html',
  styleUrl: './folder-select-dialog.scss',
})
export class FolderSelectDialog implements OnInit {
  private dialogRef = inject(MatDialogRef<FolderSelectDialog>);
  private photoService = inject(PhotoService);
  private data: FolderSelectData = inject(MAT_DIALOG_DATA);

  selectedName = '__selected';
  dustName = '__dust';
  rootName = '';
  folders: string[] = [];
  comfyOutputPath: string | null = null;
  comfyOutputName: string | null = null;
  loading = true;

  selectedSubfolder = '';
  selectedCollection = '';

  readonly collections = [
    { value: '',    label: 'Working', icon: 'folder_open'  },
    { value: 'sel', label: 'Selected', icon: 'check_circle' },
    { value: 'dust', label: 'Dust',    icon: 'delete'        },
  ];

  ngOnInit(): void {
    this.decompose(this.data.currentPath);
    this.photoService.listFolders().subscribe({
      next: res => {
        this.rootName        = res.root_name;
        this.selectedName    = res.selected_name ?? '__selected';
        this.dustName        = res.dust_name     ?? '__dust';
        this.folders         = ['', ...res.folders];
        this.comfyOutputPath = res.comfy_output;
        this.comfyOutputName = res.comfy_output_name;
        this.loading = false;
        // re-decompose now that we have real names
        this.decompose(this.data.currentPath);
      },
      error: () => { this.loading = false; },
    });
  }

  private decompose(path: string): void {
    if (!path) {
      this.selectedSubfolder  = '';
      this.selectedCollection = '';
      return;
    }
    const last = path.split('/').at(-1)!;
    if (last === this.selectedName || last === this.dustName) {
      const slash = path.lastIndexOf('/');
      this.selectedSubfolder  = slash === -1 ? '' : path.slice(0, slash);
      this.selectedCollection = last;
    } else {
      this.selectedSubfolder  = path;
      this.selectedCollection = '';
    }
  }

  get resultPath(): string {
    if (this.selectedSubfolder === '__comfy_output') return '__comfy_output';
    const col = this.selectedCollection;
    if (!this.selectedSubfolder && !col) return '';
    if (!col) return this.selectedSubfolder;
    if (!this.selectedSubfolder) return col;
    return `${this.selectedSubfolder}/${col}`;
  }

  get confirmDisabled(): boolean {
    return this.loading || this.resultPath === this.data.currentPath;
  }

  collectionKey(c: { value: string }): string {
    if (c.value === 'sel')  return this.selectedName;
    if (c.value === 'dust') return this.dustName;
    return '';
  }

  selectCollection(c: { value: string }): void {
    this.selectedCollection = this.collectionKey(c);
  }

  isActiveCollection(c: { value: string }): boolean {
    return this.selectedCollection === this.collectionKey(c);
  }

  selectSubfolder(folder: string): void {
    this.selectedSubfolder = folder;
  }

  selectComfyOutput(): void {
    this.selectedSubfolder  = '__comfy_output';
    this.selectedCollection = '';
  }

  displayName(folder: string): string {
    return this.rootName + (folder ? '/' + folder : '/');
  }

  confirm(): void {
    this.dialogRef.close({ kind: 'navigate', path: this.resultPath } satisfies FolderSelectResult);
  }
}
