import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/** Thin bootstrapped shell — the desktop app and the mobile feed are routes. */
@Component({
  selector: 'pp-root',
  imports: [RouterOutlet],
  template: '<router-outlet />',
})
export class Root {}
