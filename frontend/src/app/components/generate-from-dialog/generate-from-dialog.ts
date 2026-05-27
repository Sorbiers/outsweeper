import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { catchError, of, switchMap } from 'rxjs';
import { ConnectionStateService } from '../../services/connection-state.service';
import { PhotoService } from '../../services/photo.service';
import { STORAGE_KEYS } from '../../constants';
import { PrompterDialog } from '../prompter-dialog/prompter-dialog';

export interface GenerateFromDialogData {
  filename: string;
  folder: string;
  imageWidth: number | null;
  imageHeight: number | null;
  imageComfyPrompt?: Record<string, any>;
}

/** Full workflow from F:\down\full_flow.json — embedded as constant */
const FULL_FLOW_WORKFLOW: Record<string, any> = {
  "3": {
    "inputs": { "seed": 560957029626234, "steps": 21, "cfg": 3.2, "sampler_name": "euler", "scheduler": "beta", "denoise": 0.49, "model": ["15", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["11", 0] },
    "class_type": "KSampler"
  },
  "4": {
    "inputs": { "ckpt_name": "flux1-dev-fp8.safetensors" },
    "class_type": "CheckpointLoaderSimple"
  },
  "5": {
    "inputs": { "width": 1920, "height": 1080, "batch_size": 4 },
    "class_type": "EmptyLatentImage"
  },
  "6": {
    "inputs": { "text": "", "clip": ["15", 1] },
    "class_type": "CLIPTextEncode"
  },
  "7": {
    "inputs": { "text": "", "clip": ["15", 1] },
    "class_type": "CLIPTextEncode"
  },
  "8": {
    "inputs": { "samples": ["3", 0], "vae": ["13", 0] },
    "class_type": "VAEDecode"
  },
  "9": {
    "inputs": { "filename_prefix": "genFrom_", "images": ["8", 0] },
    "class_type": "SaveImage"
  },
  "10": {
    "inputs": { "image": "ComfyUI_00001_.png" },
    "class_type": "LoadImage"
  },
  "11": {
    "inputs": { "pixels": ["12", 0], "vae": ["13", 0] },
    "class_type": "VAEEncode"
  },
  "12": {
    "inputs": { "amount": 1, "image": ["21", 0] },
    "class_type": "RepeatImageBatch"
  },
  "13": {
    "inputs": { "vae_name": "ae.safetensors" },
    "class_type": "VAELoader"
  },
  "14": {
    "inputs": { "clip_name1": "clip_l.safetensors", "clip_name2": "t5xxl_fp16.safetensors", "type": "flux", "device": "default" },
    "class_type": "DualCLIPLoader"
  },
  "15": {
    "inputs": { "lora_name": "Illustration Factory V3.safetensors", "strength_model": 0.3, "strength_clip": 1, "model": ["20", 0], "clip": ["14", 0] },
    "class_type": "LoraLoader"
  },
  "20": {
    "inputs": { "unet_name": "fasciumKREAFLUXNSFW_v70.safetensors", "weight_dtype": "default" },
    "class_type": "UNETLoader"
  },
  "21": {
    "inputs": { "target_width": 1024, "target_height": 1024, "padding_color": "white", "interpolation": "area", "image": ["10", 0] },
    "class_type": "ResizeAndPadImage"
  }
};

interface FullFlowParams {
  seed: number | null;
  steps: number | null;
  cfg: number | null;
  denoise: number;
  batchSize: number | null;
  width: number | null;
  height: number | null;
  samplerName: string | null;
  scheduler: string | null;
  positivePrompt: string;
  negativePrompt: string;
}

interface ManualLora {
  name: string;
  strengthModel: number;
  strengthClip: number;
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

const DEFAULT_NEGATIVE_PROMPT = 'worst quality, low quality, bad anatomy, bad hands, text, watermark, blurry, deformed';

@Component({
  selector: 'pp-generate-from-dialog',
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatIconModule, MatCheckboxModule],
  templateUrl: './generate-from-dialog.html',
  styleUrl: './generate-from-dialog.scss',
})
export class GenerateFromDialog {
  private dialogRef = inject(MatDialogRef<GenerateFromDialog>);
  private data: GenerateFromDialogData = inject(MAT_DIALOG_DATA);
  private dialog = inject(MatDialog);
  private photoService = inject(PhotoService);
  private snackBar = inject(MatSnackBar);
  private connState = inject(ConnectionStateService);

  comfyUrl = '';
  params: FullFlowParams;
  sending = false;
  copyResult = false;
  checkStatus: 'idle' | 'checking' | 'ok' | 'error' = 'idle';
  hasRunComfyCommand = false;
  runTriggered = false;

  availableModels: { name: string; type: 'checkpoint' | 'unet' }[] = [];
  selectedModel = '';
  selectedModelType: 'checkpoint' | 'unet' | null = null;

  availableLoras: string[] = [];
  loraNodes: VariableNode[] = [];
  manualLoras: ManualLora[] = [];
  availableSamplers: string[] = [];
  availableSchedulers: string[] = [];

  showLoras = false;

  originalWidth: number | null;
  originalHeight: number | null;

  constructor() {
    this.comfyUrl = this.connState.comfy.url || '';

    if (this.comfyUrl && this.connState.comfy.status === 'ok') {
      this.checkStatus = 'ok';
      this.availableLoras = [...this.connState.comfy.loras];
      this.availableSamplers = [...this.connState.comfy.samplers];
      this.availableSchedulers = [...this.connState.comfy.schedulers];
      // Rebuild combined model list from cached state
      this.availableModels = [
        ...this.connState.comfy.checkpoints.map(n => ({ name: n, type: 'checkpoint' as const })),
      ];
      this.fetchModels(); // refresh to also get unets
    }

    // Extract params from the base workflow, then override from image's ComfyUI prompt if present
    const baseWorkflow = this.data.imageComfyPrompt ?? FULL_FLOW_WORKFLOW;
    this.params = this.extractParams(baseWorkflow);

    // Preload image dimensions
    this.originalWidth  = this.data.imageWidth;
    this.originalHeight = this.data.imageHeight;
    if (this.data.imageWidth  != null) this.params.width  = this.data.imageWidth;
    if (this.data.imageHeight != null) this.params.height = this.data.imageHeight;

    // Always start with a random seed
    this.randomizeSeed();

    // Extract LoRA nodes from the fixed workflow
    this.loraNodes = this.extractVariableNodes(FULL_FLOW_WORKFLOW, 'lora_name');

    this.photoService.getConfig().subscribe(cfg => {
      this.hasRunComfyCommand = !!cfg.has_run_comfy_command;
      if (!this.comfyUrl) this.comfyUrl = cfg.comfy_url || '';
    });
  }

  onUrlChange(): void {
    if (this.comfyUrl !== this.connState.comfy.url) {
      this.checkStatus = 'idle';
    }
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
        this.fetchModels();
        this.fetchLoras();
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

  openPrompter(): void {
    this.dialog.open(PrompterDialog, { width: '600px' }).afterClosed().subscribe(result => {
      if (result) this.params.positivePrompt = result;
    });
  }

  onModelChange(name: string): void {
    const found = this.availableModels.find(m => m.name === name);
    this.selectedModelType = found?.type ?? null;
  }

  addLora(): void {
    this.manualLoras.push({ name: '', strengthModel: 0.7, strengthClip: 0.7 });
    this.showLoras = true;
  }

  removeLora(index: number): void {
    this.manualLoras.splice(index, 1);
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

    if (this.params.denoise < 1) {
      // img2img: upload current image to ComfyUI first
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
    } else {
      // txt2img: no upload needed
      unload$.subscribe(() => this._doSend(null));
    }
  }

  private _doSend(uploadedImageName: string | null): void {
    const workflow = this.applyFullFlowParams(FULL_FLOW_WORKFLOW, this.params, uploadedImageName);
    const finalWorkflow = this.injectManualLoras(
      this.removeEmptyLoraNodes(workflow),
      this.manualLoras.filter(l => l.name),
    );

    this.photoService.sendToComfy(this.comfyUrl, finalWorkflow, this.copyResult).subscribe({
      next: () => {
        this.sending = false;
        this.snackBar.open('Prompt queued', '', { duration: 3000 });
        this.randomizeSeed(); // auto-randomize for next send
      },
      error: (err) => {
        this.sending = false;
        const msg = err.error?.error || err.message || 'Failed to send';
        this.snackBar.open(`Error: ${msg}`, '', { duration: 5000 });
      },
    });
  }

  private applyFullFlowParams(
    workflow: Record<string, any>,
    params: FullFlowParams,
    uploadedImageName: string | null,
  ): Record<string, any> {
    const copy: Record<string, any> = JSON.parse(JSON.stringify(workflow));
    let positiveSet = false;
    let negativeSet = false;

    // --- 1. Standard params ---
    for (const [nodeId, node] of Object.entries(copy)) {
      const inputs = node.inputs || {};
      const ct = node.class_type || '';

      if ('steps' in inputs && 'cfg' in inputs) {
        if (params.steps != null)    inputs.steps        = params.steps;
        if (params.cfg != null)      inputs.cfg          = params.cfg;
        if ('seed' in inputs && params.seed != null) inputs.seed = params.seed;
        if (params.samplerName)      inputs.sampler_name = params.samplerName;
        if (params.scheduler)        inputs.scheduler    = params.scheduler;
        if ('denoise' in inputs)     inputs.denoise      = params.denoise;
      }

      if ('batch_size' in inputs && params.batchSize != null) {
        inputs.batch_size = params.batchSize;
      }

      if (ct === 'CLIPTextEncode' && 'text' in inputs) {
        if (!positiveSet) {
          inputs.text = params.positivePrompt;
          positiveSet = true;
        } else if (!negativeSet) {
          inputs.text = params.negativePrompt;
          negativeSet = true;
        }
      }

      // Apply LoRA node changes (single-select in this dialog)
      const loraNode = this.loraNodes.find(n => n.nodeId === nodeId);
      if (loraNode && inputs) {
        if (loraNode.removed) {
          inputs['lora_name'] = '';
        } else {
          // Apply the selected LoRA name (empty string → removeEmptyLoraNodes will drop the node)
          inputs['lora_name'] = loraNode.selected[0] ?? '';
          if (loraNode.strengthModel != null) inputs['strength_model'] = loraNode.strengthModel;
          if (loraNode.strengthClip  != null) inputs['strength_clip']  = loraNode.strengthClip;
        }
      }
    }

    // --- 2. Denoise mode ---
    if (params.denoise >= 1.0) {
      // txt2img: wire EmptyLatentImage → KSampler, remove img2img chain
      const emptyLatentEntry = Object.entries(copy).find(([, n]) => n.class_type === 'EmptyLatentImage');
      const ksamplerEntry    = Object.entries(copy).find(([, n]) => n.class_type === 'KSampler');

      if (emptyLatentEntry && ksamplerEntry) {
        const [emptyId, emptyNode] = emptyLatentEntry;
        if (params.width  != null) emptyNode.inputs.width  = params.width;
        if (params.height != null) emptyNode.inputs.height = params.height;
        ksamplerEntry[1].inputs.latent_image = [emptyId, 0];
      }

      // Remove img2img chain to avoid LoadImage failure
      const IMG2IMG_TYPES = new Set(['LoadImage', 'ResizeAndPadImage', 'RepeatImageBatch', 'VAEEncode']);
      for (const [id, node] of Object.entries(copy)) {
        if (IMG2IMG_TYPES.has(node.class_type)) {
          delete copy[id];
        }
      }
    } else {
      // img2img: set uploaded image name, optionally update resize target
      const loadImageEntry   = Object.entries(copy).find(([, n]) => n.class_type === 'LoadImage');
      const resizeEntry      = Object.entries(copy).find(([, n]) => n.class_type === 'ResizeAndPadImage');
      const repeatBatchEntry = Object.entries(copy).find(([, n]) => n.class_type === 'RepeatImageBatch');

      if (loadImageEntry && uploadedImageName) {
        loadImageEntry[1].inputs.image = uploadedImageName;
      }

      if (resizeEntry) {
        const sizeModified = params.width !== this.originalWidth || params.height !== this.originalHeight;
        if (sizeModified) {
          if (params.width  != null) resizeEntry[1].inputs.target_width  = params.width;
          if (params.height != null) resizeEntry[1].inputs.target_height = params.height;
        }
      }

      if (repeatBatchEntry && params.batchSize != null) {
        repeatBatchEntry[1].inputs.amount = params.batchSize;
      }
    }

    // --- 3. Model selection ---
    if (this.selectedModel && this.selectedModelType) {
      if (this.selectedModelType === 'checkpoint') {
        // Find CheckpointLoaderSimple and set checkpoint name
        const ckptEntry = Object.entries(copy).find(([, n]) => n.class_type === 'CheckpointLoaderSimple');
        const unetEntry = Object.entries(copy).find(([, n]) => n.class_type === 'UNETLoader');
        const dualClipEntry = Object.entries(copy).find(([, n]) => n.class_type === 'DualCLIPLoader');
        const vaeLoaderEntry = Object.entries(copy).find(([, n]) => n.class_type === 'VAELoader');

        if (ckptEntry) {
          const [ckptId] = ckptEntry;
          ckptEntry[1].inputs.ckpt_name = this.selectedModel;

          for (const node of Object.values(copy)) {
            const inp = node.inputs || {};

            // Rewire LoraLoader: model from UNETLoader → checkpoint[0]
            if (node.class_type === 'LoraLoader') {
              if (unetEntry && Array.isArray(inp.model) && inp.model[0] === unetEntry[0]) {
                inp.model = [ckptId, 0];
              }
              // Rewire LoraLoader: clip from DualCLIPLoader → checkpoint[1]
              if (dualClipEntry && Array.isArray(inp.clip) && inp.clip[0] === dualClipEntry[0]) {
                inp.clip = [ckptId, 1];
              }
            }

            // Rewire VAEDecode: vae from VAELoader → checkpoint[2]
            if (node.class_type === 'VAEDecode') {
              if (vaeLoaderEntry && Array.isArray(inp.vae) && inp.vae[0] === vaeLoaderEntry[0]) {
                inp.vae = [ckptId, 2];
              }
            }
          }
        }
      } else if (this.selectedModelType === 'unet') {
        const unetEntry = Object.entries(copy).find(([, n]) => n.class_type === 'UNETLoader');
        if (unetEntry) {
          unetEntry[1].inputs.unet_name = this.selectedModel;
        }
      }
    }

    return copy;
  }

  private extractParams(workflow: Record<string, any>): FullFlowParams {
    const params: FullFlowParams = {
      seed:           null,
      steps:          null,
      cfg:            null,
      denoise:        1.0,
      batchSize:      null,
      width:          null,
      height:         null,
      samplerName:    null,
      scheduler:      null,
      positivePrompt: '',
      negativePrompt: '',
    };

    for (const node of Object.values(workflow)) {
      const inputs = node.inputs || {};
      const ct     = node.class_type || '';

      if ('steps' in inputs && 'cfg' in inputs) {
        params.steps = inputs.steps;
        params.cfg   = inputs.cfg;
        if ('seed'         in inputs) params.seed        = inputs.seed;
        if ('sampler_name' in inputs) params.samplerName = inputs.sampler_name;
        if ('scheduler'    in inputs) params.scheduler   = inputs.scheduler;
        // do NOT extract denoise from the image flow — always default to 1.0
      }

      if ('batch_size' in inputs) params.batchSize = inputs.batch_size;

      if ((ct === 'EmptyLatentImage' || ct === 'EmptySD3LatentImage')) {
        if ('width'  in inputs) params.width  = inputs.width;
        if ('height' in inputs) params.height = inputs.height;
      }

      if (ct === 'CLIPTextEncode' && 'text' in inputs) {
        if (!params.positivePrompt) {
          params.positivePrompt = inputs.text;
        } else if (!params.negativePrompt) {
          params.negativePrompt = inputs.text;
        }
      }
    }

    // Fill from session storage if still null
    const ls = (k: string) => sessionStorage.getItem(k);
    if (params.steps     == null) { const v = ls(STORAGE_KEYS.GEN_STEPS);     if (v) params.steps     = +v; }
    if (params.cfg       == null) { const v = ls(STORAGE_KEYS.GEN_CFG);       if (v) params.cfg       = +v; }
    if (params.batchSize == null) { const v = ls(STORAGE_KEYS.GEN_BATCH);     if (v) params.batchSize = +v; }
    if (!params.samplerName)      params.samplerName = ls(STORAGE_KEYS.GEN_SAMPLER);
    if (!params.scheduler)        params.scheduler   = ls(STORAGE_KEYS.GEN_SCHEDULER);
    if (!params.positivePrompt)   params.positivePrompt = ls(STORAGE_KEYS.GEN_POS_PROMPT) || '';
    if (!params.negativePrompt)   params.negativePrompt = ls(STORAGE_KEYS.GEN_NEG_PROMPT) || DEFAULT_NEGATIVE_PROMPT;

    return params;
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

  private fetchModels(): void {
    this.photoService.getComfyModels(this.comfyUrl).subscribe({
      next: (res) => {
        this.availableModels = res.models || [];
        // Update shared cache with checkpoints only
        this.connState.comfy.checkpoints = res.models
          .filter(m => m.type === 'checkpoint')
          .map(m => m.name);
      },
      error: () => this.availableModels = [],
    });
  }

  private fetchLoras(): void {
    this.photoService.getComfyLoras(this.comfyUrl).subscribe({
      next: (res) => { this.availableLoras = res.loras || []; this.connState.comfy.loras = [...this.availableLoras]; },
      error: () => this.availableLoras = [],
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
      const tailId = [...loraIds].find(id =>
        ![...loraIds].some(otherId =>
          otherId !== id && (
            (workflow[otherId].inputs?.model as any[])?.[0] === id ||
            (workflow[otherId].inputs?.clip  as any[])?.[0] === id
          )
        )
      ) ?? [...loraIds][loraIds.size - 1];
      insertAfterModel = [tailId, 0];
      insertAfterClip  = [tailId, 1];
    } else {
      const ckptEntry = Object.entries(workflow).find(([, n]) => n.class_type === 'CheckpointLoaderSimple');
      if (!ckptEntry) return workflow;
      insertAfterModel = [ckptEntry[0], 0];
      insertAfterClip  = [ckptEntry[0], 1];
    }

    const originalNodeIds = new Set(Object.keys(workflow));
    let maxId = Math.max(...Object.keys(workflow).map(Number).filter(n => !isNaN(n)), 100);

    let prevModel: [string, number] = insertAfterModel;
    let prevClip:  [string, number] = insertAfterClip;

    for (const lora of loras) {
      maxId++;
      const newId = String(maxId);
      workflow[newId] = {
        class_type: 'LoraLoader',
        inputs: {
          lora_name: lora.name,
          strength_model: lora.strengthModel,
          strength_clip:  lora.strengthClip,
          model: [...prevModel],
          clip:  [...prevClip],
        },
      };
      prevModel = [newId, 0];
      prevClip  = [newId, 1];
    }

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
      const clipInput  = workflow[nodeId].inputs.clip;
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
}
