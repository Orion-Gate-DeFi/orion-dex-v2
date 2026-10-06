import { TestBed } from '@angular/core/testing';
import { ToastService, Toast } from './toast.service';

describe('ToastService', () => {
  let service: ToastService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [ToastService]
    });
    service = TestBed.inject(ToastService);
  });

  afterEach(() => {
    const toastIds = service.toasts().map(t => t.id);
    toastIds.forEach(id => service.remove(id));
  });

  it('should start with empty toasts', () => {
    expect(service.toasts().length).toBe(0);
  });

  it('should add success toast', () => {
    service.success('Test Title', 'Test Message');

    expect(service.toasts().length).toBe(1);
    expect(service.toasts()[0].type).toBe('success');
    expect(service.toasts()[0].title).toBe('Test Title');
    expect(service.toasts()[0].message).toBe('Test Message');
  });

  it('should add error toast', () => {
    service.error('Error Title', 'Error Message');

    expect(service.toasts().length).toBe(1);
    expect(service.toasts()[0].type).toBe('error');
  });

  it('should add warning toast', () => {
    service.warning('Warning Title', 'Warning Message');

    expect(service.toasts().length).toBe(1);
    expect(service.toasts()[0].type).toBe('warning');
  });

  it('should add info toast', () => {
    service.info('Info Title', 'Info Message');

    expect(service.toasts().length).toBe(1);
    expect(service.toasts()[0].type).toBe('info');
  });

  it('should add link to toast', () => {
    const link = { text: 'Click me', url: 'https://example.com' };
    service.success('Title', 'Message', link);

    expect(service.toasts()[0].link).toEqual(link);
  });

  it('should remove toast by id', () => {
    service.success('Toast 1', 'Message 1');
    service.success('Toast 2', 'Message 2');

    const firstToastId = service.toasts()[0].id;
    service.remove(firstToastId);

    expect(service.toasts().length).toBe(1);
    expect(service.toasts()[0].title).toBe('Toast 2');
  });

  it('should generate unique IDs for toasts', () => {
    service.success('Toast 1', 'Message 1');
    service.success('Toast 2', 'Message 2');

    const ids = service.toasts().map(t => t.id);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('should handle multiple toasts', () => {
    service.success('Toast 1', 'Message 1');
    service.error('Toast 2', 'Message 2');
    service.warning('Toast 3', 'Message 3');

    expect(service.toasts().length).toBe(3);
  });

  it('should remove all toasts when removing each one', () => {
    service.success('Toast 1', 'Message 1');
    service.success('Toast 2', 'Message 2');
    service.success('Toast 3', 'Message 3');

    const toastIds = service.toasts().map(t => t.id);
    toastIds.forEach(id => service.remove(id));

    expect(service.toasts().length).toBe(0);
  });

  describe('stack cap', () => {
    it('should cap visible toasts at 4 by evicting the oldest', () => {
      for (let i = 1; i <= 5; i++) {
        service.info(`Toast ${i}`, `Message ${i}`);
      }

      const titles = service.toasts().map(t => t.title);
      expect(titles).toEqual(['Toast 2', 'Toast 3', 'Toast 4', 'Toast 5']);
    });

    it('should skip paused toasts and evict the oldest unpaused one', () => {
      const firstId = service.info('Toast 1', 'Message 1');
      for (let i = 2; i <= 4; i++) {
        service.info(`Toast ${i}`, `Message ${i}`);
      }
      service.pause(firstId); // user is reading the oldest toast

      service.info('Toast 5', 'Message 5');

      const titles = service.toasts().map(t => t.title);
      expect(titles).toEqual(['Toast 1', 'Toast 3', 'Toast 4', 'Toast 5']);
    });

    it('should tolerate overflow when every older toast is paused', () => {
      const ids: string[] = [];
      for (let i = 1; i <= 4; i++) {
        ids.push(service.info(`Toast ${i}`, `Message ${i}`));
      }
      ids.forEach(id => service.pause(id));

      service.info('Toast 5', 'Message 5');

      // Nothing evictable (and the just-shown toast must not be the victim).
      expect(service.toasts().length).toBe(5);
    });
  });

  describe('duplicate collapse', () => {
    it('should refresh the visible toast with the same title instead of stacking', () => {
      const firstId = service.error('RPC error', 'First attempt');
      const secondId = service.error('RPC error', 'Second attempt');

      expect(secondId).toBe(firstId);
      expect(service.toasts().length).toBe(1);
      expect(service.toasts()[0].message).toBe('Second attempt');
    });

    it('should restart the dismiss timer when a duplicate is collapsed', () => {
      jasmine.clock().install();
      try {
        service.info('Quote failed', 'Try again'); // default 5000ms
        jasmine.clock().tick(4000);

        service.info('Quote failed', 'Still failing'); // refresh, not stack

        // 8000ms after the first show — without the refresh it would have
        // auto-dismissed at 5000ms.
        jasmine.clock().tick(4000);
        expect(service.toasts().length).toBe(1);

        jasmine.clock().tick(1001);
        expect(service.toasts().length).toBe(0);
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('should not re-arm the timer when a duplicate refreshes a paused toast', () => {
      jasmine.clock().install();
      try {
        const id = service.info('Quote failed', 'Try again');
        service.pause(id); // user is reading the toast

        service.info('Quote failed', 'Still failing'); // duplicate while paused

        // Content refreshed, but no dismissal mid-read.
        jasmine.clock().tick(10000);
        expect(service.toasts().length).toBe(1);
        expect(service.toasts()[0].message).toBe('Still failing');

        // resume() arms the refreshed duration normally.
        service.resume(id);
        jasmine.clock().tick(5001);
        expect(service.toasts().length).toBe(0);
      } finally {
        jasmine.clock().uninstall();
      }
    });

    it('should keep the existing link when the duplicate carries none', () => {
      const link = { text: 'View on explorer', url: 'https://example.com/tx/0x1' };
      const id = service.error('Swap failed', 'First attempt', link);

      service.error('Swap failed', 'Second attempt'); // no link this time

      expect(service.toasts().length).toBe(1);
      expect(service.toasts()[0].id).toBe(id);
      expect(service.toasts()[0].message).toBe('Second attempt');
      expect(service.toasts()[0].link).toEqual(link);
    });

    it('should prefer the incoming link over the existing one', () => {
      service.error('Swap failed', 'First attempt', { text: 'Old', url: 'https://example.com/old' });
      const incoming = { text: 'New', url: 'https://example.com/new' };

      service.error('Swap failed', 'Second attempt', incoming);

      expect(service.toasts()[0].link).toEqual(incoming);
    });
  });

  describe('pause / resume (hover and keyboard focus share these)', () => {
    it('should not auto-dismiss while paused and re-arm on resume', () => {
      jasmine.clock().install();
      try {
        const id = service.info('Focus me', 'Body');

        service.pause(id);
        jasmine.clock().tick(10000);
        expect(service.toasts().length).toBe(1);

        service.resume(id);
        jasmine.clock().tick(5001);
        expect(service.toasts().length).toBe(0);
      } finally {
        jasmine.clock().uninstall();
      }
    });
  });
});
