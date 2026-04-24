import { Component, inject, OnInit } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDividerModule } from '@angular/material/divider';
import { PhotoService } from '../../services/photo.service';

export type FolderSelectResult =
  | { kind: 'view'; folder: 'source' | 'selected' | 'dust' }
  | { kind: 'change'; path: string };

export interface FolderSelectData {
  currentView: 'source' | 'selected' | 'dust';
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

  currentView = this.data.currentView;

  folders: string[] = [];
  rootName = '';
  current = '';
  selected = '';
  loading = true;
  notAllowed = false;

  readonly views: { key: 'source' | 'selected' | 'dust'; label: string; icon: string }[] = [
    { key: 'source',   label: 'Working Folder', icon: 'folder_open' },
    { key: 'selected', label: 'Selected',       icon: 'check_circle' },
    { key: 'dust',     label: 'Dust',           icon: 'delete' },
  ];

  ngOnInit(): void {
    this.photoService.listFolders().subscribe({
      next: (res) => {
        this.rootName = res.root_name;
        this.folders = ['', ...res.folders];
        this.current = res.current;
        this.selected = res.current;
        this.loading = false;
      },
      error: (err) => {
        this.loading = false;
        if (err.status === 403) this.notAllowed = true;
      },
    });
  }

  switchView(folder: 'source' | 'selected' | 'dust'): void {
    this.dialogRef.close({ kind: 'view', folder } satisfies FolderSelectResult);
  }

  displayName(folder: string): string {
    return this.rootName + (folder ? '/' + folder : '/');
  }

  confirm(): void {
    this.dialogRef.close({ kind: 'change', path: this.selected } satisfies FolderSelectResult);
  }
}
