import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { forkJoin } from 'rxjs';
import { PhotoService } from '../../services/photo.service';

export interface GenerateDialogData {
  workflow: Record<string, any>;
}

interface WorkflowParams {
  seed: number | null;
  steps: number | null;
  cfg: number | null;
  batchSize: number | null;
  positivePrompt: string;
  negativePrompt: string;
}

interface LoraNode {
  nodeId: string;
  originalName: string;
  selected: string[];
}

@Component({
  selector: 'pp-generate-dialog',
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatIconModule],
  templateUrl: './generate-dialog.html',
  styleUrl: './generate-dialog.scss',
})
export class GenerateDialog {
  private dialogRef = inject(MatDialogRef<GenerateDialog>);
  private data: GenerateDialogData = inject(MAT_DIALOG_DATA);
  private photoService = inject(PhotoService);
  private snackBar = inject(MatSnackBar);

  comfyUrl = localStorage.getItem('comfyUrl') || 'http://127.0.0.1:8188';
  params: WorkflowParams;
  sending = false;
  checkStatus: 'idle' | 'checking' | 'ok' | 'error' = 'idle';

  availableLoras: string[] = [];
  loraNodes: LoraNode[] = [];

  constructor() {
    this.params = this.extractParams(this.data.workflow);
    this.loraNodes = this.extractLoraNodes(this.data.workflow);
  }

  checkConnection(): void {
    this.checkStatus = 'checking';
    localStorage.setItem('comfyUrl', this.comfyUrl);
    this.photoService.checkComfy(this.comfyUrl).subscribe({
      next: () => {
        this.checkStatus = 'ok';
        this.fetchLoras();
      },
      error: () => this.checkStatus = 'error',
    });
  }

  randomizeSeed(): void {
    this.params.seed = Math.floor(Math.random() * 2 ** 32);
  }

  send(): void {
    localStorage.setItem('comfyUrl', this.comfyUrl);
    this.sending = true;

    const loraNodesWithSelections = this.loraNodes.filter(n => n.selected.length > 0);

    if (loraNodesWithSelections.length === 0) {
      // No LoRA selections — single send
      const workflow = this.applyParams(this.data.workflow, this.params);
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

    // Build cartesian product of all LoRA node selections
    const combinations = this.cartesian(loraNodesWithSelections.map(n => n.selected));
    const requests = combinations.map(combo => {
      const workflow = this.applyParams(this.data.workflow, this.params);
      // Apply each LoRA in the combination to its corresponding node
      combo.forEach((loraName, i) => {
        const nodeId = loraNodesWithSelections[i].nodeId;
        if (workflow[nodeId]?.inputs) {
          workflow[nodeId].inputs.lora_name = loraName;
        }
      });
      return this.photoService.sendToComfy(this.comfyUrl, workflow);
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
    const nodesWithSelections = this.loraNodes.filter(n => n.selected.length > 0);
    if (nodesWithSelections.length === 0) return 1;
    return nodesWithSelections.reduce((acc, n) => acc * n.selected.length, 1);
  }

  private fetchLoras(): void {
    this.photoService.getComfyLoras(this.comfyUrl).subscribe({
      next: (res) => this.availableLoras = res.loras || [],
      error: () => this.availableLoras = [],
    });
  }

  private extractLoraNodes(workflow: Record<string, any>): LoraNode[] {
    const nodes: LoraNode[] = [];
    for (const [nodeId, node] of Object.entries(workflow)) {
      const inputs = node.inputs || {};
      if ('lora_name' in inputs) {
        nodes.push({
          nodeId,
          originalName: inputs.lora_name,
          selected: [inputs.lora_name],
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
      }

      if ('batch_size' in inputs) {
        params.batchSize = inputs.batch_size;
      }

      if (classType === 'CLIPTextEncode' && 'text' in inputs) {
        if (!params.positivePrompt) {
          params.positivePrompt = inputs.text;
        } else if (!params.negativePrompt) {
          params.negativePrompt = inputs.text;
        }
      }
    }

    return params;
  }

  private applyParams(workflow: Record<string, any>, params: WorkflowParams): Record<string, any> {
    const copy: Record<string, any> = JSON.parse(JSON.stringify(workflow));
    let positiveSet = false;
    let negativeSet = false;

    for (const node of Object.values(copy)) {
      const inputs = node.inputs || {};
      const classType = node.class_type || '';

      if ('steps' in inputs && 'cfg' in inputs) {
        if (params.steps != null) inputs.steps = params.steps;
        if (params.cfg != null) inputs.cfg = params.cfg;
        if ('seed' in inputs && params.seed != null) inputs.seed = params.seed;
      }

      if ('batch_size' in inputs && params.batchSize != null) {
        inputs.batch_size = params.batchSize;
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
    }

    return copy;
  }

  private cartesian(arrays: string[][]): string[][] {
    return arrays.reduce<string[][]>(
      (acc, arr) => acc.flatMap(combo => arr.map(item => [...combo, item])),
      [[]]
    );
  }
}
