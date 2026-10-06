import { TestBed } from '@angular/core/testing';
import {
  GlobalErrorHandler,
  errorTracker,
  scrubWalletAddresses,
  scrubSentryEvent,
  ScrubbableEvent,
} from './global-error-handler.service';
import { ToastService } from './toast.service';

describe('GlobalErrorHandler', () => {
  let handler: GlobalErrorHandler;
  let toastService: jasmine.SpyObj<ToastService>;
  let captureSpy: jasmine.Spy;
  let isEnabledSpy: jasmine.Spy;

  beforeEach(() => {
    toastService = jasmine.createSpyObj<ToastService>('ToastService', ['error']);

    TestBed.configureTestingModule({
      providers: [
        GlobalErrorHandler,
        { provide: ToastService, useValue: toastService },
      ],
    });

    handler = TestBed.inject(GlobalErrorHandler);

    // Spy on the seam — never let the real SDK run inside Karma
    captureSpy = spyOn(errorTracker, 'captureException');
    isEnabledSpy = spyOn(errorTracker, 'isEnabled').and.returnValue(false);

    // Silence the handler's console output in the test log
    spyOn(console, 'group');
    spyOn(console, 'groupEnd');
    spyOn(console, 'error');
    spyOn(console, 'log');
  });

  it('should be created', () => {
    expect(handler).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // Sentry capture path
  // ---------------------------------------------------------------------------

  it('should not capture when tracking is disabled', () => {
    handler.handleError(new Error('boom'));

    expect(captureSpy).not.toHaveBeenCalled();
    expect(toastService.error).toHaveBeenCalled();
  });

  it('should capture the error with context when tracking is enabled', () => {
    isEnabledSpy.and.returnValue(true);
    const error = new Error('Cannot read properties of undefined');

    handler.handleError(error);

    expect(captureSpy).toHaveBeenCalledTimes(1);
    const [captured, context] = captureSpy.calls.mostRecent().args;
    expect(captured).toBe(error);
    expect(context.tags.errorType).toBe('runtime');
    expect(context.extra.url).toBe(window.location.href);
  });

  it('should not attach the raw extracted message as an extra (scrub bypass)', () => {
    isEnabledSpy.and.returnValue(true);

    handler.handleError(new Error('failed for 0x1234567890abcdef1234567890abcdef12345678'));

    const context = captureSpy.calls.mostRecent().args[1];
    expect('extractedMessage' in context.extra).toBeFalse();
  });

  it('should capture before showing the toast', () => {
    isEnabledSpy.and.returnValue(true);

    handler.handleError(new Error('boom'));

    expect(captureSpy).toHaveBeenCalledBefore(toastService.error);
  });

  it('should unwrap zone.js promise rejections to the original error', () => {
    isEnabledSpy.and.returnValue(true);
    const original = new Error('rejected');

    handler.handleError({ rejection: original, message: 'Uncaught (in promise): rejected' });

    expect(captureSpy.calls.mostRecent().args[0]).toBe(original);
  });

  it('should still capture known errors even though the toast is suppressed', () => {
    isEnabledSpy.and.returnValue(true);

    handler.handleError(new Error('USER_REJECTED'));

    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(toastService.error).not.toHaveBeenCalled();
  });
});

describe('errorTracker seam', () => {
  afterEach(() => {
    errorTracker.sdkCapture = undefined;
  });

  it('captureException is a no-op before the SDK has loaded', () => {
    errorTracker.sdkCapture = undefined;

    expect(() => errorTracker.captureException(new Error('early'), {})).not.toThrow();
  });

  it('forwards to the lazily-registered SDK capture function', () => {
    const sdkCapture = jasmine.createSpy('sdkCapture');
    errorTracker.sdkCapture = sdkCapture as unknown as typeof errorTracker.sdkCapture;
    const error = new Error('boom');

    errorTracker.captureException(error, { tags: { errorType: 'runtime' } });

    expect(sdkCapture).toHaveBeenCalledOnceWith(error, { tags: { errorType: 'runtime' } });
  });

  it('isEnabled stays false without a configured DSN even after the SDK loads', () => {
    // Test builds ship sentryDsn: '' — the DSN check must gate capture on its own.
    errorTracker.sdkCapture = jasmine.createSpy('sdkCapture') as unknown as typeof errorTracker.sdkCapture;

    expect(errorTracker.isEnabled()).toBeFalse();
  });
});

describe('scrubWalletAddresses', () => {
  const address = '0x1234567890abcdef1234567890abcdef12345678';

  it('should shorten a full wallet address to 0x12…78 form', () => {
    expect(scrubWalletAddresses(`insufficient funds for ${address}`))
      .toBe('insufficient funds for 0x12…78');
  });

  it('should shorten every address occurrence', () => {
    const other = '0xABCDEFabcdef0123456789ABCDEFabcdef012345';

    expect(scrubWalletAddresses(`transfer ${address} -> ${other}`))
      .toBe('transfer 0x12…78 -> 0xAB…45');
  });

  it('should leave longer hex blobs like tx hashes intact', () => {
    const txHash = '0x' + 'ab'.repeat(32); // 0x + 64 hex chars

    expect(scrubWalletAddresses(`tx ${txHash} failed`)).toBe(`tx ${txHash} failed`);
  });

  it('should leave text without addresses unchanged', () => {
    expect(scrubWalletAddresses('plain error, short hex 0xdeadbeef'))
      .toBe('plain error, short hex 0xdeadbeef');
  });
});

describe('scrubSentryEvent', () => {
  const address = '0x1234567890abcdef1234567890abcdef12345678';

  it('should scrub the event message and exception values in place', () => {
    const event: ScrubbableEvent = {
      message: `failed for ${address}`,
      exception: {
        values: [
          { value: `execution reverted for ${address}` },
          { value: 'no address here' },
        ],
      },
    };

    scrubSentryEvent(event);

    expect(event.message).toBe('failed for 0x12…78');
    expect(event.exception!.values![0].value).toBe('execution reverted for 0x12…78');
    expect(event.exception!.values![1].value).toBe('no address here');
  });

  it('should scrub breadcrumb messages', () => {
    const event: ScrubbableEvent = {
      breadcrumbs: [
        { message: `approve sent for ${address}` },
        { message: 'no address here' },
      ],
    };

    scrubSentryEvent(event);

    expect(event.breadcrumbs![0].message).toBe('approve sent for 0x12…78');
    expect(event.breadcrumbs![1].message).toBe('no address here');
  });

  it('should scrub string values in breadcrumb data, including nested objects and arrays', () => {
    const event: ScrubbableEvent = {
      breadcrumbs: [
        {
          data: {
            url: `https://api.example.com/balances/${address}`,
            status: 200,
            nested: { args: [`from ${address}`] },
          },
        },
      ],
    };

    scrubSentryEvent(event);

    const data = event.breadcrumbs![0].data!;
    expect(data['url']).toBe('https://api.example.com/balances/0x12…78');
    expect(data['status']).toBe(200);
    expect((data['nested'] as { args: string[] }).args[0]).toBe('from 0x12…78');
  });

  it('should stop descending into breadcrumb data beyond the depth cap', () => {
    const event: ScrubbableEvent = {
      breadcrumbs: [
        {
          data: {
            shallow: `at ${address}`,
            l1: { l2: { l3: { l4: { l5: { tooDeep: `at ${address}` } } } } },
          },
        },
      ],
    };

    scrubSentryEvent(event);

    const data = event.breadcrumbs![0].data as {
      shallow: string;
      l1: { l2: { l3: { l4: { l5: { tooDeep: string } } } } };
    };
    expect(data.shallow).toBe('at 0x12…78');
    expect(data.l1.l2.l3.l4.l5.tooDeep).toBe(`at ${address}`);
  });

  it('should terminate on cyclic breadcrumb data', () => {
    const cyclic: Record<string, unknown> = { msg: `from ${address}` };
    cyclic['self'] = cyclic;
    const event: ScrubbableEvent = { breadcrumbs: [{ data: cyclic }] };

    expect(() => scrubSentryEvent(event)).not.toThrow();
    expect(cyclic['msg']).toBe('from 0x12…78');
  });

  it('should strip the query string from request.url entirely', () => {
    const event: ScrubbableEvent = {
      request: { url: `https://app.oriongate.io/swap?fromAddress=${address}&amount=5` },
    };

    scrubSentryEvent(event);

    expect(event.request!.url).toBe('https://app.oriongate.io/swap');
  });

  it('should scrub addresses remaining in the request.url path', () => {
    const event: ScrubbableEvent = {
      request: { url: `https://app.oriongate.io/address/${address}/history` },
    };

    scrubSentryEvent(event);

    expect(event.request!.url).toBe('https://app.oriongate.io/address/0x12…78/history');
  });

  it('should scrub string values in extra, leaving non-strings untouched', () => {
    const event: ScrubbableEvent = {
      extra: {
        url: `https://app.oriongate.io/swap?from=${address}`,
        attempt: 3,
        flags: { wallet: address },
      },
    };

    scrubSentryEvent(event);

    expect(event.extra!['url']).toBe('https://app.oriongate.io/swap?from=0x12…78');
    expect(event.extra!['attempt']).toBe(3);
    expect((event.extra!['flags'] as Record<string, unknown>)['wallet']).toBe('0x12…78');
  });

  it('should tolerate events without any scrubbed fields', () => {
    const event: ScrubbableEvent = {};

    expect(() => scrubSentryEvent(event)).not.toThrow();
  });
});
