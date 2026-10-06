/**
 * Orion Assistant — transports.
 *
 * `OrionAiTransport` runs a NON-streaming completion through the backend `/ai`
 * passthrough proxy (no key in the browser): it POSTs the OpenAI-compatible
 * body (model, messages, tools, plugins) and returns the whole assistant
 * message so the service can run the tool-calling loop. `MockAgentTransport`
 * returns a canned reply (no tools) for local UX testing before the backend
 * `/ai` endpoint ships — enable it with `localStorage['orion.agent.mock'] = '1'`.
 *
 * @author Orion DEX Team
 * @version 0.2.0
 */
import { environment } from '../../../../environments/environment';
import {
  AGENT_FALLBACK_MODELS,
  AGENT_MAX_ATTEMPTS,
  AGENT_MAX_OUTPUT_TOKENS,
  AGENT_MAX_REQUEST_BYTES,
  AGENT_MODEL,
  AGENT_REQUEST_TIMEOUT_MS,
  AGENT_RETRY_BASE_MS,
  AgentTransportError,
  type AgentCompleteOptions,
  type AgentToolCall,
  type AgentTransport,
  type AgentTurnResult,
  type AgentWireMessage,
} from './agent.models';

/** Minimal shape of an OpenAI chat-completion response (typed at the boundary). */
interface OpenAiChatResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: {
      readonly content?: string | null;
      readonly tool_calls?: ReadonlyArray<{
        readonly id?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }>;
    };
  }>;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Map a non-2xx response to a classified, retry-aware transport error. */
async function classifyHttpError(response: Response): Promise<AgentTransportError> {
  const status = response.status;
  if (status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
    // Gonka Network throttling (rate_limit_exceeded) is retryable; a billing
    // shortfall (insufficient_quota) is not — read the OpenAI-style error code.
    let code = '';
    try {
      const data = (await response.json()) as { error?: { code?: string } };
      code = data?.error?.code ?? '';
    } catch {
      // Non-JSON body — treat as a plain throttle.
    }
    if (code === 'insufficient_quota') {
      return new AgentTransportError('quota', code, status, false);
    }
    return new AgentTransportError('rate_limit', code || 'rate_limit_exceeded', status, true, retryAfterMs);
  }
  // Our own proxy answers 503 "AI assistant is not configured" when the upstream
  // key is unset: the assistant is switched off server-side, so retrying cannot
  // help and the message must not call it temporary. A 503 relayed from the
  // gateway itself IS transient, so only that known text gets the hard reading.
  if (status === 503) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      // Unreadable body — fall through to the transient reading.
    }
    if (/not configured/i.test(body)) {
      return new AgentTransportError('unconfigured', body.trim() || 'assistant not configured', status, false);
    }
    return new AgentTransportError('server', `AI proxy error ${status}`, status, true);
  }
  if (status >= 500) return new AgentTransportError('server', `AI proxy error ${status}`, status, true);
  if (status === 401 || status === 403) {
    return new AgentTransportError('auth', `AI proxy error ${status}`, status, false);
  }
  return new AgentTransportError('client', `AI proxy error ${status}`, status, false);
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) to milliseconds,
 *  capped so the user never waits absurdly long. Undefined when absent/invalid. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  let ms: number;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    ms = seconds * 1000;
  } else {
    const when = Date.parse(header);
    if (Number.isNaN(when)) return undefined;
    ms = when - Date.now();
  }
  if (ms <= 0) return undefined;
  return Math.min(ms, 10_000);
}

/** A delay that rejects with an 'aborted' error if the signal fires meanwhile. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new AgentTransportError('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AgentTransportError('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Live transport: POST to the Privy-JWT-authed `/ai` proxy (stream:false) and
 * return the assistant message. The token provider is injected so this class
 * stays free of Angular DI (the service owns the wiring).
 */
export class OrionAiTransport implements AgentTransport {
  constructor(private readonly getToken: () => Promise<string | null>) {}

  async complete(
    messages: readonly AgentWireMessage[],
    opts: AgentCompleteOptions,
    signal: AbortSignal,
  ): Promise<AgentTurnResult> {
    const jwt = await this.getToken();
    if (!jwt) {
      throw new AgentTransportError('auth', 'Not authenticated');
    }

    const body: Record<string, unknown> = {
      model: AGENT_MODEL,
      // Keep the primary in `model` (readable in logs/telemetry) and ordered
      // backups in `models`; GonkaGate tries them only on a temporary primary
      // failure before the response starts.
      ...(AGENT_FALLBACK_MODELS.length > 0 ? { models: AGENT_FALLBACK_MODELS } : {}),
      messages,
      stream: false,
      max_tokens: AGENT_MAX_OUTPUT_TOKENS,
    };
    if (opts.tools && opts.tools.length > 0) body['tools'] = opts.tools;
    if (opts.plugins && opts.plugins.length > 0) body['plugins'] = opts.plugins;
    const payload = JSON.stringify(body);

    // Over the proxy's body cap the upstream read fails and it answers 502 —
    // indistinguishable from an outage, and every retry re-sends the same
    // oversized conversation. Reject here so the user gets the one thing that
    // actually fixes it (clear the chat) instead of "try again later" forever.
    const payloadBytes = new TextEncoder().encode(payload).byteLength;
    if (payloadBytes > AGENT_MAX_REQUEST_BYTES) {
      throw new AgentTransportError(
        'too_large',
        `request body ${payloadBytes}B exceeds the ${AGENT_MAX_REQUEST_BYTES}B proxy cap`,
      );
    }

    // Bounded retry for TRANSIENT failures. A failed completion produces no
    // assistant message and dispatches no tools, so retrying any attempt is
    // idempotent — safe even mid-tool-loop. rate_limit (Gonka Network throttle),
    // 5xx and network blips retry; quota / 4xx / auth / timeout do not.
    let lastError: AgentTransportError | null = null;
    for (let attempt = 0; attempt < AGENT_MAX_ATTEMPTS; attempt++) {
      if (signal.aborted) throw new AgentTransportError('aborted');
      try {
        return await this.attempt(payload, jwt, signal);
      } catch (err) {
        const e =
          err instanceof AgentTransportError
            ? err
            : new AgentTransportError('network', (err as Error)?.message);
        if (e.kind === 'aborted') throw e; // user cancel — never retry
        lastError = e;
        if (!e.retryable || attempt === AGENT_MAX_ATTEMPTS - 1) throw e;
        // Honour Retry-After when present, else exponential backoff + jitter.
        const backoff =
          e.retryAfterMs ?? AGENT_RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * 200);
        await abortableDelay(backoff, signal);
      }
    }
    throw lastError ?? new AgentTransportError('server');
  }

  /**
   * One completion attempt: compose the caller's cancel signal with a
   * per-request timeout, POST, and parse — classifying any failure into an
   * `AgentTransportError` for the retry loop. A user cancel and our own timeout
   * are told apart so the loop never retries a deliberate cancel.
   */
  private async attempt(payload: string, jwt: string, signal: AbortSignal): Promise<AgentTurnResult> {
    const controller = new AbortController();
    let timedOut = false;
    const onUserAbort = (): void => controller.abort();
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', onUserAbort, { once: true });
    }
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, AGENT_REQUEST_TIMEOUT_MS);

    try {
      let response: Response;
      try {
        response = await fetch(`${environment.apiUrl}/ai/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${jwt}`,
          },
          body: payload,
          signal: controller.signal,
        });
      } catch (err) {
        // fetch rejects on abort (user cancel or our timeout) or a network error.
        if (signal.aborted) throw new AgentTransportError('aborted');
        if (timedOut) throw new AgentTransportError('timeout');
        throw new AgentTransportError('network', (err as Error)?.message);
      }

      if (!response.ok) {
        throw await classifyHttpError(response);
      }

      const data = (await response.json()) as OpenAiChatResponse;
      const message = data.choices?.[0]?.message;
      const content = typeof message?.content === 'string' ? message.content : '';

      const toolCalls: AgentToolCall[] = (message?.tool_calls ?? [])
        .filter(tc => typeof tc.function?.name === 'string')
        .map((tc, i) => ({
          id: tc.id ?? `call_${i}`,
          name: tc.function!.name as string,
          argumentsJson: tc.function?.arguments ?? '{}',
        }));

      // The assistant turn to append verbatim before feeding tool results back.
      const assistantMessage: AgentWireMessage = {
        role: 'assistant',
        content,
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map(tc => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.argumentsJson },
              })),
            }
          : {}),
      };

      return { content, toolCalls, assistantMessage };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onUserAbort);
    }
  }
}

/**
 * Local mock — returns a fixed reply (no tools) so the panel, the typing
 * indicator and the Orbit edge-glow are testable without the backend or a key.
 */
export class MockAgentTransport implements AgentTransport {
  async complete(
    _messages: readonly AgentWireMessage[],
    _opts: AgentCompleteOptions,
    signal: AbortSignal,
  ): Promise<AgentTurnResult> {
    await delay(400);
    if (signal.aborted) throw new Error('aborted');
    const content =
      'This is a local mock reply — the live answer (with tools + web research) ' +
      'comes from the backend /ai proxy once it ships. ' +
      'Set localStorage "orion.agent.mock" to 0 to use the live proxy.';
    return { content, toolCalls: [], assistantMessage: { role: 'assistant', content } };
  }
}

/**
 * Transport selection. Defaults to the live `/ai` proxy; a developer can force
 * the mock locally with `localStorage['orion.agent.mock'] = '1'`.
 */
export function resolveTransport(getToken: () => Promise<string | null>): AgentTransport {
  let useMock = false;
  // Dev-only convenience: never honour the flag in production builds, even if a
  // synced browser profile carries it over — a beta user must never see the
  // canned mock copy. Selection runs once at construction, so toggling the flag
  // at runtime needs a reload regardless.
  if (environment.envName !== 'production') {
    try {
      useMock = localStorage.getItem('orion.agent.mock') === '1';
    } catch {
      // localStorage may be unavailable (privacy mode / SSR) — default to live.
    }
  }
  return useMock ? new MockAgentTransport() : new OrionAiTransport(getToken);
}
