import { Component, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatDividerModule } from '@angular/material/divider';
import { PhotoService } from '../../services/photo.service';

export interface BatchDialogData {
  operation: 'copy' | 'move';
  filenames: string[];
  sourceFolder: string;
}

@Component({
  selector: 'pp-batch-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatIconModule,
            MatCheckboxModule, MatProgressSpinnerModule, MatDividerModule],
  templateUrl: './batch-dialog.html',
  styleUrl: './batch-dialog.scss',
})
export class BatchDialog implements OnInit {
  private dialogRef    = inject(MatDialogRef<BatchDialog>);
  private data         = inject<BatchDialogData>(MAT_DIALOG_DATA);
  private photoService = inject(PhotoService);

  operation = this.data.operation;
  count     = this.data.filenames.length;

  phase: 'select' | 'progress' | 'done' = 'select';
  folders: string[]              = [];
  rootName                       = '';
  selectedFolder                 = '__selected';  // default to Selected folder
  selectedComfyOutput            = false;
  comfyOutputPath: string | null = null;
  comfyOutputName: string | null = null;
  selectedName                   = '__selected';
  dustName                       = '__dust';
  zipFiles      = false;
  loading       = true;
  notAllowed    = false;
  resultMessage = '';

  ngOnInit(): void {
    this.photoService.listFolders().subscribe({
      next: res => {
        this.rootName        = res.root_name;
        this.folders         = ['', ...res.folders];
        this.comfyOutputPath = res.comfy_output;
        this.comfyOutputName = res.comfy_output_name;
        this.selectedName    = res.selected_name ?? '__selected';
        this.dustName        = res.dust_name ?? '__dust';
        this.loading         = false;
      },
      error: err => {
        this.loading = false;
        if (err.status === 403) this.notAllowed = true;
      },
    });
  }

  displayName(folder: string): string {
    return this.rootName + (folder ? '/' + folder : '/');
  }

  selectFolder(folder: string): void {
    this.selectedFolder = folder;
    this.selectedComfyOutput = false;
  }

  selectComfyOutput(): void {
    this.selectedComfyOutput = true;
    this.selectedFolder = '';
  }

  get applyDisabled(): boolean {
    return this.loading || this.notAllowed;
  }

  apply(): void {
    this.phase = 'progress';
    this.photoService.batchOperation({
      filenames:        this.data.filenames,
      operation:        this.operation,
      destination:      this.selectedFolder,
      use_comfy_output: this.selectedComfyOutput,
      zip:              this.zipFiles,
      folder:           this.data.sourceFolder,
    }).subscribe({
      next: res => {
        this.phase = 'done';
        const verb = this.operation === 'copy' ? 'Copied' : 'Moved';
        this.resultMessage = `${verb} ${res.count} file(s)` +
          (res.errors.length ? ` (${res.errors.length} error(s))` : '') + '.';
        if (res.ok) setTimeout(() => this.dialogRef.close({ ok: true }), 1500);
      },
      error: err => {
        this.phase = 'done';
        this.resultMessage = `Error: ${err.error?.error || 'Operation failed'}`;
      },
    });
  }
}
