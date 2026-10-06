import type { TransactionReceipt } from 'ethers';
import { PUBLIC_RPCS } from '../constants/public-rpcs.constant';
import { pollPublicRpcReceipt } from './fetch-receipt';

describe('pollPublicRpcReceipt', () => {
  it('rotates to the next public RPC within the overall window instead of exhausting the deadline on a lagging first URL', async () => {
    // chainId 1 has 3 public RPC URLs configured (see public-rpcs.constant.ts).
    // The first URL is healthy but never has the receipt (a lagging-but-not
    // erroring node); the second URL has it immediately. With a per-URL
    // deadline the second URL must be consulted well before the 900ms
    // overall window expires — a single shared deadline would starve it.
    const fakeReceipt = { status: 1 } as unknown as TransactionReceipt;
    let providerIndex = -1;

    const providerFactory = (_url: string) => {
      providerIndex += 1;
      const index = providerIndex;
      return {
        getTransactionReceipt: async () => {
          if (index === 0) return null;
          if (index === 1) return fakeReceipt;
          return null;
        },
      };
    };

    const receipt = await pollPublicRpcReceipt(1, '0xdeadbeef', 900, providerFactory, 50);

    expect(receipt).toBe(fakeReceipt);
    expect(providerIndex).toBe(1);
  });

  it('cycles back through the RPC list until the overall deadline when early URLs fail fast', async () => {
    // Degraded-RPC scenario: the first two URLs throw immediately (dead
    // nodes), the third is healthy but needs a third poll before the receipt
    // lands. A single forward pass with per-URL slices would give the third
    // URL only one ~400ms slice (two polls at a 200ms interval) and return
    // null with most of the window unused — the loop must cycle back through
    // the list until the overall deadline instead.
    const fakeReceipt = { status: 1 } as unknown as TransactionReceipt;
    const urls = PUBLIC_RPCS[1];
    const factoryCalls: string[] = [];
    let healthyUrlPolls = 0;

    // The dead-URL throws are expected diagnostics — keep the output clean.
    spyOn(console, 'warn');

    const providerFactory = (url: string) => {
      factoryCalls.push(url);
      if (urls.indexOf(url) < 2) {
        return {
          getTransactionReceipt: (): Promise<TransactionReceipt | null> => {
            throw new Error('rpc down');
          },
        };
      }
      return {
        getTransactionReceipt: async (): Promise<TransactionReceipt | null> => {
          healthyUrlPolls += 1;
          return healthyUrlPolls >= 3 ? fakeReceipt : null;
        },
      };
    };

    const receipt = await pollPublicRpcReceipt(1, '0xdeadbeef', 1_200, providerFactory, 200);

    expect(receipt).toBe(fakeReceipt);
    expect(healthyUrlPolls).toBe(3);
    // Cycling proof: a 400ms slice at a 200ms interval fits at most two
    // polls per pass, so the third poll requires a second pass — i.e. the
    // dead first URL was re-attempted after the list was exhausted once.
    expect(factoryCalls.filter((u) => u === urls[0]).length).toBeGreaterThan(1);
  });

  it('returns null when no public RPCs are configured for the chain', async () => {
    const receipt = await pollPublicRpcReceipt(999999, '0xdeadbeef', 900);
    expect(receipt).toBeNull();
  });
});
