import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ComfyConnectionService } from '../../services/comfy-connection.service';
import { ConnectionStateService } from '../../services/connection-state.service';
import { PhotoService } from '../../services/photo.service';
import { DialogTitleDirective } from '../../directives/dialog-title.directive';
import { ComfyUrlRowComponent } from '../comfy-url-row/comfy-url-row';

export interface KontextDialogData {
  filename: string;
  folder: string;
}

/** Plain instruction editing, or continuing a shot to its next moment. */
export type KontextMode = 'edit' | 'next';

/**
 * Prefix that turns an edit instruction into a shot continuation.
 *
 * Kontext preserves *identity*, not motion — it has no notion of time. Naming the
 * things that must not change is what keeps a continuation from re-imagining the
 * scene, so the wording is deliberately explicit about wardrobe, set and light.
 * It is shown under the box rather than silently prepended.
 */
const NEXT_FRAME_PREFIX =
  'Same character, same wardrobe, same set, same lighting and same film grain. ' +
  'This is the next moment of one continuous shot:';

/**
 * FLUX.1 Kontext: reference image + instruction in, edited image out.
 *
 * The reference is encoded once and used twice — as `ReferenceLatent` conditioning
 * and as the sampler's starting latent — which is how Kontext keeps the subject
 * while following the instruction. `FluxKontextImageScale` snaps the input to a
 * resolution the model was trained on, so odd aspect ratios need no handling here.
 */
const KONTEXT_WORKFLOW: Record<string, any> = {
  '3': {
    inputs: { seed: 0, steps: 20, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['31', 0], positive: ['26', 0], negative: ['46', 0], latent_image: ['19', 0] },
    class_type: 'KSampler',
  },
  '8': {
    inputs: { samples: ['3', 0], vae: ['32', 0] },
    class_type: 'VAEDecode',
  },
  '9': {
    inputs: { filename_prefix: 'kontext_', images: ['8', 0] },
    class_type: 'SaveImage',
  },
  '17': {
    inputs: { image: '__pp_pending_upload__' },
    class_type: 'LoadImage',
  },
  '18': {
    inputs: { image: ['17', 0] },
    class_type: 'FluxKontextImageScale',
  },
  '19': {
    inputs: { pixels: ['18', 0], vae: ['32', 0] },
    class_type: 'VAEEncode',
  },
  '23': {
    inputs: { text: '', clip: ['34', 0] },
    class_type: 'CLIPTextEncode',
  },
  '24': {
    inputs: { conditioning: ['23', 0], latent: ['19', 0] },
    class_type: 'ReferenceLatent',
  },
  '26': {
    inputs: { guidance: 2.5, conditioning: ['24', 0] },
    class_type: 'FluxGuidance',
  },
  '31': {
    inputs: { unet_name: 'flux1-dev-kontext_fp8_scaled.safetensors', weight_dtype: 'default' },
    class_type: 'UNETLoader',
  },
  '32': {
    inputs: { vae_name: 'ae.safetensors' },
    class_type: 'VAELoader',
  },
  '34': {
    inputs: { clip_name1: 'clip_l.safetensors', clip_name2: 't5xxl_fp16.safetensors', type: 'flux', device: 'default' },
    class_type: 'DualCLIPLoader',
  },
  '46': {
    inputs: { conditioning: ['23', 0] },
    class_type: 'ConditioningZeroOut',
  },
};

/** A LoRA to chain between the UNET/CLIP loaders and their consumers. */
interface KontextLora {
  name: string;
  strengthModel: number;
  strengthClip: number;
}

interface KontextParams {
  seed: number;
  steps: number;
  cfg: number;
  guidance: number;
  samplerName: string | null;
  scheduler: string | null;
  instruction: string;
}

@Component({
  selector: 'pp-kontext-dialog',
  imports: [DialogTitleDirective, FormsModule, MatDialogModule, MatFormFieldModule,
            MatInputModule, MatSelectModule, MatButtonModule, MatButtonToggleModule,
            MatIconModule, MatCheckboxModule, MatTooltipModule, ComfyUrlRowComponent],
  templateUrl: './kontext-dialog.html',
  styleUrl: './kontext-dialog.scss',
})
export class KontextDialog {
  readonly data: KontextDialogData = inject(MAT_DIALOG_DATA);
  private photoService = inject(PhotoService);
  private snackBar = inject(MatSnackBar);
  private connState = inject(ConnectionStateService);
  comfy = inject(ComfyConnectionService);

  readonly NEXT_FRAME_PREFIX = NEXT_FRAME_PREFIX;

  sending = false;
  copyResult = false;
  mode: KontextMode = 'next';

  /** Queue several at once: same reference, different seeds — candidate frames. */
  variants = 1;

  availableModels: string[] = [];
  selectedModel = 'flux1-dev-kontext_fp8_scaled.safetensors';
  availableSamplers: string[] = [];
  availableSchedulers: string[] = [];
  availableLoras: string[] = [];
  loras: KontextLora[] = [];

  params: KontextParams = {
    seed: 0,
    steps: 20,
    cfg: 1,
    guidance: 2.5,
    samplerName: 'euler',
    scheduler: 'simple',
    instruction: '',
  };

  constructor() {
    this.comfy.init();
    if (this.comfy.checkStatus === 'ok') {
      this.availableSamplers = [...this.connState.comfy.samplers];
      this.availableSchedulers = [...this.connState.comfy.schedulers];
      this.fetchUnetModels();
      this.fetchLoras();
    }
    this.randomizeSeed();
  }

  get imageUrl(): string {
    return this.photoService.getImageUrl(this.data.filename, this.data.folder);
  }

  /** Exactly what the CLIPTextEncode node receives. */
  get effectivePrompt(): string {
    const text = this.params.instruction.trim();
    if (!text) return '';
    return this.mode === 'next' ? `${NEXT_FRAME_PREFIX} ${text}` : text;
  }

  get placeholder(): string {
    return this.mode === 'next'
      ? 'she turns toward the window and takes half a step forward'
      : 'change her jacket to red';
  }

  randomizeSeed(): void {
    this.params.seed = Math.floor(Math.random() * 2 ** 32);
  }

  onConnected(): void {
    this.fetchUnetModels();
    this.fetchSamplers();
    this.fetchLoras();
  }

  // --- LoRAs ------------------------------------------------------------

  addLora(): void {
    this.loras.push({ name: '', strengthModel: 1, strengthClip: 1 });
  }

  removeLora(i: number): void {
    this.loras.splice(i, 1);
  }

  // --- generation -------------------------------------------------------

  private buildWorkflow(seed: number): Record<string, any> {
    const wf: Record<string, any> = JSON.parse(JSON.stringify(KONTEXT_WORKFLOW));
    const p = this.params;

    wf['3'].inputs.seed = seed;
    wf['3'].inputs.steps = p.steps;
    wf['3'].inputs.cfg = p.cfg;
    if (p.samplerName) wf['3'].inputs.sampler_name = p.samplerName;
    if (p.scheduler) wf['3'].inputs.scheduler = p.scheduler;

    wf['23'].inputs.text = this.effectivePrompt;
    wf['26'].inputs.guidance = p.guidance;
    if (this.selectedModel) wf['31'].inputs.unet_name = this.selectedModel;

    // Chain LoRAs between the loaders and their consumers: the sampler takes MODEL
    // directly here (no DifferentialDiffusion in this graph), CLIP goes to the encode.
    let modelRef: [string, number] = ['31', 0];
    let clipRef: [string, number] = ['34', 0];
    this.loras.filter(l => l.name).forEach((lora, i) => {
      const id = String(60 + i);
      wf[id] = {
        inputs: {
          lora_name: lora.name,
          strength_model: lora.strengthModel,
          strength_clip: lora.strengthClip,
          model: modelRef,
          clip: clipRef,
        },
        class_type: 'LoraLoader',
      };
      modelRef = [id, 0];
      clipRef = [id, 1];
    });
    wf['3'].inputs.model = modelRef;
    wf['23'].inputs.clip = clipRef;

    return wf;
  }

  send(): void {
    if (!this.params.instruction.trim()) {
      this.snackBar.open(
        this.mode === 'next' ? 'Describe what happens next' : 'Describe the edit', '',
        { duration: 3000 });
      return;
    }
    this.sending = true;

    const count = Math.max(1, Math.min(24, Math.floor(this.variants) || 1));
    // Each variant is its own graph on one job: same reference, different seed.
    const prompts = Array.from({ length: count }, (_, i) => ({
      workflow: this.buildWorkflow(count === 1 ? this.params.seed
                                              : Math.floor(Math.random() * 2 ** 32)),
      uploadNodeId: '17',
      seedNodeId: '3',
      promptNodeId: '23',
      _i: i,
    })).map(({ _i, ...p }) => p);

    const label = this.mode === 'next' ? 'Next frame' : 'Kontext';
    this.photoService.enqueueJob('comfy',
      `${label} · ${this.data.filename}${count > 1 ? ` ×${count}` : ''}`, {
      prompts,
      copyResult: this.copyResult,
      upload: { path: this.data.folder ? `${this.data.folder}/${this.data.filename}` : this.data.filename },
    }).subscribe({
      next: () => {
        this.sending = false;
        this.snackBar.open(`${label} queued`, '', { duration: 3000 });
        this.randomizeSeed();
      },
      error: (err) => {
        this.sending = false;
        const msg = err.error?.error || err.message || 'Failed to queue';
        this.snackBar.open(`Error: ${msg}`, '', { duration: 5000 });
      },
    });
  }

  private fetchUnetModels(): void {
    this.photoService.getComfyModels(this.comfy.comfyUrl).subscribe({
      next: (res) => {
        this.availableModels = (res.models || [])
          .filter(m => m.type === 'unet')
          .map(m => m.name);
      },
      error: () => this.availableModels = [],
    });
  }

  private fetchLoras(): void {
    this.photoService.getComfyLoras(this.comfy.comfyUrl).subscribe({
      next: (res) => this.availableLoras = res.loras || [],
      error: () => this.availableLoras = [],
    });
  }

  private fetchSamplers(): void {
    this.photoService.getComfySamplers(this.comfy.comfyUrl).subscribe({
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
