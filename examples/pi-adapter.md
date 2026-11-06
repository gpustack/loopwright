# Public adapter lifecycle

This host-side TypeScript function receives an already claimed `PiHost`, validated `PiOpenInput` and bounded metadata sink.
It does not create credentials, policy or state. Prepare those under the [adapter guide](../docs/pi-adapter.md#host-construction).
Use a fresh command/checkpoint ID for each intended operation. Do not run this example with fabricated runtime identities.

```ts
import { openPiAdapter, type PiEvent, type PiHost, type PiOpenInput, type PiResult, type PiOutcome, type PiCapture } from '@loopwright/agent-pi';

export async function runRole(
  host: PiHost,
  input: PiOpenInput,
  recordMetadata: (event: PiEvent) => Promise<void>,
) {
  const opened = await openPiAdapter(host, input);
  if (!opened.ok) return { opened };

  const adapter = opened.value;
  const events = (async () => {
    for await (const event of adapter.events()) await recordMetadata(event);
    return true;
  })().catch(async () => {
    await adapter.cancel({ reason: 'consumer_disconnected' });
    return false;
  });
  let result: { outcome: PiResult<PiOutcome>; capture: PiResult<PiCapture> | null } | null = null;
  let cleanup: PiResult<{ readonly closed: true }> | null = null;
  try {
    const outcome = await adapter.execute({
      commandId: 'task-turn-1', text: 'Inspect the admitted candidate.',
      purpose: 'task', repair: 'none',
    });
    const capture = outcome.ok && outcome.value.status === 'execution_settled' && outcome.value.usage === 'complete'
      ? await adapter.capture({ checkpointId: 'task-checkpoint-1' }) : null;
    result = { outcome, capture };
  } finally {
    cleanup = await adapter.close();
  }
  return { result, cleanup, eventsComplete: await events };

}
```

The trusted caller must bound `recordMetadata` and keep raw content/credentials out of it. A slow consumer can cause terminal
`EVENT_OVERFLOW`; it is not permission to discard authoritative state. In a real controller, retain the returned execution error, cleanupError, cleanup result and metadata-delivery status as a typed host incident.
Do not throw away those facts or retry the whole function. A value with status failed/blocked/recovery_required is not a successful execution. Release S02 authority only after cleanup is confirmed.

For cancellation, call `adapter.cancel({reason:'operator'})` on the same handle. Cancellation returns separate provider/usage/local
cleanup facts and cannot refund an uncertain request. For manual compaction, call `adapter.compact({commandId:'summary-1'})` explicitly;
it consumes the same parent budget and requires suitable existing history. Neither operation changes context mode or resource identity.

A successful execution/capture still needs authenticated verifier evidence and core acceptance evaluation. The example never emits a task pass.
