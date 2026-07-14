import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';

export interface ConfirmDialogData {
  message: string;
  confirmLabel?: string;
}

/** Generic yes/no confirmation. Closes with `true` on confirm. */
@Component({
  selector: 'pp-confirm-dialog',
  imports: [MatDialogModule, MatButtonModule],
  template: `
    <mat-dialog-content>{{ data.message }}</mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [mat-dialog-close]="true">{{ data.confirmLabel || 'OK' }}</button>
    </mat-dialog-actions>
  `,
})
export class ConfirmDialog {
  data = inject<ConfirmDialogData>(MAT_DIALOG_DATA);
}
