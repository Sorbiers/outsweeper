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
import { catchError, of, switchMap } from 'rxjs';
import { UpscaleCapabilities } from '../../models/photo.model';
import { ComfyConnectionService } from '../../services/comfy-connection.service';
import { ConnectionStateService } from '../../services/connection-state.service';
import { PhotoService } from '../../services/photo.service';
import { ComfyUrlRowComponent } from '../comfy-url-row/comfy-url-row';

export type UpscaleMethod = 'spandrel' | 'model' | 'interpolation';

export interface UpscaleDialogData {
  filename: string;
  folder: string;
  method: UpscaleMethod;
}

@Component({
  selector: 'pp-upscale-dialog',
  imports: [CdkDrag, CdkDragHandle, FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule,
            MatSelectModule, MatButtonModule, MatButtonToggleModule, MatIconModule, MatCheckboxModule,
            MatProgressSpinnerModule, MatTooltipModule, ComfyUrlRowComponent],
  templateUrl: './upscale-dialog.html',
  styleUrl: './upscale-dialog.scss',
})
export class UpscaleDialog {
  private dialogRef = inject(MatDialogRef<UpscaleDialog>);
  private data: UpscaleDialogData = inject(MAT_DIALOG_DATA);
  private photoService = inject(PhotoService);
  private snackBar = inject(MatSnackBar);
  private connState = inject(ConnectionStateService);
  comfy = inject(ComfyConnectionService);

  method = signal<UpscaleMethod>(this.data.method);
  running = signal(false);
  caps = signal<UpscaleCapabilities | null>(null);

  // spandrel (local, model-based)
  spandrelModel = '';
  tile = 512;

  // interpolation (local, Pillow)
  interpMethod = 'lanczos';
  interpScale = 4;

  // model (ComfyUI upscale-model node)
  availableUpscaleModels: string[] = [];
  comfyUpscaleModel = '';
  copyResult = true;

  constructor() {
    this.comfy.init();
    this.photoService.upscaleCapabilities().subscribe(caps => {
      this.caps.set(caps);
      if (caps.models.length && !this.spandrelModel) this.spandrelModel = caps.models[0];
    });
    if (this.comfy.checkStatus === 'ok') this.fetchUpscaleModels();
  }

  get filename(): string { return this.data.filename; }

  onConnected(): void {
    this.fetchUpscaleModels();
  }

  /** spandrel is usable only when torch+spandrel are installed and models exist. */
  get spandrelReady(): boolean {
    const c = this.caps();
    return !!c?.spandrel && !!c.models.length;
  }

  get spandrelHint(): string {
    const c = this.caps();
    if (!c) return '';
    if (!c.spandrel) return 'Install torch + spandrel in the backend to enable this.';
    if (!c.models_dir) return 'Set upscale_models_dir in config.toml (point it at ComfyUI models/upscale_models).';
    if (!c.models.length) return 'No model files found in upscale_models_dir.';
    if (!c.cuda) return 'Running on CPU (no CUDA) — this will be slow.';
    return '';
  }

  private fetchUpscaleModels(): void {
    this.photoService.getComfyUpscaleModels(this.comfy.comfyUrl).subscribe({
      next: res => {
        this.availableUpscaleModels = res.models || [];
        if (this.availableUpscaleModels.length && !this.comfyUpscaleModel) {
          this.comfyUpscaleModel = this.availableUpscaleModels[0];
        }
      },
      error: () => this.availableUpscaleModels = [],
    });
  }

  run(): void {
    switch (this.method()) {
      case 'spandrel':      return this.runSpandrel();
      case 'interpolation': return this.runInterpolation();
      case 'model':         return this.runModel();
    }
  }

  private runSpandrel(): void {
    if (!this.spandrelModel) return;
    this.running.set(true);
    this.photoService.spandrelUpscale(this.data.filename, this.data.folder, this.spandrelModel, this.tile).subscribe({
      next: res => this.done(`Upscaled ×${res.scale} → ${res.filename}`),
      error: err => this.fail(err),
    });
  }

  private runInterpolation(): void {
    this.running.set(true);
    this.photoService.interpolateUpscale(this.data.filename, this.data.folder, this.interpMethod, this.interpScale).subscribe({
      next: res => this.done(`Upscaled → ${res.filename}`),
      error: err => this.fail(err),
    });
  }

  private runModel(): void {
    if (!this.comfyUpscaleModel) return;
    this.running.set(true);
    const lmUrl = this.connState.lmstudio.url;
    const unload$ = lmUrl ? this.photoService.unloadLmStudio(lmUrl).pipe(catchError(() => of(null))) : of(null);
    unload$.pipe(
      switchMap(() => this.photoService.uploadToComfy(this.comfy.comfyUrl, this.data.filename, this.data.folder)),
    ).subscribe({
      next: res => this.sendModelWorkflow(res.name),
      error: err => this.fail(err, 'Upload'),
    });
  }

  private sendModelWorkflow(uploadedName: string): void {
    const workflow: Record<string, any> = {
      '1': { class_type: 'LoadImage',            inputs: { image: uploadedName } },
      '2': { class_type: 'UpscaleModelLoader',   inputs: { model_name: this.comfyUpscaleModel } },
      '3': { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['2', 0], image: ['1', 0] } },
      '4': { class_type: 'SaveImage',            inputs: { filename_prefix: 'upscaled', images: ['3', 0] } },
    };
    this.photoService.sendToComfy(this.comfy.comfyUrl, workflow, this.copyResult).subscribe({
      next: () => {
        this.running.set(false);
        const suffix = this.copyResult ? ' — will appear in the working folder' : '';
        this.snackBar.open('Upscale queued' + suffix, '', { duration: 4000 });
        this.dialogRef.close();
      },
      error: err => this.fail(err),
    });
  }

  private done(msg: string): void {
    this.running.set(false);
    this.snackBar.open(msg, '', { duration: 4000 });
    this.dialogRef.close(true);
  }

  private fail(err: any, what = 'Upscale'): void {
    this.running.set(false);
    const msg = err?.error?.error || err?.message || 'failed';
    this.snackBar.open(`${what} error: ${msg}`, 'Dismiss', { duration: 8000 });
  }
}
