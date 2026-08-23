import { DecimalPipe } from '@angular/common';
import { Component, DestroyRef, ElementRef, inject, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
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

export interface InpaintDialogData {
  filename: string;
  folder: string;
}

/**
 * Flux Fill inpainting graph.
 *
 * This is the outpaint workflow with `ImagePadForOutpaint` removed: there the mask
 * is synthesised from the padding, here it arrives with the image. ComfyUI's
 * `LoadImage` returns MASK as `1 - alpha`, so one RGBA upload feeds both the
 * `pixels` and `mask` inputs of `InpaintModelConditioning` — which is what lets an
 * inpaint fit the job queue's one-upload-per-job contract.
 */
const INPAINT_WORKFLOW: Record<string, any> = {
  '3': {
    inputs: { seed: 0, steps: 20, cfg: 1, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['39', 0], positive: ['38', 0], negative: ['38', 1], latent_image: ['38', 2] },
    class_type: 'KSampler',
  },
  '8': {
    inputs: { samples: ['3', 0], vae: ['32', 0] },
    class_type: 'VAEDecode',
  },
  '9': {
    inputs: { filename_prefix: 'inpaint_', images: ['8', 0] },
    class_type: 'SaveImage',
  },
  '17': {
    inputs: { image: '__pp_pending_upload__' },
    class_type: 'LoadImage',
  },
  '23': {
    inputs: { text: '', clip: ['34', 0] },
    class_type: 'CLIPTextEncode',
  },
  '26': {
    inputs: { guidance: 30, conditioning: ['23', 0] },
    class_type: 'FluxGuidance',
  },
  '31': {
    inputs: { unet_name: 'flux1-fill-dev.safetensors', weight_dtype: 'default' },
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
  '35': {
    inputs: { mask: ['17', 1], expand: 0, tapered_corners: true },
    class_type: 'GrowMask',
  },
  '38': {
    inputs: { noise_mask: false, positive: ['26', 0], negative: ['46', 0], vae: ['32', 0], pixels: ['17', 0], mask: ['35', 0] },
    class_type: 'InpaintModelConditioning',
  },
  '39': {
    inputs: { strength: 1, model: ['31', 0] },
    class_type: 'DifferentialDiffusion',
  },
  '46': {
    inputs: { conditioning: ['23', 0] },
    class_type: 'ConditioningZeroOut',
  },
};

const ZOOM_STEP = 1.2;
const MIN_ZOOM = 1;
const MAX_ZOOM = 12;

/** A LoRA to chain between the UNET/CLIP loaders and their consumers. */
interface InpaintLora {
  name: string;
  strengthModel: number;
  strengthClip: number;
}

/** One painted stroke, in image pixel coordinates. Kept so undo can replay. */
interface Stroke {
  points: { x: number; y: number }[];
  radius: number;
  erase: boolean;
}

interface InpaintParams {
  seed: number;
  steps: number;
  cfg: number;
  samplerName: string | null;
  scheduler: string | null;
  positivePrompt: string;
  guidance: number;
  maskExpand: number;
}

@Component({
  selector: 'pp-inpaint-dialog',
  imports: [DecimalPipe, DialogTitleDirective, FormsModule, MatDialogModule, MatFormFieldModule,
            MatInputModule, MatSelectModule, MatButtonModule, MatButtonToggleModule,
            MatIconModule, MatCheckboxModule, MatTooltipModule,
            ComfyUrlRowComponent],
  templateUrl: './inpaint-dialog.html',
  styleUrl: './inpaint-dialog.scss',
})
export class InpaintDialog {
  readonly data: InpaintDialogData = inject(MAT_DIALOG_DATA);
  private photoService = inject(PhotoService);
  private snackBar = inject(MatSnackBar);
  private connState = inject(ConnectionStateService);
  comfy = inject(ComfyConnectionService);
  private destroyRef = inject(DestroyRef);

  private viewCanvas = viewChild<ElementRef<HTMLCanvasElement>>('view');
  private canvasWrap = viewChild<ElementRef<HTMLElement>>('wrap');
  private wrapObserver?: ResizeObserver;

  sending = false;
  copyResult = false;
  /** Composite the render back over the original so unmasked pixels survive the VAE. */
  keepUnmasked = true;

  loading = true;
  loadError = '';
  imageWidth = 0;
  imageHeight = 0;

  brush = 60;
  erase = false;

  /** Display scale relative to fit-in-panel. 1 = fitted, >1 = zoomed in. */
  zoom = 1;
  /** Scale at which the image exactly fits the panel; the anchor `zoom` multiplies. */
  private fitScale = 1;
  private panning = false;
  private panFrom = { x: 0, y: 0, left: 0, top: 0 };

  availableLoras: string[] = [];
  loras: InpaintLora[] = [];

  availableModels: string[] = [];
  selectedModel = 'flux1-fill-dev.safetensors';
  availableSamplers: string[] = [];
  availableSchedulers: string[] = [];

  params: InpaintParams = {
    seed: 0,
    steps: 20,
    cfg: 1,
    samplerName: 'euler',
    scheduler: 'normal',
    positivePrompt: '',
    guidance: 30,
    maskExpand: 0,
  };

  /** The source image at native resolution — the paint target and the export base. */
  private image = new Image();
  /** Painted coverage, native resolution. Only its alpha channel is used. */
  private maskCanvas = document.createElement('canvas');
  private strokes: Stroke[] = [];
  private active: Stroke | null = null;

  constructor() {
    this.comfy.init();
    if (this.comfy.checkStatus === 'ok') {
      this.availableSamplers = [...this.connState.comfy.samplers];
      this.availableSchedulers = [...this.connState.comfy.schedulers];
      this.fetchUnetModels();
      this.fetchLoras();
    }
    this.randomizeSeed();
    this.loadImage();
    this.destroyRef.onDestroy(() => this.wrapObserver?.disconnect());
  }

  get hasMask(): boolean {
    return this.strokes.length > 0;
  }

  // --- image + canvas ---------------------------------------------------

  private loadImage(): void {
    this.image.onload = () => {
      this.imageWidth = this.image.naturalWidth;
      this.imageHeight = this.image.naturalHeight;
      this.maskCanvas.width = this.imageWidth;
      this.maskCanvas.height = this.imageHeight;
      // A brush sized off the image keeps the default usable at any resolution.
      this.brush = Math.max(16, Math.round(Math.min(this.imageWidth, this.imageHeight) / 12));
      this.loading = false;
      this.zoom = 1;
      this.redraw();
    };
    this.image.onerror = () => {
      this.loading = false;
      this.loadError = 'Could not load the image.';
    };
    this.image.src = this.photoService.getImageUrl(this.data.filename, this.data.folder);
  }

  /** Displayed width in CSS pixels. The canvas keeps its native pixel size; only
   *  the box it is painted into changes, so strokes stay full resolution. */
  get displayWidth(): number {
    return Math.round(this.imageWidth * this.fitScale * this.zoom);
  }

  /** Track the panel's size: the dialog is still animating open when the canvas
   *  first paints, so measuring once would fit to a mid-animation box. */
  private watchWrap(): void {
    const wrap = this.canvasWrap()?.nativeElement;
    if (!wrap || this.wrapObserver) return;
    this.wrapObserver = new ResizeObserver(() => this.computeFitScale());
    this.wrapObserver.observe(wrap);
  }

  /** Largest scale that still fits the panel, never enlarging past 100%. */
  private computeFitScale(): void {
    const wrap = this.canvasWrap()?.nativeElement;
    if (!wrap || !this.imageWidth) return;
    const style = getComputedStyle(wrap);
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const w = wrap.clientWidth - padX;
    const h = wrap.clientHeight - padY;
    if (w <= 0 || h <= 0) return;
    this.fitScale = Math.min(w / this.imageWidth, h / this.imageHeight, 1);
  }

  fitToPanel(): void {
    this.zoom = 1;
    this.computeFitScale();
  }

  /** Wheel zooms about the cursor, so the pixel under it stays put. */
  onWheel(ev: WheelEvent): void {
    if (this.loading || this.loadError) return;
    ev.preventDefault();
    const wrap = this.canvasWrap()?.nativeElement;
    const el = this.viewCanvas()?.nativeElement;
    if (!wrap || !el) return;

    const before = el.getBoundingClientRect();
    const fx = (ev.clientX - before.left) / before.width;
    const fy = (ev.clientY - before.top) / before.height;

    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM,
      this.zoom * (ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)));
    if (next === this.zoom) return;
    this.zoom = next;

    // The new layout only exists after Angular writes the width back out.
    requestAnimationFrame(() => {
      const after = el.getBoundingClientRect();
      wrap.scrollLeft += (after.left + fx * after.width) - ev.clientX;
      wrap.scrollTop += (after.top + fy * after.height) - ev.clientY;
    });
  }

  /** Middle-drag pans, leaving left-drag free to paint. */
  onCanvasPointerDown(ev: PointerEvent): void {
    const wrap = this.canvasWrap()?.nativeElement;
    if (ev.button === 1 && wrap) {
      ev.preventDefault();
      this.panning = true;
      this.panFrom = { x: ev.clientX, y: ev.clientY, left: wrap.scrollLeft, top: wrap.scrollTop };
      (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
      return;
    }
    this.onPointerDown(ev);
  }

  onCanvasPointerMove(ev: PointerEvent): void {
    const wrap = this.canvasWrap()?.nativeElement;
    if (this.panning && wrap) {
      wrap.scrollLeft = this.panFrom.left - (ev.clientX - this.panFrom.x);
      wrap.scrollTop = this.panFrom.top - (ev.clientY - this.panFrom.y);
      return;
    }
    this.onPointerMove(ev);
  }

  onCanvasPointerUp(ev: PointerEvent): void {
    if (this.panning) {
      this.panning = false;
      (ev.target as HTMLElement).releasePointerCapture?.(ev.pointerId);
      return;
    }
    this.onPointerUp(ev);
  }

  /** Image pixel coordinates for a pointer event on the CSS-scaled canvas. */
  private toImage(ev: PointerEvent): { x: number; y: number } {
    const el = this.viewCanvas()!.nativeElement;
    const r = el.getBoundingClientRect();
    return {
      x: ((ev.clientX - r.left) / r.width) * this.imageWidth,
      y: ((ev.clientY - r.top) / r.height) * this.imageHeight,
    };
  }

  onPointerDown(ev: PointerEvent): void {
    if (this.loading || this.loadError) return;
    ev.preventDefault();
    (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
    this.active = { points: [this.toImage(ev)], radius: this.brush / 2, erase: this.erase };
    this.strokes.push(this.active);
    this.redraw();
  }

  onPointerMove(ev: PointerEvent): void {
    if (!this.active) return;
    this.active.points.push(this.toImage(ev));
    this.redraw();
  }

  onPointerUp(ev: PointerEvent): void {
    if (!this.active) return;
    (ev.target as HTMLElement).releasePointerCapture?.(ev.pointerId);
    this.active = null;
  }

  undo(): void {
    this.strokes.pop();
    this.redraw();
  }

  clearMask(): void {
    this.strokes = [];
    this.redraw();
  }

  /** Replay every stroke into the mask, then paint image + red overlay on screen. */
  private redraw(): void {
    const el = this.viewCanvas()?.nativeElement;
    if (!this.imageWidth) return;
    if (!el) {
      // The canvas lives behind @if (loading), so on the first paint it isn't in
      // the DOM yet — come back once Angular has rendered it.
      setTimeout(() => this.redraw());
      return;
    }
    el.width = this.imageWidth;
    el.height = this.imageHeight;
    this.watchWrap();

    const mctx = this.maskCanvas.getContext('2d')!;
    mctx.clearRect(0, 0, this.imageWidth, this.imageHeight);
    mctx.lineCap = 'round';
    mctx.lineJoin = 'round';
    mctx.strokeStyle = '#fff';
    mctx.fillStyle = '#fff';

    for (const s of this.strokes) {
      mctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
      mctx.lineWidth = s.radius * 2;
      const [first, ...rest] = s.points;
      // A tap with no drag still has to leave a dot, so always stamp the origin.
      mctx.beginPath();
      mctx.arc(first.x, first.y, s.radius, 0, Math.PI * 2);
      mctx.fill();
      if (rest.length) {
        mctx.beginPath();
        mctx.moveTo(first.x, first.y);
        for (const p of rest) mctx.lineTo(p.x, p.y);
        mctx.stroke();
      }
    }
    mctx.globalCompositeOperation = 'source-over';

    const ctx = el.getContext('2d')!;
    ctx.clearRect(0, 0, this.imageWidth, this.imageHeight);
    ctx.drawImage(this.image, 0, 0);
    ctx.save();
    ctx.globalAlpha = 0.45;
    // Tint the coverage red rather than leaving it white, so it reads as "will change".
    ctx.drawImage(this.tinted(), 0, 0);
    ctx.restore();
  }

  /** The mask coverage rendered in red, for the on-screen overlay only. */
  private tinted(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.imageWidth;
    c.height = this.imageHeight;
    const cx = c.getContext('2d')!;
    cx.drawImage(this.maskCanvas, 0, 0);
    cx.globalCompositeOperation = 'source-in';
    cx.fillStyle = '#ff2d2d';
    cx.fillRect(0, 0, c.width, c.height);
    return c;
  }

  /**
   * What gets posted: the painted coverage alone, white on black.
   *
   * The backend merges it into the source's alpha with Pillow. Compositing here
   * instead would premultiply — every fully transparent pixel would lose its
   * colour, and the graph reads the source image through the mask in two places
   * where that would surface as black.
   */
  private coveragePng(): string {
    const c = document.createElement('canvas');
    c.width = this.imageWidth;
    c.height = this.imageHeight;
    const cx = c.getContext('2d')!;
    cx.fillStyle = '#000';
    cx.fillRect(0, 0, c.width, c.height);
    cx.drawImage(this.maskCanvas, 0, 0);   // strokes are already white
    return c.toDataURL('image/png');
  }

  // --- generation -------------------------------------------------------

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

  private fetchLoras(): void {
    this.photoService.getComfyLoras(this.comfy.comfyUrl).subscribe({
      next: (res) => this.availableLoras = res.loras || [],
      error: () => this.availableLoras = [],
    });
  }

  private buildWorkflow(): Record<string, any> {
    const wf: Record<string, any> = JSON.parse(JSON.stringify(INPAINT_WORKFLOW));
    const p = this.params;

    wf['3'].inputs.seed = p.seed;
    wf['3'].inputs.steps = p.steps;
    wf['3'].inputs.cfg = p.cfg;
    if (p.samplerName) wf['3'].inputs.sampler_name = p.samplerName;
    if (p.scheduler) wf['3'].inputs.scheduler = p.scheduler;

    // Chain LoRAs between the loaders and their consumers: UNETLoader -> ... ->
    // DifferentialDiffusion for MODEL, DualCLIPLoader -> ... -> CLIPTextEncode for CLIP.
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
    wf['39'].inputs.model = modelRef;
    wf['23'].inputs.clip = clipRef;

    wf['23'].inputs.text = p.positivePrompt;
    wf['26'].inputs.guidance = p.guidance;
    wf['35'].inputs.expand = p.maskExpand;
    if (this.selectedModel) wf['31'].inputs.unet_name = this.selectedModel;

    if (this.keepUnmasked) {
      // Flux Fill re-encodes the whole frame, so untouched areas drift. Paste the
      // render back through the mask to keep them bit-for-bit.
      wf['47'] = {
        inputs: {
          destination: ['17', 0], source: ['8', 0],
          x: 0, y: 0, resize_source: false, mask: ['35', 0],
        },
        class_type: 'ImageCompositeMasked',
      };
      wf['9'].inputs.images = ['47', 0];
    }
    return wf;
  }

  send(): void {
    if (!this.hasMask) {
      this.snackBar.open('Paint the area to replace first', '', { duration: 3000 });
      return;
    }
    this.sending = true;
    const src = this.data.folder ? `${this.data.folder}/${this.data.filename}` : this.data.filename;

    // The mask goes to disk first: a job uploads a *path* when it runs, which is
    // what keeps the operation working when ComfyUI isn't up yet.
    this.photoService.saveMask(src, this.coveragePng()).subscribe({
      next: (res) => {
        const workflow = this.buildWorkflow();
        this.photoService.enqueueJob('comfy', `Inpaint · ${this.data.filename}`, {
          prompts: [{ workflow, uploadNodeId: '17' }],
          copyResult: this.copyResult,
          upload: { path: res.path },
        }).subscribe({
          next: () => {
            this.sending = false;
            this.snackBar.open('Inpaint queued', '', { duration: 3000 });
            this.randomizeSeed();
          },
          error: (err) => this.fail(err),
        });
      },
      error: (err) => this.fail(err),
    });
  }

  private fail(err: any): void {
    this.sending = false;
    const msg = err.error?.error || err.message || 'Failed to queue';
    this.snackBar.open(`Error: ${msg}`, '', { duration: 5000 });
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
