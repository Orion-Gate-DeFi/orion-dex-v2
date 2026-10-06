import { Routes } from '@angular/router';

// Per-route titles are picked up by the router's default TitleStrategy —
// without them document.title is identical on every screen (bad for tabs,
// history and screen readers).
export const routes: Routes = [
  {
    path: '',
    title: 'Portfolio — Orion',
    loadComponent: () => import('./features/dashboard/dashboard.component').then(m => m.DashboardComponent),
  },
  {
    path: 'swap',
    title: 'Swap — Orion',
    loadComponent: () => import('./features/swap/swap.component').then(m => m.SwapComponent),
  },
  {
    path: 'send',
    title: 'Send — Orion',
    loadComponent: () => import('./features/send/send.component').then(m => m.SendComponent),
  },
  {
    path: 'receive',
    title: 'Receive — Orion',
    loadComponent: () => import('./features/receive/receive.component').then(m => m.ReceiveComponent),
  },
  {
    // Reached by direct URL only (the iOS app opens it in SFSafari with
    // `?from=app`) — deliberately absent from the header nav.
    path: 'buy',
    title: 'Buy crypto — Orion',
    loadComponent: () => import('./features/buy/buy.component').then(m => m.BuyComponent),
  },
  {
    path: 'legal',
    title: 'Legal — Orion',
    loadComponent: () => import('./features/legal/legal.component').then(m => m.LegalComponent),
  },
  {
    path: '**',
    redirectTo: '',
  },
];
