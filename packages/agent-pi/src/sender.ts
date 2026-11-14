import { randomBytes } from 'node:crypto';
import type { Quantity } from '@loopwright/core';
import type { RequestAdmission, TrustedEvidence } from '@loopwright/state';
import { Admission, stateValue } from './admission.js';
import { canonical, digest, freeze, object, id, text, snapshot } from './boundary.js';
import { assessFinalRequestContext, parseBoundedJson } from './context.js';
import { PiFailure, refuse } from './errors.js';
import { inspectRawResponse, toolArgumentsDigest, type RawInspection } from './usage.js';
import { publishReceipt } from './receipt.js';
import { boundedResponse, semanticHeaders, validateInvocation, validateRequestResources, type FetchIdentity, type InvocationIdentity, type ParsedCandidate, type RuntimeBroker, type RuntimeReply, type ToolAuthorization } from './provider.js';
import type { PiHost, PiOpenInput, PiCommand, PiOutcome, PiErrorCode, PiError, PiContextRecord, PiModelCost } from './types.js';
import type { ToolExecutor, ToolIdentity, ToolResult } from './tools.js';
import type { Mcp } from './mcp.js';
import type { JsonRpcMessage } from '@earendil-works/pi-mcp';
import type { EventPublisher } from './events.js';
import { resolveCatalogModel, resolveProviderAuthHeaderName, resolveProviderDestination, selectedCatalog, type CatalogIdentity } from './catalog.js';
interface Attempt {
  readonly requestId: string; readonly operationId: string; readonly context: PiContextRecord;
  raw?: RawInspection; status?: number; committed: boolean; committedUsage?: RawInspection['usage'];
}
interface Turn {
  readonly kind: 'execute' | 'compact'; readonly command: PiCommand; readonly abort: AbortController;
  readonly requests: Attempt[]; failure: PiErrorCode | null; uncertain: boolean;
  readonly operations: string[]; pendingTools: number; readonly executedCalls: Set<string>;
  stateErrorCode: PiError['stateErrorCode']; error: PiError | null;
}
interface Slot {
  readonly invocation: number; readonly token: string; readonly turn: Turn;
  claimed: boolean; parsedDone: boolean; final?: Attempt; parsedDigest?: string; parsedPromise?: Promise<void>;
  readonly completion: Promise<void>; complete: () => void;
}
interface NativeParent { readonly slot: Slot; readonly identity: ToolIdentity; readonly timer: ReturnType<typeof setTimeout>; readonly nested: Map<string, string> }
export interface SenderPorts { readonly fetch: typeof globalThis.fetch; readonly catalog?: CatalogIdentity }
const unknown = (): Quantity => ({ provenance: 'unknown' });
/** One active host command, original permits only, and no native/provider retry authority. */
export class Sender implements RuntimeBroker {
  readonly #admission: Admission; readonly #catalog: CatalogIdentity; readonly #destination: string; readonly #authHeader: 'authorization' | 'x-api-key'; readonly #modelCost: PiModelCost | undefined;
  #turn: Turn | null = null; #lastInvocation = 0;
  #slots = new Map<number, Slot>(); #commands = new Set<string>(); #blocked = false; #lastSlot: Slot | null = null;
  #outboundObserved = false;
  #events: EventPublisher = async () => {};
  installEvents(events: EventPublisher): void { if (this.#turn) refuse('SESSION_BUSY'); this.#events = events; }
  #tools: ToolExecutor | null = null;
  #mcp: Mcp | null = null; readonly #native = new Map<string, NativeParent>(); readonly #sessionAbort = new AbortController(); #onFault: () => void = () => {};
  readonly #toolCancels = new Map<string, { slot: string; abort: AbortController }>();
  installMcp(mcp: Mcp, fault: () => void): void { if (this.#mcp || this.#turn) refuse('SESSION_BUSY'); this.#mcp = mcp; this.#onFault = fault; }
  runtimeFault(code: PiErrorCode): void { if (this.#turn) { this.#turn.failure ??= code; this.#turn.abort.abort(); } this.#blocked = true; for (const parent of this.#native.values()) clearTimeout(parent.timer); this.#native.clear(); this.#onFault(); }
  installTools(tools: ToolExecutor): void { if (this.#tools || this.#turn) refuse('SESSION_BUSY'); this.#tools = tools; }
  async tool(identity: ToolIdentity, bytes: Uint8Array): Promise<ToolResult> {
    const slot = this.#slot(identity.invocation, identity.slot), turn = slot.turn; let operationId: string | null = null;
    try {
      if (bytes.byteLength > this.input.policy.limits.toolArgsBytes) refuse('OUTPUT_LIMIT', '', { phase: 'tool' });
      let args: unknown;
      try { args = parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { nodes: 262144, array: 4096 }); } catch { refuse('TOOL_DENIED', '', { phase: 'tool' }); }
      const key = identity.invocation + ':' + identity.callId;
      if (!this.#tools || turn.executedCalls.has(key) || !await this.rootTool({ ...identity, argumentsDigest: toolArgumentsDigest(args) }) || !slot.final) refuse('TOOL_DENIED', '', { phase: 'tool' });
      await this.#events('tool_start', { requestId: slot.final.requestId, digest: digest(bytes) });
      turn.executedCalls.add(key); turn.pendingTools++; const abort = new AbortController(); this.#toolCancels.set(key, { slot: identity.slot, abort });
      try { const value = await this.#tools.invoke({ invocation: identity.invocation, slot: identity.slot, callId: identity.callId, name: identity.name, parentId: identity.parentId, parentRequestId: slot.final.requestId, ...(identity.parentId === null ? {} : { nativeParentAdmitted: true as const }) }, bytes, AbortSignal.any([turn.abort.signal, abort.signal]), id => { operationId = id; turn.operations.push(id); }); await this.#events('tool_end', { requestId: slot.final.requestId, operationId, digest: digest(Buffer.from(canonical(value))) }); return value; }
      finally { turn.pendingTools--; this.#toolCancels.delete(key); }
    } catch (error) {
      turn.failure ??= error instanceof PiFailure ? error.detail.code : 'RECOVERY_REQUIRED';
      if (error instanceof PiFailure) { turn.stateErrorCode ??= error.detail.stateErrorCode; if (!turn.error && (!turn.failure || turn.failure === error.detail.code)) turn.error = error.detail; }
      const unresolved = turn.operations.some(id => { const record = this.host.store.getOperation(id); return !record.ok || record.value.state !== 'confirmed'; });
      await this.#events('tool_end', { requestId: slot.final?.requestId ?? null, operationId: error instanceof PiFailure ? error.detail.operationId ?? operationId : operationId, code: error instanceof PiFailure ? error.detail.code : 'RECOVERY_REQUIRED' }).catch(() => {});
      turn.uncertain ||= unresolved; this.#blocked ||= unresolved; throw error;
    }
  }
  cancelTool(identity: ToolIdentity): void { const pending = this.#toolCancels.get(identity.invocation + ':' + identity.callId); if (pending?.slot === identity.slot) pending.abort.abort(); }
  get outboundObserved(): boolean { return this.#outboundObserved; }
  constructor(readonly host: PiHost, readonly input: PiOpenInput, readonly ports: SenderPorts = { fetch: globalThis.fetch }) {
    this.#destination = resolveProviderDestination(input.policy.selection);
    this.#authHeader = resolveProviderAuthHeaderName(input.policy.selection);
    this.#modelCost = resolveCatalogModel(input.policy.selection).record.cost;
    this.#admission = new Admission(host, { destination: this.#destination, fetch: ports.fetch, maxRequestBytes: input.policy.context.maxRequestBytes });
    this.#catalog = freeze(structuredClone(ports.catalog ?? selectedCatalog(input)));
  }
  begin(kind: 'execute' | 'compact', input: unknown): void {
    if (this.#turn) refuse('SESSION_BUSY', '', { phase: 'session' }); if (this.#blocked) refuse('RECOVERY_REQUIRED', '', { phase: 'session' });
    const command = object(snapshot(input), kind === 'execute' ? ['commandId', 'text', 'purpose', 'repair'] : ['commandId']); id(command.commandId, '/commandId');
    if (this.#commands.has(command.commandId as string) || this.#commands.size >= this.input.policy.limits.requests) refuse('REQUEST_REFUSED', '/commandId');
    if (kind === 'execute') {
      const literal = text(command.text, '/text', this.input.policy.limits.promptBytes); if (literal.trimStart().startsWith('/')) refuse('INPUT_INVALID', '/text');
      if (!['task', 'judge', 'reviewer', 'child', 'compaction'].includes(command.purpose as string) || !['none', 'format', 'implementation'].includes(command.repair as string)) refuse('INPUT_INVALID');
    }
    const view = stateValue(this.host.store.inspect()); if ((view.clock.remainingTaskMs.safeValue ?? 0) <= 0) refuse('DEADLINE'); if (view.ledger.violations.length || view.clockStatus !== 'trusted') refuse('RECOVERY_REQUIRED');
    stateValue(this.host.store.renew(this.host.authority));
    const value = kind === 'execute' ? command as unknown as PiCommand : { commandId: command.commandId as string, text: '', purpose: 'compaction' as const, repair: 'none' as const };
    this.#commands.add(value.commandId); this.#turn = { kind, command: freeze(value), abort: new AbortController(), requests: [], operations: [], pendingTools: 0, executedCalls: new Set(), failure: null, uncertain: false, stateErrorCode: null, error: null };
  }
  async invoke(identity: InvocationIdentity): Promise<{ readonly slot: string }> {
    const value = validateInvocation(identity, this.input.policy.selection), turn = this.#turn;
    if (!turn || turn.failure || turn.abort.signal.aborted || turn.pendingTools || this.#native.size || value.invocation !== this.#lastInvocation + 1 || this.#slots.size >= this.input.policy.limits.requests) refuse('SEND_PATH_UNSUPPORTED', '', { phase: 'admission' });
    this.#lastInvocation = value.invocation;
    if (this.#lastSlot) await this.#lastSlot.completion;
    if (turn !== this.#turn || turn.failure || turn.abort.signal.aborted) refuse('SEND_PATH_UNSUPPORTED');
    let complete!: () => void; const completion = new Promise<void>(resolve => { complete = resolve; });
    const slot: Slot = { invocation: value.invocation, token: randomBytes(24).toString('hex'), turn, claimed: false, parsedDone: false, completion, complete };
    this.#slots.set(value.invocation, slot); this.#lastSlot = slot; return Object.freeze({ slot: slot.token });
  }
  #slot(invocation: number, token: string): Slot {
    const slot = this.#slots.get(invocation); if (!slot || slot.token !== token || slot.turn !== this.#turn) refuse('PAYLOAD_MISMATCH'); return slot;
  }
  async send(identity: FetchIdentity, input: Uint8Array): Promise<RuntimeReply> {
    const slot = this.#slot(identity.invocation, identity.slot), turn = slot.turn;
    if (slot.claimed || turn.failure || turn.abort.signal.aborted) refuse('REQUEST_REFUSED'); slot.claimed = true;
    try {
      const headers = semanticHeaders(identity, this.input.policy.selection), bytes = Buffer.from(input);
      const contextSelection = { modelId: this.input.policy.selection.model, effort: this.input.policy.selection.thinking, tools: this.input.policy.tools, contextWindow: this.#catalog.contextWindow, perCallOutputTokens: this.input.lock.spec.contract.spec.budgets.perCallOutputTokens, provider: this.input.policy.selection.provider, api: this.input.policy.selection.api };
      const assessment = assessFinalRequestContext(bytes, this.input.policy.context, contextSelection);
      if (!assessment.ok) { await this.#context(null, assessment.assessment ?? null, false); refuse('CONTEXT_UNSAFE', '', { phase: 'admission' }); }
      await validateRequestResources(bytes, this.input, turn.kind);
      let previous: string | null = null;
      for (;;) {
        if (turn.abort.signal.aborted) refuse('CANCELLED', '', { phase: 'admission' });
        const view = stateValue(this.host.store.inspect());
        if (view.counts.requests >= this.input.policy.limits.requests || view.counts.operations >= this.input.policy.limits.operations) refuse('REQUEST_REFUSED');
        const remaining = view.clock.remainingTaskMs.safeValue; if (remaining === null || remaining <= 0) refuse('DEADLINE');
        const signal = AbortSignal.any([turn.abort.signal, AbortSignal.timeout(Math.min(300000, remaining))]);
        const credential = await this.#credential(turn, signal);
        if (bytes.includes(Buffer.from(credential))) refuse('PAYLOAD_MISMATCH', '', { phase: 'admission' });
        const attemptAssessment = assessFinalRequestContext(bytes, this.input.policy.context, contextSelection);
        if (!attemptAssessment.ok) { await this.#context(null, attemptAssessment.assessment ?? null, false); refuse('CONTEXT_UNSAFE', '', { phase: 'admission' }); }
        const seed = randomBytes(16).toString('hex'), requestId = 'req-' + seed, operationId = 'op-' + seed, attemptId = 'attempt-' + seed;
        const requestDigest = digest(Buffer.concat([Buffer.from('loopwright.dev/pi-request/v1\0' + canonical({ method: 'POST', destination: this.#destination, headers,
          selection: this.input.policy.selection, runtime: this.input.policy.runtime, policy: digest(Buffer.from(canonical(this.input.policy))), lock: this.input.lock.spec.lockHash,
          sessionId: this.input.sessionId, roleId: this.input.roleId, stepId: this.input.stepId, commandId: turn.command.commandId, purpose: turn.command.purpose, repair: turn.command.repair, attemptId, resources: this.input.policy.resources })), bytes]));
        const request: RequestAdmission = { requestId, operationId, roleId: this.input.roleId, nodeId: this.input.stepId, attemptId, purpose: turn.command.purpose, repair: turn.command.repair, transportRetryOf: previous,
          requestDigest, inputUpperBound: attemptAssessment.value.inputReservation, outputUpperBound: attemptAssessment.value.outputReservation, totalUpperBound: attemptAssessment.value.totalReservation,
          capability: { adapterId: 'pi', adapterVersion: '0.0.0', provider: this.input.policy.selection.provider, model: this.input.policy.selection.model, kind: 'soft_only', coversAllBillableTokens: false, enforcesOutputBound: true }, targetIdentity: this.#destination };
        const context = await this.#context(requestId, attemptAssessment.value, true);
        await this.#events('request_start', { requestId, operationId, attemptId, digest: requestDigest });
        const attempt: Attempt = { requestId, operationId, context, committed: false }; turn.requests.push(attempt); slot.final = attempt;
        let response: Response, body: Uint8Array;
        try {
          const authPair = this.#authHeader === 'x-api-key' ? { 'x-api-key': credential } : { authorization: 'Bearer ' + credential };
          const ticket = this.#admission.issue(request, { destination: this.#destination, headers: { ...headers, ...authPair }, body: bytes, signal });
          response = await this.#admission.dispatch(ticket); this.#outboundObserved = true; body = await boundedResponse(response, this.input.policy.limits.responseBytes, signal);
        } catch (error) {
          if (signal.aborted && !turn.abort.signal.aborted) turn.failure ??= 'DEADLINE';
          const record = this.host.store.getRequest(requestId);
          if (record.ok && record.value.dispatch) { this.host.store.markRequestUnresolved(this.host.authority, requestId, turn.abort.signal.aborted ? 'cancellation' : signal.aborted ? 'timeout' : 'connection_lost'); turn.uncertain = true; }
          else if (!record.ok && record.error.code === 'RECORD_NOT_FOUND') { turn.requests.pop(); delete slot.final; }
          else turn.uncertain = true;
          await this.#events(turn.uncertain ? 'request_uncertain' : 'request_receipt', { requestId, operationId, attemptId, code: error instanceof PiFailure ? error.detail.code : 'RECOVERY_REQUIRED' }).catch(() => {});
          throw error;
        }
        // This check prevents a credential echo from entering SDK/model/session data or receipt artifacts.
        const decoded = Buffer.from(body).toString('utf8').replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))).replace(/\\\//g, '/');
        if (decoded.includes(credential)) { this.host.store.markRequestUnresolved(this.host.authority, requestId, 'connection_lost'); turn.uncertain = true; refuse('PROVIDER_RESPONSE_INVALID', '', { phase: 'dispatch', effect: 'possible', requestId, operationId }); }
        const strictModel = this.input.policy.selection.provider === 'github-copilot' && !this.input.policy.selection.customProvider;
        attempt.raw = inspectRawResponse(body, response.status, this.input.policy.selection.model, this.input.policy.selection.api, strictModel, this.#modelCost); attempt.status = response.status;
        const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
        if (mediaType !== (response.status === 200 ? 'text/event-stream' : 'application/json')) { turn.failure ??= 'PROVIDER_RESPONSE_INVALID'; }
        await publishReceipt(this.host.artifactsDirectory, requestId, 'raw', { version: 1, requestId, operationId, requestDigest, responseDigest: attempt.raw.responseDigest,
          context: attempt.context, status: response.status, rawStop: this.#safeStop(attempt.raw.rawStop), terminationCandidate: attempt.raw.termination, usageCandidate: attempt.raw.usage });
        const retry = response.status === 429 && attempt.raw.termination === 'confirmed';
        if (retry) {
          await this.#commit(attempt, attempt.raw.usage, attempt.raw.termination, false);
          const current = stateValue(this.host.store.inspect());
          const wait = response.headers.get('retry-after'), delay = wait === null ? 100 : /^\d+(?:\.\d+)?$/.test(wait) ? Number(wait) * 1000 : Infinity;
          if (Number.isFinite(delay) && delay >= 0 && delay <= 1000 && current.ledger.transportRetries < this.input.lock.spec.contract.spec.budgets.maxTransportRetries && (current.clock.remainingTaskMs.safeValue ?? 0) > delay) {
            previous = requestId; await this.#events('retry_wait', { requestId, operationId, attemptId, count: delay }); await this.#delay(delay, turn.abort.signal); continue;
          }
        }
        if (!attempt.raw.admission.ok) turn.failure ??= attempt.raw.admission.code === 'CONTEXT_LIMIT' ? 'CONTEXT_LIMIT' : attempt.raw.admission.code === 'OUTPUT_LIMIT' ? 'OUTPUT_LIMIT' : 'PROVIDER_RESPONSE_INVALID';
        return { status: response.status, headers: { 'content-type': response.status === 200 ? 'text/event-stream' : 'application/json' }, bytes: body };
      }
    } catch (error) {
      if (error instanceof PiFailure) { turn.stateErrorCode ??= error.detail.stateErrorCode; if (!turn.error && (!turn.failure || turn.failure === error.detail.code)) turn.error = error.detail; }
      turn.failure ??= error instanceof PiFailure ? error.detail.code : turn.abort.signal.aborted ? 'CANCELLED' : 'PROVIDER_RESPONSE_INVALID'; throw error;
    }
  }
  async #context(requestId: string | null, assessment: PiContextRecord['assessment'], admitted: boolean): Promise<PiContextRecord> {
    const assessmentId = 'ctx-' + randomBytes(16).toString('hex');
    const record: PiContextRecord = freeze({ version: 1, assessmentId, requestId, decision: admitted ? 'admitted' : 'refused', code: admitted ? null : 'CONTEXT_UNSAFE', policyDigest: digest(Buffer.from(canonical(this.input.policy))), catalogDigest: this.#catalog.digest, catalogWindow: this.#catalog.contextWindow, model: this.input.policy.selection, assessment });
    await publishReceipt(this.host.artifactsDirectory, assessmentId, 'context', record);
    await this.#events('context_assessment', { requestId, code: record.code, context: record }); return record;
  }
  async #credential(turn: Turn, signal: AbortSignal): Promise<string> {
    const scope = stateValue(this.host.store.inspect()), now = BigInt(scope.clock.sampledNow.monotonicMs), task = BigInt(scope.clock.basis.taskDeadlineMonotonicMs);
    const readiness = AbortSignal.any([signal, AbortSignal.timeout(10000)]); let listener: () => void = () => {};
    try {
      const credential = await Promise.race([this.host.resolveCredential({ provider: this.input.policy.selection.provider, model: this.input.policy.selection.model, destination: this.#destination, purpose: turn.command.purpose,
        runId: this.input.lock.spec.runId, roleId: this.input.roleId, stepId: this.input.stepId, notAfterMonotonicMs: String(task < now + 10000n ? task : now + 10000n), signal: readiness }),
      new Promise<never>((_, reject) => { listener = () => reject(new Error('Credential readiness cancelled')); readiness.addEventListener('abort', listener, { once: true }); if (readiness.aborted) listener(); })]);
      if (turn !== this.#turn || readiness.aborted || typeof credential.bearerToken !== 'string' || credential.bearerToken.length < 16 || credential.bearerToken.length > 16384 || /[^\x21-\x7e]|["\\]/.test(credential.bearerToken)) refuse('REQUEST_REFUSED', '', { phase: 'admission' });
      return credential.bearerToken;
    } catch (error) { if (error instanceof PiFailure) throw error; refuse(readiness.aborted ? turn.abort.signal.aborted ? 'CANCELLED' : 'DEADLINE' : 'REQUEST_REFUSED', '', { phase: 'admission' }); }
    finally { readiness.removeEventListener('abort', listener); }
  }
  async parsed(candidate: ParsedCandidate): Promise<void> {
    const slot = this.#slot(candidate.invocation, candidate.slot), fingerprint = digest(Buffer.from(canonical(candidate))).hex;
    if (slot.parsedDigest && slot.parsedDigest !== fingerprint) refuse('PAYLOAD_MISMATCH');
    if (slot.parsedPromise) return slot.parsedPromise; slot.parsedDigest = fingerprint;
    slot.parsedPromise = (async () => {
      const attempt = slot.final, turn = slot.turn;
      if (!attempt?.raw) { slot.parsedDone = true; slot.complete(); return; }
      let usage = attempt.raw.usage;
      const completed = ['stop', 'toolUse', 'length'].includes(candidate.stopReason);
      if (completed) {
        const numbers = candidate.usage;
        const input = numbers.input + numbers.cacheRead + numbers.cacheWrite;
        const valid = Object.values(numbers).every(value => Number.isSafeInteger(value) && value >= 0) && Number.isSafeInteger(input);
        const mismatch = !valid || usage.inputTokens.provenance === 'reported' && usage.inputTokens.value !== input || usage.outputTokens.provenance === 'reported' && usage.outputTokens.value !== numbers.output || attempt.raw.admission.ok && canonical(candidate.toolCalls) !== canonical(attempt.raw.toolCalls);
        if (mismatch) { usage = { inputTokens: unknown(), outputTokens: unknown(), costMicrousd: unknown() }; turn.failure ??= 'PROVIDER_RESPONSE_INVALID'; this.#blocked = true; }
      } else if (attempt.raw.admission.ok) turn.failure ??= 'PROVIDER_RESPONSE_INVALID';
      if (!attempt.committed) await this.#commit(attempt, usage, attempt.raw.termination, attempt.raw.admission.ok && completed && !turn.failure);
      if (attempt.raw.termination === 'unknown') turn.uncertain = true;
      slot.parsedDone = true; slot.complete();
    })();
    try { await slot.parsedPromise; } catch (error) { if (error instanceof PiFailure) { slot.turn.stateErrorCode ??= error.detail.stateErrorCode; if (!slot.turn.error && (!slot.turn.failure || slot.turn.failure === error.detail.code)) slot.turn.error = error.detail; } slot.turn.uncertain ||= !slot.final?.committed; slot.turn.failure ??= error instanceof PiFailure ? error.detail.code : 'RECOVERY_REQUIRED'; slot.complete(); throw error; }
  }
  async #commit(attempt: Attempt, usage: RawInspection['usage'], termination: RawInspection['termination'], succeeded: boolean): Promise<void> {
    const operation = stateValue(this.host.store.getOperation(attempt.operationId), 'dispatch'); if (!operation.dispatch) refuse('RECOVERY_REQUIRED');
    const view = stateValue(this.host.store.inspect(), 'dispatch');
    const subject = { storeId: view.storeId, runId: view.runId, lockHash: { ...view.lockHash }, operationId: attempt.operationId, requestId: attempt.requestId,
      intentDigest: { ...operation.intentDigest }, dispatchGeneration: operation.dispatch.generation, dispatchId: operation.dispatch.dispatchId };
    const artifact = await publishReceipt(this.host.artifactsDirectory, attempt.requestId, 'final', { version: 1, subject, responseDigest: attempt.raw?.responseDigest ?? null,
      context: attempt.context, status: attempt.status ?? null, termination, usage, succeeded });
    const evidence: TrustedEvidence = { evidenceId: 'evidence-' + randomBytes(12).toString('hex'), producerId: 'pi-owner', method: 'anthropic-final-bytes-v1', subject, artifact };
    const observed = stateValue(this.host.store.observeRequest(this.host.authority, attempt.requestId, { receiptId: 'receipt-' + randomBytes(12).toString('hex'), evidence,
      termination, outcome: termination === 'confirmed' ? succeeded ? 'succeeded' : 'failed' : null,
      usage: { requestId: attempt.requestId, inputTokens: { ...usage.inputTokens }, outputTokens: { ...usage.outputTokens }, costMicrousd: { ...usage.costMicrousd } } }), 'dispatch');
    const accepted = observed.record.initialObservation; if (!accepted) refuse('RECOVERY_REQUIRED', '', { phase: 'dispatch', effect: 'possible', requestId: attempt.requestId, operationId: attempt.operationId });
    attempt.committedUsage = freeze(structuredClone(accepted.usage)); attempt.committed = true;
    const reported = usage.inputTokens.provenance === 'reported' && usage.outputTokens.provenance === 'reported' ? usage.inputTokens.value + usage.outputTokens.value : null;
    await this.#events(termination === 'confirmed' ? 'request_receipt' : 'request_uncertain', { requestId: attempt.requestId, operationId: attempt.operationId, digest: artifact.digest, count: reported !== null && Number.isSafeInteger(reported) ? reported : null });
  }
  async rootTool(input: ToolAuthorization): Promise<boolean> {
    const slot = this.#slot(input.invocation, input.slot); await slot.completion;
    if (slot.turn !== this.#turn || slot.turn.failure || slot.turn.abort.signal.aborted || !slot.parsedDone || !slot.final?.committed || !this.input.policy.tools.includes(input.name)) return false;
    if (input.argumentsBytes) {
      if (input.argumentsBytes.byteLength > this.input.policy.limits.toolArgsBytes) return false;
      try { if (canonical(toolArgumentsDigest(parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(input.argumentsBytes), { nodes: 262144, array: 4096 }))) !== canonical(input.argumentsDigest)) return false; } catch { return false; }
    }
    const root = slot.final.raw?.toolCalls.find(call => call.id === (input.parentId ?? input.callId));
    if (!root) return false;
    if (input.parentId === null) { if (root.name !== input.name || canonical(root.argumentsDigest) !== canonical(input.argumentsDigest)) return false; }
    else {
      const parent = this.#native.get(input.invocation + ':' + input.parentId), fingerprint = canonical(input.argumentsDigest);
      if (root.name !== 'codemode' || !parent || parent.slot !== slot || input.name === 'codemode' || !input.callId.startsWith(input.parentId + '/') || input.callId.length > 256 || parent.nested.size >= 32 && !parent.nested.has(input.callId)) return false;
      const before = parent.nested.get(input.callId); if (before !== undefined && before !== fingerprint) return false; parent.nested.set(input.callId, fingerprint);
    }
    stateValue(this.host.store.renew(this.host.authority)); const view = stateValue(this.host.store.inspect());
    if (view.ledger.violations.length || (view.clock.remainingTaskMs.safeValue ?? 0) <= 0) return false;
    if (input.parentId === null && input.name === 'codemode') {
      const key = input.invocation + ':' + input.callId; if (slot.turn.executedCalls.has(key) || this.#native.size >= 2) return false; slot.turn.executedCalls.add(key);
      await this.#events('tool_start', { requestId: slot.final.requestId, digest: root.argumentsDigest });
      const timer = setTimeout(() => this.runtimeFault('DEADLINE'), Math.min(this.input.policy.limits.toolWallMs, view.clock.remainingTaskMs.safeValue!));
      this.#native.set(key, { slot, identity: { invocation: input.invocation, slot: input.slot, callId: input.callId, name: input.name, parentId: null }, timer, nested: new Map() });
    }
    return true;
  }
  async nativeResult(identity: ToolIdentity, bytes: Uint8Array): Promise<void> {
    const key = identity.invocation + ':' + identity.callId, parent = this.#native.get(key);
    try {
      if (!parent || parent.identity.slot !== identity.slot || identity.parentId !== null || identity.name !== 'codemode' || bytes.length > this.input.policy.limits.toolResultBytes) refuse('OUTPUT_LIMIT', '', { phase: 'tool' });
      const value = object(parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { nodes: 262144, array: 4096 }), ['argumentsDigest', 'result']);
      const root = parent.slot.final!.raw!.toolCalls.find(call => call.id === identity.callId); if (!root || canonical(root.argumentsDigest) !== canonical(value.argumentsDigest)) refuse('PAYLOAD_MISMATCH', '', { phase: 'tool' });
      const result = value.result as { content?: { type: string; text: string }[]; isError?: unknown };
      if (!Array.isArray(result.content) || result.content.length > 16 || result.content.some(block => block.type !== 'text' || typeof block.text !== 'string') || typeof result.isError !== 'boolean') refuse('TOOL_DENIED', '', { phase: 'tool' });
      stateValue(this.host.store.renew(this.host.authority)); clearTimeout(parent.timer); this.#native.delete(key); await this.#events('tool_end', { requestId: parent.slot.final!.requestId, digest: digest(bytes) });
    } catch (error) { this.runtimeFault(error instanceof PiFailure ? error.detail.code : 'MCP_FAILED'); throw error; }
  }
  guardRootTool(identity: ToolIdentity): void {
    const slot = this.#slot(identity.invocation, identity.slot);
    try {
      if (slot.turn.failure || slot.turn.abort.signal.aborted) refuse('TOOL_DENIED', '', { phase: 'tool' });
      stateValue(this.host.store.renew(this.host.authority), 'tool'); const view = stateValue(this.host.store.inspect(), 'tool'); if (view.clockStatus !== 'trusted' || (view.clock.remainingTaskMs.safeValue ?? 0) <= 0) refuse('DEADLINE', '', { phase: 'tool' });
    } catch (error) { if (error instanceof PiFailure) { slot.turn.failure ??= error.detail.code; slot.turn.stateErrorCode ??= error.detail.stateErrorCode; } throw error; }
  }
  async mcp(identity: ToolIdentity | null, bytes: Uint8Array, reply: (message: JsonRpcMessage) => Promise<void>): Promise<void> {
    try {
      if (!this.#mcp || this.#blocked || this.#sessionAbort.signal.aborted) refuse('MCP_FAILED', '', { phase: 'tool' });
      if (identity) {
        const turn = this.#turn, slot = this.#slot(identity.invocation, identity.slot); if (!turn || bytes.length > 65536) refuse('MCP_FAILED', '', { phase: 'tool' });
        const message = parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as { params?: { arguments?: unknown } }, args = Buffer.from(canonical(message.params?.arguments));
        const key = identity.invocation + ':' + identity.callId;
        if (turn.executedCalls.has(key) || !await this.rootTool({ ...identity, argumentsDigest: toolArgumentsDigest(message.params?.arguments), argumentsBytes: args }) || !slot.final) refuse('TOOL_DENIED', '', { phase: 'tool' }); turn.executedCalls.add(key);
        let operationId: string | null = null;
        await this.#mcp.send({ ...identity, parentRequestId: slot.final.requestId }, bytes, turn.abort.signal, async message => { if ('id' in message && !('method' in message)) await this.#events('tool_end', { requestId: slot.final!.requestId, operationId, digest: digest(Buffer.from(canonical(message))) }); await reply(message); }, async id => { await this.#events('tool_start', { requestId: slot.final!.requestId, operationId: id, digest: digest(args) }); operationId = id; turn.operations.push(id); });
      } else await this.#mcp.send(null, bytes, this.#sessionAbort.signal, reply, () => { refuse('TOOL_DENIED', '', { phase: 'tool' }); });
    } catch (error) { if (error instanceof PiFailure && this.#turn) this.#turn.stateErrorCode ??= error.detail.stateErrorCode; this.runtimeFault(error instanceof PiFailure ? error.detail.code : 'MCP_FAILED'); throw error; }
  }
  cancelMcp(id: unknown): void { this.#mcp?.cancel(id); }
  async closeMcp(): Promise<void> { await this.#mcp?.close(); }
  #safeStop(value: string | null): string | null { return value && ['end_turn', 'tool_use', 'max_tokens', 'model_context_window_exceeded', 'pause_turn', 'stop_sequence', 'refusal', 'sensitive', 'stop', 'tool_calls', 'length', 'content_filter', 'completed', 'incomplete'].includes(value) ? value : null; }
  async #delay(ms: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => { const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Retry cancelled')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
  }
  cancel(code: PiErrorCode = 'CANCELLED'): void { if (this.#turn) { this.#turn.failure ??= code; this.#turn.abort.abort(); } this.#sessionAbort.abort(); for (const parent of this.#native.values()) clearTimeout(parent.timer); this.#native.clear(); }
  progress(): PiOutcome | null {
    const turn = this.#turn; if (!turn) return null;
    return freeze({ status: 'cancelled', requestIds: turn.requests.map(value => value.requestId), operationIds: [...turn.requests.map(value => value.operationId), ...turn.operations],
      providerTermination: !turn.requests.length ? 'none' : turn.requests.every(value => value.raw?.termination === 'confirmed') ? 'confirmed' : 'unknown',
      usage: !turn.requests.length ? 'none' : turn.requests.every(value => value.committed && value.committedUsage?.inputTokens.provenance === 'reported' && value.committedUsage.outputTokens.provenance === 'reported') ? 'complete' : 'incomplete', localCleanup: 'pending', error: turn.error, cleanupError: null });
  }
  finish(): PiOutcome {
    const turn = this.#turn; if (!turn) refuse('SESSION_BUSY'); this.#turn = null;
    for (const slot of this.#slots.values()) if (slot.turn === turn) { if (!slot.parsedDone) { turn.failure ??= 'PROVIDER_RESPONSE_INVALID'; if (turn.requests.length) turn.uncertain = true; } slot.complete(); }
    if (turn.requests.some(attempt => !attempt.committed)) turn.uncertain = true;
    if (this.#native.size) { turn.failure ??= 'MCP_FAILED'; for (const parent of this.#native.values()) clearTimeout(parent.timer); this.#native.clear(); }
    if (turn.pendingTools || turn.operations.some(id => { const record = this.host.store.getOperation(id); return !record.ok || record.value.state !== 'confirmed'; })) turn.uncertain = true;
    this.#blocked ||= turn.uncertain; turn.abort.abort();
    const inspected = this.host.store.inspect();
    if (!inspected.ok) { turn.uncertain = true; turn.stateErrorCode ??= inspected.error.code; turn.failure ??= 'STATE_REFUSED'; }
    else { if ((inspected.value.clock.remainingTaskMs.safeValue ?? 0) <= 0) turn.failure ??= 'DEADLINE'; if (inspected.value.ledger.violations.length || inspected.value.clockStatus !== 'trusted') turn.uncertain = true; }
    const recovery = turn.uncertain || this.#blocked;
    const code = turn.failure ?? (recovery ? 'RECOVERY_REQUIRED' : turn.requests.length ? null : 'PROVIDER_RESPONSE_INVALID');
    this.#blocked ||= recovery || code !== null;
    const termination = !turn.requests.length ? 'none' : turn.requests.every(value => value.raw?.termination === 'confirmed') ? 'confirmed' : 'unknown';
    return freeze({ status: recovery ? 'recovery_required' : code === null ? 'execution_settled' : code === 'CANCELLED' ? 'cancelled' : !turn.requests.length ? 'blocked' : 'failed',
      requestIds: turn.requests.map(value => value.requestId), operationIds: [...turn.requests.map(value => value.operationId), ...turn.operations], providerTermination: termination,
      usage: !turn.requests.length ? 'none' : turn.requests.every(value => value.committed && value.committedUsage?.inputTokens.provenance === 'reported' && value.committedUsage.outputTokens.provenance === 'reported') ? 'complete' : 'incomplete', localCleanup: 'pending', cleanupError: null,
      error: code === null ? null : { code, path: '', phase: 'session', retryable: false, ...turn.error, effect: !turn.requests.length && !turn.operations.length ? 'none' : recovery || termination === 'unknown' ? 'possible' : 'confirmed', requestId: turn.requests.at(-1)?.requestId ?? null, operationId: turn.operations.at(-1) ?? turn.requests.at(-1)?.operationId ?? null, stateErrorCode: turn.stateErrorCode } });
  }
}
