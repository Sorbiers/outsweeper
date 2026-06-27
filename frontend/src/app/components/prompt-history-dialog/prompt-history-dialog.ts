import { Component, inject } from '@angular/core';
import { CdkDrag, CdkDragHandle } from '@angular/cdk/drag-drop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { PromptHistoryService } from '../../services/prompt-history.service';

@Component({
  selector: 'pp-prompt-history-dialog',
  imports: [CdkDrag, CdkDragHandle, MatDialogModule, MatButtonModule, MatIconModule, MatTooltipModule],
  templateUrl: './prompt-history-dialog.html',
  styleUrl: './prompt-history-dialog.scss',
})
export class PromptHistoryDialog {
  private dialogRef = inject(MatDialogRef<PromptHistoryDialog, string>);
  history = inject(PromptHistoryService);

  selected: string | null = null;

  select(prompt: string): void {
    this.selected = prompt;
  }

  /** Apply the highlighted prompt and close. */
  reuse(): void {
    if (this.selected) this.dialogRef.close(this.selected);
  }

  /** Double-click shortcut: reuse a prompt directly. */
  reuseNow(prompt: string): void {
    this.dialogRef.close(prompt);
  }

  remove(prompt: string, event: Event): void {
    event.stopPropagation();
    this.history.remove(prompt);
    if (this.selected === prompt) this.selected = null;
  }

  clear(): void {
    this.history.clear();
    this.selected = null;
  }
}
