import { ClipboardModule } from '@angular/cdk/clipboard';
import { Component, OnDestroy, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { catchError, firstValueFrom, of } from 'rxjs';
import { STORAGE_KEYS } from '../../constants';
import { DialogTitleDirective } from '../../directives/dialog-title.directive';
import { LmStudioConnectionService } from '../../services/lmstudio-connection.service';
import { PhotoService } from '../../services/photo.service';
import { PromptHistoryService } from '../../services/prompt-history.service';

export interface SynopsisDialogData {
  lmUrl: string;
  /** Hand the generated prompt(s) back to the still-open parent Generate dialog. */
  applyPrompts: (prompts: string[]) => void;
}

const STORY_INSTRUCTION =
  'Write a short story from the synopsis below. Introduce the characters and setting, follow ' +
  'the plot and action described, and give it a clear beginning, middle, and end. Return ONLY ' +
  'the story text — no title, preamble, or commentary.\n\nSYNOPSIS:\n';

/** Phrase the illustration count as a constraint, not a fixed number — 0 on either
 *  bound means "not set" (the model decides freely on that side). */
function countClause(min: number, max: number): string {
  if (min > 0 && max > 0) return `between ${min} and ${max} illustrations`;
  if (min > 0) return `at least ${min} illustrations`;
  if (max > 0) return `at most ${max} illustrations`;
  return 'as many illustrations as the story needs';
}

function illustratorInstruction(story: string, style: string, min: number, max: number): string {
  const styleLine = style.trim() ? `Illustration style: ${style.trim()}.\n` : '';
  return (
    `You are a text-to-image prompt writer for the FLUX model. Read the story below and write ` +
    `${countClause(min, max)} — one per key scene, in narrative order. Choose whatever number ` +
    `within that constraint best covers the story's beats. Each prompt must be a single, richly ` +
    `detailed image-generation prompt describing the subjects, action, setting, lighting, and ` +
    `composition of that scene.\n` + styleLine +
    `Separate each prompt with a line containing only ---. Do not number them, and do not add ` +
    `any titles, explanations, or commentary — output only the prompts and the --- separators.\n\n` +
    `STORY:\n${story}`
  );
}

/** Split the illustrator's raw output into individual prompts on `---` lines (falling back to
 *  blank-line splitting if the model ignored the separator), trimming stray numbering/fences. */
function splitIllustrations(text: string): string[] {
  const clean = (s: string): string => {
    // Trim first so the fence/numbering patterns anchor on the segment's own
    // edges, not the whole raw string (a `---`-split segment carries its own
    // surrounding newlines).
    let t = s.trim();
    t = t.replace(/^```[\w-]*\n?/, '').replace(/\n?```$/, '').trim();
    t = t.replace(/^\s*(illustration\s*)?#?\d+[.):]\s*/i, '');
    return t.trim();
  };

  let parts = text.split(/^[ \t]*-{3,}[ \t]*$/m).map(clean).filter(Boolean);
  if (parts.length <= 1) parts = text.split(/\n\s*\n/).map(clean).filter(Boolean);
  return parts;
}

@Component({
  selector: 'pp-synopsis-dialog',
  imports: [DialogTitleDirective, ClipboardModule, FormsModule, MatDialogModule, MatFormFieldModule,
            MatInputModule, MatSelectModule, MatButtonModule, MatIconModule, MatProgressSpinnerModule,
            MatTooltipModule],
  templateUrl: './synopsis-dialog.html',
  styleUrl: './synopsis-dialog.scss',
})
export class SynopsisDialog implements OnDestroy {
  private dialogRef = inject(MatDialogRef<SynopsisDialog>);
  data: SynopsisDialogData = inject(MAT_DIALOG_DATA);
  private photo = inject(PhotoService);
  private snackBar = inject(MatSnackBar);
  private promptHistory = inject(PromptHistoryService);
  lms = inject(LmStudioConnectionService);

  synopsis = '';
  /** Both an output (Generate story fills it) and an input (paste your own to skip that step). */
  story = '';
  style = '';
  storytellerModel = '';
  illustratorModel = '';
  /** 0 = not set (no bound on that side). */
  minImages = 3;
  maxImages = 6;

  running = signal(false);
  status = signal('');
  prompts = signal<string[]>([]);
  /** Set once the work has been handed to the job queue (monitor mode). */
  jobId = signal<string | null>(null);
  private timer: any = null;

  constructor() {
    this.lms.init();
    if (!this.lms.availableModels.length && this.lms.lmstudioUrl) this.lms.checkConnection();

    this.style = localStorage.getItem(STORAGE_KEYS.SYNOPSIS_STYLE) || '';
    this.storytellerModel = localStorage.getItem(STORAGE_KEYS.SYNOPSIS_STORYTELLER_MODEL) || '';
    this.illustratorModel = localStorage.getItem(STORAGE_KEYS.SYNOPSIS_ILLUSTRATOR_MODEL) || '';
    const savedMin = Number(localStorage.getItem(STORAGE_KEYS.SYNOPSIS_MIN));
    const savedMax = Number(localStorage.getItem(STORAGE_KEYS.SYNOPSIS_MAX));
    if (Number.isFinite(savedMin)) this.minImages = savedMin;
    if (Number.isFinite(savedMax)) this.maxImages = savedMax;

    this.dialogRef.disableClose = true;
  }

  get canGenerateStory(): boolean {
    return !this.running() && !!this.synopsis.trim() && !!this.storytellerModel;
  }

  get canGenerateIllustrations(): boolean {
    return !this.running() && !!this.story.trim() && !!this.illustratorModel;
  }

  ngOnDestroy(): void {
    this.stopPolling();
    // Keep the synopsis for the session so it can be picked from prompt history.
    this.promptHistory.add(this.synopsis);
  }

  close(): void {
    if (!this.running()) this.dialogRef.close();
  }

  get canEnqueue(): boolean {
    return !this.running() && !!this.illustratorModel &&
      (!!this.story.trim() || (!!this.synopsis.trim() && !!this.storytellerModel));
  }

  /**
   * Hand the whole flow (story, if needed, then illustrations) to the job queue
   * instead of running it here — it then waits its turn behind any rendering work
   * and survives this dialog being closed.
   */
  enqueue(): void {
    if (!this.canEnqueue) return;
    this.saveSettings();
    this.clampBounds();
    this.photo.enqueueJob('synopsis', `Illustrations · ${this.shortLabel()}`, {
      prompts: [],
      synopsis: this.synopsis.trim(),
      story: this.story.trim(),
      storytellerModel: this.storytellerModel,
      illustratorModel: this.illustratorModel,
      style: this.style,
      minImages: this.minImages,
      maxImages: this.maxImages,
    } as any).subscribe({
      next: r => {
        this.jobId.set(r.id);
        this.snackBar.open('Queued — results appear here when it runs', '', { duration: 4000 });
        this.poll();
      },
      error: err => this.snackBar.open(
        `Could not queue: ${this.errText(err)}`, 'Dismiss', { duration: 8000 }),
    });
  }

  /** Follow the queued job and surface its story/prompts as they land. */
  private poll(): void {
    this.stopPolling();
    const tick = () => {
      const id = this.jobId();
      if (!id) return;
      this.photo.getJob(id).subscribe({
        next: job => {
          this.status.set(job.progress?.step || '');
          const res = job.result || {};
          if (res['story']) this.story = res['story'] as string;
          if (Array.isArray(res['prompts'])) this.prompts.set(res['prompts'] as string[]);
          if (['done', 'failed', 'cancelled'].includes(job.status)) {
            this.stopPolling();
            this.status.set('');
            if (job.status === 'failed') {
              this.snackBar.open(`Job failed: ${job.error || 'unknown error'}`, 'Dismiss', { duration: 8000 });
            }
          }
        },
        error: () => this.stopPolling(),
      });
    };
    tick();
    this.timer = setInterval(tick, 2000);
  }

  private stopPolling(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private shortLabel(): string {
    const s = (this.synopsis || this.story || '').trim().replace(/\s+/g, ' ');
    return s.length > 50 ? s.slice(0, 50) + '…' : (s || 'untitled');
  }

  async generateStory(): Promise<void> {
    if (!this.canGenerateStory) return;
    this.saveSettings();
    this.running.set(true);
    this.prompts.set([]);
    try {
      this.status.set('Unloading LLM models…');
      await this.unloadAll();
      this.status.set('Writing the story…');
      const r = await firstValueFrom(
        this.photo.lmPrompt(this.data.lmUrl, STORY_INSTRUCTION + this.synopsis.trim(), this.storytellerModel));
      this.story = (r.description || '').trim();
      if (!this.story) this.snackBar.open('The storyteller model returned nothing', '', { duration: 4000 });
    } catch (e: any) {
      this.snackBar.open(`Story generation failed: ${this.errText(e)}`, 'Dismiss', { duration: 8000 });
    } finally {
      await this.finishRun();
    }
  }

  async generateIllustrations(): Promise<void> {
    if (!this.canGenerateIllustrations) return;
    this.saveSettings();
    this.clampBounds();
    this.running.set(true);
    this.prompts.set([]);
    try {
      this.status.set('Unloading LLM models…');
      await this.unloadAll();
      this.status.set('Writing illustration prompts…');
      const instruction = illustratorInstruction(this.story.trim(), this.style, this.minImages, this.maxImages);
      const r = await firstValueFrom(this.photo.lmPrompt(this.data.lmUrl, instruction, this.illustratorModel));
      let parts = splitIllustrations(r.description || '');

      if (this.maxImages > 0 && parts.length > this.maxImages) parts = parts.slice(0, this.maxImages);
      if (this.minImages > 0 && parts.length < this.minImages && parts.length > 0) {
        this.snackBar.open(
          `Only got ${parts.length} illustration(s); asked for at least ${this.minImages}.`, '', { duration: 5000 });
      }
      if (!parts.length) this.snackBar.open('No illustration prompts were returned', '', { duration: 4000 });
      this.prompts.set(parts);
    } catch (e: any) {
      this.snackBar.open(`Illustration generation failed: ${this.errText(e)}`, 'Dismiss', { duration: 8000 });
    } finally {
      await this.finishRun();
    }
  }

  /** Apply just this one prompt to the parent's positive prompt and close. */
  useOne(prompt: string): void {
    this.data.applyPrompts([prompt]);
    this.dialogRef.close();
  }

  /** Apply the whole illustration set to the parent (joined with the `---` delimiter,
   *  Multiple prompts switched on) and close. */
  useAll(): void {
    if (!this.prompts().length) return;
    this.data.applyPrompts(this.prompts());
    this.dialogRef.close();
  }

  private unloadAll(): Promise<any> {
    return firstValueFrom(this.photo.unloadLmStudio(this.data.lmUrl).pipe(catchError(() => of(null))));
  }

  private async finishRun(): Promise<void> {
    this.status.set('Unloading LLM models…');
    await this.unloadAll();
    this.status.set('');
    this.running.set(false);
  }

  private saveSettings(): void {
    if (this.storytellerModel) localStorage.setItem(STORAGE_KEYS.SYNOPSIS_STORYTELLER_MODEL, this.storytellerModel);
    if (this.illustratorModel) localStorage.setItem(STORAGE_KEYS.SYNOPSIS_ILLUSTRATOR_MODEL, this.illustratorModel);
    localStorage.setItem(STORAGE_KEYS.SYNOPSIS_STYLE, this.style);
    localStorage.setItem(STORAGE_KEYS.SYNOPSIS_MIN, String(this.minImages));
    localStorage.setItem(STORAGE_KEYS.SYNOPSIS_MAX, String(this.maxImages));
  }

  private clampBounds(): void {
    this.minImages = Math.max(0, Math.floor(Number(this.minImages) || 0));
    this.maxImages = Math.max(0, Math.floor(Number(this.maxImages) || 0));
    if (this.minImages > 0 && this.maxImages > 0 && this.minImages > this.maxImages) {
      [this.minImages, this.maxImages] = [this.maxImages, this.minImages];
    }
  }

  private errText(e: any): string {
    return e?.error?.error || e?.message || 'Something went wrong';
  }
}
