import { DecisionError, DECISION_INPUT_COST_PER_MTOK_USD, DECISION_OUTPUT_COST_PER_MTOK_USD, DECISION_PROVIDER_API_KEY_ENV,
  getProviderDialect } from './types.js';
import { validateDecisionPolicy, validateDecisionQuestions } from './schema.js';
import { formatProviderRequest, parseAndValidateProviderResponse, providerRequestHeaders } from './primitives.js';
import type {
  DecisionBudgetOptions, DecisionBudgetSnapshot, DecisionClientOptions, DecisionImageAsset, DecisionPolicyConfig,
  DecisionProviderKind, DecisionProviderUsage, DecisionQuestion, DecisionQuestionOutput, DecisionSdkAdapter,
  DecisionSdkRequest, DecisionTransport, DecisionTransportRequest, DecisionTransportResponse,
} from './types.js';

/** Minimum wall-clock that must remain inside the deadline window for a single retry (AC-3.2). */
const RETRY_MIN_REMAINING_MS = 50;

/** Marks a failure that happened after dispatch (HTTP status, unreadable body): never retried. */
class PostDispatchError extends Error {
  readonly decisionError: DecisionError;
  constructor(decisionError: DecisionError) {
    super(decisionError.message);
    this.decisionError = decisionError;
  }
}

/** Budget settlement surface `DecisionClient` needs; `DecisionBudgetTracker` implements it. */
export interface DecisionBudgetLedgerPort {
  reserve(estimatedInputTokens: number): void;
  settle(usage: DecisionProviderUsage): void;
  retainUnknown(estimatedInputTokens: number): void;
}

/**
 * Conservative token/cost budget ledger (AC-3.3): reserves estimated input tokens pre-send, settles exact
 * reported usage on success, and retains the reservation on any post-dispatch failure so unknown provider
 * consumption is never refunded. Input is priced `0.042` USD per Mtok and output `0` by default.
 */
export class DecisionBudgetTracker {
  readonly #inputCostPerMtokUsd: number;
  readonly #outputCostPerMtokUsd: number;
  readonly #maxInputTokens: number | null;
  readonly #maxCostUsd: number | null;
  #reservedTokens = 0;
  #totalInputTokens = 0;
  #totalOutputTokens = 0;
  #unknownUsageCount = 0;
  #unknownUsageRetained = false;

  constructor(options: DecisionBudgetOptions = {}) {
    this.#inputCostPerMtokUsd = options.inputCostPerMtokUsd ?? DECISION_INPUT_COST_PER_MTOK_USD;
    this.#outputCostPerMtokUsd = options.outputCostPerMtokUsd ?? DECISION_OUTPUT_COST_PER_MTOK_USD;
    if (!Number.isFinite(this.#inputCostPerMtokUsd) || this.#inputCostPerMtokUsd < 0) {
      throw new DecisionError('DECISION_POLICY_INVALID', 'inputCostPerMtokUsd must be a non-negative finite number');
    }
    if (!Number.isFinite(this.#outputCostPerMtokUsd) || this.#outputCostPerMtokUsd < 0) {
      throw new DecisionError('DECISION_POLICY_INVALID', 'outputCostPerMtokUsd must be a non-negative finite number');
    }
    this.#maxInputTokens = options.maxInputTokens ?? null;
    this.#maxCostUsd = options.maxCostUsd ?? null;
    if (this.#maxInputTokens !== null && (!Number.isSafeInteger(this.#maxInputTokens) || this.#maxInputTokens <= 0)) {
      throw new DecisionError('DECISION_POLICY_INVALID', 'maxInputTokens must be a positive integer when provided');
    }
    if (this.#maxCostUsd !== null && (!Number.isFinite(this.#maxCostUsd) || this.#maxCostUsd <= 0)) {
      throw new DecisionError('DECISION_POLICY_INVALID', 'maxCostUsd must be a positive finite number when provided');
    }
  }

  /** Input tokens settled plus outstanding reservations; the basis for remaining-budget refusal. */
  get committedInputTokens(): number {
    return this.#totalInputTokens + this.#reservedTokens;
  }

  get unknownUsageCount(): number {
    return this.#unknownUsageCount;
  }

  /** Reserve estimated input tokens pre-send; refuses with `DECISION_BUDGET_EXCEEDED` when insufficient. */
  reserve(estimatedInputTokens: number): void {
    if (!Number.isFinite(estimatedInputTokens) || estimatedInputTokens < 0) {
      throw new RangeError('estimatedInputTokens must be a non-negative finite number');
    }
    const projectedInput = this.committedInputTokens + estimatedInputTokens;
    if (this.#maxInputTokens !== null && projectedInput > this.#maxInputTokens) {
      throw new DecisionError('DECISION_BUDGET_EXCEEDED', `estimated input ${estimatedInputTokens} tokens exceeds the remaining ${this.#maxInputTokens - this.committedInputTokens} token budget`);
    }
    const projectedCostUsd = (projectedInput * this.#inputCostPerMtokUsd + this.#totalOutputTokens * this.#outputCostPerMtokUsd) / 1e6;
    if (this.#maxCostUsd !== null && projectedCostUsd > this.#maxCostUsd) {
      throw new DecisionError('DECISION_BUDGET_EXCEEDED', `projected cost ${projectedCostUsd} USD exceeds the remaining ${this.#maxCostUsd} USD budget`);
    }
    this.#reservedTokens += estimatedInputTokens;
  }

  /** Release the reservation and charge the exact reported usage (AC-3.3 settled path). */
  settle(usage: DecisionProviderUsage): void {
    this.#reservedTokens = Math.max(0, this.#reservedTokens - usage.input_tokens);
    this.#totalInputTokens += usage.input_tokens;
    this.#totalOutputTokens += usage.output_tokens;
    this.#unknownUsageRetained = false;
  }

  /** Retain a post-dispatch failure's reservation as consumed (unknown provider usage is never refunded). */
  retainUnknown(estimatedInputTokens: number): void {
    const retained = Math.max(0, Math.min(estimatedInputTokens, this.#reservedTokens));
    this.#reservedTokens -= retained;
    this.#totalInputTokens += retained;
    this.#unknownUsageCount += 1;
    this.#unknownUsageRetained = true;
  }

  snapshot(): DecisionBudgetSnapshot {
    return {
      totalInputTokens: this.#totalInputTokens,
      totalOutputTokens: this.#totalOutputTokens,
      unknownUsageCount: this.#unknownUsageCount,
      unknownUsageRetained: this.#unknownUsageRetained,
      estimatedCostUsd: (this.#totalInputTokens * this.#inputCostPerMtokUsd + this.#totalOutputTokens * this.#outputCostPerMtokUsd) / 1e6,
    };
  }
}

/** Built-in HTTP `fetch` transport honoring the deadline abort signal and provider danger-zone headers. */
export class HttpDecisionTransport implements DecisionTransport {
  async send(request: DecisionTransportRequest): Promise<DecisionTransportResponse> {
    const response = await fetch(request.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${request.apiKey}`, ...(request.headers ?? {}) },
      body: request.body,
      signal: request.signal,
    });
    return { status: response.status, body: await response.text() };
  }
}

/** Marks transports created by `createSdkDecisionTransport` so the client skips the HTTP apiKey requirement. */
const SDK_TRANSPORT_BRAND = '__loopwrightSdkTransport__';

export type SdkBranchedTransport = DecisionTransport & { readonly __loopwrightSdkTransport__?: true };

/**
 * Bridge an in-process provider SDK adapter (`@typesafe-ai/sdk`, Vercel `experimental_decide`,
 * `env.AI.run`, ...) into a `DecisionTransport`; the adapter receives the structured SDK request and
 * returns the raw provider payload, which keeps every client-level guarantee intact (REVIEW-004).
 * The returned transport is branded so the client never demands a raw HTTP `apiKey` for it.
 */
/** Profile for `createSdkDecisionTransport`: the provider kind plus optional canonical metadata
 * (`questions`, `images`) forwarded to the adapter alongside the wire payload (SHIP-REVIEW-001 Nit 2). */
export interface DecisionSdkTransportProfile {
  readonly provider: DecisionProviderKind;
  readonly questions?: readonly DecisionQuestion[];
  readonly images?: readonly DecisionImageAsset[];
}

export function createSdkDecisionTransport(adapter: DecisionSdkAdapter, profile: DecisionSdkTransportProfile): SdkBranchedTransport {
  const transport: SdkBranchedTransport = {
    async send(request: DecisionTransportRequest): Promise<DecisionTransportResponse> {
      let wirePayload: Record<string, unknown>;
      try {
        wirePayload = JSON.parse(request.body) as Record<string, unknown>;
      } catch {
        throw new DecisionError('DECISION_SCHEMA_INVALID', 'request body is not valid JSON');
      }
      const state = (wirePayload['state'] ?? wirePayload['input']) as Record<string, unknown> | undefined;
      const sdkRequest: DecisionSdkRequest = {
        provider: profile.provider,
        dialect: getProviderDialect(profile.provider),
        model: typeof wirePayload['model'] === 'string' ? wirePayload['model'] : '',
        endpoint: request.endpoint,
        state: state ?? {},
        questions: profile.questions ?? [],
        ...(profile.images !== undefined ? { images: profile.images } : {}),
        wirePayload,
        headers: request.headers ?? {},
        signal: request.signal,
      };
      const raw = await adapter.evaluate(sdkRequest);
      return { status: 200, body: JSON.stringify(raw ?? {}) };
    },
  };
  Object.defineProperty(transport, SDK_TRANSPORT_BRAND, { value: true, enumerable: false });
  return transport;
}

export interface DecisionExecuteInput {
  readonly questions: readonly DecisionQuestion[];
  readonly stateBody: string;
  readonly budget: DecisionBudgetLedgerPort;
  readonly images?: readonly DecisionImageAsset[];
}

export interface DecisionClientResult {
  readonly outputs: readonly DecisionQuestionOutput[];
  readonly usage: DecisionProviderUsage | null;
  readonly attempts: number;
  readonly estimatedInputTokens: number;
}

/**
 * Hard-deadline-supervised decision client (AC-3.1, AC-3.2): every transport invocation runs inside an
 * outer `AbortController` timer of `policy.hardDeadlineMs`; retries are capped at `maxAttempts` (max 2)
 * and permitted only when at least 50ms of wall clock remain inside the same deadline window. Budget is
 * reserved pre-send, settled on exact usage, and retained on any post-dispatch failure (AC-3.3). An
 * in-process `sdkAdapter` gets the exact same guarantees and needs no raw HTTP `apiKey` (REVIEW-004).
 * Exported as `DecisionClient` with the `JevDecisionClient` alias (REVIEW-002).
 */
export class DecisionClient {
  readonly #policy: DecisionPolicyConfig;
  readonly #transport: DecisionTransport | undefined;
  readonly #sdkAdapter: DecisionSdkAdapter | undefined;
  readonly #apiKeyOverride: string | undefined;
  readonly #endpointOverride: string | undefined;
  readonly #now: () => number;

  constructor(options: DecisionClientOptions) {
    const policy = validateDecisionPolicy(options.policy);
    if (policy.maxAttempts > 2) throw new DecisionError('DECISION_POLICY_INVALID', 'maxAttempts must be 1 or 2');
    if (options.transport === undefined && options.sdkAdapter === undefined) {
      throw new DecisionError('DECISION_POLICY_INVALID', 'a transport or an sdkAdapter is required');
    }
    this.#policy = policy;
    this.#transport = options.transport;
    this.#sdkAdapter = options.sdkAdapter;
    this.#apiKeyOverride = options.apiKey;
    this.#endpointOverride = options.endpoint;
    this.#now = options.now ?? Date.now;
  }

  #resolveApiKey(): string | null {
    if (this.#apiKeyOverride !== undefined && this.#apiKeyOverride.length > 0) return this.#apiKeyOverride;
    for (const envName of DECISION_PROVIDER_API_KEY_ENV[this.#policy.provider]) {
      const value = process.env[envName];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return null;
  }

  get policy(): DecisionPolicyConfig {
    return this.#policy;
  }

  async execute(input: DecisionExecuteInput): Promise<DecisionClientResult> {
    const questions = validateDecisionQuestions(input.questions, this.#policy);
    const images = input.images ?? [];
    const brandedSdkTransport = (this.#transport as SdkBranchedTransport | undefined)?.['__loopwrightSdkTransport__'] === true;
    if (this.#sdkAdapter === undefined && !brandedSdkTransport && this.#resolveApiKey() === null) {
      const envName = DECISION_PROVIDER_API_KEY_ENV[this.#policy.provider][0];
      throw new DecisionError('DECISION_TRANSPORT_ERROR', `no API key configured for provider ${this.#policy.provider} (set ${envName} or supply an sdkAdapter)`);
    }
    const endpoint = this.#endpointOverride ?? this.#policy.endpoint;
    const body = formatProviderRequest(questions, input.stateBody, this.#policy, images);
    const estimatedInputTokens = Math.ceil(Buffer.byteLength(body, 'utf8') / 4);
    const headers = providerRequestHeaders(this.#policy, questions, images);
    const adapter = this.#sdkAdapter;
    const transport = this.#transport;
    let wirePayload: Record<string, unknown> = {};
    let state: Record<string, unknown> = {};
    if (adapter !== undefined) {
      wirePayload = JSON.parse(body) as Record<string, unknown>;
      state = (wirePayload['state'] ?? wirePayload['input'] ?? {}) as Record<string, unknown>;
    }
    const performSend = async (signal: AbortSignal): Promise<unknown> => {
      if (adapter !== undefined) {
        const sdkRequest: DecisionSdkRequest = {
          provider: this.#policy.provider,
          dialect: getProviderDialect(this.#policy.provider),
          model: this.#policy.model,
          endpoint,
          state,
          questions,
          images,
          wirePayload,
          headers,
          signal,
        };
        return adapter.evaluate(sdkRequest);
      }
      const response = await (transport as DecisionTransport).send({ endpoint, apiKey: this.#resolveApiKey() ?? '', body, signal, headers });
      if (response.status < 200 || response.status >= 300) {
        throw new PostDispatchError(new DecisionError('DECISION_TRANSPORT_ERROR', `transport returned HTTP ${response.status}`));
      }
      try {
        return JSON.parse(response.body);
      } catch {
        throw new PostDispatchError(new DecisionError('DECISION_RESPONSE_INVALID', 'transport body is not valid JSON'));
      }
    };
    input.budget.reserve(estimatedInputTokens);
    const deadlineAt = this.#now() + this.#policy.hardDeadlineMs;
    let attempts = 0;
    let lastError: unknown = null;
    while (attempts < this.#policy.maxAttempts) {
      const remainingMs = deadlineAt - this.#now();
      if (attempts > 0 && remainingMs < RETRY_MIN_REMAINING_MS) break;
      attempts += 1;
      const controller = new AbortController();
      let deadlineHit = false;
      let timer: NodeJS.Timeout | undefined;
      try {
        let raw: unknown;
        try {
          const sendPromise = performSend(controller.signal);
          sendPromise.catch(() => { /* superseded when the deadline race wins */ });
          const deadlinePromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              deadlineHit = true;
              controller.abort(new DecisionError('DECISION_DEADLINE_EXCEEDED', `transport exceeded the ${this.#policy.hardDeadlineMs}ms hard deadline`));
              reject(new DecisionError('DECISION_DEADLINE_EXCEEDED', `transport exceeded the ${this.#policy.hardDeadlineMs}ms hard deadline`));
            }, Math.max(0, remainingMs));
            timer.unref?.();
          });
          deadlinePromise.catch(() => { /* superseded when the send wins the race */ });
          raw = await Promise.race([sendPromise, deadlinePromise]);
        } catch (error) {
          if (deadlineHit) {
            input.budget.retainUnknown(estimatedInputTokens);
            throw error instanceof DecisionError ? error : new DecisionError('DECISION_DEADLINE_EXCEEDED', `transport exceeded the ${this.#policy.hardDeadlineMs}ms hard deadline`);
          }
          if (error instanceof PostDispatchError) {
            // Post-dispatch outcomes (HTTP errors, unreadable bodies) are never retried (AC-3.2).
            input.budget.retainUnknown(estimatedInputTokens);
            throw error.decisionError;
          }
          // Pre-dispatch/transient failure of the send path: the only retry-eligible outcome (AC-3.2).
          lastError = error instanceof DecisionError ? error : new DecisionError('DECISION_TRANSPORT_ERROR', `transport failed: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        try {
          const parsed = parseAndValidateProviderResponse(questions, raw, this.#policy);
          input.budget.settle(parsed.usage ?? { input_tokens: estimatedInputTokens, output_tokens: 0 });
          return { outputs: parsed.outputs, usage: parsed.usage, attempts, estimatedInputTokens };
        } catch (error) {
          // Post-dispatch invalid payloads are never retried (AC-3.2); the send already happened.
          input.budget.retainUnknown(estimatedInputTokens);
          throw error;
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        controller.abort();
      }
    }
    input.budget.retainUnknown(estimatedInputTokens);
    if (lastError instanceof DecisionError) throw lastError;
    throw new DecisionError('DECISION_TRANSPORT_ERROR', `transport failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
}

export const JevDecisionClient = DecisionClient;
