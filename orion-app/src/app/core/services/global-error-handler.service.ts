/**
 * =============================================================================
 * GLOBAL ERROR HANDLER
 * =============================================================================
 *
 * Catches all unhandled errors in the application and provides graceful degradation.
 * Prevents white screen of death and shows user-friendly error messages.
 *
 * Features:
 * - Catches all unhandled exceptions
 * - Logs errors to console with context
 * - Shows user-friendly toast notifications
 * - Reports errors to Sentry (when a DSN is configured)
 * - Prevents app from crashing
 *
 * @author Orion DEX Team
 * @version 2.2.0
 */

import { ErrorHandler, Injectable, inject } from '@angular/core';
import { environment } from '../../../environments/environment';
import { ToastService } from './toast.service';

// =============================================================================
// SENTRY SEAM & EVENT SCRUBBING
// =============================================================================

/**
 * Type of the SDK's `captureException`. Only the type is referenced here —
 * the value arrives at runtime through `errorTracker.sdkCapture` (assigned in
 * main.ts after a dynamic `import('@sentry/angular')`), so the SDK never
 * lands in the initial bundle while no DSN is configured.
 */
type SentryCaptureException = typeof import('@sentry/angular')['captureException'];

/**
 * Thin seam over the Sentry SDK so specs can spy on capture calls without
 * exercising the real SDK transport, and so the SDK can be loaded lazily.
 */
export const errorTracker = {
  /**
   * The lazily-loaded SDK's `captureException`. Undefined until main.ts
   * resolves the dynamic import + init; errors raised inside that boot
   * window are dropped by design (toast/console handling still runs).
   */
  sdkCapture: undefined as SentryCaptureException | undefined,

  /** Tracking is on only when a DSN is configured AND the SDK finished loading. */
  isEnabled(): boolean {
    return environment.sentryDsn !== '' && this.sdkCapture !== undefined;
  },

  captureException(
    error: unknown,
    context: { tags?: Record<string, string>; extra?: Record<string, unknown> },
  ): void {
    this.sdkCapture?.(error, context);
  },
};

/**
 * Full EVM wallet addresses (0x + 40 hex chars). The negative lookahead keeps
 * longer hex blobs (tx hashes: 0x + 64 hex chars) intact for debugging.
 */
const WALLET_ADDRESS_PATTERN = /0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/g;

/**
 * Shorten wallet addresses inside arbitrary text to a `0x12…34` form.
 * Addresses are pseudonymous PII and must not accumulate in the tracker.
 */
export function scrubWalletAddresses(text: string): string {
  return text.replace(WALLET_ADDRESS_PATTERN, (address) => `${address.slice(0, 4)}…${address.slice(-2)}`);
}

/** Minimal structural slice of a Sentry error event that scrubbing touches. */
export interface ScrubbableEvent {
  message?: string;
  exception?: { values?: { value?: string }[] };
  breadcrumbs?: { message?: string; data?: Record<string, unknown> }[];
  request?: { url?: string };
  extra?: Record<string, unknown>;
}

/**
 * Recursion cap for object graphs of unknown shape (breadcrumb `data`,
 * `extra`). Keeps the walk bounded on deep, cyclic, or adversarial payloads.
 */
const MAX_SCRUB_DEPTH = 4;

/**
 * Scrub wallet addresses from every own enumerable string value of an
 * object graph, descending into nested objects/arrays up to MAX_SCRUB_DEPTH.
 * `Object.keys` deliberately ignores inherited properties.
 */
function scrubObjectStrings(value: Record<string, unknown>, depth: number): void {
  if (depth > MAX_SCRUB_DEPTH) {
    return;
  }
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (typeof entry === 'string') {
      value[key] = scrubWalletAddresses(entry);
    } else if (typeof entry === 'object' && entry !== null) {
      scrubObjectStrings(entry as Record<string, unknown>, depth + 1);
    }
  }
}

/** Drop the query string — swap/quote URLs routinely carry addresses and amounts. */
function stripQueryString(url: string): string {
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

/**
 * Sentry `beforeSend` hook body: scrub wallet addresses from every text
 * carrier of the outgoing event in place before it leaves the browser —
 * message, exception values, breadcrumb messages + data (console/fetch
 * breadcrumbs embed arbitrary app strings), request.url (query string is
 * dropped entirely), and extra values.
 */
export function scrubSentryEvent(event: ScrubbableEvent): void {
  if (event.message) {
    event.message = scrubWalletAddresses(event.message);
  }
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) {
      exception.value = scrubWalletAddresses(exception.value);
    }
  }
  for (const breadcrumb of event.breadcrumbs ?? []) {
    if (breadcrumb.message) {
      breadcrumb.message = scrubWalletAddresses(breadcrumb.message);
    }
    if (breadcrumb.data) {
      scrubObjectStrings(breadcrumb.data, 0);
    }
  }
  if (event.request?.url) {
    event.request.url = scrubWalletAddresses(stripQueryString(event.request.url));
  }
  if (event.extra) {
    scrubObjectStrings(event.extra, 0);
  }
}

@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  private toastService = inject(ToastService);

  /**
   * Handle uncaught errors
   */
  handleError(error: Error | any): void {
    // Extract meaningful error message
    const errorMessage = this.extractErrorMessage(error);
    const errorType = this.categorizeError(error);

    // Report to the tracker first so a failure in toast/console handling
    // can never swallow the report
    this.sendToErrorTracking(error, errorType);

    // Log to console with full details
    this.logError(error, errorType);

    // Show user-friendly notification
    this.showUserNotification(errorMessage, errorType);
  }

  /**
   * Extract a meaningful error message from various error types
   */
  private extractErrorMessage(error: any): string {
    // Error object with message
    if (error?.message) {
      return error.message;
    }

    // String error
    if (typeof error === 'string') {
      return error;
    }

    // Error with rejection (Promise rejection)
    if (error?.rejection?.message) {
      return error.rejection.message;
    }

    // HTTP error
    if (error?.status) {
      return `HTTP ${error.status}: ${error.statusText || 'Unknown error'}`;
    }

    // Fallback
    return 'An unexpected error occurred';
  }

  /**
   * Categorize error for appropriate handling
   */
  private categorizeError(error: any): 'network' | 'validation' | 'runtime' | 'unknown' {
    const message = this.extractErrorMessage(error).toLowerCase();

    // Network/API errors
    if (
      message.includes('http') ||
      message.includes('network') ||
      message.includes('fetch') ||
      message.includes('timeout') ||
      message.includes('cors') ||
      message.includes('failed to fetch')
    ) {
      return 'network';
    }

    // Validation errors
    if (
      message.includes('invalid') ||
      message.includes('required') ||
      message.includes('validation') ||
      message.includes('must be')
    ) {
      return 'validation';
    }

    // Runtime errors
    if (
      message.includes('undefined') ||
      message.includes('null') ||
      message.includes('cannot read') ||
      message.includes('is not a function')
    ) {
      return 'runtime';
    }

    return 'unknown';
  }

  /**
   * Log error to console with context
   */
  private logError(error: any, type: string): void {
    console.group(`🔴 Global Error Handler [${type}]`);

    console.error('Error:', error);

    // Log stack trace if available
    if (error?.stack) {
      console.error('Stack trace:', error.stack);
    }

    console.groupEnd();
  }

  /**
   * Show user-friendly notification
   */
  private showUserNotification(message: string, type: string): void {
    // Don't show toasts for known/handled errors
    if (this.isKnownError(message)) {
      return;
    }

    // Customize message based on error type
    let userMessage = message;
    let title = 'Error';

    switch (type) {
      case 'network':
        title = 'Connection Error';
        userMessage = 'Network connection issue. Please check your internet and try again.';
        break;

      case 'validation':
        title = 'Invalid Input';
        // Use original message for validation errors
        break;

      case 'runtime':
        title = 'Something Went Wrong';
        userMessage = 'An unexpected error occurred. Please refresh the page.';
        break;

      default:
        title = 'Unexpected Error';
        userMessage = 'Something went wrong. Please try again or contact support.';
    }

    // Show toast notification
    this.toastService.error(title, userMessage);
  }

  /**
   * Check if error is already handled/known
   */
  private isKnownError(message: string): boolean {
    const knownErrors = [
      'NO_LIQUIDITY',
      'AMOUNT_TOO_SMALL',
      'INSUFFICIENT_BALANCE',
      'USER_REJECTED',
      'TRANSACTION_FAILED'
    ];

    return knownErrors.some(known => message.includes(known));
  }

  /**
   * Report the error to Sentry.
   *
   * This is the ONLY reporting path for errors raised inside the app:
   * zone.js (loaded as the bootstrap polyfill, see angular.json) intercepts
   * both sync exceptions and unhandled promise rejections in the Angular zone
   * and forwards them to this ErrorHandler without re-throwing, so Sentry's
   * globalHandlersIntegration (window.onerror / onunhandledrejection) never
   * sees them — capturing here does not double-report. Errors thrown outside
   * the Angular zone bypass this handler and are still picked up by Sentry's
   * global handlers.
   */
  private sendToErrorTracking(error: unknown, errorType: string): void {
    if (!errorTracker.isEnabled()) {
      return;
    }

    // Promise rejections arrive wrapped by zone.js — unwrap to the original
    // error so Sentry groups by the real stack trace
    const original = (error as { rejection?: unknown })?.rejection ?? error;

    // No extractedMessage extra: it duplicated the exception value verbatim
    // and bypassed the beforeSend wallet-address scrub.
    errorTracker.captureException(original, {
      tags: { errorType },
      extra: {
        url: window.location.href,
      },
    });
  }
}
