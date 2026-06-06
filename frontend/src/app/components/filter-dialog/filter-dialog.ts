import { COMMA, ENTER, SPACE } from '@angular/cdk/keycodes';
import { CdkDrag, CdkDragHandle } from '@angular/cdk/drag-drop';
import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatChipInputEvent, MatChipsModule } from '@angular/material/chips';
import { MatRadioModule } from '@angular/material/radio';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { provideNativeDateAdapter } from '@angular/material/core';

export interface ActiveFilters {
  dateField: 'created' | 'modified' | 'exif';
  dateFrom: string;
  dateTo: string;
  types: string[];
  sizeMin: number | null;
  sizeMax: number | null;
  widthMin: number | null;
  widthMax: number | null;
  heightMin: number | null;
  heightMax: number | null;
  tags: string[];
}

export function emptyFilters(): ActiveFilters {
  return { dateField: 'modified', dateFrom: '', dateTo: '', types: [], sizeMin: null, sizeMax: null, widthMin: null, widthMax: null, heightMin: null, heightMax: null, tags: [] };
}

export function hasActiveFilters(f: ActiveFilters): boolean {
  return !!(f.dateFrom || f.dateTo || f.types.length || f.sizeMin != null || f.sizeMax != null || f.widthMin != null || f.widthMax != null || f.heightMin != null || f.heightMax != null || f.tags.length);
}

export interface FilterDialogData {
  current: ActiveFilters;
  availableTypes: string[];
}

@Component({
  selector: 'pp-filter-dialog',
  providers: [provideNativeDateAdapter()],
  imports: [CdkDrag, CdkDragHandle, FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatIconModule, MatCheckboxModule, MatChipsModule, MatRadioModule, MatDatepickerModule],
  templateUrl: './filter-dialog.html',
  styleUrl: './filter-dialog.scss',
})
export class FilterDialog {
  private dialogRef = inject(MatDialogRef<FilterDialog>);
  private data: FilterDialogData = inject(MAT_DIALOG_DATA);

  readonly chipSeparators = [ENTER, COMMA, SPACE] as const;
  availableTypes = this.data.availableTypes;
  filters: ActiveFilters = {
    ...this.data.current,
    types: [...this.data.current.types],
    tags: [...(this.data.current.tags ?? [])],
  };

  dateFromDate: Date | null = this.parseLocalDate(this.data.current.dateFrom);
  dateToDate: Date | null = this.parseLocalDate(this.data.current.dateTo);

  get sizeMinKb(): number | null {
    return this.filters.sizeMin != null ? Math.round(this.filters.sizeMin / 1024) : null;
  }
  set sizeMinKb(v: number | string | null) {
    this.filters.sizeMin = v != null && v !== '' ? +v * 1024 : null;
  }

  get sizeMaxKb(): number | null {
    return this.filters.sizeMax != null ? Math.round(this.filters.sizeMax / 1024) : null;
  }
  set sizeMaxKb(v: number | string | null) {
    this.filters.sizeMax = v != null && v !== '' ? +v * 1024 : null;
  }

  isTypeSelected(type: string): boolean {
    return this.filters.types.includes(type);
  }

  toggleType(type: string): void {
    const idx = this.filters.types.indexOf(type);
    if (idx >= 0) {
      this.filters.types.splice(idx, 1);
    } else {
      this.filters.types.push(type);
    }
  }

  addTag(e: MatChipInputEvent): void {
    const v = (e.value || '').trim().replace(/^#/, '').toLowerCase();
    if (v && !this.filters.tags.includes(v)) this.filters.tags.push(v);
    e.chipInput?.clear();
  }

  removeTag(t: string): void {
    const i = this.filters.tags.indexOf(t);
    if (i >= 0) this.filters.tags.splice(i, 1);
  }

  apply(): void {
    this.filters.dateFrom = this.dateFromDate ? this.localDateString(this.dateFromDate) : '';
    this.filters.dateTo = this.dateToDate ? this.localDateString(this.dateToDate) : '';
    this.dialogRef.close(this.filters);
  }

  private parseLocalDate(s: string): Date | null {
    if (!s) return null;
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  private localDateString(d: Date): string {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  reset(): void {
    this.dialogRef.close(emptyFilters());
  }
}
