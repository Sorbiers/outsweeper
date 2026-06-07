import { inject, Injectable } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ConnectionStateService } from './connection-state.service';
import { PhotoService } from './photo.service';

@Injectable({ providedIn: 'root' })
export class ComfyConnectionService {
  private photoService = inject(PhotoService);
  private connState = inject(ConnectionStateService);
  private snackBar = inject(MatSnackBar);

  comfyUrl = '';
  checkStatus: 'idle' | 'checking' | 'ok' | 'error' = 'idle';
  hasRunComfyCommand = false;
  runTriggered = false;

  /** URL to use for requests — falls back to connState so it works before init() is called. */
  get effectiveUrl(): string {
    return this.comfyUrl || this.connState.comfy.url;
  }

  /** Call once in a dialog constructor to restore shared connection state. */
  init(): void {
    this.comfyUrl = this.connState.comfy.url || '';
    if (this.comfyUrl && this.connState.comfy.status === 'ok') {
      this.checkStatus = 'ok';
    }
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

  checkConnection(onSuccess?: () => void): void {
    this.checkStatus = 'checking';
    this.runTriggered = false;
    this.connState.comfy.url = this.comfyUrl;
    this.connState.comfy.status = 'checking';
    this.photoService.checkComfy(this.comfyUrl).subscribe({
      next: () => {
        this.checkStatus = 'ok';
        this.connState.comfy.status = 'ok';
        onSuccess?.();
      },
      error: () => {
        this.checkStatus = 'error';
        this.connState.comfy.status = 'error';
      },
    });
  }

  runService(): void {
    this.runTriggered = true;
    this.photoService.runCommand('comfy').subscribe({
      next: () => this.snackBar.open('Starting ComfyUI...', '', { duration: 3000 }),
      error: () => {
        this.runTriggered = false;
        this.snackBar.open('Failed to run command', '', { duration: 3000 });
      },
    });
  }
}
