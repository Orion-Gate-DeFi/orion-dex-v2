import { ApplicationConfig, provideZoneChangeDetection, APP_INITIALIZER, ErrorHandler } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { routes } from './app.routes';
import { EnvironmentValidatorService } from './core/services/environment-validator.service';
import { GlobalErrorHandler } from './core/services/global-error-handler.service';
import { authInterceptor } from './core/interceptors/auth.interceptor';

/**
 * App initializer factory for environment validation
 * Validates environment variables before the app starts
 */
export function validateEnvironment(validator: EnvironmentValidatorService) {
  return () => {
    const status = validator.validate();

    // If validation fails, show alert in development
    if (!status.isValid && !status.errors[0]?.includes('production')) {
      const errorMsg = validator.getErrorMessage(status);
      console.error(errorMsg);

      // In development, show alert (optional - comment out if annoying)
      // alert(errorMsg);
    }

    return Promise.resolve();
  };
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideHttpClient(withInterceptors([authInterceptor])),
    {
      provide: APP_INITIALIZER,
      useFactory: validateEnvironment,
      deps: [EnvironmentValidatorService],
      multi: true
    },
    {
      provide: ErrorHandler,
      useClass: GlobalErrorHandler
    }
  ]
};
