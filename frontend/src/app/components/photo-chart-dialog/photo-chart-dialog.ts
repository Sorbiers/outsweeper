import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { STORAGE_KEYS } from '../../constants';
import { DialogTitleDirective } from '../../directives/dialog-title.directive';
import { ChartId, ChartPreset, ChartSection, ChartSet, PHOTO_CHARTS, PhotoChart } from './photo-chart-presets';

export interface PhotoChartDialogData {
  chart: ChartId;
}

/**
 * Single-selection grid over a photographic reference chart. Pick a tile, and its
 * prompt snippet is inserted at the caret in the positive prompt.
 *
 * Tiles come from contact sheets cut into `public/charts/` (`tools/sheet_slicer.py`,
 * or `tools/import_chart_tiles.py` for tiles cut by hand). A chart may carry more
 * than one illustration set — the same presets shot with different subjects — and
 * then a switch appears. If a tile is missing the grid still works: that card
 * falls back to showing its cell number.
 */
@Component({
  selector: 'pp-photo-chart-dialog',
  imports: [DialogTitleDirective, FormsModule, MatDialogModule, MatFormFieldModule,
            MatInputModule, MatButtonModule, MatButtonToggleModule, MatIconModule,
            MatTooltipModule],
  templateUrl: './photo-chart-dialog.html',
  styleUrl: './photo-chart-dialog.scss',
})
export class PhotoChartDialog {
  private dialogRef = inject(MatDialogRef<PhotoChartDialog>);
  private data: PhotoChartDialogData = inject(MAT_DIALOG_DATA);

  readonly chart: PhotoChart = PHOTO_CHARTS[this.data.chart];

  filter = signal('');
  selected = signal<ChartPreset | null>(null);
  /** Which illustration set is showing; remembered per chart. */
  set = signal<ChartSet>(this.restoreSet());
  /** Tiles that failed to load, keyed `setId/n` — those cards fall back to the number. */
  private missing = signal<Set<string>>(new Set());

  readonly sections = computed<ChartSection[]>(() => {
    const q = this.filter().trim().toLowerCase();
    if (!q) return this.chart.sections;
    return this.chart.sections
      .map(s => ({
        name: s.name,
        presets: s.presets.filter(p =>
          p.label.toLowerCase().includes(q) ||
          p.text.toLowerCase().includes(q) ||
          s.name.toLowerCase().includes(q)),
      }))
      .filter(s => s.presets.length > 0);
  });

  private storageKey(): string {
    return `${STORAGE_KEYS.CHART_SET_PREFIX}${this.data.chart}`;
  }

  private restoreSet(): ChartSet {
    const sets = PHOTO_CHARTS[this.data.chart].sets;
    const saved = localStorage.getItem(`${STORAGE_KEYS.CHART_SET_PREFIX}${this.data.chart}`);
    return sets.find(s => s.id === saved) ?? sets[0];
  }

  setSet(id: string): void {
    const next = this.chart.sets.find(s => s.id === id);
    if (!next) return;
    this.set.set(next);
    localStorage.setItem(this.storageKey(), id);
  }

  tile(p: ChartPreset): string {
    const set = this.set();
    return `${set.dir}/${String(p.n).padStart(2, '0')}.${set.ext}`;
  }

  hasTile(p: ChartPreset): boolean {
    return !this.missing().has(`${this.set().id}/${p.n}`);
  }

  onTileError(p: ChartPreset): void {
    this.missing.update(s => new Set(s).add(`${this.set().id}/${p.n}`));
  }

  isSelected(p: ChartPreset): boolean {
    return this.selected()?.n === p.n;
  }

  select(p: ChartPreset): void {
    this.selected.set(this.isSelected(p) ? null : p);
  }

  insertOne(p: ChartPreset): void {
    this.dialogRef.close(p.text);
  }

  insert(): void {
    const p = this.selected();
    if (p) this.dialogRef.close(p.text);
  }
}
