/**
 * EnvironmentValidatorService — required-setting validation and the blocking
 * `isBlocked` signal the app shell renders the config-error screen from.
 *
 * `validate()` takes an env parameter (defaulting to the real environment)
 * precisely so these specs never touch src/environments/* (CI-deployed).
 */
import { TestBed } from '@angular/core/testing';
import {
  EnvironmentValidatorService,
  ValidatedEnvironment,
} from './environment-validator.service';

describe('EnvironmentValidatorService', () => {
  let service: EnvironmentValidatorService;

  const validEnv: ValidatedEnvironment = {
    privyAppId: 'cmtestapp1234567890',
    lifiProxyUrl: 'https://api.example.com/lifi/v1',
    apiUrl: 'https://api.example.com/api/v1',
    lifiIntegrator: 'orion-dex',
    lifiFee: 0.001,
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [EnvironmentValidatorService],
    });
    service = TestBed.inject(EnvironmentValidatorService);
  });

  it('a fully valid env passes and does not block the app', () => {
    const status = service.validate(validEnv);

    expect(status.isValid).toBeTrue();
    expect(status.errors).toEqual([]);
    expect(service.isBlocked()).toBeFalse();
  });

  describe('apiUrl validation (fail-open fix)', () => {
    it('an empty apiUrl is a critical error that blocks the app', () => {
      const status = service.validate({ ...validEnv, apiUrl: '' });

      expect(status.isValid).toBeFalse();
      expect(status.errors.some((e) => e.includes('API_URL'))).toBeTrue();
      expect(service.isBlocked()).toBeTrue();
    });

    it('a non-HTTPS apiUrl is rejected', () => {
      const status = service.validate({ ...validEnv, apiUrl: 'http://api.example.com/api/v1' });

      expect(status.isValid).toBeFalse();
      expect(service.isBlocked()).toBeTrue();
    });

    it('an unparseable apiUrl is rejected', () => {
      const status = service.validate({ ...validEnv, apiUrl: 'https://' });

      expect(status.isValid).toBeFalse();
      expect(status.errors.some((e) => e.includes('API_URL'))).toBeTrue();
      expect(service.isBlocked()).toBeTrue();
    });
  });

  it('a missing privyAppId is a critical error that blocks the app', () => {
    const status = service.validate({ ...validEnv, privyAppId: '' });

    expect(status.isValid).toBeFalse();
    expect(status.errors.some((e) => e.includes('PRIVY_APP_ID'))).toBeTrue();
    expect(service.isBlocked()).toBeTrue();
  });

  it('a missing lifiProxyUrl is a critical error that blocks the app', () => {
    const status = service.validate({ ...validEnv, lifiProxyUrl: '' });

    expect(status.isValid).toBeFalse();
    expect(service.isBlocked()).toBeTrue();
  });

  it('warning-level issues (integrator, fee) do not block the app', () => {
    const status = service.validate({
      ...validEnv,
      lifiIntegrator: 'bad name!',
      lifiFee: 0.5,
    });

    expect(status.isValid).toBeTrue();
    expect(status.warnings.length).toBe(2);
    expect(service.isBlocked()).toBeFalse();
  });

  it('a later valid run clears a previous block (signal follows the last validation)', () => {
    service.validate({ ...validEnv, apiUrl: '' });
    expect(service.isBlocked()).toBeTrue();

    service.validate(validEnv);
    expect(service.isBlocked()).toBeFalse();
  });
});
