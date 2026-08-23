import { CdkDrag, CdkDragHandle } from '@angular/cdk/drag-drop';
import { Component, ElementRef, inject, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { STORAGE_KEYS } from '../../constants';
import { ComfyConnectionService } from '../../services/comfy-connection.service';
import { ConnectionStateService } from '../../services/connection-state.service';
import { JobPayload, JobPrompt } from '../../models/job.model';
import { DictionaryService, DictionaryValue, DictionaryValueLora } from '../../services/dictionary.service';
import { LmStudioConnectionService } from '../../services/lmstudio-connection.service';
import { PhotoService } from '../../services/photo.service';
import { PromptHistoryService } from '../../services/prompt-history.service';
import { ComfyUrlRowComponent } from '../comfy-url-row/comfy-url-row';
import { DictionaryDialog } from '../dictionary-dialog/dictionary-dialog';
import { GuidedGenerationData, GuidedGenerationDialog } from '../guided-generation-dialog/guided-generation-dialog';
import { LlmModelDialog, LlmModelDialogData } from '../llm-model-dialog/llm-model-dialog';
import type { PhotoChartDialogData } from '../photo-chart-dialog/photo-chart-dialog';
import type { ChartId } from '../photo-chart-dialog/photo-chart-presets';
import { PromptHistoryDialog } from '../prompt-history-dialog/prompt-history-dialog';
import { PrompterDialog } from '../prompter-dialog/prompter-dialog';
import { SaveFlowDialog } from '../save-flow-dialog/save-flow-dialog';
import { SynopsisDialog, SynopsisDialogData } from '../synopsis-dialog/synopsis-dialog';

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

/** One prepared prompt ready to build into a workflow: fully resolved params
 *  (substitution + seed), the dict-triggered LoRAs it picked, and the
 *  checkpoint/LoRA variable-node value assignments for its Cartesian combo. */
interface PromptUnit {
  resolved: WorkflowParams;
  dictLoras: ManualLora[];
  assign: { nodeId: string; inputKey: string; value: string }[];
}

const DEFAULT_NEGATIVE_PROMPT = 'worst quality, low quality, bad anatomy, bad hands, text, watermark, blurry, deformed';

/** Stand-in for the source image name in an img2img graph. The upload happens on the
 *  backend when the job runs, and the worker swaps this for the real filename. */
const UPLOAD_PLACEHOLDER = '__pp_pending_upload__';

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
  private lmStudio = inject(LmStudioConnectionService);
  comfy = inject(ComfyConnectionService);

  /** Needed to splice cheat-chart text in at the caret. */
  private positivePromptInput = viewChild<ElementRef<HTMLTextAreaElement>>('positivePromptInput');

  params: WorkflowParams;
  sending = false;
  /** Progress line shown while "Improve then send" runs its multi-phase flow. */
  sendStatus = '';
  copyResult = false;
  randomizeSeedOnSend = false;
  jobsNumber = 1;
  hasDenoise = false;
  /** When enabled, the positive prompt is split into several prompts (each
   *  queued as its own separate send) on lines matching the delimiter. */
  multiplePrompts = false;
  /** Delimiter line for splitting. Empty (the default) splits on empty lines;
   *  otherwise a line whose trimmed text equals this is the separator. */
  promptDelimiter = '';

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
    this.lmStudio.init();

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

  /** Restore the built-in negative prompt (handy after a flow supplied a poor one,
   *  or none at all). */
  resetNegativePrompt(): void {
    this.params.negativePrompt = DEFAULT_NEGATIVE_PROMPT;
  }

  /**
   * Illustrated camera cheat chart; the picked wording is spliced into the positive
   * prompt where the caret was. The caret is captured *before* opening, because the
   * modal takes focus and a re-rendered textarea would otherwise lose the position.
   */
  /** Loaded on demand — the chart ships 42 inline diagrams and their preset table. */
  async openCameraChart(): Promise<void> {
    const at = this.caretInPrompt();
    const { CameraDialog } = await import('../camera-dialog/camera-dialog');
    this.dialog.open(CameraDialog, { width: '90vw', maxWidth: '900px', maxHeight: '86vh' })
      .afterClosed().subscribe((text?: string) => {
        if (text) this.insertIntoPrompt(text, at);
      });
  }

  /** Photographic reference chart (camera framing/angles or lighting), single pick. */
  async openPhotoChart(chart: ChartId): Promise<void> {
    const at = this.caretInPrompt();
    const { PhotoChartDialog } = await import('../photo-chart-dialog/photo-chart-dialog');
    this.dialog.open(PhotoChartDialog, {
      data: { chart } satisfies PhotoChartDialogData,
      width: '92vw', maxWidth: '1040px', maxHeight: '88vh',
    }).afterClosed().subscribe((text?: string) => {
      if (text) this.insertIntoPrompt(text, at);
    });
  }

  /** Caret position, captured before a modal opens and takes focus. */
  private caretInPrompt(): { start: number; end: number } | null {
    const el = this.positivePromptInput()?.nativeElement;
    if (!el) return null;
    return {
      start: el.selectionStart ?? el.value.length,
      end: el.selectionEnd ?? el.value.length,
    };
  }

  /** Splice `text` into the positive prompt at `at`, tidying separators, and leave
   *  the caret just after what was inserted. */
  private insertIntoPrompt(text: string, at: { start: number; end: number } | null): void {
    const current = this.params.positivePrompt ?? '';
    const start = at ? Math.min(at.start, current.length) : current.length;
    const end = at ? Math.min(at.end, current.length) : current.length;
    const before = current.slice(0, start);
    const after = current.slice(end);

    // Only add separators where they're actually missing. Whitespace alone doesn't
    // separate prompt clauses — a comma does — so look past it when deciding.
    const beforeTrimmed = before.replace(/\s+$/, '');
    const afterTrimmed = after.replace(/^\s+/, '');
    const lead = !beforeTrimmed || /[,([]$/.test(beforeTrimmed)
      ? (before.endsWith(' ') || !before ? '' : ' ')
      : ', ';
    const tail = !afterTrimmed || /^[,.)\]]/.test(afterTrimmed)
      ? ''
      : (/^\s/.test(after) ? ',' : ', ');   // reuse the space that's already there
    this.params.positivePrompt = before + lead + text + tail + after;

    const caret = (before + lead + text).length;
    const el = this.positivePromptInput()?.nativeElement;
    if (el) {
      // After the model write has been flushed to the DOM.
      setTimeout(() => { el.focus(); el.setSelectionRange(caret, caret); });
    }
  }

  openPrompter(): void {
    this.dialog.open(PrompterDialog, { width: '600px' }).afterClosed().subscribe(result => {
      if (result) {
        this.params.positivePrompt = result;
      }
    });
  }

  openDictionaries(): void {
    this.dialog.open(DictionaryDialog, {
      width: '80vw', height: '70vh',
      minWidth: '780px', minHeight: '400px',
      maxWidth: '95vw', maxHeight: '95vh',
    });
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
   * the dictionaries, plus any LoRAs attached to the values picked along the way
   * (deduped by name — a LoRA is added at most once per resolution). Called per
   * queued prompt so batches vary independently.
   */
  private resolvedParams(positiveTemplate: string): { params: WorkflowParams; loras: ManualLora[] } {
    const loraSink: DictionaryValueLora[] = [];
    const positivePrompt = this.dictionaries.substitute(positiveTemplate, loraSink);
    const negativePrompt = this.dictionaries.substitute(this.params.negativePrompt, loraSink);
    const seen = new Set<string>();
    const loras = loraSink.filter(l => l.name && !seen.has(l.name) && seen.add(l.name));
    return { params: { ...this.params, positivePrompt, negativePrompt }, loras };
  }

  /**
   * When "Multiple prompts" is on, split the positive prompt into separate
   * prompts on delimiter lines (whole-line match). An empty delimiter — the
   * default — splits on empty lines; otherwise a line whose trimmed text equals
   * the delimiter is the separator. Off, or with no separator present, returns
   * the prompt unchanged as a single part. Blank parts are dropped. Splitting
   * happens on the template, so each part keeps and independently resolves its
   * own {{tokens}}.
   */
  private positivePromptParts(): string[] {
    if (!this.multiplePrompts) return [this.params.positivePrompt];
    const sep = this.promptDelimiter.trim();
    const parts: string[] = [];
    let current: string[] = [];
    for (const line of this.params.positivePrompt.split(/\r?\n/)) {
      const isDelimiter = sep ? line.trim() === sep : line.trim() === '';
      if (isDelimiter) {
        parts.push(current.join('\n'));
        current = [];
      } else {
        current.push(line);
      }
    }
    parts.push(current.join('\n'));
    const trimmed = parts.map(p => p.trim()).filter(Boolean);
    return trimmed.length ? trimmed : [this.params.positivePrompt];
  }

  /** Number of prompts the positive prompt splits into (>= 1). */
  get promptPartCount(): number {
    return this.positivePromptParts().length;
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

  /** Build the { flow, dictionaries } document — prompts keep their {{tokens}}. */
  private buildFlowContent(): { flow: Record<string, any>; dictionaries: Record<string, DictionaryValue[]> } {
    let flow = this.applyParams(this.data.workflow, this.params);
    flow = this.normalizeLoraClip(this.injectManualLoras(this.removeEmptyLoraNodes(flow), this.manualLoras.filter(l => l.name)));

    const dictionaries: Record<string, DictionaryValue[]> = {};
    for (const name of this.dictionaries.referencedNames(`${this.params.positivePrompt}\n${this.params.negativePrompt}`)) {
      const d = this.dictionaries.get(name);
      if (d) dictionaries[d.name] = d.values;
    }
    return { flow, dictionaries };
  }

  saveToCollection(): void {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    this.dialog.open(SaveFlowDialog, {
      data: { content: this.buildFlowContent(), defaultName: `flow_${stamp}` },
      width: '90vw',
      maxWidth: '480px',
    });
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

  /**
   * Queue this generation as an internal job. The backend owns the whole dance from
   * here — starting ComfyUI, waiting for its queue, unloading LM Studio, uploading
   * the source image and submitting the batch — so the work no longer depends on
   * this dialog (or this tab) staying open.
   */
  send(front = false): void {
    this.saveParams();
    this.promptHistory.add(this.params.positivePrompt);

    const units = this.buildPromptUnits();
    if (!units.length) return;

    const src = this.data.sourceImage;
    const needsUpload = !!(src && this.params.denoise != null && this.params.denoise < 1);
    const prompts: JobPrompt[] = units.map(u => {
      const workflow = this.buildWorkflowFromUnit(u, needsUpload ? UPLOAD_PLACEHOLDER : null);
      return { workflow, ...this.patchPoints(workflow), uploadNodeId: this.uploadNodeId(workflow) };
    });

    this.enqueue(front ? 'Send to front' : 'Generate', {
      prompts,
      copyResult: this.copyResult,
      front,
      upload: needsUpload ? { path: src!.folder ? `${src!.folder}/${src!.filename}` : src!.filename } : undefined,
    });
  }

  sendFront(): void {
    this.send(true);
  }

  /** POST a job and report the outcome; the dialog stays open and usable. */
  private enqueue(label: string, payload: JobPayload, kind = 'comfy'): void {
    this.sending = true;
    const n = payload.prompts.length;
    const title = `${label}${n > 1 ? ` ×${n}` : ''} · ${this.shortPrompt()}`;
    this.photoService.enqueueJob(kind, title, payload).subscribe({
      next: () => {
        this.sending = false;
        this.snackBar.open(n > 1 ? `Queued ${n} prompts` : 'Job queued', '', { duration: 3000 });
      },
      error: err => {
        this.sending = false;
        this.snackBar.open(`Could not queue: ${this.formatSendError(err)}`, 'Dismiss', { duration: 8000 });
      },
    });
  }

  /** Node ids a backend runner patches between iterations (prompt text and seed). */
  private patchPoints(wf: Record<string, any>): { promptNodeId?: string; seedNodeId?: string } {
    const entry = Object.entries<any>(wf).find(
      ([, n]) => 'steps' in (n.inputs || {}) && 'cfg' in (n.inputs || {}));
    if (!entry) return {};
    const [seedNodeId, ksampler] = entry;
    return {
      seedNodeId,
      promptNodeId: this.resolveClipNodeId(ksampler.inputs?.positive, wf) ?? undefined,
    };
  }

  /** The LoadImage node holding the placeholder, so the worker can patch in the
   *  real uploaded filename once it has performed the upload. */
  private uploadNodeId(wf: Record<string, any>): string | undefined {
    return Object.keys(wf).find(id => wf[id]?.inputs?.image === UPLOAD_PLACEHOLDER);
  }

  private shortPrompt(): string {
    const p = (this.params.positivePrompt || '').trim().replace(/\s+/g, ' ');
    return p.length > 60 ? p.slice(0, 60) + '…' : (p || 'untitled');
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

  /** The checkpoint/LoRA nodes that expand into a Cartesian batch. */
  private activeVariableNodes(): VariableNode[] {
    return [
      ...this.checkpointNodes.filter(n => n.selected.length > 0),
      ...this.loraNodes.filter(n => n.selected.length > 0 && !n.removed),
    ];
  }

  /**
   * Prepare every prompt for one send: for each job (seed re-randomized) × split
   * prompt × Cartesian combo, resolve {{vars}} once and capture the result. The
   * prompts are frozen here so they can be improved before the workflow is built.
   */
  private buildPromptUnits(): PromptUnit[] {
    const variableNodes = this.activeVariableNodes();
    const combinations = variableNodes.length
      ? this.cartesian(variableNodes.map(n => n.selected))
      : [[]];
    const promptParts = this.positivePromptParts();

    const units: PromptUnit[] = [];
    for (let j = 0; j < this.jobCount; j++) {
      if (this.randomizeSeedOnSend) this.randomizeSeed();
      for (const part of promptParts) {
        for (const combo of combinations) {
          const { params: resolved, loras: dictLoras } = this.resolvedParams(part);
          const assign = combo.map((value, i) => ({
            nodeId: variableNodes[i].nodeId,
            inputKey: variableNodes[i].inputKey,
            value,
          }));
          units.push({ resolved, dictLoras, assign });
        }
      }
    }
    return units;
  }

  /** Build the final ComfyUI flow for one prepared unit (params + combo + loras + img2img). */
  private buildWorkflowFromUnit(unit: PromptUnit, uploadedImageName: string | null): Record<string, any> {
    const workflow = this.applyParams(this.data.workflow, unit.resolved);
    for (const a of unit.assign) {
      if (workflow[a.nodeId]?.inputs) workflow[a.nodeId].inputs[a.inputKey] = a.value;
    }
    const loras = [...this.manualLoras.filter(l => l.name), ...unit.dictLoras];
    let out = this.injectManualLoras(this.removeEmptyLoraNodes(workflow), loras);
    out = this.normalizeLoraClip(out);
    if (uploadedImageName) out = this.toImg2Img(out, uploadedImageName);
    return out;
  }

  /** Pick the LLM model, then queue the improve-then-send job. */
  improveThenSend(front = false): void {
    const lmUrl = this.connState.lmstudio.url;
    if (!lmUrl) {
      this.snackBar.open('Set the LM Studio URL first (open the Prompt/Describe dialog to connect).', 'Dismiss', { duration: 6000 });
      return;
    }
    this.dialog.open(LlmModelDialog, {
      data: { title: 'Improve then send — LLM model' } satisfies LlmModelDialogData,
      width: '90vw', maxWidth: '420px',
    }).afterClosed().subscribe((model?: string) => {
      if (model) this.runImproveThenSend(front, lmUrl, model);
    });
  }

  /**
   * Queue an "improve then send" job. The graphs go over already built with the
   * original prompt text plus `promptText` / `promptNodeId`; the worker enriches the
   * text with the LLM, patches it into each graph, then renders the batch — all
   * behind the same VRAM guards as any other job.
   */
  private runImproveThenSend(front: boolean, lmUrl: string, model: string): void {
    this.saveParams();
    this.promptHistory.add(this.params.positivePrompt);

    const units = this.buildPromptUnits();
    if (!units.length) return;

    const src = this.data.sourceImage;
    const needsUpload = !!(src && this.params.denoise != null && this.params.denoise < 1);
    const prompts: JobPrompt[] = units.map(u => {
      const workflow = this.buildWorkflowFromUnit(u, needsUpload ? UPLOAD_PLACEHOLDER : null);
      return {
        workflow,
        ...this.patchPoints(workflow),
        uploadNodeId: this.uploadNodeId(workflow),
        promptText: u.resolved.positivePrompt,
      };
    });

    this.enqueue('Improve then send', {
      prompts,
      copyResult: this.copyResult,
      front,
      lmModel: model,
      upload: needsUpload ? { path: src!.folder ? `${src!.folder}/${src!.filename}` : src!.filename } : undefined,
    }, 'improve_send');
  }

  /** Guided generation handles a single image only — disabled for batches. */
  get guidedDisabled(): boolean {
    return this.totalSends > 1;
  }

  /**
   * Guided generation: freeze the current single-image flow, then hand a
   * prompt→workflow builder to the loop dialog (improve → generate → evaluate →
   * refine, up to 5×). Dictionary tokens are resolved once here; the loop then
   * works on concrete, LLM-refined prompt text.
   */
  openGuided(): void {
    const lmUrl = this.connState.lmstudio.url;
    if (!lmUrl) {
      this.snackBar.open('Set the LM Studio URL first (open the Prompt/Describe dialog to connect).', 'Dismiss', { duration: 6000 });
      return;
    }
    if (this.guidedDisabled) return;

    this.saveParams();
    this.randomizeSeed();

    const loraSink: DictionaryValueLora[] = [];
    const negativePrompt = this.dictionaries.substitute(this.params.negativePrompt, loraSink);
    const basePrompt = this.dictionaries.substitute(this.params.positivePrompt, loraSink);
    const seen = new Set<string>();
    const dictLoras = loraSink.filter(l => l.name && !seen.has(l.name) && seen.add(l.name));
    const variableNodes = this.activeVariableNodes();
    const assign = variableNodes.map(n => ({ nodeId: n.nodeId, inputKey: n.inputKey, value: n.selected[0] }));
    const frozen = { ...this.params };

    // One concrete graph plus its patch points; the backend runner re-patches the
    // prompt text and seed on each iteration rather than rebuilding the graph.
    const workflow = this.buildWorkflowFromUnit(
      { resolved: { ...frozen, positivePrompt: basePrompt, negativePrompt }, dictLoras, assign }, null);

    this.dialog.open(GuidedGenerationDialog, {
      data: {
        lmUrl, basePrompt, copyResult: this.copyResult,
        prompt: { workflow, ...this.patchPoints(workflow) },
      } satisfies GuidedGenerationData,
      width: '90vw', maxWidth: '960px', height: '80vh', maxHeight: '90vh',
    });
  }

  /**
   * Synopsis to illustrations: compose a story from a plot synopsis, then a set of
   * FLUX-ready illustration prompts, in a separate dialog — then hand the whole set
   * back here as this dialog's positive prompt (Multiple prompts + `---` delimiter),
   * or a single prompt from the set, without closing this dialog.
   */
  openSynopsis(): void {
    const lmUrl = this.connState.lmstudio.url;
    if (!lmUrl) {
      this.snackBar.open('Set the LM Studio URL first (open the Prompt/Describe dialog to connect).', 'Dismiss', { duration: 6000 });
      return;
    }

    const applyPrompts = (prompts: string[]) => {
      this.params.positivePrompt = prompts.join('\n---\n');
      this.multiplePrompts = true;
      this.promptDelimiter = '---';
    };

    this.dialog.open(SynopsisDialog, {
      data: { lmUrl, applyPrompts } satisfies SynopsisDialogData,
      width: '90vw', maxWidth: '760px', height: '85vh', maxHeight: '92vh',
    });
  }

  /** Number of jobs to queue per send (>= 1). */
  get jobCount(): number {
    return Math.max(1, Math.floor(Number(this.jobsNumber) || 1));
  }

  /** Prompts per job: split prompts × Cartesian combinations (checkpoints × LoRAs). */
  get totalPrompts(): number {
    const variableNodes = this.activeVariableNodes();
    const combos = variableNodes.length === 0
      ? 1
      : variableNodes.reduce((acc, n) => acc * n.selected.length, 1);
    return combos * this.promptPartCount;
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

  /** Text of the CLIPTextEncode a conditioning input traces back to ('' if none). */
  private resolveClipText(ref: any, workflow: Record<string, any>): string {
    const nodeId = this.resolveClipNodeId(ref, workflow);
    return nodeId ? (workflow[nodeId]?.inputs?.text ?? '') : '';
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
        // Resolve prompts via KSampler references so order in the object doesn't matter.
        // If both sides trace to the *same* encoder the flow has no distinct negative
        // (Flux zero-out flows do this) — leave it blank so the fallback below supplies
        // the default rather than echoing the positive prompt back at the user.
        const posId = this.resolveClipNodeId(inputs.positive, workflow);
        const negId = this.resolveClipNodeId(inputs.negative, workflow);
        params.positivePrompt = posId ? (workflow[posId]?.inputs?.text ?? '') : '';
        params.negativePrompt = negId && negId !== posId ? (workflow[negId]?.inputs?.text ?? '') : '';
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

  /**
   * Find the node ID of the CLIPTextEncode a conditioning input traces back to.
   *
   * Stops at `ConditioningZeroOut`: it is the standard Flux way to say "no negative
   * prompt", and it takes the *positive* conditioning as its input — so following
   * through it would walk straight back to the positive encoder and report the
   * positive text as the negative one.
   */
  private resolveClipNodeId(ref: any, workflow: Record<string, any>): string | null {
    const visited = new Set<string>();
    let nodeId = Array.isArray(ref) ? ref[0] : null;
    while (nodeId && !visited.has(nodeId)) {
      visited.add(nodeId);
      const node = workflow[nodeId];
      if (!node) break;
      if (node.class_type === 'ConditioningZeroOut') return null;
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
      // No existing LoRA: anchor to the live MODEL and CLIP sources so the LoRA
      // sits between them and their consumers. Trace MODEL from the sampler's
      // `model` input and CLIP from a CLIPTextEncode's `clip` input — for Flux
      // the CLIP comes from DualCLIPLoader, not the checkpoint.
      const sampler = Object.values(workflow).find(
        n => Array.isArray(n.inputs?.model) && 'steps' in (n.inputs || {}) && 'cfg' in (n.inputs || {}),
      );
      const clipEnc = Object.values(workflow).find(
        n => n.class_type === 'CLIPTextEncode' && Array.isArray(n.inputs?.clip),
      );
      const modelRef = sampler?.inputs?.model;
      const clipRef  = clipEnc?.inputs?.clip;
      if (!Array.isArray(modelRef) || !Array.isArray(clipRef)) return workflow;
      insertAfterModel = [modelRef[0], modelRef[1]];
      insertAfterClip  = [clipRef[0], clipRef[1]];
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

  /**
   * Repair the CLIP wiring of a Model-and-CLIP LoRA chain so the LoRA's clip
   * comes from the real CLIP loader (DualCLIPLoader for Flux, else the
   * checkpoint) and the prompt encoders read the LoRA's clip output. Idempotent
   * on already-correct flows; fixes ones baked wrong by older code.
   */
  private normalizeLoraClip(workflow: Record<string, any>): Record<string, any> {
    const entries = Object.entries(workflow);
    const loras = entries.filter(
      ([, n]) => n.class_type === 'LoraLoader' && Array.isArray(n.inputs?.clip) && Array.isArray(n.inputs?.model),
    );
    if (!loras.length) return workflow;
    const loraIds = new Set(loras.map(([id]) => id));

    // The true CLIP source: a dedicated CLIP loader, else the checkpoint's CLIP.
    const clipLoader = entries.find(([, n]) => n.class_type === 'DualCLIPLoader' || n.class_type === 'CLIPLoader');
    const checkpoint = entries.find(([, n]) => n.class_type === 'CheckpointLoaderSimple');
    const clipSource: [string, number] | null =
      clipLoader ? [clipLoader[0], 0] : checkpoint ? [checkpoint[0], 1] : null;
    if (!clipSource) return workflow;

    // Chain head (clip not fed by another LoRA) and tail (clip not consumed by another LoRA).
    const head = loras.find(([, n]) => !loraIds.has(n.inputs.clip[0]));
    const tail = loras.find(([id]) => !loras.some(([oid, on]) => oid !== id && on.inputs.clip[0] === id));
    if (!head || !tail) return workflow;

    // 1. Feed the chain head's CLIP from the real source.
    head[1].inputs.clip = [...clipSource];
    // 2. Route every prompt encoder that bypasses the chain through the tail's CLIP output.
    const tailRef: [string, number] = [tail[0], 1];
    for (const [, n] of entries) {
      if (n.class_type === 'CLIPTextEncode' && Array.isArray(n.inputs?.clip) && !loraIds.has(n.inputs.clip[0])) {
        n.inputs.clip = [...tailRef];
      }
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
