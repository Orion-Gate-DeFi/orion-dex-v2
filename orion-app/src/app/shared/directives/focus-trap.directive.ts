/**
 * =============================================================================
 * FOCUS TRAP DIRECTIVE
 * =============================================================================
 *
 * Minimal dialog focus management without pulling in @angular/cdk:
 *   - moves focus into the container when it appears,
 *   - keeps Tab / Shift+Tab cycling inside it,
 *   - restores focus to the previously-focused element on destroy.
 *
 * Apply to the root element of any modal / popover: `<div orionFocusTrap>`.
 * Escape handling stays with each component (they already implement it).
 *
 * @author Orion DEX Team
 * @version 1.0.0
 */

import { AfterViewInit, Directive, ElementRef, HostListener, OnDestroy, inject } from '@angular/core';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

@Directive({
  selector: '[orionFocusTrap]',
  standalone: true,
})
export class FocusTrapDirective implements AfterViewInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private restoreTo: HTMLElement | null = null;

  ngAfterViewInit(): void {
    this.restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Defer a tick so @if-rendered children exist before we look for them.
    queueMicrotask(() => {
      const el = this.host.nativeElement;
      if (el.contains(document.activeElement)) return; // content already took focus
      const first = this.focusables()[0];
      if (first) {
        first.focus();
      } else {
        el.tabIndex = -1;
        el.focus();
      }
    });
  }

  ngOnDestroy(): void {
    // The focused element is being removed with the dialog — without an
    // explicit restore, focus silently drops to <body> and keyboard users
    // lose their place.
    this.restoreTo?.focus?.();
  }

  @HostListener('keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const items = this.focusables();
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = this.host.nativeElement.contains(active);

    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  }

  private focusables(): HTMLElement[] {
    // offsetParent filters out display:none descendants (e.g. collapsed
    // sections); keep the current active element so Shift+Tab math works
    // even when it's mid-transition.
    return Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((el) => el.offsetParent !== null || el === document.activeElement);
  }
}
