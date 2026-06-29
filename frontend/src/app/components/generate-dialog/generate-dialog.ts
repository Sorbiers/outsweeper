import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CdkDrag, CdkDragHandle } from '@angular/cdk/drag-drop';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatDividerModule } from '@angular/material/divider';
import { MatMenuModule } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { forkJoin, Observable, of } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { STORAGE_KEYS } from '../../constants';
import { ComfyConnectionService } from '../../services/comfy-connection.service';
import { ConnectionStateService } from '../../services/connection-state.service';
import { DictionaryService } from '../../services/dictionary.service';
import { PhotoService } from '../../services/photo.service';
import { PromptHistoryService } from '../../services/prompt-history.service';
import { ComfyUrlRowComponent } from '../comfy-url-row/comfy-url-row';
import { DictionaryDialog } from '../dictionary-dialog/dictionary-dialog';
import { PromptHistoryDialog } from '../prompt-history-dialog/prompt-history-dialog';
import { PrompterDialog } from '../prompter-dialog/prompter-dialog';

export interface GenerateDialogData {
  workflow: Record<string, any>;
  positivePromptOverride?: string;
  title?: string;
  /** When set, the dialog runs in "Generate from" mode: shows Denoise and, when
   *  denoise < 1, uploads this image and rewires the flow to img2img. */
  sourceImage?: { filename: string; folder: string; width: number | null; height: number | null };
}

export interface GenerateCloseResult {
  copyResult: boolean;
}

export const DEFAULT_FLUX_WORKFLOW: Record<string, any> = {
  "9":     { "class_type": "SaveImage",             "inputs": { "filename_prefix": "ComfyUI", "images": ["41:8", 0] }, "_meta": { "title": "Save Image" } },
  "103":   { "class_type": "CLIPTextEncode",         "inputs": { "text": "worst quality, low quality, bad anatomy, bad hands, text, watermark, blurry, deformed", "clip": ["41:40", 0] }, "_meta": { "title": "CLIP Text Encode (Prompt)" } },
  "41:39": { "class_type": "VAELoader",              "inputs": { "vae_name": "ae.safetensors" }, "_meta": { "title": "Load VAE" } },
  "41:27": { "class_type": "EmptySD3LatentImage",    "inputs": { "width": 1024, "height": 1024, "batch_size": 1 }, "_meta": { "title": "EmptySD3LatentImage" } },
  "41:47": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "fluxmania_kreamania.safetensors" }, "_meta": { "title": "Load Checkpoint" } },
  "41:40": { "class_type": "DualCLIPLoader",         "inputs": { "clip_name1": "clip_l.safetensors", "clip_name2": "t5xxl_fp16.safetensors", "type": "flux", "device": "default" }, "_meta": { "title": "DualCLIPLoader" } },
  "41:45": { "class_type": "CLIPTextEncode",         "inputs": { "text": "", "clip": ["41:40", 0] }, "_meta": { "title": "CLIP Text Encode (Prompt)" } },
  "41:31": { "class_type": "KSampler",               "inputs": { "seed": 472850275239431, "steps": 20, "cfg": 1, "sampler_name": "euler", "scheduler": "simple", "denoise": 1, "model": ["41:47", 0], "positive": ["41:45", 0], "negative": ["103", 0], "latent_image": ["41:27", 0] }, "_meta": { "title": "KSampler" } },
  "41:8":  { "class_type": "VAEDecode",              "inputs": { "samples": ["41:31", 0], "vae": ["41:39", 0] }, "_meta": { "title": "VAE Decode" } }
};

interface WorkflowParams {
  seed: number | null;
  steps: number | null;
  cfg: number | null;
  denoise: number | null;
  batchSize: number | null;
  width: number | null;
  height: number | null;
  samplerName: string | null;
  scheduler: string | null;
  positivePrompt: string;
  negativePrompt: string;
}

interface VariableNode {
  nodeId: string;
  originalName: string;
  selected: string[];
  inputKey: string;
  removed?: boolean;
  strengthModel?: number;
  strengthClip?: number;
}

interface ManualLora {
  name: string;
  strengthModel: number;
  strengthClip: number;
}

const DEFAULT_NEGATIVE_PROMPT = 'worst quality, low quality, bad anatomy, bad hands, text, watermark, blurry, deformed';

@Component({
  selector: 'pp-generate-dialog',
  imports: [FormsModule, CdkDrag, CdkDragHandle, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatIconModule, MatCheckboxModule, MatMenuModule, MatDividerModule, MatTooltipModule, ComfyUrlRowComponent],
  templateUrl: './generate-dialog.html',
  styleUrl: './generate-dialog.scss',
})
export class GenerateDialog {
  private dialogRef = inject(MatDialogRef<GenerateDialog>);
  private data: GenerateDialogData = inject(MAT_DIALOG_DATA);
  private dialog = inject(MatDialog);
  private photoService = inject(PhotoService);
  private snackBar = inject(MatSnackBar);
  private connState = inject(ConnectionStateService);
  private dictionaries = inject(DictionaryService);
  private promptHistory = inject(PromptHistoryService);
  comfy = inject(ComfyConnectionService);

  params: WorkflowParams;
  sending = false;
  copyResult = false;
  randomizeSeedOnSend = false;
  jobsNumber = 1;
  hasDenoise = false;

  availableLoras: string[] = [];
  loraNodes: VariableNode[] = [];
  availableCheckpoints: string[] = [];
  checkpointNodes: VariableNode[] = [];
  manualLoras: ManualLora[] = [];
  availableSamplers: string[] = [];
  availableSchedulers: string[] = [];

  constructor() {
    this.dialogRef.disableClose = true;
    this.dialogRef.keydownEvents().subscribe(e => { if (e.key === 'Escape') this.dialogRef.close(); });
    this.comfy.init();

    if (this.comfy.checkStatus === 'ok') {
      this.availableLoras = [...this.connState.comfy.loras];
      this.availableCheckpoints = [...this.connState.comfy.checkpoints];
      this.availableSamplers = [...this.connState.comfy.samplers];
      this.availableSchedulers = [...this.connState.comfy.schedulers];
    }

    this.params = this.extractParams(this.data.workflow);
    if (this.data.positivePromptOverride) {
      this.params.positivePrompt = this.data.positivePromptOverride;
    }
    this.hasDenoise = Object.values(this.data.workflow).some(
      n => 'denoise' in (n.inputs || {}) && n.inputs.denoise !== 1.0,
    );
    // "Generate from" mode: surface a usable denoise default and a fresh seed.
    if (this.data.sourceImage) {
      if (this.params.denoise == null) this.params.denoise = 0.5;
      this.randomizeSeed();
    }
    this.loraNodes = this.extractVariableNodes(this.data.workflow, 'lora_name');
    this.checkpointNodes = this.extractVariableNodes(this.data.workflow, 'ckpt_name');

    // Pre-seed option lists from workflow values so dropdowns render
    // even before ComfyUI is connected (overwritten by full lists on connect).
    if (!this.availableSamplers.length && this.params.samplerName)
      this.availableSamplers = [this.params.samplerName];
    if (!this.availableSchedulers.length && this.params.scheduler)
      this.availableSchedulers = [this.params.scheduler];
    if (!this.availableLoras.length) {
      const names = [...new Set(this.loraNodes.map(n => n.originalName).filter(Boolean))];
      if (names.length) this.availableLoras = names;
    }
    if (!this.availableCheckpoints.length) {
      const names = [...new Set(this.checkpointNodes.map(n => n.originalName).filter(Boolean))];
      if (names.length) this.availableCheckpoints = names;
    }
  }

  onConnected(): void {
    this.fetchLoras();
    this.fetchCheckpoints();
    this.fetchSamplers();
  }

  get dialogTitle(): string {
    return this.data.title ?? 'Generate with ComfyUI';
  }

  /** True when launched from "Generate from" with a source image. */
  get sourceMode(): boolean {
    return !!this.data.sourceImage;
  }

  randomizeSeed(): void {
    this.params.seed = Math.floor(Math.random() * 2 ** 32);
  }

  openPrompter(): void {
    this.dialog.open(PrompterDialog, { width: '600px' }).afterClosed().subscribe(result => {
      if (result) {
        this.params.positivePrompt = result;
      }
    });
  }

  openDictionaries(): void {
    this.dialog.open(DictionaryDialog, { width: '70vw', maxWidth: '1000px' });
  }

  openPromptHistory(): void {
    this.dialog.open(PromptHistoryDialog, { width: '600px', maxWidth: '90vw' })
      .afterClosed().subscribe((picked?: string) => {
        // Only a picked prompt (always non-empty) is applied; Close emits '' and
        // Escape/backdrop emit undefined — both are ignored.
        if (picked) this.params.positivePrompt = picked;
      });
  }

  /**
   * A copy of the current params with `{{name}}` placeholders resolved against
   * the dictionaries. Called per queued prompt so batches vary independently.
   */
  private resolvedParams(): WorkflowParams {
    return {
      ...this.params,
      positivePrompt: this.dictionaries.substitute(this.params.positivePrompt),
      negativePrompt: this.dictionaries.substitute(this.params.negativePrompt),
    };
  }

  extractWorkflow(): void {
    const workflow = this.injectManualLoras(
      this.removeEmptyLoraNodes(this.applyParams(this.data.workflow, this.params)),
      this.manualLoras.filter(l => l.name),
    );
    this.downloadJson(workflow, 'workflow.json');
  }

  extractApi(): void {
    const workflow = this.injectManualLoras(
      this.removeEmptyLoraNodes(this.applyParams(this.data.workflow, this.params)),
      this.manualLoras.filter(l => l.name)
    );
    this.downloadJson(workflow, 'workflow_api.json');
  }

  private downloadJson(data: object, filename: string): void {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  addLora(): void {
    this.manualLoras.push({ name: '', strengthModel: 0.7, strengthClip: 0.7 });
  }

  removeLora(index: number): void {
    this.manualLoras.splice(index, 1);
  }

  send(front = false): void {
    this.saveParams();
    this.promptHistory.add(this.params.positivePrompt);
    this.sending = true;
    const lmstudioUrl = this.connState.lmstudio.url;
    const unload$ = lmstudioUrl
      ? this.photoService.unloadLmStudio(lmstudioUrl).pipe(catchError(() => of(null)))
      : of(null);

    const src = this.data.sourceImage;
    if (src && this.params.denoise != null && this.params.denoise < 1) {
      // img2img: upload the source image to ComfyUI before building the flow.
      unload$.pipe(
        switchMap(() => this.photoService.uploadToComfy(this.comfy.comfyUrl, src.filename, src.folder)),
      ).subscribe({
        next: res => this._doSend(front, res.name),
        error: err => {
          this.sending = false;
          this.snackBar.open(`Upload error: ${this.formatSendError(err)}`, 'Dismiss', { duration: 10000 });
        },
      });
    } else {
      unload$.subscribe(() => this._doSend(front));
    }
  }

  sendFront(): void {
    this.send(true);
  }

  /**
   * Build a readable message from a failed send. ComfyUI returns validation
   * errors as `{ error: { message, ... }, node_errors: {...} }` (an object),
   * which would otherwise stringify to "[object Object]".
   */
  private formatSendError(err: any): string {
    console.error('ComfyUI send failed', err);
    const body = err?.error;
    if (typeof body === 'string') return body;

    const parts: string[] = [];
    const inner = body?.error;
    if (typeof inner === 'string') parts.push(inner);
    else if (inner?.message) parts.push(inner.message);

    for (const [nodeId, ne] of Object.entries<any>(body?.node_errors ?? {})) {
      for (const e of ne?.errors ?? []) {
        parts.push(`[${nodeId}] ${e.message}${e.details ? ': ' + e.details : ''}`);
      }
    }

    return parts.join(' — ') || err?.message || 'Failed to send';
  }

  private _doSend(front = false, uploadedImageName: string | null = null): void {
    const notifySuccess = (count: number) => {
      this.sending = false;
      const msg = count > 1 ? `Queued ${count} prompts` : 'Prompt queued';
      const suffix = this.copyResult ? ' — will copy to folder' : '';
      this.snackBar.open(msg + suffix, '', { duration: 4000 });
    };

    // Build the final flow for one combo: loras, then (in source mode) img2img.
    const finalize = (wf: Record<string, any>) => {
      let out = this.injectManualLoras(this.removeEmptyLoraNodes(wf), this.manualLoras.filter(l => l.name));
      if (uploadedImageName) out = this.toImg2Img(out, uploadedImageName);
      return out;
    };

    const variableNodes = [
      ...this.checkpointNodes.filter(n => n.selected.length > 0),
      ...this.loraNodes.filter(n => n.selected.length > 0 && !n.removed),
    ];
    const combinations = variableNodes.length
      ? this.cartesian(variableNodes.map(n => n.selected))
      : [[]];

    // One job = the full Cartesian set; resolvedParams() re-rolls {{vars}} per combo.
    const buildJob = (): Observable<any>[] =>
      combinations.map(combo => {
        const workflow = this.applyParams(this.data.workflow, this.resolvedParams());
        combo.forEach((value, i) => {
          const node = variableNodes[i];
          if (workflow[node.nodeId]?.inputs) workflow[node.nodeId].inputs[node.inputKey] = value;
        });
        return this.photoService.sendToComfy(this.comfy.comfyUrl, finalize(workflow), this.copyResult, front);
      });

    // Re-randomize the seed and re-substitute template vars once per job.
    const requests: Observable<any>[] = [];
    for (let j = 0; j < this.jobCount; j++) {
      if (this.randomizeSeedOnSend) this.randomizeSeed();
      requests.push(...buildJob());
    }

    forkJoin(requests).subscribe({
      next: () => notifySuccess(requests.length),
      error: (err) => {
        this.sending = false;
        const msg = this.formatSendError(err);
        this.snackBar.open(`Error: ${msg}`, 'Dismiss', { duration: 10000 });
      },
    });
  }

  /** Number of jobs to queue per send (>= 1). */
  get jobCount(): number {
    return Math.max(1, Math.floor(Number(this.jobsNumber) || 1));
  }

  /** Cartesian combinations for one job (checkpoints × LoRAs). */
  get totalPrompts(): number {
    const variableNodes = [
      ...this.checkpointNodes.filter(n => n.selected.length > 0),
      ...this.loraNodes.filter(n => n.selected.length > 0 && !n.removed),
    ];
    if (variableNodes.length === 0) return 1;
    return variableNodes.reduce((acc, n) => acc * n.selected.length, 1);
  }

  /** Total prompts queued across all jobs. */
  get totalSends(): number {
    return this.jobCount * this.totalPrompts;
  }

  private fetchLoras(): void {
    this.photoService.getComfyLoras(this.comfy.comfyUrl).subscribe({
      next: (res) => { this.availableLoras = res.loras || []; this.connState.comfy.loras = [...this.availableLoras]; },
      error: () => this.availableLoras = [],
    });
  }

  private fetchCheckpoints(): void {
    this.photoService.getComfyCheckpoints(this.comfy.comfyUrl).subscribe({
      next: (res) => { this.availableCheckpoints = res.checkpoints || []; this.connState.comfy.checkpoints = [...this.availableCheckpoints]; },
      error: () => this.availableCheckpoints = [],
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
      error: () => {
        this.availableSamplers = [];
        this.availableSchedulers = [];
      },
    });
  }

  private saveParams(): void {
    const p = this.params;
    if (p.steps != null) sessionStorage.setItem(STORAGE_KEYS.GEN_STEPS, String(p.steps));
    if (p.cfg != null) sessionStorage.setItem(STORAGE_KEYS.GEN_CFG, String(p.cfg));
    if (p.batchSize != null) sessionStorage.setItem(STORAGE_KEYS.GEN_BATCH, String(p.batchSize));
    if (p.width != null) sessionStorage.setItem(STORAGE_KEYS.GEN_WIDTH, String(p.width));
    if (p.height != null) sessionStorage.setItem(STORAGE_KEYS.GEN_HEIGHT, String(p.height));
    if (p.samplerName) sessionStorage.setItem(STORAGE_KEYS.GEN_SAMPLER, p.samplerName);
    if (p.scheduler) sessionStorage.setItem(STORAGE_KEYS.GEN_SCHEDULER, p.scheduler);
    if (p.positivePrompt) sessionStorage.setItem(STORAGE_KEYS.GEN_POS_PROMPT, p.positivePrompt);
    if (p.negativePrompt) sessionStorage.setItem(STORAGE_KEYS.GEN_NEG_PROMPT, p.negativePrompt);
  }

  private extractVariableNodes(workflow: Record<string, any>, inputKey: string): VariableNode[] {
    const nodes: VariableNode[] = [];
    for (const [nodeId, node] of Object.entries(workflow)) {
      const inputs = node.inputs || {};
      if (inputKey in inputs) {
        const entry: VariableNode = {
          nodeId,
          originalName: inputs[inputKey],
          selected: inputs[inputKey] ? [inputs[inputKey]] : [],
          inputKey,
        };
        if (inputKey === 'lora_name') {
          entry.strengthModel = inputs['strength_model'] ?? 1.0;
          entry.strengthClip  = inputs['strength_clip']  ?? 1.0;
        }
        nodes.push(entry);
      }
    }
    return nodes;
  }

  /** Trace a node reference chain until a CLIPTextEncode is found; return its text. */
  private resolveClipText(ref: any, workflow: Record<string, any>): string {
    const visited = new Set<string>();
    let nodeId = Array.isArray(ref) ? ref[0] : null;
    while (nodeId && !visited.has(nodeId)) {
      visited.add(nodeId);
      const node = workflow[nodeId];
      if (!node) break;
      if (node.class_type === 'CLIPTextEncode') return node.inputs?.text ?? '';
      // Follow the first input reference onward (handles FluxGuidance etc.)
      const next = Object.values(node.inputs ?? {}).find(v => Array.isArray(v));
      nodeId = next ? (next as any)[0] : null;
    }
    return '';
  }

  private extractParams(workflow: Record<string, any>): WorkflowParams {
    const params: WorkflowParams = {
      seed: null, steps: null, cfg: null, denoise: null,
      batchSize: null, width: null, height: null,
      samplerName: null, scheduler: null,
      positivePrompt: '', negativePrompt: '',
    };

    for (const node of Object.values(workflow)) {
      const inputs = node.inputs || {};
      const classType = node.class_type || '';

      if ('steps' in inputs && 'cfg' in inputs) {
        params.steps = inputs.steps;
        params.cfg   = inputs.cfg;
        if ('seed'         in inputs) params.seed        = inputs.seed;
        if ('sampler_name' in inputs) params.samplerName = inputs.sampler_name;
        if ('scheduler'    in inputs) params.scheduler   = inputs.scheduler;
        if ('denoise'      in inputs && inputs.denoise !== 1.0) params.denoise = inputs.denoise;
        // Resolve prompts via KSampler references so order in the object doesn't matter
        params.positivePrompt = this.resolveClipText(inputs.positive, workflow);
        params.negativePrompt = this.resolveClipText(inputs.negative, workflow);
      }

      if ('batch_size' in inputs) params.batchSize = inputs.batch_size;

      if (classType === 'EmptyLatentImage' || classType === 'EmptySD3LatentImage') {
        if ('width'  in inputs) params.width  = inputs.width;
        if ('height' in inputs) params.height = inputs.height;
      }
    }

    // Fill empty fields from last used values
    const ls = (k: string) => sessionStorage.getItem(k);
    if (params.steps     == null) { const v = ls(STORAGE_KEYS.GEN_STEPS);  if (v) params.steps     = +v; }
    if (params.cfg       == null) { const v = ls(STORAGE_KEYS.GEN_CFG);    if (v) params.cfg       = +v; }
    if (params.batchSize == null) { const v = ls(STORAGE_KEYS.GEN_BATCH);  if (v) params.batchSize = +v; }
    if (params.width     == null) { const v = ls(STORAGE_KEYS.GEN_WIDTH);  if (v) params.width     = +v; }
    if (params.height    == null) { const v = ls(STORAGE_KEYS.GEN_HEIGHT); if (v) params.height    = +v; }
    if (!params.samplerName)  params.samplerName  = ls(STORAGE_KEYS.GEN_SAMPLER);
    if (!params.scheduler)    params.scheduler    = ls(STORAGE_KEYS.GEN_SCHEDULER);
    if (!params.positivePrompt) params.positivePrompt = ls(STORAGE_KEYS.GEN_POS_PROMPT) || '';
    if (!params.negativePrompt) params.negativePrompt = ls(STORAGE_KEYS.GEN_NEG_PROMPT) || DEFAULT_NEGATIVE_PROMPT;

    return params;
  }

  /** Find the node ID of the CLIPTextEncode reached by following ref in workflow. */
  private resolveClipNodeId(ref: any, workflow: Record<string, any>): string | null {
    const visited = new Set<string>();
    let nodeId = Array.isArray(ref) ? ref[0] : null;
    while (nodeId && !visited.has(nodeId)) {
      visited.add(nodeId);
      const node = workflow[nodeId];
      if (!node) break;
      if (node.class_type === 'CLIPTextEncode') return nodeId;
      const next = Object.values(node.inputs ?? {}).find(v => Array.isArray(v));
      nodeId = next ? (next as any)[0] : null;
    }
    return null;
  }

  private applyParams(workflow: Record<string, any>, params: WorkflowParams): Record<string, any> {
    const copy: Record<string, any> = JSON.parse(JSON.stringify(workflow));

    // Resolve positive/negative node IDs from KSampler references upfront
    const ksampler = Object.values(copy).find(n => 'steps' in (n.inputs || {}) && 'cfg' in (n.inputs || {}));
    const posNodeId = ksampler ? this.resolveClipNodeId(ksampler.inputs.positive, copy) : null;
    const negNodeId = ksampler ? this.resolveClipNodeId(ksampler.inputs.negative, copy) : null;

    for (const [nodeId, node] of Object.entries(copy)) {
      const inputs = node.inputs || {};
      const classType = node.class_type || '';

      if ('steps' in inputs && 'cfg' in inputs) {
        if (params.steps != null)  inputs.steps         = params.steps;
        if (params.cfg   != null)  inputs.cfg           = params.cfg;
        if ('seed' in inputs && params.seed != null) inputs.seed = params.seed;
        if (params.samplerName)    inputs.sampler_name  = params.samplerName;
        if (params.scheduler)      inputs.scheduler     = params.scheduler;
        if ('denoise' in inputs && params.denoise != null) inputs.denoise = params.denoise;
      }

      if ('batch_size' in inputs && params.batchSize != null) inputs.batch_size = params.batchSize;

      if (classType === 'EmptyLatentImage' || classType === 'EmptySD3LatentImage') {
        if (params.width  != null) inputs.width  = params.width;
        if (params.height != null) inputs.height = params.height;
      }

      if (classType === 'CLIPTextEncode' && 'text' in inputs) {
        if (nodeId === posNodeId) inputs.text = params.positivePrompt;
        else if (nodeId === negNodeId) inputs.text = params.negativePrompt;
      }

      const loraNode = this.loraNodes.find(n => n.nodeId === nodeId);
      if (loraNode && inputs) {
        if (loraNode.removed) {
          inputs['lora_name'] = '';
        } else {
          if (loraNode.strengthModel != null) inputs['strength_model'] = loraNode.strengthModel;
          if (loraNode.strengthClip  != null) inputs['strength_clip']  = loraNode.strengthClip;
        }
      }
    }

    return copy;
  }

  private injectManualLoras(workflow: Record<string, any>, loras: ManualLora[]): Record<string, any> {
    if (loras.length === 0) return workflow;

    const loraIds = new Set(
      Object.entries(workflow)
        .filter(([, n]) => n.class_type === 'LoraLoader')
        .map(([id]) => id)
    );

    let insertAfterModel: [string, number];
    let insertAfterClip: [string, number];

    if (loraIds.size > 0) {
      // Find the tail: a LoraLoader whose outputs aren't consumed by another LoraLoader
      const tailId = [...loraIds].find(id =>
        ![...loraIds].some(otherId =>
          otherId !== id && (
            (workflow[otherId].inputs?.model as any[])?.[0] === id ||
            (workflow[otherId].inputs?.clip as any[])?.[0] === id
          )
        )
      ) ?? [...loraIds][loraIds.size - 1];
      insertAfterModel = [tailId, 0];
      insertAfterClip = [tailId, 1];
    } else {
      const ckptEntry = Object.entries(workflow).find(([, n]) => n.class_type === 'CheckpointLoaderSimple');
      if (!ckptEntry) return workflow;
      insertAfterModel = [ckptEntry[0], 0];
      insertAfterClip = [ckptEntry[0], 1];
    }

    const originalNodeIds = new Set(Object.keys(workflow));
    let maxId = Math.max(...Object.keys(workflow).map(Number).filter(n => !isNaN(n)), 100);

    let prevModel: [string, number] = insertAfterModel;
    let prevClip: [string, number] = insertAfterClip;

    for (const lora of loras) {
      maxId++;
      const newId = String(maxId);
      workflow[newId] = {
        class_type: 'LoraLoader',
        inputs: {
          lora_name: lora.name,
          strength_model: lora.strengthModel,
          strength_clip: lora.strengthClip,
          model: [...prevModel],
          clip: [...prevClip],
        },
      };
      prevModel = [newId, 0];
      prevClip = [newId, 1];
    }

    // Rewire original nodes that consumed the old chain tail to use the new tail
    for (const nodeId of originalNodeIds) {
      const node = workflow[nodeId];
      for (const [key, val] of Object.entries(node.inputs ?? {})) {
        if (Array.isArray(val)) {
          if (val[0] === insertAfterModel[0] && val[1] === insertAfterModel[1]) {
            node.inputs[key] = [...prevModel];
          } else if (val[0] === insertAfterClip[0] && val[1] === insertAfterClip[1]) {
            node.inputs[key] = [...prevClip];
          }
        }
      }
    }

    return workflow;
  }

  private removeEmptyLoraNodes(workflow: Record<string, any>): Record<string, any> {
    const emptyLoraIds = Object.entries(workflow)
      .filter(([, n]) => n.class_type === 'LoraLoader' && !n.inputs?.lora_name)
      .map(([id]) => id);

    for (const nodeId of emptyLoraIds) {
      const modelInput = workflow[nodeId].inputs.model;
      const clipInput = workflow[nodeId].inputs.clip;
      for (const node of Object.values(workflow)) {
        for (const [key, val] of Object.entries(node.inputs ?? {})) {
          if (Array.isArray(val) && val[0] === nodeId) {
            node.inputs[key] = val[1] === 0 ? modelInput : clipInput;
          }
        }
      }
      delete workflow[nodeId];
    }
    return workflow;
  }

  private cartesian(arrays: string[][]): string[][] {
    return arrays.reduce<string[][]>(
      (acc, arr) => acc.flatMap(combo => arr.map(item => [...combo, item])),
      [[]]
    );
  }

  /**
   * Rewire a txt2img flow into img2img: feed the uploaded source image through
   * LoadImage → VAEEncode (reusing the flow's VAE) into the sampler's latent,
   * repeating it for batch sizes > 1. Denoise is already applied via applyParams.
   * The now-unreferenced EmptyLatentImage node is simply ignored by ComfyUI.
   */
  private toImg2Img(workflow: Record<string, any>, imageName: string): Record<string, any> {
    const entries = Object.entries(workflow);
    const ksampler = entries.find(([, n]) => n.inputs && 'latent_image' in n.inputs && 'denoise' in n.inputs)?.[1];
    if (!ksampler) return workflow;

    // VAE source: prefer the decoder's VAE input, else any VAELoader.
    let vaeRef: any = entries.find(([, n]) => n.class_type === 'VAEDecode' && Array.isArray(n.inputs?.vae))?.[1].inputs.vae;
    if (!vaeRef) {
      const vaeLoaderId = entries.find(([, n]) => n.class_type === 'VAELoader')?.[0];
      if (vaeLoaderId) vaeRef = [vaeLoaderId, 0];
    }
    if (!vaeRef) return workflow; // can't encode without a VAE — leave as txt2img

    let maxId = Math.max(...Object.keys(workflow).map(Number).filter(n => !isNaN(n)), 100);
    const loadId = String(++maxId);
    workflow[loadId] = { class_type: 'LoadImage', inputs: { image: imageName } };
    const encId = String(++maxId);
    workflow[encId] = { class_type: 'VAEEncode', inputs: { pixels: [loadId, 0], vae: [...vaeRef] } };

    let latentRef: [string, number] = [encId, 0];
    const batch = this.params.batchSize;
    if (batch != null && batch > 1) {
      const repId = String(++maxId);
      workflow[repId] = { class_type: 'RepeatLatentBatch', inputs: { samples: [encId, 0], amount: batch } };
      latentRef = [repId, 0];
    }
    ksampler.inputs.latent_image = latentRef;
    return workflow;
  }
}
