/**
 * =============================================================================
 * AUTH INTERCEPTOR
 * =============================================================================
 *
 * HTTP interceptor that:
 * - Adds Authorization Bearer header to API requests
 * - Handles 401 responses by logging out user (token expired)
 *
 * @author Orion DEX Team
 * @version 2.0.0
 */

import { HttpInterceptorFn, HttpRequest, HttpHandlerFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, switchMap, throwError, from } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { environment } from '../../../environments/environment';

/**
 * Auth interceptor function (Angular 19 functional interceptor)
 *
 * Only adds auth header to requests going to our API
 */
export const authInterceptor: HttpInterceptorFn = (req: HttpRequest<unknown>, next: HttpHandlerFn) => {
  const authService = inject(AuthService);

  // Only intercept requests to our API
  if (!req.url.startsWith(environment.apiUrl)) {
    return next(req);
  }

  // Get access token via the new asynchronous method
  return from(authService.getAccessTokenAsync()).pipe(
    switchMap(token => {
      let authReq = req;
      if (token) {
        authReq = req.clone({
          setHeaders: {
            Authorization: `Bearer ${token}`,
          },
        });
      }

      return next(authReq).pipe(
        catchError((error: HttpErrorResponse) => {
          // Handle 401 Unauthorized - token expired/invalid, need to re-authenticate.
          // EXCEPT the fire-and-forget backend signup (POST /my): a background
          // signup must never nuke a fresh session with a logout — a genuinely
          // bad token will 401 on the next foreground call anyway. Match the
          // exact `/my` path, not a substring: `url.includes('/my')` would also
          // spare `/myx` or a `?ref=/my` query, silently widening the carve-out.
          const isBackgroundSignup =
            req.method === 'POST' &&
            new URL(req.url).pathname === new URL(`${environment.apiUrl}/my`).pathname;
          if (error.status === 401 && !isBackgroundSignup) {
            authService.logout();
          }
          return throwError(() => error);
        })
      );
    })
  );
};