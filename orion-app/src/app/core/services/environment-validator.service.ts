/**
 * =============================================================================
 * ENVIRONMENT VALIDATOR SERVICE
 * =============================================================================
 *
 * Validates that all required environment variables are set on application startup.
 * Prevents the app from starting with missing or invalid configuration.
 *
 * Critical failures (privyAppId / lifiProxyUrl / apiUrl missing or invalid)
 * flip the `isBlocked` signal, which the app shell uses to render a blocking
 * configuration-error screen instead of silently starting a broken app.
 *
 * @author Orion DEX Team
 * @version 2.1.0
 */

import { Injectable, signal } from '@angular/core';
import { environment } from '../../../environments/environment';

/**
 * The subset of the environment object this service validates. Kept as an
 * explicit interface so specs can pass a fake env without touching the real
 * (CI-deployed) environment files.
 */
export interface ValidatedEnvironment {
  privyAppId: string;
  lifiProxyUrl: string;
  apiUrl: string;
  lifiIntegrator: string;
  lifiFee: number;
}

/**
 * Validation result for an environment variable
 */
interface ValidationResult {
  key: string;
  value: string;
  isValid: boolean;
  errorMessage?: string;
}

/**
 * Overall validation status
 */
interface ValidationStatus {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  results: ValidationResult[];
}

@Injectable({
  providedIn: 'root'
})
export class EnvironmentValidatorService {

  /**
   * True when a REQUIRED setting (privyAppId / lifiProxyUrl / apiUrl) is
   * missing or invalid. The app shell renders a blocking config-error screen
   * off this signal — a broken build must fail loudly, not start silently.
   */
  private readonly criticalFailure = signal(false);
  readonly isBlocked = this.criticalFailure.asReadonly();

  /**
   * Validate all required environment variables
   * Call this in APP_INITIALIZER to ensure env is valid before app starts
   */
  validate(env: ValidatedEnvironment = environment): ValidationStatus {
    const results: ValidationResult[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check Privy App ID (REQUIRED)
    const privyResult = this.validatePrivyAppId(env.privyAppId);
    results.push(privyResult);
    if (!privyResult.isValid) {
      errors.push(privyResult.errorMessage!);
    }

    // Check LI.FI Proxy URL (REQUIRED)
    const lifiResult = this.validateLifiProxyUrl(env.lifiProxyUrl);
    results.push(lifiResult);
    if (!lifiResult.isValid) {
      errors.push(lifiResult.errorMessage!);
    }

    // Check Orion backend API URL (REQUIRED — /best-quote, /refresh-quote)
    const apiResult = this.validateApiUrl(env.apiUrl);
    results.push(apiResult);
    if (!apiResult.isValid) {
      errors.push(apiResult.errorMessage!);
    }

    // Check Integrator name
    const integratorResult = this.validateIntegrator(env.lifiIntegrator);
    results.push(integratorResult);
    if (!integratorResult.isValid) {
      warnings.push(integratorResult.errorMessage!);
    }

    // Check fee configuration
    const feeResult = this.validateFee(env.lifiFee);
    results.push(feeResult);
    if (!feeResult.isValid) {
      warnings.push(feeResult.errorMessage!);
    }

    const isValid = errors.length === 0;
    this.criticalFailure.set(!isValid);

    // Log results
    this.logValidationResults({ isValid, errors, warnings, results });

    return { isValid, errors, warnings, results };
  }

  /**
   * Validate Privy App ID
   */
  private validatePrivyAppId(value: string): ValidationResult {
    const key = 'PRIVY_APP_ID';

    // Check if set
    if (!value || value === 'YOUR_PRIVY_APP_ID') {
      return {
        key,
        value: value || '(not set)',
        isValid: false,
        errorMessage: '❌ PRIVY_APP_ID is not set. Get one at https://dashboard.privy.io/'
      };
    }

    // Check format (should start with "cl" or "cm" - Privy app ID prefixes)
    if (!value.startsWith('cl') && !value.startsWith('cm')) {
      return {
        key,
        value,
        isValid: false,
        errorMessage: `❌ PRIVY_APP_ID has invalid format: "${value}"`
      };
    }

    return {
      key,
      value,
      isValid: true
    };
  }

  /**
   * Validate LI.FI Proxy URL
   */
  private validateLifiProxyUrl(value: string): ValidationResult {
    const key = 'LIFI_PROXY_URL';

    if (!value || value.trim() === '') {
      return {
        key,
        value: '(not set)',
        isValid: false,
        errorMessage: '❌ LIFI_PROXY_URL not set. Required for LI.FI API calls.'
      };
    }

    // HTTPS-only by design: local plain-http proxies are deliberately
    // blocked — preprod-over-https is the supported dev path.
    if (!value.startsWith('https://')) {
      return {
        key,
        value,
        isValid: false,
        errorMessage: `❌ LIFI_PROXY_URL must be HTTPS: ${value}`
      };
    }

    return {
      key,
      value: value.substring(0, 10) + '…',
      isValid: true
    };
  }

  /**
   * Validate Orion backend API URL (best-quote / refresh-quote dispatch).
   * Mirrors the LI.FI proxy check, plus a full URL-parse — a typo'd host
   * here means every quote silently falls back or fails.
   */
  private validateApiUrl(value: string): ValidationResult {
    const key = 'API_URL';

    if (!value || value.trim() === '') {
      return {
        key,
        value: '(not set)',
        isValid: false,
        errorMessage: '❌ API_URL not set. Required for backend quote dispatch (/best-quote).'
      };
    }

    // HTTPS-only by design: local plain-http backends are deliberately
    // blocked — preprod-over-https is the supported dev path.
    if (!value.startsWith('https://')) {
      return {
        key,
        value,
        isValid: false,
        errorMessage: `❌ API_URL must be HTTPS: ${value}`
      };
    }

    try {
      new URL(value);
    } catch {
      return {
        key,
        value,
        isValid: false,
        errorMessage: `❌ API_URL is not a parseable URL: ${value}`
      };
    }

    return {
      key,
      value: value.substring(0, 10) + '…',
      isValid: true
    };
  }

  /**
   * Validate integrator name
   */
  private validateIntegrator(value: string): ValidationResult {
    const key = 'LIFI_INTEGRATOR';

    if (!value || value.trim() === '') {
      return {
        key,
        value: '(not set)',
        isValid: false,
        errorMessage: '⚠️  LIFI_INTEGRATOR not set. Using default "orion-dex"'
      };
    }

    // Should be a simple string (no spaces, special characters)
    if (!/^[a-z0-9-]+$/i.test(value)) {
      return {
        key,
        value,
        isValid: false,
        errorMessage: `⚠️  LIFI_INTEGRATOR should only contain letters, numbers, and hyphens`
      };
    }

    return {
      key,
      value,
      isValid: true
    };
  }

  /**
   * Validate fee configuration
   */
  private validateFee(value: number): ValidationResult {
    const key = 'LIFI_FEE';

    if (typeof value !== 'number' || isNaN(value)) {
      return {
        key,
        value: String(value),
        isValid: false,
        errorMessage: `⚠️  LIFI_FEE must be a number`
      };
    }

    if (value < 0 || value > 0.1) {
      return {
        key,
        value: String(value),
        isValid: false,
        errorMessage: `⚠️  LIFI_FEE should be between 0 and 0.1 (0-10%). Current: ${value}`
      };
    }

    return {
      key,
      value: `${(value * 100).toFixed(2)}%`,
      isValid: true
    };
  }

  /**
   * Log validation results to console
   */
  private logValidationResults(status: ValidationStatus): void {
    // Log errors
    if (status.errors.length > 0) {
      console.group('❌ Errors (must fix):');
      status.errors.forEach(err => console.error(err));
      console.groupEnd();
    }

    // Log warnings
    if (status.warnings.length > 0) {
      console.group('⚠️  Warnings (recommended to fix):');
      status.warnings.forEach(warn => console.warn(warn));
      console.groupEnd();
    }
  }

  /**
   * Get a user-friendly error message for display
   */
  getErrorMessage(status: ValidationStatus): string {
    if (status.isValid) {
      return '';
    }

    let message = '⚠️ Configuration Error\n\n';

    if (status.errors.length > 0) {
      message += 'The following required configuration is missing:\n\n';
      status.errors.forEach(err => {
        message += `${err}\n`;
      });
      message += '\nPlease check ENVIRONMENT_SETUP.md for instructions.';
    }

    return message;
  }
}
