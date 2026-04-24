import { Component, inject, OnInit } from '@angular/core';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { PhotoService } from '../../services/photo.service';

@Component({
  selector: 'pp-folder-select-dialog',
  imports: [MatDialogModule, MatButtonModule, MatIconModule, MatProgressSpinnerModule],
  templateUrl: './folder-select-dialog.html',
  styleUrl: './folder-select-dialog.scss',
})
export class FolderSelectDialog implements OnInit {
  private dialogRef = inject(MatDialogRef<FolderSelectDialog>);
  private photoService = inject(PhotoService);

  folders: string[] = [];
  rootName = '';
  current = '';
  selected = '';
  loading = true;
  notAllowed = false;

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

  displayName(folder: string): string {
    return this.rootName + (folder ? '/' + folder : '/');
  }

  confirm(): void {
    this.dialogRef.close(this.selected);
  }
}
