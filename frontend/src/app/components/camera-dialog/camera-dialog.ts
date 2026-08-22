import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { STORAGE_KEYS } from '../../constants';
import { DialogTitleDirective } from '../../directives/dialog-title.directive';
import { CAMERA_GROUPS, CameraGroup, CameraPreset } from './camera-presets';

/** How each card illustrates its preset. */
export type ChartMode = 'schema' | 'example';

/**
 * Illustrated cheat chart of camera language. Pick one or more cards and the
 * assembled snippet is inserted into the positive prompt at the cursor.
 *
 * Each card illustrates its preset one of two ways, switchable in the header:
 * a **schema** drawn live from the preset's `diagram` parameters (so it can never
 * drift from the text and ships no assets), or an **example** photograph of the
 * same setup, cut from the reference sheets by `tools/slice_camera_examples.py`.
 * Missing photos fall back to the schema, so the chart works either way.
 */
@Component({
  selector: 'pp-camera-dialog',
  imports: [DialogTitleDirective, FormsModule, MatDialogModule, MatFormFieldModule,
            MatInputModule, MatButtonModule, MatButtonToggleModule, MatIconModule,
            MatTooltipModule],
  templateUrl: './camera-dialog.html',
  styleUrl: './camera-dialog.scss',
})
export class CameraDialog {
  private dialogRef = inject(MatDialogRef<CameraDialog>);

  /** Standing figure used by the framing/angle diagrams (viewBox 0 0 100 100). */
  readonly FIGURE = 'M50 24 c-8 0 -13 5 -13 12 v20 h4 v40 h6 v-30 h6 v30 h6 v-40 h4 v-20 c0 -7 -5 -12 -13 -12 z';

  filter = signal('');
  /** Preset ids in the order they were picked — that order drives the snippet. */
  picked = signal<string[]>([]);

  mode = signal<ChartMode>(
    localStorage.getItem(STORAGE_KEYS.CAMERA_CHART_MODE) === 'example' ? 'example' : 'schema');
  /** Preset ids whose example photo failed to load — those cards keep the schema. */
  private noPhoto = signal<Set<string>>(new Set());

  readonly groups = computed<CameraGroup[]>(() => {
    const q = this.filter().trim().toLowerCase();
    if (!q) return CAMERA_GROUPS;
    return CAMERA_GROUPS
      .map(g => ({
        name: g.name,
        presets: g.presets.filter(p =>
          p.label.toLowerCase().includes(q) ||
          p.text.toLowerCase().includes(q) ||
          p.hint.toLowerCase().includes(q) ||
          g.name.toLowerCase().includes(q)),
      }))
      .filter(g => g.presets.length > 0);
  });

  /** The text that will be inserted, in pick order. */
  readonly snippet = computed(() => {
    const byId = new Map(CAMERA_GROUPS.flatMap(g => g.presets).map(p => [p.id, p]));
    return this.picked().map(id => byId.get(id)?.text).filter(Boolean).join(', ');
  });

  setMode(mode: ChartMode): void {
    this.mode.set(mode);
    localStorage.setItem(STORAGE_KEYS.CAMERA_CHART_MODE, mode);
  }

  /** True when this card should show its photo rather than its schema. */
  showPhoto(p: CameraPreset): boolean {
    return this.mode() === 'example' && !this.noPhoto().has(p.id);
  }

  photo(p: CameraPreset): string {
    return `charts/camera-examples/${p.id}.jpg`;
  }

  onPhotoError(p: CameraPreset): void {
    this.noPhoto.update(s => new Set(s).add(p.id));
  }

  isPicked(p: CameraPreset): boolean {
    return this.picked().includes(p.id);
  }

  toggle(p: CameraPreset): void {
    this.picked.update(ids => ids.includes(p.id) ? ids.filter(i => i !== p.id) : [...ids, p.id]);
  }

  /** Double-click inserts a single preset straight away. */
  insertOne(p: CameraPreset): void {
    this.dialogRef.close(p.text);
  }

  insert(): void {
    const text = this.snippet();
    if (text) this.dialogRef.close(text);
  }

  clear(): void {
    this.picked.set([]);
  }

  // --- diagram geometry -------------------------------------------------
  // Each helper turns a preset's parameters into SVG numbers, so a diagram
  // always depicts exactly the value it is labelled with.

  /** Map the figure band [from,to] onto the full 0-100 frame. */
  frameTransform(from: number, to: number): string {
    const s = 100 / (to - from);
    return `translate(${50 - 50 * s} ${-from * s}) scale(${s})`;
  }

  /** Camera position for a vertical angle: negative looks up, positive looks down. */
  camPos(deg: number): { x: number; y: number } {
    const r = 36;
    const rad = (deg * Math.PI) / 180;
    return { x: 60 - r * Math.cos(rad), y: 58 - r * Math.sin(rad) };
  }

  /** Camera position for a top-down bearing around the subject. */
  viewPos(deg: number): { x: number; y: number } {
    const r = 34;
    const rad = ((deg - 90) * Math.PI) / 180;
    return { x: 50 + r * Math.cos(rad), y: 52 + r * Math.sin(rad) };
  }

  /** Field-of-view wedge for a half-angle, drawn from the camera upward. */
  lensCone(half: number): string {
    const apexX = 50, apexY = 84, len = 74;
    const rad = (half * Math.PI) / 180;
    const dx = Math.tan(rad) * len;
    return `M${apexX} ${apexY} L${apexX - dx} ${apexY - len} L${apexX + dx} ${apexY - len} Z`;
  }

  /** Blur radius for one of the three depth planes. */
  dofBlur(sharp: 'near' | 'all' | 'far', plane: 'near' | 'mid' | 'far'): number {
    if (sharp === 'all') return plane === 'far' ? 0.6 : 0;
    if (sharp === 'near') return plane === 'near' ? 0 : plane === 'mid' ? 1.6 : 3.2;
    return plane === 'far' ? 0 : plane === 'mid' ? 1.6 : 3.2;   // 'far'
  }

  /** Evenly spaced trailing streaks; length grows with the streak strength. */
  streaks(n: number): { x: number; o: number; w: number }[] {
    if (n <= 0) return [];
    return Array.from({ length: n }, (_, i) => ({
      x: 46 - (i + 1) * 9,
      o: 0.55 - i * 0.11,
      w: 4 + n,
    }));
  }
}
