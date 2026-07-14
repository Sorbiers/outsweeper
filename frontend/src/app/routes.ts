import { inject } from '@angular/core';
import { CanActivateFn, Router, Routes } from '@angular/router';
import { App } from './app';
import { MobileFeed } from './components/mobile-feed/mobile-feed';

/** Small touch-screen device → send the root URL to the mobile feed. */
const mobileRedirectGuard: CanActivateFn = () => {
  const touch = window.matchMedia('(pointer: coarse)').matches;
  const small = Math.min(window.screen.width, window.screen.height) <= 820;
  return touch && small ? inject(Router).parseUrl('/m') : true;
};

export const routes: Routes = [
  { path: 'm', component: MobileFeed },
  { path: '', component: App, canActivate: [mobileRedirectGuard] },
  { path: '**', redirectTo: '' },
];
