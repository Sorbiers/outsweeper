import { Component, inject } from '@angular/core';
import { CdkDrag, CdkDragHandle } from '@angular/cdk/drag-drop';
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
import { ComfyConnectionService } from '../../services/comfy-connection.service';
import { ConnectionStateService } from '../../services/connection-state.service';
import { PhotoService } from '../../services/photo.service';
import { STORAGE_KEYS } from '../../constants';
import { ComfyUrlRowComponent } from '../comfy-url-row/comfy-url-row';
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
  imports: [CdkDrag, CdkDragHandle, FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatIconModule, MatCheckboxModule, ComfyUrlRowComponent],
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
  comfy = inject(ComfyConnectionService);

  params: FullFlowParams;
  sending = false;
  copyResult = false;

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
    this.dialogRef.disableClose = true;
    this.dialogRef.keydownEvents().subscribe(e => { if (e.key === 'Escape') this.dialogRef.close(); });
    this.comfy.init();

    if (this.comfy.checkStatus === 'ok') {
      this.availableLoras = [...this.connState.comfy.loras];
      this.availableSamplers = [...this.connState.comfy.samplers];
      this.availableSchedulers = [...this.connState.comfy.schedulers];
      this.availableModels = [
        ...this.connState.comfy.checkpoints.map(n => ({ name: n, type: 'checkpoint' as const })),
      ];
      this.fetchModels();
    }

    const baseWorkflow = this.data.imageComfyPrompt ?? FULL_FLOW_WORKFLOW;
    this.params = this.extractParams(baseWorkflow);

    if (this.data.imageComfyPrompt) {
      const modelInfo = this.extractModelFromWorkflow(this.data.imageComfyPrompt);
      if (modelInfo) {
        this.selectedModel     = modelInfo.name;
        this.selectedModelType = modelInfo.type;
      }
    }

    this.originalWidth  = this.data.imageWidth;
    this.originalHeight = this.data.imageHeight;
    if (this.data.imageWidth  != null) this.params.width  = this.data.imageWidth;
    if (this.data.imageHeight != null) this.params.height = this.data.imageHeight;

    this.randomizeSeed();
    this.loraNodes = this.extractVariableNodes(FULL_FLOW_WORKFLOW, 'lora_name');
  }

  onConnected(): void {
    this.fetchModels();
    this.fetchLoras();
    this.fetchSamplers();
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

  saveWorkflow(): void {
    const workflow = this.injectManualLoras(
      this.removeEmptyLoraNodes(this.applyFullFlowParams(FULL_FLOW_WORKFLOW, this.params, null)),
      this.manualLoras.filter(l => l.name),
    );
    this.downloadJson(workflow, 'full_flow_api.json');
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

  send(front = false): void {
    this.sending = true;

    const lmstudioUrl = this.connState.lmstudio.url;
    const unload$ = lmstudioUrl
      ? this.photoService.unloadLmStudio(lmstudioUrl).pipe(catchError(() => of(null)))
      : of(null);

    if (this.params.denoise < 1) {
      // img2img: upload current image to ComfyUI first
      unload$.pipe(
        switchMap(() => this.photoService.uploadToComfy(this.comfy.comfyUrl, this.data.filename, this.data.folder))
      ).subscribe({
        next: (res) => this._doSend(res.name, front),
        error: (err) => {
          this.sending = false;
          const msg = err.error?.error || err.message || 'Failed to upload image';
          this.snackBar.open(`Upload error: ${msg}`, '', { duration: 5000 });
        },
      });
    } else {
      // txt2img: no upload needed
      unload$.subscribe(() => this._doSend(null, front));
    }
  }

  sendFront(): void {
    this.send(true);
  }

  private _doSend(uploadedImageName: string | null, front = false): void {
    const workflow = this.applyFullFlowParams(FULL_FLOW_WORKFLOW, this.params, uploadedImageName);
    const finalWorkflow = this.injectManualLoras(
      this.removeEmptyLoraNodes(workflow),
      this.manualLoras.filter(l => l.name),
    );

    this.photoService.sendToComfy(this.comfy.comfyUrl, finalWorkflow, this.copyResult, front).subscribe({
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
      // img2img: set uploaded image name; resize only if size changed
      const loadImageEntry   = Object.entries(copy).find(([, n]) => n.class_type === 'LoadImage');
      const resizeEntry      = Object.entries(copy).find(([, n]) => n.class_type === 'ResizeAndPadImage');
      const repeatBatchEntry = Object.entries(copy).find(([, n]) => n.class_type === 'RepeatImageBatch');

      if (loadImageEntry && uploadedImageName) {
        loadImageEntry[1].inputs.image = uploadedImageName;
      }

      const sizeModified = params.width !== this.originalWidth || params.height !== this.originalHeight;

      if (resizeEntry) {
        if (sizeModified) {
          // Update resize dimensions and keep the node
          if (params.width  != null) resizeEntry[1].inputs.target_width  = params.width;
          if (params.height != null) resizeEntry[1].inputs.target_height = params.height;
        } else {
          // Size unchanged: bypass ResizeAndPadImage entirely
          const [resizeId, resizeNode] = resizeEntry;
          const upstream = resizeNode.inputs.image; // the [loadImageId, 0] reference
          for (const node of Object.values(copy)) {
            for (const [key, val] of Object.entries(node.inputs ?? {})) {
              if (Array.isArray(val) && val[0] === resizeId) {
                (node.inputs as any)[key] = upstream;
              }
            }
          }
          delete copy[resizeId];
        }
      }

      if (repeatBatchEntry && params.batchSize != null) {
        repeatBatchEntry[1].inputs.amount = params.batchSize;
      }
    }

    // --- 3. Model selection ---
    if (this.selectedModel && this.selectedModelType) {
      if (this.selectedModelType === 'checkpoint') {
        // Set the checkpoint name and rewire ONLY the model signal.
        // DualCLIPLoader and VAELoader stay connected — Flux needs its own CLIP/VAE loaders.
        const ckptEntry = Object.entries(copy).find(([, n]) => n.class_type === 'CheckpointLoaderSimple');
        const unetEntry = Object.entries(copy).find(([, n]) => n.class_type === 'UNETLoader');

        if (ckptEntry && unetEntry) {
          const [ckptId] = ckptEntry;
          const [unetId] = unetEntry;
          ckptEntry[1].inputs.ckpt_name = this.selectedModel;

          // Redirect every node whose `model` input points to UNETLoader → checkpoint[0]
          for (const node of Object.values(copy)) {
            const inp = node.inputs || {};
            if (Array.isArray(inp.model) && inp.model[0] === unetId) {
              inp.model = [ckptId, 0];
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

  private extractModelFromWorkflow(
    workflow: Record<string, any>,
  ): { name: string; type: 'checkpoint' | 'unet' } | null {
    // Trace KSampler.model back through any LoRA chain to find the root model loader
    const ksampler = Object.values(workflow).find(n => n.class_type === 'KSampler');
    if (!ksampler) return null;
    let ref = ksampler.inputs?.model;
    const visited = new Set<string>();
    while (Array.isArray(ref)) {
      const [nodeId] = ref as [string, number];
      if (visited.has(nodeId)) break;
      visited.add(nodeId);
      const node = workflow[nodeId];
      if (!node) break;
      if (node.class_type === 'UNETLoader') return { name: node.inputs?.unet_name, type: 'unet' };
      if (node.class_type === 'CheckpointLoaderSimple') return { name: node.inputs?.ckpt_name, type: 'checkpoint' };
      ref = node.inputs?.model;
    }
    return null;
  }

  private fetchModels(): void {
    this.photoService.getComfyModels(this.comfy.comfyUrl).subscribe({
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
    this.photoService.getComfyLoras(this.comfy.comfyUrl).subscribe({
      next: (res) => { this.availableLoras = res.loras || []; this.connState.comfy.loras = [...this.availableLoras]; },
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
      // No LoRA nodes remain — trace the live model/clip sources from the graph.
      // (Don't fall back to CheckpointLoaderSimple: in UNET workflows it is a
      //  disconnected floating node and chaining from it would produce dead LoRAs.)
      const ksamplerNode = Object.values(workflow).find(n => n.class_type === 'KSampler');
      const clipEncNode  = Object.values(workflow).find(n => n.class_type === 'CLIPTextEncode');
      if (!ksamplerNode || !clipEncNode) return workflow;
      const modelRef = ksamplerNode.inputs?.model;
      const clipRef  = clipEncNode.inputs?.clip;
      if (!Array.isArray(modelRef) || !Array.isArray(clipRef)) return workflow;
      insertAfterModel = [modelRef[0] as string, modelRef[1] as number];
      insertAfterClip  = [clipRef[0]  as string, clipRef[1]  as number];
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
