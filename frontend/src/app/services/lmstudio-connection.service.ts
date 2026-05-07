import { inject, Injectable } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ConnectionStateService } from './connection-state.service';
import { PhotoService } from './photo.service';
import { STORAGE_KEYS } from '../constants';

@Injectable({ providedIn: 'root' })
export class LmStudioConnectionService {
  private photoService = inject(PhotoService);
  private connState = inject(ConnectionStateService);
  private snackBar = inject(MatSnackBar);

  lmstudioUrl = '';
  model = localStorage.getItem(STORAGE_KEYS.LMS_MODEL) || '';
  checkStatus: 'idle' | 'checking' | 'ok' | 'error' = 'idle';
  availableModels: string[] = [];
  hasRunCommand = false;
  runTriggered = false;

  /** Call once in dialog constructor to restore state from the shared connection state. */
  init(): void {
    this.lmstudioUrl = this.connState.lmstudio.url || '';
    if (this.lmstudioUrl && this.connState.lmstudio.status === 'ok') {
      this.checkStatus = 'ok';
      this.availableModels = [...this.connState.lmstudio.models];
      this._normalizeModel();
    }
    this.photoService.getConfig().subscribe(cfg => {
      this.hasRunCommand = !!cfg.has_run_lmstudio_command;
    });
  }

  onUrlChange(): void {
    if (this.lmstudioUrl !== this.connState.lmstudio.url) {
      this.checkStatus = 'idle';
    }
  }

  checkConnection(): void {
    this.checkStatus = 'checking';
    this.runTriggered = false;
    this.connState.lmstudio.url = this.lmstudioUrl;
    this.connState.lmstudio.status = 'checking';
    this.photoService.checkLmStudio(this.lmstudioUrl).subscribe({
      next: (res) => {
        this.checkStatus = 'ok';
        this.connState.lmstudio.status = 'ok';
        this.availableModels = (res.data || []).map((m: any) => m.id);
        this.connState.lmstudio.models = [...this.availableModels];
        this._normalizeModel();
      },
      error: () => {
        this.checkStatus = 'error';
        this.connState.lmstudio.status = 'error';
      },
    });
  }

  saveModel(): void {
    if (this.model) localStorage.setItem(STORAGE_KEYS.LMS_MODEL, this.model);
  }

  runService(): void {
    this.runTriggered = true;
    this.photoService.runCommand('lmstudio').subscribe({
      next: () => this.snackBar.open('Starting LM Studio...', '', { duration: 3000 }),
      error: () => {
        this.runTriggered = false;
        this.snackBar.open('Failed to run command', '', { duration: 3000 });
      },
    });
  }

  private _normalizeModel(): void {
    if (this.availableModels.length && !this.availableModels.includes(this.model)) {
      this.model = this.availableModels[0];
    }
  }
}
