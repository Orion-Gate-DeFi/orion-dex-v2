import { TestBed } from '@angular/core/testing';
import { RpcPoolService } from './rpc-pool.service';

describe('RpcPoolService', () => {
  let service: RpcPoolService;
  const URL = 'https://rpc.example.test';

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(RpcPoolService);
  });

  it('treats an unknown URL as healthy', () => {
    expect(service.isHealthy(URL)).toBeTrue();
  });

  describe('failure classification', () => {
    it('cools an RPC after ethers v6 exhausts its internal 429 retries', () => {
      // ethers v6 retries 429s inside FetchRequest and resurfaces them as a
      // typed SERVER_ERROR whose message is "exceeded maximum retry limit".
      const err = Object.assign(new Error('exceeded maximum retry limit (request="…", response="…")'), {
        code: 'SERVER_ERROR',
        shortMessage: 'exceeded maximum retry limit',
      });
      service.markUnhealthy(URL, err);
      expect(service.isHealthy(URL)).toBeFalse();
    });

    it('cools an RPC on a plain rate-limit message', () => {
      service.markUnhealthy(URL, new Error('429 Too Many Requests'));
      expect(service.isHealthy(URL)).toBeFalse();
    });

    it('cools an RPC on a generic network error (short cooldown class)', () => {
      service.markUnhealthy(URL, new Error('fetch failed'));
      expect(service.isHealthy(URL)).toBeFalse();
    });

    it('does NOT cool an RPC on BAD_DATA — data-level failure, endpoint is fine', () => {
      const err = Object.assign(new Error('could not decode result data'), { code: 'BAD_DATA' });
      service.markUnhealthy(URL, err);
      expect(service.isHealthy(URL)).toBeTrue();
    });

    it('does NOT cool an RPC on CALL_EXCEPTION — a reverted call is not RPC health', () => {
      const err = Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' });
      service.markUnhealthy(URL, err);
      expect(service.isHealthy(URL)).toBeTrue();
    });
  });

  describe('provider cache', () => {
    it('caches one provider per chain+URL pair', () => {
      const created: string[] = [];
      spyOn(service as any, 'createProvider').and.callFake((url: string, chainId: number) => {
        created.push(`${chainId}:${url}`);
        return {};
      });

      const a = service.getProvider(URL, 1);
      const b = service.getProvider(URL, 1);
      service.getProvider(URL, 8453);

      expect(a).toBe(b);
      // Same URL on another chain is a distinct (chain-bound) provider.
      expect(created).toEqual([`1:${URL}`, `8453:${URL}`]);
    });
  });
});
