import { Injectable, signal } from '@angular/core';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message: string;
  link?: {
    text: string;
    url: string;
  };
  duration?: number;
}

/**
 * Maximum number of simultaneously visible toasts. A burst of failures
 * (RPC retries, multi-step swaps) stacked without bound and covered the
 * whole screen on mobile — beyond the cap the oldest toast is evicted.
 */
const MAX_VISIBLE_TOASTS = 4;

/** Auto-dismiss fallback (ms) when the caller doesn't pass a duration. */
const DEFAULT_DURATION = 5000;

@Injectable({
  providedIn: 'root',
})
export class ToastService {
  private _toasts = signal<Toast[]>([]);
  readonly toasts = this._toasts.asReadonly();

  /** Dismiss timers, keyed by toast id, so hover/focus can pause/resume them. */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private durations = new Map<string, number>();
  /**
   * Toasts whose dismiss timer is paused (pointer hover / keyboard focus).
   * A paused toast is being read right now: duplicate-collapse must not
   * re-arm its timer and eviction must not pull it out from under the user.
   */
  private pausedIds = new Set<string>();

  show(toast: Omit<Toast, 'id'>): string {
    const duration = toast.duration ?? DEFAULT_DURATION;

    // Collapse duplicates: re-firing a toast whose title is already on
    // screen (the same RPC error on every retry, the same quote failure on
    // every auto-refresh tick) refreshes the visible toast's content and
    // timer instead of stacking an identical copy. Keep the existing link
    // when the refresh carries none — a retry message must not strip the
    // explorer link the user may be about to click.
    const duplicate = this._toasts().find((t) => t.title === toast.title);
    if (duplicate) {
      this._toasts.update((toasts) =>
        toasts.map((t) =>
          t.id === duplicate.id
            ? { ...toast, id: duplicate.id, link: toast.link ?? t.link }
            : t,
        ),
      );
      this.restartTimer(duplicate.id, duration);
      return duplicate.id;
    }

    const id = `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newToast: Toast = { ...toast, id };

    this._toasts.update((toasts) => [...toasts, newToast]);

    // Evict the oldest UNPAUSED toast(s) once the stack exceeds the cap; if
    // everything older is paused (all being read), tolerate the overflow
    // rather than dismiss under the cursor or evict the toast just shown.
    while (this._toasts().length > MAX_VISIBLE_TOASTS) {
      const victim = this._toasts().find(
        (t) => t.id !== id && !this.pausedIds.has(t.id),
      );
      if (!victim) break;
      this.remove(victim.id);
    }

    // Auto remove after duration (0 = sticky)
    if (duration > 0) {
      this.durations.set(id, duration);
      this.timers.set(id, setTimeout(() => this.remove(id), duration));
    }

    return id;
  }

  /**
   * Clear and re-arm the dismiss timer (duplicate-collapse refresh). While
   * the toast is paused only the stored duration is updated — resume() arms
   * it later; re-arming here would auto-dismiss a toast mid-read.
   */
  private restartTimer(id: string, duration: number): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.durations.delete(id);
    if (duration > 0) {
      this.durations.set(id, duration);
      if (!this.pausedIds.has(id)) {
        this.timers.set(id, setTimeout(() => this.remove(id), duration));
      }
    }
  }

  /**
   * Pause the dismiss timer while the pointer is over the toast or while it
   * holds keyboard focus (focusin) — error toasts carry next-step
   * instructions and explorer links that users were losing mid-read.
   */
  pause(id: string): void {
    // Guard against stale ids (event fired after removal) leaking into the
    // paused set — an orphan entry would block eviction forever.
    if (!this._toasts().some((t) => t.id === id)) return;
    this.pausedIds.add(id);
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  /** Resume after hover/focus ends; restarts with the toast's full duration. */
  resume(id: string): void {
    this.pausedIds.delete(id);
    if (this.timers.has(id)) return;
    const duration = this.durations.get(id);
    if (duration) {
      this.timers.set(id, setTimeout(() => this.remove(id), duration));
    }
  }

  success(title: string, message: string, link?: Toast['link']): string {
    return this.show({ type: 'success', title, message, link });
  }

  error(title: string, message: string, link?: Toast['link']): string {
    return this.show({ type: 'error', title, message, link, duration: 8000 });
  }

  warning(title: string, message: string, link?: Toast['link']): string {
    return this.show({ type: 'warning', title, message, link });
  }

  info(title: string, message: string, link?: Toast['link']): string {
    return this.show({ type: 'info', title, message, link });
  }

  remove(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.durations.delete(id);
    this.pausedIds.delete(id);
    this._toasts.update((toasts) => toasts.filter((t) => t.id !== id));
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.durations.clear();
    this.pausedIds.clear();
    this._toasts.set([]);
  }
}

