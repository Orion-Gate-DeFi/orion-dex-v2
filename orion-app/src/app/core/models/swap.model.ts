/**
 * =============================================================================
 * SWAP MODELS
 * =============================================================================
 * 
 * This file defines TypeScript interfaces for swap operations.
 * Includes quote structure, transaction states, and swap state management.
 *
 * @author Orion DEX Team
 * @version 2.1.0
 */

import { Token } from './token.model';

// =============================================================================
// SWAP QUOTE
// =============================================================================

/**
 * Represents a swap quote from LI.FI
 * Contains all information needed to display and execute a swap
 */
export interface SwapQuote {
  /** Unique quote ID */
  id: string;
  
  /** Token being sold */
  fromToken: Token;
  
  /** Token being bought */
  toToken: Token;
  
  /** Amount to sell (human readable, e.g., "1.5") */
  fromAmount: string;
  
  /** Amount to receive (human readable) */
  toAmount: string;
  
  /** Value of fromAmount in USD */
  fromAmountUSD: string;
  
  /** Value of toAmount in USD */
  toAmountUSD: string;
  
  /** Exchange rate string (e.g., "1 ETH = 3500.00 USDC") */
  exchangeRate: string;
  
  /** Price impact percentage (how much the trade affects price) */
  priceImpact: string;
  
  /** Gas cost in native token */
  gasCost: string;
  
  /** Gas cost in USD */
  gasCostUSD: string;
  
  /** Estimated transaction time in seconds */
  estimatedTime: number;
  
  /** Route taken (which DEXes/bridges used) */
  route: SwapRoute[];
  
  /** Slippage tolerance percentage */
  slippage: number;

  /** Minimum amount user will receive (after slippage) */
  minimumReceived: string;

  /** Timestamp when quote was created (for freshness check) */
  createdAt?: number;

  /** Internal: Original LI.FI route data for execution */
  _lifiRoute?: LifiRouteData;

  /** Internal: Backend aggregator data for execution (multi-aggregator mode) */
  _aggregatorData?: AggregatorQuote;

  /** Which aggregator produced this quote (set when using backend API) */
  aggregator?: AggregatorName;
}

/**
 * LI.FI route data needed for swap execution
 * This is stored internally on SwapQuote to ensure we use the same
 * route that was approved (prevents approvalAddress mismatch bugs)
 */
export interface LifiRouteData {
  /** Quote ID from LI.FI */
  id?: string;

  /**
   * Bridge/exchange tool key (e.g. 'stargate'). Already present at runtime on
   * the stored LI.FI quote; typed here so the status tracker can pass the
   * `bridge` hint LI.FI recommends (required for cross-chain lookups).
   */
  tool?: string;

  /** Transaction request data for execution */
  transactionRequest?: {
    to: string;
    data: string;
    value?: string;
    gasLimit?: string | bigint;
    gasPrice?: string | bigint;
    chainId?: number;
  };

  /** Estimate containing approval address */
  estimate?: {
    approvalAddress?: string;
    toAmount?: string;
    toAmountMin?: string;
    executionDuration?: number;
    gasCosts?: Array<{
      amount: string;
      amountUSD: string;
      token: any;
    }>;
  };

  /** Included steps for multi-hop swaps */
  includedSteps?: Array<{
    tool: string;
    toolDetails?: {
      name: string;
      logoURI?: string;
    };
  }>;
}

// =============================================================================
// MULTI-AGGREGATOR BACKEND API TYPES
// =============================================================================

/**
 * Aggregator identifiers from the backend swap service.
 * Maps to the Go `Aggregator` type in `internal/swap/aggregator.go`.
 */
export type AggregatorName = 'zerox' | 'paraswap' | 'odos' | 'lifi' | 'squid';

/**
 * Request body for POST /api/v1/swap/best-quote
 */
export interface BestQuoteRequest {
  from_token: string;
  to_token: string;
  amount: string;
  from_chain_id: number;
  to_chain_id: number;
  sender_address: string;
  slippage?: number;
}

/**
 * Response from POST /api/v1/swap/best-quote
 */
export interface BestQuoteResponse {
  best_quote: AggregatorQuote;
  alternatives?: AggregatorQuote[];
}

/**
 * Request body for POST /api/v1/swap/refresh-quote
 */
export interface RefreshQuoteRequest {
  aggregator: AggregatorName;
  from_token: string;
  to_token: string;
  amount: string;
  from_chain_id: number;
  to_chain_id: number;
  sender_address: string;
  slippage?: number;
  /** Raw to-amount (wei) of the quote being refreshed — lets the backend compute price_changed. */
  previous_to_amount?: string;
  /** Approval address of the quote being refreshed — lets the backend compute approval_address_changed. */
  previous_approval_address?: string;
}

/**
 * Response from POST /api/v1/swap/refresh-quote
 */
export interface RefreshQuoteResponse {
  quote: AggregatorQuote;
  price_changed?: boolean;
  approval_address_changed?: boolean;
}

/**
 * A single aggregator quote from the backend.
 * Contains the winning aggregator's calldata ready for on-chain execution.
 */
export interface AggregatorQuote {
  aggregator: AggregatorName;
  from_token?: string;
  to_token?: string;
  from_amount?: string;
  /** Input amount in USD (backend ≥0.0.14: adapter-native data / sibling derivation). */
  from_amount_usd?: string;
  to_amount: string;
  /** Output amount in USD — absent when no adapter could price the pair. */
  to_amount_usd?: string;
  /**
   * Aggregator-enforced post-slippage floor in raw token units (wei-style).
   * Absent for ODOS by design: its API gives no enforced-floor semantics, so
   * the backend refuses to report an unenforced number as a minimum — the
   * frontend falls back to its own toAmount×(1−slippage) estimate.
   */
  to_amount_min?: string;
  approval_address: string;
  tx_request: AggregatorTxRequest;
  estimated_gas?: string;
  quoted_at: number;
  /** Squid only: pass to GET /swap/status as `quote_id` for bridge tracking. */
  tracking_quote_id?: string;
  /** Squid only: pass to GET /swap/status as `request_id` for bridge tracking. */
  tracking_request_id?: string;
}

/**
 * Transaction request data from the backend.
 * Passed directly to `signer.sendTransaction()`.
 */
export interface AggregatorTxRequest {
  to: string;
  data: string;
  value: string;
  gas_limit?: string;
}

/**
 * Normalized bridge status from GET /api/v1/swap/status.
 * Per the backend contract only `success` and `partial_success` are final —
 * everything else (including `not_found`, which is normal right after
 * submission while upstream indexers catch up) means "keep polling".
 */
export type SwapBridgeStatus =
  | 'pending'
  | 'success'
  | 'needs_gas'
  | 'partial_success'
  | 'refunding'
  | 'not_found';

/**
 * Client-side parameters for GET /api/v1/swap/status (camelCase here;
 * AggregatorService translates to the snake_case query params on the wire).
 */
export interface SwapStatusRequest {
  aggregator: AggregatorName;
  /** Source-chain transaction hash. */
  transactionId: string;
  fromChainId: number;
  toChainId: number;
  /** Squid: `AggregatorQuote.tracking_quote_id`. */
  quoteId?: string;
  /** Squid: `AggregatorQuote.tracking_request_id`. */
  requestId?: string;
}

/**
 * Response from GET /api/v1/swap/status — the backend bridge-status
 * dispatcher's normalized view of a cross-chain transfer.
 */
export interface SwapStatusResponse {
  aggregator: string;
  status: SwapBridgeStatus;
  /** Raw upstream substatus (e.g. Squid 'ONGOING') — display/debug only. */
  substatus: string;
  /** External end-to-end tracker URL (Squid: Axelarscan). */
  tracking_url?: string;
  /** True only for `success` / `partial_success`. */
  is_final: boolean;
}

/**
 * Single step in a swap route
 * Complex swaps may use multiple protocols
 */
export interface SwapRoute {
  /** Protocol name (e.g., "Uniswap", "SushiSwap") */
  protocol: string;
  
  /** URL to protocol logo */
  protocolLogo?: string;
  
  /** Token at start of this step */
  fromToken: Token;
  
  /** Token at end of this step */
  toToken: Token;
  
  /** Percentage of swap going through this route */
  percentage: number;
}

// =============================================================================
// TRANSACTION STATE
// =============================================================================

/**
 * All possible transaction statuses
 * Used to track swap progress and display appropriate UI
 */
export type TransactionStatus = 
  | 'idle'       // No transaction in progress
  | 'approving'  // Waiting for token approval
  | 'approved'   // Token approved, ready to swap
  | 'signing'    // Waiting for user to sign transaction
  | 'pending'    // Transaction sent, waiting for confirmation
  | 'confirming' // Transaction being confirmed on chain
  | 'completed'  // Transaction successful
  | 'failed';    // Transaction failed

/**
 * Current state of a transaction
 */
export interface TransactionState {
  /** Current status */
  status: TransactionStatus;
  
  /** Transaction hash (once submitted) */
  hash?: string;
  
  /** Error message (if failed) */
  error?: string;
  
  /** URL to view transaction on block explorer */
  explorerUrl?: string;
}

// =============================================================================
// GAS INFORMATION
// =============================================================================

/**
 * Gas price level for display purposes
 * Helps users decide if now is a good time to swap
 */
export type GasPriceLevel = 'cheap' | 'normal' | 'expensive';

/**
 * Gas cost information
 */
export interface GasInfo {
  /** Overall gas level */
  level: GasPriceLevel;
  
  /** Estimated cost in USD */
  estimatedUSD: string;
  
  /** Estimated cost in Gwei */
  estimatedGwei: string;
}

// =============================================================================
// SWAP STATE (for state management)
// =============================================================================

/**
 * Complete swap state
 * Used by components to track the entire swap flow
 */
export interface SwapState {
  /** Selected "from" token */
  fromToken: Token | null;
  
  /** Selected "to" token */
  toToken: Token | null;
  
  /** Amount to swap */
  fromAmount: string;
  
  /** Amount to receive */
  toAmount: string;
  
  /** Current quote (null if no quote fetched) */
  quote: SwapQuote | null;
  
  /** True while fetching quote or executing swap */
  isLoading: boolean;
  
  /** Error message (null if no error) */
  error: string | null;
  
  /** Current transaction state */
  transaction: TransactionState;
  
  /** Slippage tolerance percentage */
  slippage: number;
}

/**
 * Initial/default swap state
 * Used when resetting the swap form
 */
export const initialSwapState: SwapState = {
  fromToken: null,
  toToken: null,
  fromAmount: '',
  toAmount: '',
  quote: null,
  isLoading: false,
  error: null,
  transaction: { status: 'idle' },
  slippage: 0.5, // Default 0.5% slippage
};

// =============================================================================
// TRANSACTION STATUS TRACKING (LI.FI Status API)
// =============================================================================

/**
 * LI.FI transaction status
 * Possible values from LI.FI /v1/status endpoint
 */
export type LifiTransactionStatus =
  | 'NOT_FOUND'  // Transaction not found yet
  | 'INVALID'    // Invalid transaction
  | 'PENDING'    // Transaction in progress
  | 'DONE'       // Transaction completed
  | 'FAILED';    // Transaction failed

/**
 * LI.FI substatus - more detailed status info
 */
export type LifiTransactionSubstatus =
  // Pending states
  | 'WAIT_SOURCE_CONFIRMATIONS'   // Waiting for source chain confirmations
  | 'WAIT_DESTINATION_TRANSACTION' // Waiting for destination chain transaction
  | 'BRIDGE_NOT_AVAILABLE'        // Bridge temporarily unavailable
  | 'CHAIN_NOT_AVAILABLE'         // RPC unavailable
  | 'REFUND_IN_PROGRESS'          // Refund being processed
  | 'UNKNOWN_ERROR'               // Cannot determine status
  // Final states
  | 'COMPLETED'                   // Transfer successful
  | 'PARTIAL'                     // Partially successful (alternative tokens)
  | 'REFUNDED'                    // Tokens refunded
  | 'NOT_PROCESSABLE_REFUND_NEEDED' // Cannot complete, needs refund
  | 'OUT_OF_GAS'                  // Ran out of gas
  | 'SLIPPAGE_EXCEEDED';          // Return amount not enough

/**
 * Token transfer info from LI.FI status
 */
export interface TransferTokenInfo {
  chainId: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  amount: string;
  amountUSD: string;
  priceUSD: string;
  logoURI?: string;
}

/**
 * Sending/Receiving transaction details
 */
export interface TransactionDetails {
  txHash: string;
  txLink: string;
  amount: string;
  token: TransferTokenInfo;
  chainId: number;
  gasPrice?: string;
  gasUsed?: string;
  gasToken?: TransferTokenInfo;
  gasAmount?: string;
  gasAmountUSD?: string;
  timestamp?: number;
}

/**
 * Complete LI.FI status response
 */
export interface LifiStatusResponse {
  /** Transaction ID (not the same as txHash) */
  transactionId: string;

  /** Current status */
  status: LifiTransactionStatus;

  /** Detailed substatus */
  substatus?: LifiTransactionSubstatus;

  /** Human-readable status message */
  substatusMessage?: string;

  /** Sending chain transaction details */
  sending?: TransactionDetails;

  /** Receiving chain transaction details */
  receiving?: TransactionDetails;

  /** LI.FI explorer link */
  lifiExplorerLink?: string;

  /** Bridge/tool used */
  tool?: string;

  /** Source chain ID */
  fromChain?: number;

  /** Destination chain ID */
  toChain?: number;
}

/**
 * Simplified transaction step for UI display
 */
export interface TransactionStep {
  /** Step identifier */
  id: string;

  /** Step title (e.g., "Token Approval", "Swap on Uniswap") */
  title: string;

  /** Step description */
  description?: string;

  /** Protocol/tool logo */
  logo?: string;

  /** Step status */
  status: 'pending' | 'in_progress' | 'completed' | 'failed';

  /** Transaction hash for this step */
  txHash?: string;

  /** Explorer link for this step */
  explorerLink?: string;
}

/**
 * Transaction tracking state for UI
 */
export interface TransactionTrackingState {
  /** Overall progress (0-100) */
  progress: number;

  /** Current step index (0-based) */
  currentStep: number;

  /** All steps */
  steps: TransactionStep[];

  /** Estimated time remaining in seconds */
  estimatedTimeRemaining?: number;

  /** Status from LI.FI */
  lifiStatus?: LifiStatusResponse;

  /**
   * External end-to-end tracker URL from the aggregator status dispatcher
   * (Squid: Axelarscan). Lets the UI offer a "track this transfer" link
   * while polling is still in flight.
   */
  trackingUrl?: string;

  /** Is tracking active */
  isTracking: boolean;

  /** Error message if failed */
  error?: string;
}

// =============================================================================
// PARSED TRANSACTION ERROR (for user-friendly error display)
// =============================================================================

/**
 * Error types that can occur during swap transactions
 */
export type TransactionErrorType =
  | 'user_rejected'      // User rejected in wallet
  | 'insufficient_funds' // Not enough balance
  | 'insufficient_gas'   // Not enough gas
  | 'slippage_exceeded'  // Price moved too much
  | 'approval_failed'    // Token approval failed
  | 'execution_reverted' // Contract execution failed
  | 'network_error'      // Network/RPC issues
  | 'timeout'            // Transaction timeout
  | 'unknown';           // Unknown error

/**
 * Parsed error with user-friendly information
 */
export interface ParsedTransactionError {
  /** Error type for styling/icons */
  type: TransactionErrorType;

  /** Short title (e.g., "Transaction Rejected") */
  title: string;

  /** Detailed reason from the error */
  reason: string;

  /** Helpful suggestion for the user */
  suggestion: string;

  /** Original error message (for debugging) */
  originalError: string;

  /** Whether retry might help */
  canRetry: boolean;
}
