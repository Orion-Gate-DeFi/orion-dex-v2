/**
 * OrionAiTransport — isolated unit tests.
 *
 * Plain class, no Angular DI / Privy bridge (the service owns the wiring), so
 * these run without TestBed. They guard the wire contract the backend `/ai`
 * proxy forwards verbatim (one pinned model, no fallback list) and the
 * bounded-retry policy for transient failures (429 / 4xx / quota / cancel).
 */
import { OrionAiTransport } from './agent.transports';
import {
  AGENT_FALLBACK_MODELS,
  AGENT_MAX_REQUEST_BYTES,
  AGENT_MODEL,
  AgentTransportError,
} from './agent.models';

describe('OrionAiTransport', () => {
  const originalFetch = globalThis.fetch;
  const getToken = (): Promise<string | null> => Promise.resolve('jwt-token');

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function okResponse(): Response {
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ choices: [{ message: { content: 'hi', tool_calls: [] } }] }),
    } as unknown as Response;
  }

  function error429(code: string): Response {
    return {
      ok: false,
      status: 429,
      headers: { get: () => null },
      json: () => Promise.resolve({ error: { code } }),
    } as unknown as Response;
  }

  async function reject(promise: Promise<unknown>): Promise<AgentTransportError> {
    try {
      await promise;
    } catch (e) {
      return e as AgentTransportError;
    }
    throw new Error('expected the promise to reject');
  }

  it('sends one pinned model and no fallback list', async () => {
    let captured: Record<string, unknown> | null = null;
    globalThis.fetch = ((_url: string, init: RequestInit): Promise<Response> => {
      captured = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve(okResponse());
    }) as typeof fetch;

    const transport = new OrionAiTransport(getToken);
    await transport.complete([{ role: 'user', content: 'hey' }], {}, new AbortController().signal);

    expect(captured).not.toBeNull();
    expect(captured!['model']).toBe(AGENT_MODEL);
    expect(captured!['stream']).toBe(false);
    expect(captured!['max_tokens']).toBe(15_000);
    // No backup model drives our tool schema reliably, so AGENT_FALLBACK_MODELS
    // is empty and `models` must be absent from the wire — not sent as []. A
    // model listed here would also become a recipient of user data, so this
    // asserts the omission rather than mirroring the constant.
    expect(AGENT_FALLBACK_MODELS.length).toBe(0);
    expect(captured!['models']).toBeUndefined();
    expect('models' in captured!).toBe(false);
  });

  it('reads a 503 "not configured" as unconfigured and does NOT retry it', async () => {
    // Our own proxy answers this when the upstream key is unset. Retrying is
    // pointless, and the chat must not call it temporary.
    let calls = 0;
    globalThis.fetch = ((): Promise<Response> => {
      calls += 1;
      return Promise.resolve({
        ok: false,
        status: 503,
        text: () => Promise.resolve('AI assistant is not configured\n'),
      } as unknown as Response);
    }) as typeof fetch;

    const transport = new OrionAiTransport(getToken);
    const err = await reject(
      transport.complete([{ role: 'user', content: 'x' }], {}, new AbortController().signal),
    );

    expect(err.kind).toBe('unconfigured');
    expect(err.status).toBe(503);
    expect(calls).toBe(1);
  });

  it('still treats a 503 relayed from the gateway as a transient server error', async () => {
    let calls = 0;
    globalThis.fetch = ((): Promise<Response> => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? ({
              ok: false,
              status: 503,
              text: () => Promise.resolve('upstream temporarily unavailable'),
            } as unknown as Response)
          : okResponse(),
      );
    }) as typeof fetch;

    const transport = new OrionAiTransport(getToken);
    const result = await transport.complete(
      [{ role: 'user', content: 'x' }],
      {},
      new AbortController().signal,
    );

    expect(result.content).toBe('hi');
    expect(calls).toBe(2); // retried, unlike the "not configured" case above
  });

  it('keeps 403 distinguishable from 401 so the chat can advise differently', async () => {
    globalThis.fetch = (() =>
      Promise.resolve({ ok: false, status: 403 } as Response)) as typeof fetch;

    const transport = new OrionAiTransport(getToken);
    const err = await reject(
      transport.complete([{ role: 'user', content: 'x' }], {}, new AbortController().signal),
    );

    expect(err.kind).toBe('auth');
    expect(err.status).toBe(403); // "not allowed" — reconnecting would not help
  });

  it('rejects an over-cap turn before sending it', async () => {
    // Past the proxy's body cap the upstream read fails and it answers 502,
    // which retries forever on a body that can never fit. Never leave.
    let calls = 0;
    globalThis.fetch = ((): Promise<Response> => {
      calls += 1;
      return Promise.resolve(okResponse());
    }) as typeof fetch;

    const transport = new OrionAiTransport(getToken);
    const err = await reject(
      transport.complete(
        [{ role: 'user', content: 'x'.repeat(AGENT_MAX_REQUEST_BYTES + 1) }],
        {},
        new AbortController().signal,
      ),
    );

    expect(err.kind).toBe('too_large');
    expect(calls).toBe(0);
  });

  it('retries a transient 429 rate-limit and then succeeds', async () => {
    let calls = 0;
    globalThis.fetch = ((): Promise<Response> => {
      calls += 1;
      return Promise.resolve(calls === 1 ? error429('rate_limit_exceeded') : okResponse());
    }) as typeof fetch;

    const transport = new OrionAiTransport(getToken);
    const result = await transport.complete(
      [{ role: 'user', content: 'x' }],
      {},
      new AbortController().signal,
    );

    expect(result.content).toBe('hi');
    expect(calls).toBe(2); // first 429, retried once, second OK
  });

  it('does NOT retry a 429 insufficient_quota (billing, not a throttle)', async () => {
    let calls = 0;
    globalThis.fetch = ((): Promise<Response> => {
      calls += 1;
      return Promise.resolve(error429('insufficient_quota'));
    }) as typeof fetch;

    const transport = new OrionAiTransport(getToken);
    const err = await reject(
      transport.complete([{ role: 'user', content: 'x' }], {}, new AbortController().signal),
    );

    expect(err).toBeInstanceOf(AgentTransportError);
    expect(err.kind).toBe('quota');
    expect(calls).toBe(1);
  });

  it('does NOT retry a non-429 4xx and classifies it as client', async () => {
    let calls = 0;
    globalThis.fetch = ((): Promise<Response> => {
      calls += 1;
      return Promise.resolve({ ok: false, status: 400 } as Response);
    }) as typeof fetch;

    const transport = new OrionAiTransport(getToken);
    const err = await reject(
      transport.complete([{ role: 'user', content: 'x' }], {}, new AbortController().signal),
    );

    expect(err.kind).toBe('client');
    expect(calls).toBe(1);
  });

  it('rejects with an aborted error when the user signal is already aborted', async () => {
    globalThis.fetch = ((_url: string, init: RequestInit): Promise<Response> => {
      if (init.signal?.aborted) {
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      }
      return new Promise((_resolve, rej) => {
        init.signal?.addEventListener('abort', () =>
          rej(new DOMException('aborted', 'AbortError')),
        );
      });
    }) as typeof fetch;

    const controller = new AbortController();
    controller.abort();
    const transport = new OrionAiTransport(getToken);
    const err = await reject(
      transport.complete([{ role: 'user', content: 'x' }], {}, controller.signal),
    );

    expect(err.kind).toBe('aborted');
  });
});
