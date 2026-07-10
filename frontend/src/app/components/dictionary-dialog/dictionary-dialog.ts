import { afterNextRender, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CdkDrag, CdkDragHandle } from '@angular/cdk/drag-drop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar } from '@angular/material/snack-bar';
import { STORAGE_KEYS } from '../../constants';
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
  private dialogRef = inject(MatDialogRef<DictionaryDialog>);
  private hostEl = inject(ElementRef<HTMLElement>);

  private fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  private content = viewChild('content', { read: ElementRef });

  // Working copy, sorted by name once at open; changes are persisted on every edit.
  dicts: Dictionary[] = structuredClone(this.dictService.dictionaries())
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  selectedIndex = this.dicts.length ? 0 : -1;

  /** Parsed dictionaries awaiting the Add/Replace choice after an import. */
  importPending = signal<Dictionary[] | null>(null);

  /** True while a .json file is being dragged over the dialog. */
  isDragOver = signal(false);

  /** Resizable width (px) of the dictionary-name list, persisted across dialog opens. */
  listWidth = signal(220);
  private resizing = false;
  private boundResize    = (e: MouseEvent) => this.onResize(e);
  private boundResizeEnd = () => this.onResizeEnd();

  // Whole-dialog resize (drag handle in the actions row).
  private resizingDialog = false;
  private dialogStart = { w: 0, h: 0, x: 0, y: 0 };
  private boundDialogResize    = (e: MouseEvent) => this.onDialogResize(e);
  private boundDialogResizeEnd = () => this.onDialogResizeEnd();

  constructor() {
    afterNextRender(() => {
      const savedListWidth = Number(sessionStorage.getItem(STORAGE_KEYS.DICTIONARY_LIST_WIDTH));
      if (savedListWidth) this.listWidth.set(savedListWidth);

      const savedSize = sessionStorage.getItem(STORAGE_KEYS.DICTIONARY_DIALOG_SIZE);
      if (savedSize) {
        try {
          const { w, h } = JSON.parse(savedSize);
          if (w && h) this.dialogRef.updateSize(`${w}px`, `${h}px`);
        } catch { /* ignore malformed saved size */ }
      }
    });
  }

  get selected(): Dictionary | null {
    return this.dicts[this.selectedIndex] ?? null;
  }

  /** Literal `{{name}}` token for the usage hint (avoids template brace clashes). */
  get usageToken(): string {
    const name = this.selected?.name.trim() || 'name';
    return `{{${name}}}`;
  }

  /** Sum of weights across active (weight > 0) values only — disabled values don't count. */
  totalWeight(): number {
    const vals = this.selected?.values ?? [];
    return vals.filter(v => (v.weight ?? 0) > 0).reduce((sum, v) => sum + v.weight, 0);
  }

  percent(weight: number): number {
    const total = this.totalWeight();
    if (!total || weight <= 0) return 0;
    return Math.round((weight / total) * 100);
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

  /** Duplicate a dictionary (unique name) and select the copy. */
  cloneDictionary(index: number): void {
    const clone = structuredClone(this.dicts[index]);
    clone.name = this.uniqueName(`${clone.name || 'dictionary'} copy`);
    this.dicts.splice(index + 1, 0, clone);
    this.selectedIndex = index + 1;
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

  /** Copy a dictionary's `{{name}}` token to the clipboard (defaults to the selected one). */
  copyToken(dict: Dictionary | null = this.selected): void {
    if (!dict) return;
    const token = `{{${(dict.name || 'name').trim()}}}`;
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

  // --- Export / Import ---

  exportJson(): void {
    const blob = new Blob([JSON.stringify(this.dicts, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dictionaries.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  triggerImport(): void {
    this.fileInput()?.nativeElement.click();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-picking the same file
    if (file) this.readFile(file);
  }

  /** Read from the OS clipboard and import it as dictionary JSON. */
  async pasteFromClipboard(): Promise<void> {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      this.snackBar.open('Could not read clipboard — check browser permission', '', { duration: 3000 });
      return;
    }
    this.importFromText(text, 'clipboard');
  }

  onDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    this.isDragOver.set(true);
  }

  onDragLeave(event: DragEvent): void {
    if ((event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) return;
    this.isDragOver.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.isDragOver.set(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) this.readFile(file);
  }

  private readFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => this.importFromText(reader.result as string, 'file');
    reader.readAsText(file);
  }

  /** Shared JSON import path for file, drop, and clipboard sources. */
  private importFromText(text: string, source: 'file' | 'clipboard'): void {
    let dicts: Dictionary[];
    try {
      dicts = this.normalizeImport(JSON.parse(text));
    } catch {
      this.snackBar.open(`Invalid JSON ${source === 'file' ? 'file' : 'on clipboard'}`, '', { duration: 3000 });
      return;
    }
    if (!dicts.length) {
      this.snackBar.open(`No dictionaries found ${source === 'file' ? 'in file' : 'on clipboard'}`, '', { duration: 3000 });
      return;
    }
    this.importPending.set(dicts);
  }

  /** Coerce arbitrary parsed JSON into a clean Dictionary[] (drops bad entries). Accepts either a single dictionary object or an array of them. */
  private normalizeImport(parsed: unknown): Dictionary[] {
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr
      .filter((d: any) => d && typeof d.name === 'string' && Array.isArray(d.values))
      .map((d: any) => ({
        name: String(d.name),
        values: d.values
          .filter((v: any) => v && typeof v.value === 'string')
          .map((v: any) => ({ value: String(v.value), weight: Number(v.weight) || 1 })),
      }));
  }

  applyImport(mode: 'add' | 'replace'): void {
    const incoming = this.importPending();
    if (!incoming) return;
    if (mode === 'replace') {
      this.dicts = structuredClone(incoming);
    } else {
      // Union by name; imported entries override existing ones with the same name.
      const byName = new Map(this.dicts.map(d => [d.name.trim().toLowerCase(), d]));
      for (const d of incoming) byName.set(d.name.trim().toLowerCase(), structuredClone(d));
      this.dicts = [...byName.values()];
    }
    this.importPending.set(null);
    this.selectedIndex = this.dicts.length ? 0 : -1;
    this.persist();
    this.snackBar.open(mode === 'replace' ? 'Dictionaries replaced' : 'Dictionaries merged', '', { duration: 2000 });
  }

  // --- Resizable list column ---

  startResize(e: MouseEvent): void {
    e.preventDefault();
    this.resizing = true;
    document.addEventListener('mousemove', this.boundResize);
    document.addEventListener('mouseup', this.boundResizeEnd);
  }

  private onResize(e: MouseEvent): void {
    if (!this.resizing) return;
    const rect = this.content()?.nativeElement.getBoundingClientRect();
    if (!rect) return;
    const min = 160;
    const max = rect.width * 0.5;
    this.listWidth.set(Math.min(max, Math.max(min, e.clientX - rect.left)));
  }

  private onResizeEnd(): void {
    this.resizing = false;
    document.removeEventListener('mousemove', this.boundResize);
    document.removeEventListener('mouseup', this.boundResizeEnd);
    sessionStorage.setItem(STORAGE_KEYS.DICTIONARY_LIST_WIDTH, String(this.listWidth()));
  }

  // --- Whole-dialog resize ---

  private dialogPane(): HTMLElement | null {
    return this.hostEl.nativeElement.closest('.cdk-overlay-pane');
  }

  startDialogResize(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const rect = this.dialogPane()?.getBoundingClientRect();
    if (!rect) return;
    this.dialogStart = { w: rect.width, h: rect.height, x: e.clientX, y: e.clientY };
    this.resizingDialog = true;
    document.addEventListener('mousemove', this.boundDialogResize);
    document.addEventListener('mouseup', this.boundDialogResizeEnd);
  }

  private onDialogResize(e: MouseEvent): void {
    if (!this.resizingDialog) return;
    const minW = 780, minH = 400;
    const maxW = window.innerWidth * 0.95;
    const maxH = window.innerHeight * 0.95;
    const w = Math.min(maxW, Math.max(minW, this.dialogStart.w + (e.clientX - this.dialogStart.x)));
    const h = Math.min(maxH, Math.max(minH, this.dialogStart.h + (e.clientY - this.dialogStart.y)));
    this.dialogRef.updateSize(`${w}px`, `${h}px`);
  }

  private onDialogResizeEnd(): void {
    if (!this.resizingDialog) return;
    this.resizingDialog = false;
    document.removeEventListener('mousemove', this.boundDialogResize);
    document.removeEventListener('mouseup', this.boundDialogResizeEnd);
    const rect = this.dialogPane()?.getBoundingClientRect();
    if (rect) {
      sessionStorage.setItem(STORAGE_KEYS.DICTIONARY_DIALOG_SIZE, JSON.stringify({ w: rect.width, h: rect.height }));
    }
  }
}
