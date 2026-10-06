import { TestBed } from '@angular/core/testing';
import { WalletService } from './wallet.service';
import { RpcPoolService } from './rpc-pool.service';
import { AnalyticsService } from './analytics.service';
import { PUBLIC_RPCS } from '../constants/public-rpcs.constant';

describe('WalletService', () => {
  let service: WalletService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [WalletService]
    });
    service = TestBed.inject(WalletService);
  });

  it('should initialize with disconnected state', () => {
    expect(service.isConnected()).toBe(false);
    expect(service.address()).toBeNull();
    expect(service.chainId()).toBeNull();
  });

  it('should have correct initial balance', () => {
    expect(service.state().balance).toBe('0');
  });

  it('should generate short address correctly', () => {
    const testAddress = '0x1234567890123456789012345678901234567890';

    // Manually set address for testing
    (service as any)._state.set({
      ...service.state(),
      address: testAddress
    });

    expect(service.shortAddress()).toBe('0x1234...7890');
  });

  it('should return null short address when not connected', () => {
    expect(service.shortAddress()).toBeNull();
  });

  it('should return current chain info', () => {
    // Set chain ID to Ethereum
    (service as any)._state.set({
      ...service.state(),
      chainId: 1
    });

    const currentChain = service.currentChain();
    expect(currentChain).toBeDefined();
    expect(currentChain?.name).toBe('Ethereum');
  });

  it('should return null for unknown chain', () => {
    (service as any)._state.set({
      ...service.state(),
      chainId: 99999
    });

    expect(service.currentChain()).toBeNull();
  });

  it('should return provider and signer as null initially', () => {
    expect(service.getProvider()).toBeNull();
    expect(service.getSigner()).toBeNull();
  });

  it('should reset state on disconnect', () => {
    // Set connected state
    (service as any)._state.set({
      isConnected: true,
      isConnecting: false,
      address: '0x123',
      chainId: 1,
      balance: '100',
      error: null
    });

    service.disconnect();

    expect(service.isConnected()).toBe(false);
    expect(service.address()).toBeNull();
    expect(service.chainId()).toBeNull();
    expect(service.state().balance).toBe('0');
  });

  describe('switchChain', () => {
    const ARBITRUM = 42161;
    const ARBITRUM_HEX = '0xa4b1';

    let request: jasmine.Spy;
    let refreshConnection: jasmine.Spy;
    let track: jasmine.Spy;

    /** Args of the first EIP-1193 call with the given method, if any. */
    const callWithMethod = (method: string): { method: string; params?: unknown[] } | undefined =>
      (request.calls.allArgs() as Array<[{ method: string; params?: unknown[] }]>)
        .map(([arg]) => arg)
        .find((arg) => arg.method === method);

    beforeEach(() => {
      request = jasmine.createSpy('request').and.resolveTo(null);
      (service as any).ethereumProvider = { request };
      // The refresh is the seam under test: switchChain's contract is
      // "report the switch as failed unless the provider actually came back
      // on the new chain".
      refreshConnection = spyOn(service as any, 'refreshConnection');
      track = spyOn(TestBed.inject(AnalyticsService), 'track');
    });

    it('returns FALSE when the post-switch provider refresh fails', async () => {
      // Pre-fix this returned `true` after merely logging: callers then
      // proceeded on a stale chainId and a swap intended for chain X got
      // signed against chain Y.
      refreshConnection.and.resolveTo(false);

      await expectAsync(service.switchChain(ARBITRUM)).toBeResolvedTo(false);

      expect(callWithMethod('wallet_switchEthereumChain')).toEqual({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: ARBITRUM_HEX }],
      });
      // A failed switch is not a chain selection.
      expect(track).not.toHaveBeenCalled();
    });

    it('returns true and tracks chain_selected when the refresh succeeds', async () => {
      refreshConnection.and.resolveTo(true);

      await expectAsync(service.switchChain(ARBITRUM)).toBeResolvedTo(true);

      expect(track).toHaveBeenCalledWith('chain_selected', { chain: 'Arbitrum' });
    });

    describe('chain not in the wallet yet (EIP-1193 error 4902)', () => {
      beforeEach(() => {
        request.and.callFake(async (payload: { method: string }) => {
          if (payload.method === 'wallet_switchEthereumChain') {
            throw Object.assign(new Error('Unrecognized chain ID'), { code: 4902 });
          }
          return null;
        });
      });

      it('adds the chain and then reports the refresh result (true)', async () => {
        refreshConnection.and.resolveTo(true);

        await expectAsync(service.switchChain(ARBITRUM)).toBeResolvedTo(true);

        expect(callWithMethod('wallet_addEthereumChain')).toBeDefined();
        expect(track).toHaveBeenCalledWith('chain_selected', { chain: 'Arbitrum' });
      });

      it('still returns false when the refresh after the add fails', async () => {
        refreshConnection.and.resolveTo(false);

        await expectAsync(service.switchChain(ARBITRUM)).toBeResolvedTo(false);

        expect(callWithMethod('wallet_addEthereumChain')).toBeDefined();
        expect(track).not.toHaveBeenCalled();
      });

      it('hands the wallet the canonical first PUBLIC_RPCS entry, not a local copy', async () => {
        // A stale hardcoded RPC here once pointed MetaMask at llamarpc,
        // which 429s within seconds of any traffic.
        refreshConnection.and.resolveTo(true);

        await service.switchChain(ARBITRUM);

        const addCall = callWithMethod('wallet_addEthereumChain')!;
        const config = (addCall.params as Array<{ chainId: string; rpcUrls: string[] }>)[0];
        expect(config.chainId).toBe(ARBITRUM_HEX);
        expect(config.rpcUrls).toEqual([PUBLIC_RPCS[ARBITRUM][0]]);
      });
    });
  });

  describe('chainChanged provider refresh', () => {
    const WALLET = '0x1234567890123456789012345678901234567890';

    /**
     * Minimal EIP-1193 fake: answers the RPC calls a fresh BrowserProvider +
     * signer + balance read need, and records event handlers so the test can
     * fire 'chainChanged' the way MetaMask does.
     */
    const makeEip1193 = (chainIdHex: string) => {
      const handlers: Record<string, (payload: unknown) => void> = {};
      return {
        handlers,
        on: (event: string, cb: (payload: unknown) => void): void => {
          handlers[event] = cb;
        },
        request: async ({ method }: { method: string }): Promise<unknown> => {
          switch (method) {
            case 'eth_chainId':
              return chainIdHex;
            case 'eth_accounts':
            case 'eth_requestAccounts':
              return [WALLET];
            case 'eth_getBalance':
              return '0xde0b6b3a7640000'; // 1 ETH
            default:
              throw new Error(`unexpected RPC ${method}`);
          }
        },
      };
    };

    it('rebuilds the ethers provider before reading balances (stale-provider NETWORK_ERROR guard)', async () => {
      // Wallet is already switched to Arbitrum at the EIP-1193 level…
      const eip1193 = makeEip1193('0xa4b1');
      (service as any).ethereumProvider = eip1193;
      (service as any)._state.set({
        isConnected: true,
        isConnecting: false,
        address: WALLET,
        chainId: 1,
        balance: '0',
        error: null,
      });
      // …but the service still holds the BrowserProvider created on Ethereum.
      // Pre-fix, chainChanged read the balance through THIS stale instance
      // and ethers threw NETWORK_ERROR ("network changed: 1 => 42161").
      const staleProvider = {
        getBalance: jasmine.createSpy('staleGetBalance').and.rejectWith(
          Object.assign(new Error('network changed: 1 => 42161'), { code: 'NETWORK_ERROR' }),
        ),
      };
      (service as any).provider = staleProvider;

      (service as any).setupProviderListeners(eip1193);
      eip1193.handlers['chainChanged']('0xa4b1');

      // The refresh runs async off the event; poll until the balance commits.
      for (let i = 0; i < 200 && service.state().balance !== '1.0'; i++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }

      expect(service.chainId()).toBe(42161);
      expect(service.state().balance).toBe('1.0');
      expect(service.state().error).toBeNull();
      // The balance came from a FRESH provider — the stale one was never asked.
      expect(staleProvider.getBalance).not.toHaveBeenCalled();
      expect((service as any).provider).not.toBe(staleProvider);
    }, 10000);

    it('still records the new chainId synchronously from the event payload', () => {
      const eip1193 = makeEip1193('0xa4b1');
      (service as any).ethereumProvider = eip1193;
      (service as any).setupProviderListeners(eip1193);

      eip1193.handlers['chainChanged']('0xa4b1');

      // State reflects the wallet's chain immediately, without waiting for
      // the async provider rebuild to round-trip.
      expect(service.chainId()).toBe(42161);
    });
  });

  describe('public-RPC balance fetching', () => {
    const NATIVE = '0x0000000000000000000000000000000000000000';
    const WALLET = '0x1234567890123456789012345678901234567890';

    /** Spy on the shared pool's construction seam (one pool per TestBed). */
    const spyOnProviderFactory = (): jasmine.Spy =>
      spyOn(TestBed.inject(RpcPoolService) as any, 'createProvider');

    beforeEach(() => {
      // Connected on Ethereum; balance queries target a DIFFERENT chain so
      // they go through the public-RPC path (no wallet provider in tests).
      (service as any)._state.set({
        ...service.state(),
        address: WALLET,
        chainId: 1,
      });
    });

    it('constructs one provider per URL+chain and reuses it across calls', async () => {
      const fake = { getBalance: jasmine.createSpy('getBalance').and.resolveTo(1_000_000_000_000_000_000n) };
      const factory = spyOnProviderFactory().and.returnValue(fake);

      const first = await service.getTokenBalance(NATIVE, 18, 8453);
      const second = await service.getTokenBalance(NATIVE, 18, 8453);

      expect(first).toBe('1.0');
      expect(second).toBe('1.0');
      // Same URL+chain → a single construction, two reads through the cache.
      expect(factory).toHaveBeenCalledTimes(1);
      expect(fake.getBalance).toHaveBeenCalledTimes(2);
    });

    it('skips an RPC during its cooldown window after a rate-limit failure', async () => {
      const failing = { getBalance: jasmine.createSpy('failing').and.rejectWith(new Error('429 Too Many Requests')) };
      const healthy = { getBalance: jasmine.createSpy('healthy').and.resolveTo(0n) };
      const urls = PUBLIC_RPCS[8453];
      spyOnProviderFactory().and.callFake(
        (url: string) => (url === urls[0] ? failing : healthy),
      );

      await service.getTokenBalance(NATIVE, 18, 8453);
      expect(failing.getBalance).toHaveBeenCalledTimes(1);
      expect(healthy.getBalance).toHaveBeenCalledTimes(1);

      await service.getTokenBalance(NATIVE, 18, 8453);
      // The 429ing endpoint is cooling down — not re-polled.
      expect(failing.getBalance).toHaveBeenCalledTimes(1);
      expect(healthy.getBalance).toHaveBeenCalledTimes(2);
    });

    it('does NOT cool an RPC after a data-level BAD_DATA failure', async () => {
      const badData = Object.assign(new Error('could not decode result data'), { code: 'BAD_DATA' });
      const failing = { getBalance: jasmine.createSpy('failing').and.rejectWith(badData) };
      const healthy = { getBalance: jasmine.createSpy('healthy').and.resolveTo(0n) };
      const urls = PUBLIC_RPCS[8453];
      spyOnProviderFactory().and.callFake(
        (url: string) => (url === urls[0] ? failing : healthy),
      );

      await service.getTokenBalance(NATIVE, 18, 8453);
      await service.getTokenBalance(NATIVE, 18, 8453);
      // BAD_DATA says nothing about endpoint health — the URL is retried,
      // not put in cooldown (the next URL still serves the result).
      expect(failing.getBalance).toHaveBeenCalledTimes(2);
      expect(healthy.getBalance).toHaveBeenCalledTimes(2);
    });

    it('getNativeBalanceStrict returns null (unknown) once every RPC is cooling down', async () => {
      const failing = { getBalance: jasmine.createSpy('failing').and.rejectWith(new Error('429 Too Many Requests')) };
      spyOnProviderFactory().and.returnValue(failing);
      const rpcCount = PUBLIC_RPCS[10].length;

      expect(await service.getNativeBalanceStrict(10)).toBeNull();
      expect(failing.getBalance).toHaveBeenCalledTimes(rpcCount);

      // Second call: every URL in cooldown → immediate null, zero RPC traffic.
      expect(await service.getNativeBalanceStrict(10)).toBeNull();
      expect(failing.getBalance).toHaveBeenCalledTimes(rpcCount);
    });
  });
});
