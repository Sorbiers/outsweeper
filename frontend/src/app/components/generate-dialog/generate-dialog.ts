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
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { ConnectionStateService } from '../../services/connection-state.service';
import { PhotoService } from '../../services/photo.service';
import { STORAGE_KEYS } from '../../constants';
import { PrompterDialog } from '../prompter-dialog/prompter-dialog';

export interface GenerateDialogData {
  workflow: Record<string, any>;
  positivePromptOverride?: string;
}

export interface GenerateCloseResult {
  copyResult: boolean;
}

export const DEFAULT_FLUX_WORKFLOW: Record<string, any> = {
  "1": { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "flux1-dev.safetensors" } },
  "2": { "class_type": "LoraLoader", "inputs": { "lora_name": "", "strength_model": 1.0, "strength_clip": 1.0, "model": ["1", 0], "clip": ["1", 1] } },
  "3": { "class_type": "LoraLoader", "inputs": { "lora_name": "", "strength_model": 1.0, "strength_clip": 1.0, "model": ["2", 0], "clip": ["2", 1] } },
  "4": { "class_type": "LoraLoader", "inputs": { "lora_name": "", "strength_model": 1.0, "strength_clip": 1.0, "model": ["3", 0], "clip": ["3", 1] } },
  "5": { "class_type": "CLIPTextEncode", "inputs": { "text": "", "clip": ["4", 1] } },
  "6": { "class_type": "CLIPTextEncode", "inputs": { "text": "", "clip": ["4", 1] } },
  "7": { "class_type": "EmptyLatentImage", "inputs": { "width": 1024, "height": 1024, "batch_size": 1 } },
  "8": { "class_type": "KSampler", "inputs": { "seed": 0, "steps": 20, "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0, "model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["7", 0] } },
  "9": { "class_type": "VAEDecode", "inputs": { "samples": ["8", 0], "vae": ["1", 2] } },
  "10": { "class_type": "SaveImage", "inputs": { "filename_prefix": "flux", "images": ["9", 0] } }
};

interface WorkflowParams {
  seed: number | null;
  steps: number | null;
  cfg: number | null;
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
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatIconModule, MatCheckboxModule],
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

  comfyUrl = '';
  params: WorkflowParams;
  sending = false;
  copyResult = false;
  checkStatus: 'idle' | 'checking' | 'ok' | 'error' = 'idle';
  hasRunComfyCommand = false;
  runTriggered = false;

  availableLoras: string[] = [];
  loraNodes: VariableNode[] = [];
  availableCheckpoints: string[] = [];
  checkpointNodes: VariableNode[] = [];
  manualLoras: ManualLora[] = [];
  availableSamplers: string[] = [];
  availableSchedulers: string[] = [];

  constructor() {
    this.comfyUrl = this.connState.comfy.url || '';

    if (this.comfyUrl && this.connState.comfy.status === 'ok') {
      this.checkStatus = 'ok';
      this.availableLoras = [...this.connState.comfy.loras];
      this.availableCheckpoints = [...this.connState.comfy.checkpoints];
      this.availableSamplers = [...this.connState.comfy.samplers];
      this.availableSchedulers = [...this.connState.comfy.schedulers];
    }

    this.params = this.extractParams(this.data.workflow);
    if (this.data.positivePromptOverride) {
      this.params.positivePrompt = this.data.positivePromptOverride;
    }
    this.loraNodes = this.extractVariableNodes(this.data.workflow, 'lora_name');
    this.checkpointNodes = this.extractVariableNodes(this.data.workflow, 'ckpt_name');

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
        this.fetchLoras();
        this.fetchCheckpoints();
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
      if (result) {
        this.params.positivePrompt = result;
      }
    });
  }

  extractWorkflow(): void {
    this.downloadJson(this.data.workflow, 'workflow.json');
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

  runService(): void {
    this.runTriggered = true;
    this.photoService.runCommand('comfy').subscribe({
      next: () => this.snackBar.open('Starting ComfyUI...', '', { duration: 3000 }),
      error: () => { this.runTriggered = false; this.snackBar.open('Failed to run command', '', { duration: 3000 }); },
    });
  }

  addLora(): void {
    this.manualLoras.push({ name: '', strengthModel: 0.7, strengthClip: 0.7 });
  }

  removeLora(index: number): void {
    this.manualLoras.splice(index, 1);
  }

  send(): void {
    this.connState.comfy.url = this.comfyUrl;
    this.saveParams();
    this.sending = true;
    const lmstudioUrl = this.connState.lmstudio.url;
    const unload$ = lmstudioUrl
      ? this.photoService.unloadLmStudio(lmstudioUrl).pipe(catchError(() => of(null)))
      : of(null);
    unload$.subscribe(() => this._doSend());
  }

  private _doSend(): void {
    const variableNodes = [
      ...this.checkpointNodes.filter(n => n.selected.length > 0),
      ...this.loraNodes.filter(n => n.selected.length > 0 && !n.removed),
    ];

    if (variableNodes.length === 0) {
      const workflow = this.injectManualLoras(
        this.removeEmptyLoraNodes(this.applyParams(this.data.workflow, this.params)),
        this.manualLoras.filter(l => l.name)
      );
      this.photoService.sendToComfy(this.comfyUrl, workflow, this.copyResult).subscribe({
        next: () => {
          this.snackBar.open('Prompt queued', '', { duration: 3000 });
          this.dialogRef.close({ copyResult: this.copyResult });
        },
        error: (err) => {
          this.sending = false;
          const msg = err.error?.error || err.message || 'Failed to send';
          this.snackBar.open(`Error: ${msg}`, '', { duration: 5000 });
        },
      });
      return;
    }

    const combinations = this.cartesian(variableNodes.map(n => n.selected));
    const requests = combinations.map(combo => {
      const workflow = this.applyParams(this.data.workflow, this.params);
      combo.forEach((value, i) => {
        const node = variableNodes[i];
        if (workflow[node.nodeId]?.inputs) {
          workflow[node.nodeId].inputs[node.inputKey] = value;
        }
      });
      return this.photoService.sendToComfy(
        this.comfyUrl,
        this.injectManualLoras(
          this.removeEmptyLoraNodes(workflow),
          this.manualLoras.filter(l => l.name)
        ),
        this.copyResult,
      );
    });

    forkJoin(requests).subscribe({
      next: () => {
        this.snackBar.open(`Queued ${requests.length} prompts`, '', { duration: 3000 });
        this.dialogRef.close({ copyResult: this.copyResult });
      },
      error: (err) => {
        this.sending = false;
        const msg = err.error?.error || err.message || 'Failed to send';
        this.snackBar.open(`Error: ${msg}`, '', { duration: 5000 });
      },
    });
  }

  get totalPrompts(): number {
    const variableNodes = [
      ...this.checkpointNodes.filter(n => n.selected.length > 0),
      ...this.loraNodes.filter(n => n.selected.length > 0 && !n.removed),
    ];
    if (variableNodes.length === 0) return 1;
    return variableNodes.reduce((acc, n) => acc * n.selected.length, 1);
  }

  private fetchLoras(): void {
    this.photoService.getComfyLoras(this.comfyUrl).subscribe({
      next: (res) => { this.availableLoras = res.loras || []; this.connState.comfy.loras = [...this.availableLoras]; },
      error: () => this.availableLoras = [],
    });
  }

  private fetchCheckpoints(): void {
    this.photoService.getComfyCheckpoints(this.comfyUrl).subscribe({
      next: (res) => { this.availableCheckpoints = res.checkpoints || []; this.connState.comfy.checkpoints = [...this.availableCheckpoints]; },
      error: () => this.availableCheckpoints = [],
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

  private extractParams(workflow: Record<string, any>): WorkflowParams {
    const params: WorkflowParams = {
      seed: null,
      steps: null,
      cfg: null,
      batchSize: null,
      width: null,
      height: null,
      samplerName: null,
      scheduler: null,
      positivePrompt: '',
      negativePrompt: '',
    };

    for (const node of Object.values(workflow)) {
      const inputs = node.inputs || {};
      const classType = node.class_type || '';

      if ('steps' in inputs && 'cfg' in inputs) {
        params.steps = inputs.steps;
        params.cfg = inputs.cfg;
        if ('seed' in inputs) params.seed = inputs.seed;
        if ('sampler_name' in inputs) params.samplerName = inputs.sampler_name;
        if ('scheduler' in inputs) params.scheduler = inputs.scheduler;
      }

      if ('batch_size' in inputs) {
        params.batchSize = inputs.batch_size;
      }

      if (classType === 'EmptyLatentImage' || classType === 'EmptySD3LatentImage') {
        if ('width' in inputs) params.width = inputs.width;
        if ('height' in inputs) params.height = inputs.height;
      }

      if (classType === 'CLIPTextEncode' && 'text' in inputs) {
        if (!params.positivePrompt) {
          params.positivePrompt = inputs.text;
        } else if (!params.negativePrompt) {
          params.negativePrompt = inputs.text;
        }
      }
    }

    // Fill empty fields from last used values
    const ls = (k: string) => sessionStorage.getItem(k);
    if (params.steps == null)     { const v = ls(STORAGE_KEYS.GEN_STEPS);      if (v) params.steps     = +v; }
    if (params.cfg == null)       { const v = ls(STORAGE_KEYS.GEN_CFG);        if (v) params.cfg       = +v; }
    if (params.batchSize == null) { const v = ls(STORAGE_KEYS.GEN_BATCH);      if (v) params.batchSize = +v; }
    if (params.width == null)     { const v = ls(STORAGE_KEYS.GEN_WIDTH);      if (v) params.width     = +v; }
    if (params.height == null)    { const v = ls(STORAGE_KEYS.GEN_HEIGHT);     if (v) params.height    = +v; }
    if (!params.samplerName)      { params.samplerName = ls(STORAGE_KEYS.GEN_SAMPLER); }
    if (!params.scheduler)        { params.scheduler   = ls(STORAGE_KEYS.GEN_SCHEDULER); }
    if (!params.positivePrompt)   { params.positivePrompt = ls(STORAGE_KEYS.GEN_POS_PROMPT) || ''; }
    if (!params.negativePrompt)   { params.negativePrompt = ls(STORAGE_KEYS.GEN_NEG_PROMPT) || DEFAULT_NEGATIVE_PROMPT; }

    return params;
  }

  private applyParams(workflow: Record<string, any>, params: WorkflowParams): Record<string, any> {
    const copy: Record<string, any> = JSON.parse(JSON.stringify(workflow));
    let positiveSet = false;
    let negativeSet = false;

    for (const [nodeId, node] of Object.entries(copy)) {
      const inputs = node.inputs || {};
      const classType = node.class_type || '';

      if ('steps' in inputs && 'cfg' in inputs) {
        if (params.steps != null) inputs.steps = params.steps;
        if (params.cfg != null) inputs.cfg = params.cfg;
        if ('seed' in inputs && params.seed != null) inputs.seed = params.seed;
        if (params.samplerName) inputs.sampler_name = params.samplerName;
        if (params.scheduler) inputs.scheduler = params.scheduler;
      }

      if ('batch_size' in inputs && params.batchSize != null) {
        inputs.batch_size = params.batchSize;
      }

      if (classType === 'EmptyLatentImage' || classType === 'EmptySD3LatentImage') {
        if (params.width != null) inputs.width = params.width;
        if (params.height != null) inputs.height = params.height;
      }

      if (classType === 'CLIPTextEncode' && 'text' in inputs) {
        if (!positiveSet) {
          inputs.text = params.positivePrompt;
          positiveSet = true;
        } else if (!negativeSet) {
          inputs.text = params.negativePrompt;
          negativeSet = true;
        }
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
}
