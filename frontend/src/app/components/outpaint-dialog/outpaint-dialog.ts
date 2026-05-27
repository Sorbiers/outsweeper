import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { catchError, of, switchMap } from 'rxjs';
import { ConnectionStateService } from '../../services/connection-state.service';
import { PhotoService } from '../../services/photo.service';

export interface OutpaintDialogData {
  filename: string;
  folder: string;
}

/** Embedded workflow from F:\down\flux_fill_outpaint_example.json */
const OUTPAINT_WORKFLOW: Record<string, any> = {
  "3": {
    "inputs": { "seed": 789653886156103, "steps": 20, "cfg": 1, "sampler_name": "euler", "scheduler": "normal", "denoise": 1, "model": ["39", 0], "positive": ["38", 0], "negative": ["38", 1], "latent_image": ["38", 2] },
    "class_type": "KSampler"
  },
  "8": {
    "inputs": { "samples": ["3", 0], "vae": ["32", 0] },
    "class_type": "VAEDecode"
  },
  "9": {
    "inputs": { "filename_prefix": "outpaint_", "images": ["8", 0] },
    "class_type": "SaveImage"
  },
  "17": {
    "inputs": { "image": "ComfyUI_00001_.png" },
    "class_type": "LoadImage"
  },
  "23": {
    "inputs": { "text": "beautiful scenery", "clip": ["34", 0] },
    "class_type": "CLIPTextEncode"
  },
  "26": {
    "inputs": { "guidance": 30, "conditioning": ["23", 0] },
    "class_type": "FluxGuidance"
  },
  "31": {
    "inputs": { "unet_name": "flux1-fill-dev.safetensors", "weight_dtype": "default" },
    "class_type": "UNETLoader"
  },
  "32": {
    "inputs": { "vae_name": "ae.safetensors" },
    "class_type": "VAELoader"
  },
  "34": {
    "inputs": { "clip_name1": "clip_l.safetensors", "clip_name2": "t5xxl_fp16.safetensors", "type": "flux", "device": "default" },
    "class_type": "DualCLIPLoader"
  },
  "38": {
    "inputs": { "noise_mask": false, "positive": ["26", 0], "negative": ["46", 0], "vae": ["32", 0], "pixels": ["44", 0], "mask": ["44", 1] },
    "class_type": "InpaintModelConditioning"
  },
  "39": {
    "inputs": { "strength": 1, "model": ["31", 0] },
    "class_type": "DifferentialDiffusion"
  },
  "44": {
    "inputs": { "left": 400, "top": 0, "right": 400, "bottom": 0, "feathering": 24, "image": ["17", 0] },
    "class_type": "ImagePadForOutpaint"
  },
  "46": {
    "inputs": { "conditioning": ["23", 0] },
    "class_type": "ConditioningZeroOut"
  }
};

interface OutpaintParams {
  seed: number;
  steps: number;
  cfg: number;
  samplerName: string | null;
  scheduler: string | null;
  positivePrompt: string;
  padLeft: number;
  padTop: number;
  padRight: number;
  padBottom: number;
  feathering: number;
  guidance: number;
}

@Component({
  selector: 'pp-outpaint-dialog',
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatIconModule, MatCheckboxModule],
  templateUrl: './outpaint-dialog.html',
  styleUrl: './outpaint-dialog.scss',
})
export class OutpaintDialog {
  private dialogRef = inject(MatDialogRef<OutpaintDialog>);
  private data: OutpaintDialogData = inject(MAT_DIALOG_DATA);
  private photoService = inject(PhotoService);
  private snackBar = inject(MatSnackBar);
  private connState = inject(ConnectionStateService);

  comfyUrl = '';
  sending = false;
  copyResult = false;
  checkStatus: 'idle' | 'checking' | 'ok' | 'error' = 'idle';
  hasRunComfyCommand = false;
  runTriggered = false;

  availableModels: string[] = [];
  selectedModel = 'flux1-fill-dev.safetensors';

  availableSamplers: string[] = [];
  availableSchedulers: string[] = [];

  params: OutpaintParams = {
    seed: 0,
    steps: 20,
    cfg: 1,
    samplerName: 'euler',
    scheduler: 'normal',
    positivePrompt: 'beautiful scenery',
    padLeft: 400,
    padTop: 0,
    padRight: 400,
    padBottom: 0,
    feathering: 24,
    guidance: 30,
  };

  constructor() {
    this.comfyUrl = this.connState.comfy.url || '';

    if (this.comfyUrl && this.connState.comfy.status === 'ok') {
      this.checkStatus = 'ok';
      this.availableSamplers = [...this.connState.comfy.samplers];
      this.availableSchedulers = [...this.connState.comfy.schedulers];
      this.fetchUnetModels();
    }

    this.randomizeSeed();

    this.photoService.getConfig().subscribe(cfg => {
      this.hasRunComfyCommand = !!cfg.has_run_comfy_command;
      if (!this.comfyUrl) this.comfyUrl = cfg.comfy_url || '';
    });
  }

  onUrlChange(): void {
    if (this.comfyUrl !== this.connState.comfy.url) this.checkStatus = 'idle';
  }

  checkConnection(): void {
    this.checkStatus = 'checking';
    this.runTriggered = false;
    this.connState.comfy.url = this.comfyUrl;
    this.connState.comfy.status = 'checking';
    this.photoService.checkComfy(this.comfyUrl).subscribe({
      next: () => {
        this.checkStatus = 'ok';
        this.connState.comfy.status = 'ok';
        this.fetchUnetModels();
        this.fetchSamplers();
      },
      error: () => {
        this.checkStatus = 'error';
        this.connState.comfy.status = 'error';
      },
    });
  }

  randomizeSeed(): void {
    this.params.seed = Math.floor(Math.random() * 2 ** 32);
  }

  runService(): void {
    this.runTriggered = true;
    this.photoService.runCommand('comfy').subscribe({
      next: () => this.snackBar.open('Starting ComfyUI...', '', { duration: 3000 }),
      error: () => { this.runTriggered = false; this.snackBar.open('Failed to run command', '', { duration: 3000 }); },
    });
  }

  send(): void {
    this.connState.comfy.url = this.comfyUrl;
    this.sending = true;

    const lmstudioUrl = this.connState.lmstudio.url;
    const unload$ = lmstudioUrl
      ? this.photoService.unloadLmStudio(lmstudioUrl).pipe(catchError(() => of(null)))
      : of(null);

    unload$.pipe(
      switchMap(() => this.photoService.uploadToComfy(this.comfyUrl, this.data.filename, this.data.folder))
    ).subscribe({
      next: (res) => this._doSend(res.name),
      error: (err) => {
        this.sending = false;
        const msg = err.error?.error || err.message || 'Failed to upload image';
        this.snackBar.open(`Upload error: ${msg}`, '', { duration: 5000 });
      },
    });
  }

  private _doSend(uploadedImageName: string): void {
    const workflow = this.buildWorkflow(uploadedImageName);
    this.photoService.sendToComfy(this.comfyUrl, workflow, this.copyResult).subscribe({
      next: () => {
        this.sending = false;
        this.snackBar.open('Outpaint queued', '', { duration: 3000 });
        this.randomizeSeed();
      },
      error: (err) => {
        this.sending = false;
        const msg = err.error?.error || err.message || 'Failed to send';
        this.snackBar.open(`Error: ${msg}`, '', { duration: 5000 });
      },
    });
  }

  private buildWorkflow(uploadedImageName: string): Record<string, any> {
    const wf: Record<string, any> = JSON.parse(JSON.stringify(OUTPAINT_WORKFLOW));
    const p = this.params;

    for (const node of Object.values(wf)) {
      const inp = node.inputs || {};
      const ct: string = node.class_type || '';

      // KSampler params
      if ('steps' in inp && 'cfg' in inp) {
        inp.seed          = p.seed;
        inp.steps         = p.steps;
        inp.cfg           = p.cfg;
        if (p.samplerName) inp.sampler_name = p.samplerName;
        if (p.scheduler)   inp.scheduler    = p.scheduler;
      }

      // Positive prompt
      if (ct === 'CLIPTextEncode') inp.text = p.positivePrompt;

      // FluxGuidance
      if (ct === 'FluxGuidance') inp.guidance = p.guidance;

      // ImagePadForOutpaint
      if (ct === 'ImagePadForOutpaint') {
        inp.left       = p.padLeft;
        inp.top        = p.padTop;
        inp.right      = p.padRight;
        inp.bottom     = p.padBottom;
        inp.feathering = p.feathering;
      }

      // LoadImage — set uploaded filename
      if (ct === 'LoadImage') inp.image = uploadedImageName;

      // UNETLoader — override model if user changed it
      if (ct === 'UNETLoader' && this.selectedModel) inp.unet_name = this.selectedModel;
    }

    return wf;
  }

  private fetchUnetModels(): void {
    this.photoService.getComfyModels(this.comfyUrl).subscribe({
      next: (res) => {
        this.availableModels = (res.models || [])
          .filter(m => m.type === 'unet')
          .map(m => m.name);
      },
      error: () => this.availableModels = [],
    });
  }

  private fetchSamplers(): void {
    this.photoService.getComfySamplers(this.comfyUrl).subscribe({
      next: (res) => {
        this.availableSamplers = res.samplers || [];
        this.availableSchedulers = res.schedulers || [];
        this.connState.comfy.samplers = [...this.availableSamplers];
        this.connState.comfy.schedulers = [...this.availableSchedulers];
      },
      error: () => { this.availableSamplers = []; this.availableSchedulers = []; },
    });
  }
}
