import { Component, inject, signal } from '@angular/core';
import { CdkDrag, CdkDragHandle } from '@angular/cdk/drag-drop';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { BgRemoveCapabilities } from '../../models/photo.model';
import { PhotoService } from '../../services/photo.service';

export type BgEngine = 'rembg' | 'birefnet';

export interface RemoveBgDialogData {
  filename: string;
  folder: string;
}

/** When-to-use hints per rembg model (keyed by exact registry name). */
const REMBG_DESC: Record<string, string> = {
  'u2net':                'General purpose — reliable all-rounder.',
  'u2netp':               'Lighter/faster u2net; slightly lower quality.',
  'u2net_human_seg':      'Tuned for people / full-body subjects.',
  'u2net_cloth_seg':      'Segments clothing (upper / lower / full body).',
  'u2net_custom':         'Your own custom u2net model file.',
  'silueta':              'u2net-level quality at a small (~43 MB) size.',
  'isnet-general-use':    'Sharper general model — good default.',
  'isnet-anime':          'Anime / illustration characters.',
  'sam':                  'Segment Anything — general, heavy.',
  'ben_custom':           'Custom BEN model slot.',
  'birefnet-general':     'SOTA general — best edges & hair.',
  'birefnet-general-lite':'Lighter BiRefNet general — faster.',
  'birefnet-portrait':    'Human portraits (head & shoulders).',
  'birefnet-dis':         'High-accuracy single objects (dichotomous seg).',
  'birefnet-hrsod':       'High-resolution images / fine detail.',
  'birefnet-cod':         'Camouflaged / low-contrast subjects.',
  'birefnet-massive':     'Robust general (trained on a large dataset).',
};

/** When-to-use hints per BiRefNet (transformers) model. */
const BIREFNET_DESC: Record<string, string> = {
  'ZhengPeng7/BiRefNet_lite': 'Fast, light backbone — great quality/speed. Default.',
  'ZhengPeng7/BiRefNet':      'Full SOTA general — best quality, slower.',
  'briaai/RMBG-2.0':          'BRIA SOTA quality (non-commercial license).',
};

@Component({
  selector: 'pp-remove-bg-dialog',
  imports: [CdkDrag, CdkDragHandle, FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule,
            MatSelectModule, MatButtonModule, MatButtonToggleModule, MatIconModule, MatCheckboxModule,
            MatProgressSpinnerModule, MatTooltipModule],
  templateUrl: './remove-bg-dialog.html',
  styleUrl: './remove-bg-dialog.scss',
})
export class RemoveBgDialog {
  private dialogRef = inject(MatDialogRef<RemoveBgDialog>);
  private data: RemoveBgDialogData = inject(MAT_DIALOG_DATA);
  private photoService = inject(PhotoService);
  private snackBar = inject(MatSnackBar);

  engine = signal<BgEngine>('rembg');
  running = signal(false);
  caps = signal<BgRemoveCapabilities | null>(null);

  // rembg
  rembgModel = 'isnet-general-use';
  alphaMatting = false;

  // BiRefNet (torch/GPU)
  birefnetModel = 'ZhengPeng7/BiRefNet_lite';

  readonly rembgDesc = REMBG_DESC;
  readonly birefnetDesc = BIREFNET_DESC;

  constructor() {
    this.photoService.bgRemoveCapabilities().subscribe(caps => {
      this.caps.set(caps);
      // Prefer a sensible default that actually exists in the registry.
      if (caps.rembg_models.length && !caps.rembg_models.includes(this.rembgModel)) {
        this.rembgModel = caps.rembg_models.includes('isnet-general-use')
          ? 'isnet-general-use' : caps.rembg_models[0];
      }
      if (caps.birefnet_models.length && !caps.birefnet_models.includes(this.birefnetModel)) {
        this.birefnetModel = caps.birefnet_models[0];
      }
      // Fall back to whichever engine is available.
      if (!caps.rembg && caps.birefnet) this.engine.set('birefnet');
    });
  }

  get filename(): string { return this.data.filename; }

  get rembgReady(): boolean { return !!this.caps()?.rembg && !!this.caps()?.rembg_models.length; }
  get birefnetReady(): boolean { return !!this.caps()?.birefnet; }

  get rembgHint(): string {
    const c = this.caps();
    if (!c) return '';
    if (!c.rembg) return 'Install rembg in the backend to enable this.';
    if (!c.rembg_models.length) return 'No rembg models available.';
    if (!c.rembg_gpu) return 'Running on CPU (onnxruntime has no CUDA provider).';
    return '';
  }

  get birefnetHint(): string {
    const c = this.caps();
    if (!c) return '';
    if (!c.birefnet) return 'transformers + torch are not available in the backend.';
    if (!c.cuda) return 'No CUDA device — BiRefNet will run on CPU (slow).';
    return '';
  }

  run(): void {
    if (this.engine() === 'rembg') this.runRembg();
    else this.runBirefnet();
  }

  private runRembg(): void {
    if (!this.rembgModel) return;
    this.running.set(true);
    this.photoService.removeBgRembg(this.data.filename, this.data.folder, this.rembgModel, this.alphaMatting).subscribe({
      next: res => this.done(res.filename),
      error: err => this.fail(err),
    });
  }

  private runBirefnet(): void {
    if (!this.birefnetModel) return;
    this.running.set(true);
    this.photoService.removeBgBirefnet(this.data.filename, this.data.folder, this.birefnetModel).subscribe({
      next: res => this.done(res.filename),
      error: err => this.fail(err),
    });
  }

  private done(filename: string): void {
    this.running.set(false);
    this.snackBar.open(`Background removed → ${filename}`, '', { duration: 4000 });
    this.dialogRef.close(true);
  }

  private fail(err: any): void {
    this.running.set(false);
    const msg = err?.error?.error || err?.message || 'failed';
    this.snackBar.open(`Remove background error: ${msg}`, 'Dismiss', { duration: 8000 });
  }
}
