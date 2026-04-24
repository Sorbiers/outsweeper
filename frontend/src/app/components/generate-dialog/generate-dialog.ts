import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { PhotoService } from '../../services/photo.service';
import { PrompterDialog } from '../prompter-dialog/prompter-dialog';

export interface GenerateDialogData {
  workflow: Record<string, any>;
}

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
}

interface ManualLora {
  name: string;
  strengthModel: number;
  strengthClip: number;
}

const DEFAULT_NEGATIVE_PROMPT = 'worst quality, low quality, bad anatomy, bad hands, text, watermark, blurry, deformed';

@Component({
  selector: 'pp-generate-dialog',
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatIconModule],
  templateUrl: './generate-dialog.html',
  styleUrl: './generate-dialog.scss',
})
export class GenerateDialog {
  private dialogRef = inject(MatDialogRef<GenerateDialog>);
  private data: GenerateDialogData = inject(MAT_DIALOG_DATA);
  private dialog = inject(MatDialog);
  private photoService = inject(PhotoService);
  private snackBar = inject(MatSnackBar);

  comfyUrl = localStorage.getItem('comfyUrl') || 'http://127.0.0.1:8188';
  params: WorkflowParams;
  sending = false;
  checkStatus: 'idle' | 'checking' | 'ok' | 'error' = 'idle';

  availableLoras: string[] = [];
  loraNodes: VariableNode[] = [];
  availableCheckpoints: string[] = [];
  checkpointNodes: VariableNode[] = [];
  manualLoras: ManualLora[] = [];
  availableSamplers: string[] = [];
  availableSchedulers: string[] = [];

  constructor() {
    this.params = this.extractParams(this.data.workflow);
    this.loraNodes = this.extractVariableNodes(this.data.workflow, 'lora_name');
    this.checkpointNodes = this.extractVariableNodes(this.data.workflow, 'ckpt_name');
  }

  checkConnection(): void {
    this.checkStatus = 'checking';
    localStorage.setItem('comfyUrl', this.comfyUrl);
    this.photoService.checkComfy(this.comfyUrl).subscribe({
      next: () => {
        this.checkStatus = 'ok';
        this.fetchLoras();
        this.fetchCheckpoints();
        this.fetchSamplers();
      },
      error: () => this.checkStatus = 'error',
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

  addLora(): void {
    this.manualLoras.push({ name: '', strengthModel: 0.7, strengthClip: 0.7 });
  }

  removeLora(index: number): void {
    this.manualLoras.splice(index, 1);
  }

  send(): void {
    localStorage.setItem('comfyUrl', this.comfyUrl);
    this.sending = true;
    const lmstudioUrl = localStorage.getItem('lmstudioUrl');
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
      this.photoService.sendToComfy(this.comfyUrl, workflow).subscribe({
        next: () => {
          this.snackBar.open('Prompt queued', '', { duration: 3000 });
          this.dialogRef.close(true);
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
        )
      );
    });

    forkJoin(requests).subscribe({
      next: () => {
        this.snackBar.open(`Queued ${requests.length} prompts`, '', { duration: 3000 });
        this.dialogRef.close(true);
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
      next: (res) => this.availableLoras = res.loras || [],
      error: () => this.availableLoras = [],
    });
  }

  private fetchCheckpoints(): void {
    this.photoService.getComfyCheckpoints(this.comfyUrl).subscribe({
      next: (res) => this.availableCheckpoints = res.checkpoints || [],
      error: () => this.availableCheckpoints = [],
    });
  }

  private fetchSamplers(): void {
    this.photoService.getComfySamplers(this.comfyUrl).subscribe({
      next: (res) => {
        this.availableSamplers = res.samplers || [];
        this.availableSchedulers = res.schedulers || [];
      },
      error: () => {
        this.availableSamplers = [];
        this.availableSchedulers = [];
      },
    });
  }

  private extractVariableNodes(workflow: Record<string, any>, inputKey: string): VariableNode[] {
    const nodes: VariableNode[] = [];
    for (const [nodeId, node] of Object.entries(workflow)) {
      const inputs = node.inputs || {};
      if (inputKey in inputs) {
        nodes.push({
          nodeId,
          originalName: inputs[inputKey],
          selected: inputs[inputKey] ? [inputs[inputKey]] : [],
          inputKey,
        });
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

    if (!params.negativePrompt) {
      params.negativePrompt = DEFAULT_NEGATIVE_PROMPT;
    }

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
      if (loraNode?.removed && inputs) {
        inputs['lora_name'] = '';
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
