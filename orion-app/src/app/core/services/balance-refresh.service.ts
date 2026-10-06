/**
 * =============================================================================
 * BALANCE REFRESH SERVICE
 * =============================================================================
 *
 * Shared service for triggering balance refresh across components.
 * Used to notify Dashboard when Send/Swap transactions complete.
 *
 * @author Orion DEX Team
 */

import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class BalanceRefreshService {
  /** Subject for refresh events */
  private refreshSubject = new Subject<void>();

  /** Observable for components to subscribe to */
  refresh$ = this.refreshSubject.asObservable();

  /**
   * Trigger a balance refresh
   * Call this after Send/Swap transactions complete
   */
  triggerRefresh(): void {
    this.refreshSubject.next();
  }
}
