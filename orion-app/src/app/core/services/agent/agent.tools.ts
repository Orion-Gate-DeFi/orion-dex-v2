/**
 * Orion Assistant — tool registry + dispatcher.
 *
 * Tools wired to the app's existing services. Each `dispatch` result is a plain
 * JSON-serialisable object the service feeds back to the model as a `tool`
 * message. Mirrors the iOS AgentToolDispatcher.
 *
 * READ tools (get_balance, get_token_price... get_quote, search_token) return
 * data. WRITE tools (prepare_swap, prepare_send) only ARM the existing
 * swap/send review — they pre-fill the form and navigate; the user reviews,
 * acknowledges every guard and signs. The agent NEVER executes a transaction.
 *
 * @author Orion DEX Team
 * @version 0.2.0
 */
import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { WalletService } from '../wallet.service';
import { TokenDataService } from '../swap/token-data.service';
import { QuoteService } from '../swap/quote.service';
import { SwapIntentService } from '../swap/swap-intent.service';
import type { Token } from '../../models/token.model';
import type { AgentTool } from './agent.models';

/** Coerce a tool argument to a finite number, or undefined. */
function numArg(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * On-chain token names/symbols are attacker-controlled free text surfaced to the
 * model. Strip control characters (a prompt-injection vector) and clamp length
 * before returning them in a tool result.
 */
function safeText(value: string, max = 40): string {
  let out = '';
  for (const ch of value) {
    out += (ch.codePointAt(0) ?? 0) < 0x20 ? ' ' : ch;
  }
  return out.trim().slice(0, max);
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

@Injectable({ providedIn: 'root' })
export class AgentToolsService {
  private readonly wallet = inject(WalletService);
  private readonly tokenData = inject(TokenDataService);
  private readonly quote = inject(QuoteService);
  private readonly swapIntent = inject(SwapIntentService);
  private readonly router = inject(Router);

  /** OpenAI tool schemas advertised to the model. */
  readonly definitions: readonly AgentTool[] = [
    {
      type: 'function',
      function: {
        name: 'get_balance',
        description:
          "Get the connected wallet's token holdings (symbol, amount, USD value) " +
          'across supported chains. Use for "what do I hold / my balance / portfolio".',
        parameters: {
          type: 'object',
          properties: {
            chainId: {
              type: 'number',
              description: 'Optional: restrict to one chain (1, 42161, 8453, 137, 10, 56, 43114).',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_token',
        description:
          'Find tokens by symbol or name on a chain; returns address + decimals. ' +
          'Use to resolve a ticker before talking about a specific token.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Symbol or name fragment, e.g. "USDC".' },
            chainId: {
              type: 'number',
              description: "Chain to search (defaults to the wallet's current chain or Ethereum).",
            },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_quote',
        description:
          'Get a live swap quote: how much you would receive, rate, price impact, ' +
          'network fee and minimum received. Read-only — does NOT start a swap. ' +
          'Tokens are symbols ("ETH","USDC") or 0x addresses; same chain or cross-chain.',
        parameters: {
          type: 'object',
          properties: {
            fromToken: { type: 'string', description: 'Pay token: symbol or 0x address.' },
            toToken: { type: 'string', description: 'Receive token: symbol or 0x address.' },
            amount: { type: 'string', description: 'Human amount to pay, e.g. "1.5".' },
            fromChainId: { type: 'number', description: "Pay chain (default: wallet's chain or 1)." },
            toChainId: { type: 'number', description: 'Receive chain (default: same as fromChainId).' },
          },
          required: ['fromToken', 'toToken', 'amount'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'prepare_swap',
        description:
          'Open the swap screen PRE-FILLED with these tokens + amount so the user can ' +
          'review and sign. You do NOT execute — the user reviews risk, approves and signs ' +
          'themselves. Use only when the user clearly wants to swap.',
        parameters: {
          type: 'object',
          properties: {
            fromToken: { type: 'string', description: 'Pay token: symbol or 0x address.' },
            toToken: { type: 'string', description: 'Receive token: symbol or 0x address.' },
            amount: { type: 'string', description: 'Human amount to pay, e.g. "1.5".' },
            fromChainId: { type: 'number', description: "Pay chain (default: wallet's chain or 1)." },
            toChainId: { type: 'number', description: 'Receive chain (default: same as fromChainId).' },
          },
          required: ['fromToken', 'toToken', 'amount'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'prepare_send',
        description:
          'Open the send screen PRE-FILLED with recipient, token and amount so the user can ' +
          'review and sign. You do NOT send — the user confirms the recipient and signs. Use ' +
          'only when the user clearly wants to send to a specific 0x address.',
        parameters: {
          type: 'object',
          properties: {
            toAddress: { type: 'string', description: 'Recipient 0x address (40 hex).' },
            tokenSymbol: { type: 'string', description: 'Token to send, e.g. "USDC".' },
            amount: { type: 'string', description: 'Human amount to send, e.g. "100".' },
            chainId: { type: 'number', description: "Chain (default: wallet's chain or 1)." },
          },
          required: ['toAddress', 'tokenSymbol', 'amount'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'open_view',
        description:
          'Navigate the app when the user clearly wants to go somewhere. ' +
          'Views: swap, send, receive, dashboard.',
        parameters: {
          type: 'object',
          properties: {
            view: { type: 'string', enum: ['swap', 'send', 'receive', 'dashboard'] },
          },
          required: ['view'],
        },
      },
    },
  ];

  /**
   * Execute a tool call. Never throws — failures come back as `{ error }` so the
   * model can recover or tell the user honestly.
   */
  async dispatch(name: string, argumentsJson: string, signal?: AbortSignal): Promise<unknown> {
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(argumentsJson || '{}');
      if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
    } catch {
      return { error: 'Invalid tool arguments (not JSON).' };
    }

    try {
      switch (name) {
        case 'get_balance':
          return await this.getBalance(args);
        case 'search_token':
          return await this.searchToken(args);
        case 'get_quote':
          return await this.getQuote(args);
        case 'prepare_swap':
          return await this.prepareSwap(args, signal);
        case 'prepare_send':
          return await this.prepareSend(args, signal);
        case 'open_view':
          return this.openView(args, signal);
        default:
          return { error: `Unknown tool: ${name}` };
      }
    } catch (err) {
      return { error: (err as Error)?.message ?? 'Tool execution failed.' };
    }
  }

  // ---------------------------------------------------------------------------

  private async getBalance(args: Record<string, unknown>): Promise<unknown> {
    const address = this.wallet.address();
    if (!address) return { error: 'Wallet not connected.' };

    const chainId = numArg(args['chainId']);
    const holdings = await this.tokenData.getPortfolioBalances(
      address,
      chainId !== undefined ? [chainId] : undefined,
    );
    return {
      walletConnected: true,
      holdings: holdings.slice(0, 30).map(h => ({
        symbol: safeText(h.symbol, 20),
        name: safeText(h.name),
        amount: h.balance,
        usdValue: h.balanceUSD,
        priceUsd: h.priceUSD,
        chainId: h.chainId,
      })),
    };
  }

  private async searchToken(args: Record<string, unknown>): Promise<unknown> {
    const query = String(args['query'] ?? '').trim().toLowerCase();
    if (!query) return { error: 'Empty query.' };
    const chainId = numArg(args['chainId']) ?? this.wallet.chainId() ?? 1;

    const tokens = await this.tokenData.getTokensForChain(chainId);
    const matches = tokens
      .filter(
        t =>
          t.symbol.toLowerCase().includes(query) ||
          t.name.toLowerCase().includes(query) ||
          t.address.toLowerCase() === query,
      )
      .slice(0, 10)
      .map(t => ({
        symbol: safeText(t.symbol, 20),
        name: safeText(t.name),
        address: t.address,
        decimals: t.decimals,
        chainId: t.chainId,
      }));
    return { chainId, count: matches.length, tokens: matches };
  }

  private async getQuote(args: Record<string, unknown>): Promise<unknown> {
    const fromChainId = numArg(args['fromChainId']) ?? this.wallet.chainId() ?? 1;
    const toChainId = numArg(args['toChainId']) ?? fromChainId;
    const amount = String(args['amount'] ?? '').trim();
    if (!amount || !(Number(amount) > 0)) return { error: 'Provide a positive amount.' };

    const [from, to] = await Promise.all([
      this.resolveToken(fromChainId, String(args['fromToken'] ?? '')),
      this.resolveToken(toChainId, String(args['toToken'] ?? '')),
    ]);
    if (!from) return { error: `Couldn't find the pay token on chain ${fromChainId}.` };
    if (!to) return { error: `Couldn't find the receive token on chain ${toChainId}.` };

    const quote = await this.quote.getQuote(from, to, amount);
    if (!quote) {
      return { error: 'No quote available — connect a wallet, or this pair has no route/liquidity.' };
    }
    return {
      pay: `${quote.fromAmount} ${from.symbol}`,
      receive: `${quote.toAmount} ${to.symbol}`,
      receiveUsd: quote.toAmountUSD,
      rate: quote.exchangeRate,
      priceImpactPct: quote.priceImpact,
      minimumReceived: `${quote.minimumReceived} ${to.symbol}`,
      networkFeeUsd: quote.gasCostUSD,
      estimatedSeconds: quote.estimatedTime,
      via: quote.aggregator ?? null,
      crossChain: fromChainId !== toChainId,
    };
  }

  private async prepareSwap(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const fromChainId = numArg(args['fromChainId']) ?? this.wallet.chainId() ?? 1;
    const toChainId = numArg(args['toChainId']) ?? fromChainId;
    const amount = String(args['amount'] ?? '').trim();
    if (!amount || !(Number(amount) > 0)) return { error: 'Provide a positive amount.' };

    const [from, to] = await Promise.all([
      this.resolveToken(fromChainId, String(args['fromToken'] ?? '')),
      this.resolveToken(toChainId, String(args['toToken'] ?? '')),
    ]);
    if (!from) return { error: `Couldn't find the pay token on chain ${fromChainId}.` };
    if (!to) return { error: `Couldn't find the receive token on chain ${toChainId}.` };

    // The turn was cancelled (e.g. the panel closed) while we resolved tokens —
    // don't yank the user to a money screen after they dismissed the assistant.
    if (signal?.aborted) return { error: 'cancelled' };
    this.swapIntent.set({ fromToken: from, toToken: to, amount });
    void this.router.navigateByUrl('/swap');
    return {
      ok: true,
      prepared: `${amount} ${from.symbol} → ${to.symbol}`,
      note: 'Opened the swap screen pre-filled. The user reviews risk, approves and signs — you did NOT execute it.',
    };
  }

  private async prepareSend(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const to = String(args['toAddress'] ?? args['to'] ?? '').trim();
    if (!EVM_ADDRESS.test(to)) return { error: 'Provide a valid 0x recipient address (40 hex chars).' };
    const amount = String(args['amount'] ?? '').trim();
    if (!amount || !(Number(amount) > 0)) return { error: 'Provide a positive amount.' };
    const chainId = numArg(args['chainId']) ?? this.wallet.chainId() ?? 1;
    const symbol = String(args['tokenSymbol'] ?? args['token'] ?? '').trim();
    if (!symbol) return { error: 'Provide a token to send.' };

    const queryParams: Record<string, string> = { to, amount, token: symbol, chain: String(chainId) };
    const tok = await this.resolveToken(chainId, symbol);
    if (tok) queryParams['tokenAddress'] = tok.address;

    // Cancelled mid-resolve — don't navigate after the panel closed.
    if (signal?.aborted) return { error: 'cancelled' };
    void this.router.navigate(['/send'], { queryParams });
    return {
      ok: true,
      prepared: `send ${amount} ${symbol} to ${to.slice(0, 6)}…${to.slice(-4)} on chain ${chainId}`,
      note: 'Opened the send screen pre-filled. The user confirms the recipient + amount and signs — you did NOT send anything.',
    };
  }

  private openView(args: Record<string, unknown>, signal?: AbortSignal): unknown {
    const view = String(args['view'] ?? '').toLowerCase();
    const route: Record<string, string> = {
      swap: '/swap',
      send: '/send',
      receive: '/receive',
      dashboard: '/',
      home: '/',
    };
    const path = route[view];
    if (!path) return { error: `Unknown view: ${view}` };
    if (signal?.aborted) return { error: 'cancelled' };
    void this.router.navigateByUrl(path);
    return { ok: true, navigatedTo: view };
  }

  /** Resolve a symbol or 0x address to a Token on a chain (null if not found). */
  private async resolveToken(chainId: number, symbolOrAddress: string): Promise<Token | null> {
    const needle = symbolOrAddress.trim();
    if (!needle) return null;
    const tokens = await this.tokenData.getTokensForChain(chainId);
    if (EVM_ADDRESS.test(needle)) {
      const lower = needle.toLowerCase();
      return (
        tokens.find(t => t.address.toLowerCase() === lower) ??
        (await this.tokenData.getTokenByAddress(chainId, needle))
      );
    }
    const upper = needle.toUpperCase();
    return tokens.find(t => t.symbol.toUpperCase() === upper) ?? null;
  }
}
