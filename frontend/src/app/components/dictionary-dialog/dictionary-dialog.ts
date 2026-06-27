import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CdkDrag, CdkDragHandle } from '@angular/cdk/drag-drop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Dictionary, DictionaryService } from '../../services/dictionary.service';

@Component({
  selector: 'pp-dictionary-dialog',
  imports: [FormsModule, CdkDrag, CdkDragHandle, MatDialogModule, MatButtonModule, MatIconModule,
            MatFormFieldModule, MatInputModule, MatTooltipModule],
  templateUrl: './dictionary-dialog.html',
  styleUrl: './dictionary-dialog.scss',
})
export class DictionaryDialog {
  private dictService = inject(DictionaryService);
  private snackBar = inject(MatSnackBar);

  // Working copy; changes are persisted on every edit.
  dicts: Dictionary[] = structuredClone(this.dictService.dictionaries());
  selectedIndex = this.dicts.length ? 0 : -1;

  get selected(): Dictionary | null {
    return this.dicts[this.selectedIndex] ?? null;
  }

  /** Literal `{{name}}` token for the usage hint (avoids template brace clashes). */
  get usageToken(): string {
    const name = this.selected?.name.trim() || 'name';
    return `{{${name}}}`;
  }

  totalWeight(): number {
    const vals = this.selected?.values ?? [];
    const positive = vals.filter(v => (v.weight ?? 0) > 0);
    return (positive.length ? positive : vals).reduce(
      (sum, v) => sum + (positive.length ? v.weight : 1), 0,
    );
  }

  percent(weight: number): number {
    const total = this.totalWeight();
    const positive = (this.selected?.values ?? []).some(v => (v.weight ?? 0) > 0);
    const w = positive ? (weight > 0 ? weight : 0) : 1;
    return total ? Math.round((w / total) * 100) : 0;
  }

  addDictionary(): void {
    this.dicts.push({ name: this.uniqueName('dictionary'), values: [{ value: '', weight: 1 }] });
    this.selectedIndex = this.dicts.length - 1;
    this.persist();
  }

  deleteDictionary(index: number): void {
    this.dicts.splice(index, 1);
    if (this.selectedIndex >= this.dicts.length) this.selectedIndex = this.dicts.length - 1;
    this.persist();
  }

  addValue(): void {
    this.selected?.values.push({ value: '', weight: 1 });
    this.persist();
  }

  deleteValue(index: number): void {
    this.selected?.values.splice(index, 1);
    this.persist();
  }

  persist(): void {
    this.dictService.save(structuredClone(this.dicts));
  }

  /** Copy the selected dictionary's `{{name}}` token to the clipboard. */
  copyToken(): void {
    const token = this.usageToken;
    navigator.clipboard?.writeText(token);
    this.snackBar.open(`Copied ${token}`, '', { duration: 1500 });
  }

  private uniqueName(base: string): string {
    const names = new Set(this.dicts.map(d => d.name));
    if (!names.has(base)) return base;
    let i = 2;
    while (names.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }
}
