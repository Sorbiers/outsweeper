import { Directive, ElementRef, Input, OnDestroy, OnInit, inject } from '@angular/core';
import { MatDialogRef } from '@angular/material/dialog';

/**
 * Shared chrome for a dialog's title bar — apply to the `<h2 mat-dialog-title>`:
 *
 *   <h2 mat-dialog-title ppDialogTitle>Upscale</h2>
 *
 * Replaces the four-attribute CDK incantation that was copy-pasted across ~20
 * dialogs (`cdkDrag cdkDragRootElement=".cdk-overlay-pane" cdkDragBoundary=… cdkDragHandle`)
 * plus the per-component `.dialog-title { cursor: move }` rule, and adds two things
 * those didn't consistently get:
 *
 *  - **Escape always closes.** Dialogs set `disableClose = true` so a stray backdrop
 *    click can't discard a half-filled form — but that disables Escape too, which is
 *    rarely what's wanted. This restores it (opt out with `[ppDialogTitleEscape]="false"`,
 *    e.g. while work is in flight).
 *  - **Dragging is clamped to the viewport**, so a dialog can never be dropped
 *    somewhere its title bar can't be grabbed again.
 */
@Directive({
  selector: '[ppDialogTitle]',
  host: {
    'class': 'pp-dialog-title',
    '(mousedown)': 'onMouseDown($event)',
  },
})
export class DialogTitleDirective implements OnInit, OnDestroy {
  /** Set false to keep Escape from closing (e.g. a run is in progress). */
  @Input('ppDialogTitleEscape') escapeCloses = true;

  private el = inject(ElementRef<HTMLElement>);
  private dialogRef = inject(MatDialogRef, { optional: true });

  /** Kept visible so a dragged dialog can always be grabbed again. */
  private static readonly KEEP_VISIBLE_PX = 48;

  private pane: HTMLElement | null = null;
  private startX = 0;
  private startY = 0;
  private originX = 0;
  private originY = 0;

  private boundMove = (e: MouseEvent) => this.onMouseMove(e);
  private boundUp = () => this.onMouseUp();

  ngOnInit(): void {
    // `disableClose` blocks Escape as well as backdrop clicks; put Escape back.
    this.dialogRef?.keydownEvents().subscribe(e => {
      if (e.key === 'Escape' && this.escapeCloses) this.dialogRef!.close();
    });
  }

  ngOnDestroy(): void {
    this.detach();
  }

  onMouseDown(e: MouseEvent): void {
    // Left button only, and never start a drag from a control in the title bar.
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, a')) return;
    this.pane = this.el.nativeElement.closest('.cdk-overlay-pane');
    if (!this.pane) return;

    const t = new DOMMatrixReadOnly(getComputedStyle(this.pane).transform);
    this.originX = t.m41;
    this.originY = t.m42;
    this.startX = e.clientX;
    this.startY = e.clientY;
    e.preventDefault();
    document.addEventListener('mousemove', this.boundMove);
    document.addEventListener('mouseup', this.boundUp);
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.pane) return;
    const rect = this.pane.getBoundingClientRect();
    // Where the pane would sit with no transform, so limits can be expressed
    // directly in translate units.
    const baseX = rect.left - this.originX;
    const baseY = rect.top - this.originY;

    const minX = -baseX;
    const maxX = Math.max(minX, window.innerWidth - baseX - rect.width);
    const minY = -baseY;
    const maxY = Math.max(minY, window.innerHeight - baseY - DialogTitleDirective.KEEP_VISIBLE_PX);

    const x = Math.min(Math.max(this.originX + e.clientX - this.startX, minX), maxX);
    const y = Math.min(Math.max(this.originY + e.clientY - this.startY, minY), maxY);
    this.pane.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  private onMouseUp(): void {
    this.detach();
  }

  private detach(): void {
    document.removeEventListener('mousemove', this.boundMove);
    document.removeEventListener('mouseup', this.boundUp);
  }
}
