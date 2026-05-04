import {
  Component,
  ElementRef,
  HostListener,
  inject,
  OnInit,
  QueryList,
  ViewChildren,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { PhotoService } from '../../services/photo.service';

export type FolderSelectResult = { kind: 'navigate'; path: string };

export interface FolderSelectData {
  currentPath: string;
}

@Component({
  selector: 'pp-folder-select-dialog',
  imports: [
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatDividerModule,
  ],
  templateUrl: './folder-select-dialog.html',
  styleUrl: './folder-select-dialog.scss',
})
export class FolderSelectDialog implements OnInit {
  @ViewChildren('folderItem')
  folderItems!: QueryList<ElementRef<HTMLDivElement>>;

  @HostListener('keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    event.stopPropagation();
    event.preventDefault();
    if (event.key === 'Enter' && !this.confirmDisabled) {
      this.confirm();
    } else if (event.key === 'Escape') {
      this.dialogRef.close();
    } else if (event.key === 'ArrowDown') {
      if (this.folders.length) {
        this.selectedSubfolder = this.moveSelection(this.folders, this.selectedSubfolder, 1);
        this.scrollSelectedIntoView();
      }
    } else if (event.key === 'ArrowUp') {
      if (this.folders.length) {
        this.selectedSubfolder = this.moveSelection(this.folders, this.selectedSubfolder, -1);
        this.scrollSelectedIntoView();
      }
    } else if (event.key === 'ArrowRight') {
      this.moveCollectionSelection(1);
    } else if (event.key === 'ArrowLeft') {
      this.moveCollectionSelection(-1);
    }
  }
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
    { value: '', label: 'Working', icon: 'folder_open' },
    { value: 'sel', label: 'Selected', icon: 'check_circle' },
    { value: 'dust', label: 'Dust', icon: 'delete' },
  ];

  ngOnInit(): void {
    this.decompose(this.data.currentPath);
    this.photoService.listFolders().subscribe({
      next: (res) => {
        this.rootName = res.root_name;
        this.selectedName = res.selected_name ?? '__selected';
        this.dustName = res.dust_name ?? '__dust';
        this.folders = ['', ...res.folders];
        this.comfyOutputPath = res.comfy_output;
        this.comfyOutputName = res.comfy_output_name;
        this.loading = false;
        // re-decompose now that we have real names
        this.decompose(this.data.currentPath);
      },
      error: () => {
        this.loading = false;
      },
    });
  }

  private decompose(path: string): void {
    if (!path) {
      this.selectedSubfolder = '';
      this.selectedCollection = '';
      return;
    }
    const last = path.split('/').at(-1)!;
    if (last === this.selectedName || last === this.dustName) {
      const slash = path.lastIndexOf('/');
      this.selectedSubfolder = slash === -1 ? '' : path.slice(0, slash);
      this.selectedCollection = last;
    } else {
      this.selectedSubfolder = path;
      this.selectedCollection = '';
    }
  }

  get resultPath(): string {
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
    if (c.value === 'sel') return this.selectedName;
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
    this.selectedSubfolder = '%comfy_output%';
  }

  displayName(folder: string): string {
    return this.rootName + (folder ? '/' + folder : '/');
  }

  confirm(): void {
    this.dialogRef.close({ kind: 'navigate', path: this.resultPath } satisfies FolderSelectResult);
  }

  private moveSelection(list: string[], current: string, delta: number): string {
    if (current === '%comfy_output%' && list.length) {
      return delta === 1 ? list[0] : list[list.length -1];
    }
    if (list.length === 0) return '';
    const idx = list.indexOf(current);
    if (idx === -1) return list[0];
    const newIdx = idx + delta;
    if (newIdx < 0) return '%comfy_output%';
    if (newIdx >= list.length) return '%comfy_output%';
    return list[newIdx];
  }

  moveCollectionSelection(delta: number): void {
    this.selectedCollection = this.moveSelection(
      this.collections.map((c) => this.collectionKey(c)),
      this.selectedCollection,
      delta,
    );
  }

  private scrollSelectedIntoView() {
    queueMicrotask(() => {
      const index = this.folders.indexOf(this.selectedSubfolder);

      this.folderItems.get(index)?.nativeElement.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      });
    });
  }
}
