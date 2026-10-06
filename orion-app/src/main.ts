import { Buffer } from 'buffer';
(window as any).Buffer = Buffer;

import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';
import { errorTracker, scrubSentryEvent } from './app/core/services/global-error-handler.service';
import { environment } from './environments/environment';

// The Sentry SDK is imported lazily so it stays out of the initial bundle
// while sentryDsn is empty (its current state in every environment). Errors
// raised before the dynamic import + init resolve are not reported — an
// accepted trade-off for the short boot window; toast/console handling runs
// regardless. Errors + breadcrumbs only (the default integrations include
// global handlers for onerror/onunhandledrejection plus console/fetch/history
// breadcrumbs). No performance tracing and no session replay.
if (environment.sentryDsn) {
  import('@sentry/angular')
    .then((sentry) => {
      sentry.init({
        dsn: environment.sentryDsn,
        environment: environment.envName,
        sendDefaultPii: false,
        tracesSampleRate: 0,
        beforeSend: (event) => {
          scrubSentryEvent(event);
          return event;
        },
      });
      errorTracker.sdkCapture = sentry.captureException;
    })
    .catch((err) => console.error('Error tracking failed to load:', err));
}

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));
