import { CdkDrag, CdkDragHandle } from '@angular/cdk/drag-drop';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { catchError, firstValueFrom, of } from 'rxjs';
import { LmStudioConnectionService } from '../../services/lmstudio-connection.service';
import { PhotoService } from '../../services/photo.service';

export interface GuidedGenerationData {
  comfyUrl: string;
  lmUrl: string;
  /** Positive prompt with {{tokens}} already substituted (concrete text). */
  basePrompt: string;
  /** Build the single-image ComfyUI flow for a given positive prompt. An optional
   *  seed overrides the flow's seed (used to vary the image when the prompt can't
   *  be changed). */
  buildWorkflow: (positiveText: string, seed?: number) => Record<string, any>;
}

type IterStatus = 'generating' | 'evaluating' | 'done' | 'error' | 'aborted';

/** Thrown internally to unwind the loop when the user aborts. */
class AbortError extends Error {}

interface Iteration {
  n: number;
  prompt: string;
  status: IterStatus;
  image?: string;
  match?: boolean;
  feedback?: string;
  error?: string;
}

const MAX_ITERATIONS = 5;
/** How often to poll ComfyUI for a submitted job's result. */
const POLL_MS = 2000;

const IMPROVE_INSTRUCTION =
  'Improve and enrich the following text-to-image prompt. Keep its core subject and ' +
  'intent, but make it more vivid and detailed by adding arbitrary details, elements, ' +
  //'or plot variations. Return ONLY the improved prompt text, ready to use, with no ' +
  'or camera view and lighting variations. Return ONLY the improved prompt text, ready to use, with no ' +
  'explanations, preamble, or quotation marks.';

const evalInstruction = (prompt: string): string =>
  `You are checking whether the image matches the main subject and intended meaning of this text-to-image prompt closely enough. 
  Don’t be too strict—evaluate only the main idea of the plot and ignore secondary details. Also check the image quality: whether it is well exposed and whether the characters have correct anatomy and facial expression.
  PROMPT: "${prompt}"\n
  Reply ONLY with a JSON object and nothing else:\n
  { "match": true or false, "feedback": "what is missing or wrong (empty if it matches)",
  "corrected_prompt": "a refined single prompt that would make the model render the scene more exactly as described; keep the same intent" }
  Set “match” to true only if the following criteria are met:
- The image conveys the main idea of the prompt.
- The character types, poses, clothing, and facial expressions match what is described in the prompt.
- The characters have correct anatomy and faces.
- The image quality is good: well exposed and not blurry.`;

/** Parse the vision model's verdict, tolerating extra prose around the JSON. */
function parseVerdict(text: string): { match: boolean; feedback: string; corrected: string } {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      return {
        match: !!o.match,
        feedback: String(o.feedback ?? ''),
        corrected: String(o.corrected_prompt ?? o.correctedPrompt ?? ''),
      };
    } catch { /* fall through */ }
  }
  // Fallback: a leading yes/no.
  const head = text.trim().slice(0, 24).toLowerCase();
  return { match: /\b(yes|match(es)?|correct)\b/.test(head) && !head.startsWith('no'), feedback: text.slice(0, 300), corrected: '' };
}

@Component({
  selector: 'pp-guided-generation-dialog',
  imports: [CdkDrag, CdkDragHandle, FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule,
            MatButtonModule, MatCheckboxModule, MatIconModule, MatProgressSpinnerModule],
  templateUrl: './guided-generation-dialog.html',
  styleUrl: './guided-generation-dialog.scss',
})
export class GuidedGenerationDialog {
  private dialogRef = inject(MatDialogRef<GuidedGenerationDialog>);
  data: GuidedGenerationData = inject(MAT_DIALOG_DATA);
  private photo = inject(PhotoService);
  private snackBar = inject(MatSnackBar);
  lms = inject(LmStudioConnectionService);

  improve = signal(true);
  /** How many generate→evaluate→refine rounds to run at most. */
  maxIterations = MAX_ITERATIONS;
  /** Randomize the seed every N iterations (0 = keep the flow's seed fixed). */
  randomizeEvery = 0;
  running = signal(false);
  finished = signal(false);
  matched = signal(false);
  aborting = signal(false);
  aborted = signal(false);
  errorMsg = signal('');
  status = signal('');
  iterations = signal<Iteration[]>([]);

  constructor() {
    this.lms.init();
    if (!this.lms.availableModels.length && this.lms.lmstudioUrl) this.lms.checkConnection();
    this.dialogRef.disableClose = true;
  }

  thumb(image: string): string {
    return this.photo.getThumbnailUrl(image, '');
  }

  close(): void {
    if (!this.running()) this.dialogRef.close();
  }

  async start(): Promise<void> {
    const model = this.lms.model;
    if (!model) { this.snackBar.open('Select an LLM model first', '', { duration: 3000 }); return; }
    const { comfyUrl, lmUrl } = this.data;

    this.lms.saveModel();
    this.running.set(true);
    this.finished.set(false);
    this.matched.set(false);
    this.aborting.set(false);
    this.aborted.set(false);
    this.errorMsg.set('');
    this.iterations.set([]);

    // Clamp the user inputs to sane values.
    this.maxIterations = Math.max(1, Math.min(50, Math.floor(Number(this.maxIterations) || MAX_ITERATIONS)));
    this.randomizeEvery = Math.max(0, Math.floor(Number(this.randomizeEvery) || 0));

    // Unloads every loaded LLM instance (limited VRAM — the LLM and ComfyUI can't
    // coexist). Called before the flow, before each generation, and after the flow.
    const unloadAll = () => firstValueFrom(this.photo.unloadLmStudio(lmUrl).pipe(catchError(() => of(null))));

    let prompt = this.data.basePrompt;
    // undefined = use the flow's own seed; set to a random value when the prompt
    // can't be changed, so the next attempt still produces a different image.
    let seedOverride: number | undefined;
    try {
      // Clean slate: free all LLM VRAM before starting.
      this.status.set('Unloading LLM models…');
      await unloadAll();
      this.checkAbort();

      // Optional: improve the prompt once before the loop.
      if (this.improve() && prompt.trim()) {
        this.status.set('Improving prompt…');
        const r = await firstValueFrom(this.photo.lmPrompt(lmUrl, `${IMPROVE_INSTRUCTION}\n\n${prompt}`, model));
        prompt = (r.description || '').trim() || prompt;
        this.checkAbort();
      }

      for (let i = 1; i <= this.maxIterations; i++) {
        this.checkAbort();
        // Periodic seed randomization (0 = off): a fresh seed every N iterations.
        if (this.randomizeEvery > 0 && (i - 1) % this.randomizeEvery === 0) {
          seedOverride = Math.floor(Math.random() * 2 ** 32);
        }
        this.pushIter({ n: i, prompt, status: 'generating' });

        // Free all LLM VRAM, then generate one image in ComfyUI.
        this.status.set(`Iteration ${i}/${this.maxIterations} — unloading LLM…`);
        await unloadAll();
        this.checkAbort();
        // Queue the job, then poll its status — a long generation never blocks.
        this.status.set(`Iteration ${i}/${this.maxIterations} — queueing…`);
        const image = await this.generate(comfyUrl, this.data.buildWorkflow(prompt, seedOverride), i);
        this.patchIter(i, { image, status: 'evaluating' });

        // Free ComfyUI's VRAM, then evaluate the image with the vision model.
        this.status.set(`Iteration ${i}/${this.maxIterations} — evaluating…`);
        await firstValueFrom(this.photo.freeComfy(comfyUrl).pipe(catchError(() => of(null))));
        this.checkAbort();
        const evalResp = await firstValueFrom(
          //this.photo.describePhoto(image, '', lmUrl, evalInstruction(prompt), model));
          this.photo.describePhoto(image, '', lmUrl, evalInstruction(this.data.basePrompt), model));
        this.checkAbort();
        const verdict = parseVerdict(evalResp.description || '');
        this.patchIter(i, { match: verdict.match, feedback: verdict.feedback, status: 'done' });

        if (verdict.match) { this.matched.set(true); break; }
        // Refine the prompt from the feedback so the next attempt actually differs
        // (the eval model often leaves corrected_prompt empty). The vision model is
        // still loaded here, so this is a cheap text call before the next unload.
        this.status.set(`Iteration ${i}/${this.maxIterations} — refining prompt…`);
        const refined = await this.refinePrompt(lmUrl, model, prompt, verdict.feedback, verdict.corrected);
        this.checkAbort();
        if (this.unchanged(refined, prompt)) {
          // Workaround: the model wouldn't change the prompt — randomize the seed
          // so the next attempt at least produces a different image.
          seedOverride = Math.floor(Math.random() * 2 ** 32);
          this.patchIter(i, { feedback: `${verdict.feedback} — prompt unchanged; randomized seed for the next try.` });
        } else {
          prompt = refined;
        }
      }
    } catch (e: any) {
      if (e instanceof AbortError) {
        this.aborted.set(true);
        this.markLast('aborted');
      } else {
        const msg = e?.error?.error || e?.message || 'Something went wrong';
        this.errorMsg.set(msg);
        this.markLast('error', msg);
      }
    } finally {
      // Always free all LLM VRAM when the flow ends (success, no-match, abort, or error).
      this.status.set('Unloading LLM models…');
      await unloadAll();
      this.status.set('');
      this.aborting.set(false);
      this.running.set(false);
      this.finished.set(true);
    }
  }

  /** Stop the flow. Interrupts any in-flight ComfyUI generation so the blocking
   *  call returns quickly; the loop then unwinds at the next checkpoint. */
  abort(): void {
    if (!this.running() || this.aborting()) return;
    this.aborting.set(true);
    this.status.set('Aborting…');
    firstValueFrom(this.photo.interruptComfy(this.data.comfyUrl).pipe(catchError(() => of(null))));
  }

  private checkAbort(): void {
    if (this.aborting()) throw new AbortError();
  }

  /**
   * Queue a workflow to ComfyUI and poll its status until it finishes, returning the
   * output filename. Polling (instead of one long blocking request) means a slow
   * render never times out, stays responsive to Abort, and surfaces a clear message
   * if the job fails or produces nothing.
   */
  private async generate(comfyUrl: string, workflow: Record<string, any>, iter: number): Promise<string> {
    let submit: any;
    try {
      submit = await firstValueFrom(this.photo.sendToComfy(comfyUrl, workflow, false, true));
    } catch (e: any) {
      throw new Error(this.submitError(e?.error) || e?.message || 'ComfyUI rejected the prompt');
    }
    const promptId: string | undefined = submit?.prompt_id;
    if (!promptId) throw new Error(this.submitError(submit) || 'ComfyUI rejected the prompt');

    const started = Date.now();
    let pollFailures = 0;
    let notQueued = 0;
    while (true) {
      this.checkAbort();
      let res: { done: boolean; queued?: boolean; filenames?: string[]; status?: string };
      try {
        res = await firstValueFrom(this.photo.comfyResult(comfyUrl, promptId));
        pollFailures = 0;
      } catch (e: any) {
        if (++pollFailures >= 6) {
          throw new Error(`Lost connection to ComfyUI while waiting for the image (${e?.error?.error || e?.message || 'network error'}).`);
        }
        await this.delay(POLL_MS);
        continue;
      }
      if (res.done) {
        const img = res.filenames?.[0];
        if (img) return img;
        throw new Error(res.status === 'error'
          ? 'ComfyUI reported an error running the workflow — check the ComfyUI console for details.'
          : 'ComfyUI finished but produced no image — the workflow may be invalid (check the ComfyUI console).');
      }
      // Still running/pending. If it stays out of the queue (and never landed in
      // history), the job likely failed or was cancelled — give it a grace period.
      notQueued = res.queued ? 0 : notQueued + 1;
      if (notQueued >= 8) {
        throw new Error('The ComfyUI job stopped without producing an image — it may have failed (check the ComfyUI console).');
      }
      const secs = Math.round((Date.now() - started) / 1000);
      this.status.set(`Iteration ${iter}/${this.maxIterations} — generating… (${secs}s)`);
      await this.delay(POLL_MS);
    }
  }

  /** Extract a readable message from a ComfyUI submit rejection body. */
  private submitError(body: any): string {
    const err = body?.error;
    if (typeof err === 'string') return err;
    if (err?.message) return err.message;
    for (const v of Object.values<any>(body?.node_errors ?? {})) {
      const first = v?.errors?.[0];
      if (first?.message) return first.message;
    }
    return '';
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Ask the LLM to rewrite the prompt from the evaluation feedback so the next
   *  attempt is genuinely different. Falls back to the eval's own suggestion or
   *  the current prompt on any failure. */
  private async refinePrompt(lmUrl: string, model: string, prompt: string, feedback: string, suggested: string): Promise<string> {
    const base =
      `A text-to-image model generated an image from the PROMPT below, but the image did NOT match it.\n` +
      `PROMPT: "${prompt}"\n` +
      `WHAT THE IMAGE GOT WRONG OR MISSED: ${feedback || 'the image did not match the prompt'}\n` +
      (suggested ? `SUGGESTED DIRECTION: ${suggested}\n` : '') +
      `Write a REVISED prompt that fixes these problems and forces the model to render every described ` +
      `element. Make the missing elements explicit and prominent, use positive phrasing (describe what ` +
      `SHOULD appear, never what should not), and keep the same creative intent. The revised prompt MUST ` +
      `differ from the original. Return ONLY the revised prompt text — no explanations, labels, or quotes.`;

    const ask = (instruction: string): Promise<string> =>
      firstValueFrom(this.photo.lmPrompt(lmUrl, instruction, model))
        .then(r => (r.description || '').trim())
        .catch(() => '');

    let refined = await ask(base);
    // Vision models often echo the prompt back — push harder once if unchanged.
    if (this.unchanged(refined, prompt)) {
      refined = await ask(base +
        `\n\nYour previous answer repeated the prompt unchanged. You MUST return a clearly DIFFERENT ` +
        `prompt: reword it, put the missing elements first, and state them more explicitly.`);
    }
    // Still unchanged is handled by the caller (randomizes the seed instead).
    return refined || suggested.trim() || prompt;
  }

  /** True when the refined text is empty or the same as the previous prompt. */
  private unchanged(refined: string, prompt: string): boolean {
    const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
    return !refined || norm(refined) === norm(prompt);
  }

  private pushIter(it: Iteration): void {
    this.iterations.update(a => [...a, it]);
  }

  private patchIter(n: number, patch: Partial<Iteration>): void {
    this.iterations.update(a => a.map(it => it.n === n ? { ...it, ...patch } : it));
  }

  /** Mark the last iteration with a terminal status (and optional error detail),
   *  but only if it was still in progress (don't clobber a completed verdict). */
  private markLast(status: IterStatus, error?: string): void {
    this.iterations.update(a => a.map((it, i) =>
      i === a.length - 1 && (it.status === 'generating' || it.status === 'evaluating')
        ? { ...it, status, ...(error ? { error } : {}) } : it));
  }
}
