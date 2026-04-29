import { Injectable, NgZone, inject } from '@angular/core';
import { Subject } from 'rxjs';

export type PhotoAction = 'next' | 'prev' | 'first' | 'last' | 'select' | 'dust' | 'undo' | 'pageForward' | 'pageBackward' | 'pageForward10' | 'pageBackward10' | 'toggleSelection' | 'selectAll';

@Injectable({ providedIn: 'root' })
export class KeyboardService {
  private zone = inject(NgZone);
  action$ = new Subject<PhotoAction>();

  init(): void {
    this.zone.runOutsideAngular(() => {
      document.addEventListener('keydown', (event: KeyboardEvent) => {
        // Skip when a dialog or overlay input is focused
        const target = event.target as HTMLElement;
        if (target.closest('.cdk-overlay-container') || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
          return;
        }

        let action: PhotoAction | null = null;

        if (event.key === 'ArrowRight') action = 'next';
        else if (event.key === 'ArrowLeft') action = 'prev';
        else if (event.key === 'Home') action = 'first';
        else if (event.key === 'End') action = 'last';
        else if (event.key === '+' || event.key === '=') action = 'select';
        else if (event.key === 'Delete') action = 'dust';
        else if (event.key === 'PageDown' && event.shiftKey) action = 'pageForward10';
        else if (event.key === 'PageUp' && event.shiftKey) action = 'pageBackward10';
        else if (event.key === 'PageDown') action = 'pageForward';
        else if (event.key === 'PageUp') action = 'pageBackward';
        else if (event.key === 'z' && event.ctrlKey) action = 'undo';
        else if (event.key === ' ') action = 'toggleSelection';
        else if (event.key === 'a' && event.ctrlKey) action = 'selectAll';

        if (action) {
          event.preventDefault();
          this.zone.run(() => this.action$.next(action!));
        }
      });
    });
  }
}
