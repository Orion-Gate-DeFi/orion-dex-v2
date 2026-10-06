/**
 * =============================================================================
 * AUTH INTERCEPTOR SPEC
 * =============================================================================
 *
 * The interceptor is installed for real (`withInterceptors([authInterceptor])`)
 * rather than called as a function, so the two invariants that actually matter
 * are exercised end-to-end through HttpClient:
 *
 *  1. The Privy JWT is attached ONLY to `environment.apiUrl` requests — a
 *     third-party host must never see the bearer token (deleting the
 *     `startsWith(environment.apiUrl)` guard leaks it to every outbound
 *     HttpClient call).
 *  2. A 401 logs the user out, EXCEPT on the fire-and-forget backend signup
 *     (`POST {apiUrl}/my`). The carve-out is matched on the exact pathname:
 *     a substring match would also spare `/myx`, silently widening it.
 */
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { authInterceptor } from './auth.interceptor';
import { AuthService } from '../services/auth.service';
import { environment } from '../../../environments/environment';

describe('authInterceptor', () => {
  const TOKEN = 'privy-jwt-token';

  let http: HttpClient;
  let httpMock: HttpTestingController;
  let authSpy: jasmine.SpyObj<Pick<AuthService, 'getAccessTokenAsync' | 'logout'>>;

  /**
   * The interceptor resolves the token through a Promise before forwarding
   * the request, so nothing reaches HttpTestingController in the same tick.
   */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

  beforeEach(() => {
    authSpy = jasmine.createSpyObj<Pick<AuthService, 'getAccessTokenAsync' | 'logout'>>(
      'AuthService',
      ['getAccessTokenAsync', 'logout'],
    );
    authSpy.getAccessTokenAsync.and.resolveTo(TOKEN);

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: authSpy },
      ],
    });

    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  describe('token attachment', () => {
    it('attaches the bearer token to a backend API request', async () => {
      const url = `${environment.apiUrl}/swap/best-quote`;
      http.post(url, { amount: '1' }).subscribe({ next: () => {}, error: () => {} });
      await settle();

      const req = httpMock.expectOne(url);
      expect(req.request.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
      req.flush({});
    });

    it('sends NO Authorization header to a third-party host', async () => {
      // The whole point of the apiUrl guard: a hostile / unrelated host must
      // never receive the session JWT.
      http.get('https://evil.example/x').subscribe({ next: () => {}, error: () => {} });
      await settle();

      const req = httpMock.expectOne('https://evil.example/x');
      expect(req.request.headers.has('Authorization')).toBeFalse();
      // The token is not even requested for a non-API URL.
      expect(authSpy.getAccessTokenAsync).not.toHaveBeenCalled();
      req.flush({});
    });

    it('forwards the request unchanged when no token is available', async () => {
      authSpy.getAccessTokenAsync.and.resolveTo(null);
      const url = `${environment.apiUrl}/swap/best-quote`;
      http.post(url, {}).subscribe({ next: () => {}, error: () => {} });
      await settle();

      const req = httpMock.expectOne(url);
      expect(req.request.headers.has('Authorization')).toBeFalse();
      req.flush({});
    });
  });

  describe('401 handling', () => {
    it('logs out on a 401 from an ordinary API GET', async () => {
      const url = `${environment.apiUrl}/swap/status`;
      http.get(url).subscribe({ next: () => {}, error: () => {} });
      await settle();

      httpMock.expectOne(url).flush('nope', { status: 401, statusText: 'Unauthorized' });
      await settle();

      expect(authSpy.logout).toHaveBeenCalled();
    });

    it('does NOT log out on a 401 from the background signup POST /my', async () => {
      // Fire-and-forget signup: a 401 here must not nuke a fresh session —
      // a genuinely bad token 401s on the next foreground call anyway.
      const url = `${environment.apiUrl}/my`;
      http.post(url, {}).subscribe({ next: () => {}, error: () => {} });
      await settle();

      httpMock.expectOne(url).flush('nope', { status: 401, statusText: 'Unauthorized' });
      await settle();

      expect(authSpy.logout).not.toHaveBeenCalled();
    });

    it('DOES log out on a 401 from POST /myx — the carve-out is a path match, not a substring', async () => {
      // `url.includes('/my')` would spare this one too, silently widening the
      // exemption to any path that merely starts with those characters.
      const url = `${environment.apiUrl}/myx`;
      http.post(url, {}).subscribe({ next: () => {}, error: () => {} });
      await settle();

      httpMock.expectOne(url).flush('nope', { status: 401, statusText: 'Unauthorized' });
      await settle();

      expect(authSpy.logout).toHaveBeenCalled();
    });

    it('does not log out on non-401 API failures', async () => {
      const url = `${environment.apiUrl}/swap/best-quote`;
      http.post(url, {}).subscribe({ next: () => {}, error: () => {} });
      await settle();

      httpMock.expectOne(url).flush('boom', { status: 500, statusText: 'Server Error' });
      await settle();

      expect(authSpy.logout).not.toHaveBeenCalled();
    });
  });
});
