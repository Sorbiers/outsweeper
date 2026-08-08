import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { LmStudioConnectionService } from '../../services/lmstudio-connection.service';

export interface LlmModelDialogData {
  title?: string;
}

/** Minimal LM Studio model picker. Closes with the chosen model id, or undefined. */
@Component({
  selector: 'pp-llm-model-dialog',
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatSelectModule, MatButtonModule, MatProgressSpinnerModule],
  template: `
    <h2 mat-dialog-title>{{ data.title || 'Select LLM model' }}</h2>
    <mat-dialog-content>
      @if (lms.checkStatus === 'checking') {
        <div class="row"><mat-spinner diameter="20"></mat-spinner> Connecting to LM Studio…</div>
      }
      @if (lms.availableModels.length) {
        <mat-form-field class="full">
          <mat-label>Model</mat-label>
          <mat-select [(ngModel)]="lms.model">
            @for (m of lms.availableModels; track m) { <mat-option [value]="m">{{ m }}</mat-option> }
          </mat-select>
        </mat-form-field>
      } @else if (lms.checkStatus !== 'checking') {
        <p class="warn">No LM Studio models available. Connect LM Studio first (LM Prompt / Describe dialog).</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="!lms.model" (click)="confirm()">OK</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .full { width: 100%; }
    .row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .warn { opacity: 0.8; font-size: 13px; }
  `],
})
export class LlmModelDialog {
  data: LlmModelDialogData = inject(MAT_DIALOG_DATA);
  private dialogRef = inject(MatDialogRef<LlmModelDialog>);
  lms = inject(LmStudioConnectionService);

  constructor() {
    this.lms.init();
    if (!this.lms.availableModels.length && this.lms.lmstudioUrl) this.lms.checkConnection();
  }

  confirm(): void {
    this.lms.saveModel();
    this.dialogRef.close(this.lms.model);
  }
}
