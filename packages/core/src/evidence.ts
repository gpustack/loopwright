import { artifactRefSchema, arrayOf, checkStatus, document, evidenceLevel, identifier, nullable, record, text, type Infer } from './contracts.js';
import { fail } from './diagnostics.js';
import { unique } from './graph.js';
import { subjectSchema } from './identity.js';
import { LIMITS } from './limits.js';
import type { Json } from './boundary.js';

const evidenceShape = document('Evidence', record({ checkId: identifier, observedStatus: checkStatus,
  producerId: identifier, method: identifier, level: evidenceLevel, subject: subjectSchema,
  artifacts: arrayOf(artifactRefSchema, 0, LIMITS.manifest), reason: nullable(text()),
}));
export type Evidence = Infer<typeof evidenceShape>;
export function evidenceSchema(value: Json, path = ''): Evidence {
  const evidence = evidenceShape(value, path), observation = evidence.spec;
  if (observation.observedStatus === 'passed') {
    if (observation.reason !== null) fail('VALUE_RANGE', `${path}/spec/reason`);
    if (!observation.artifacts.length) fail('VALUE_RANGE', `${path}/spec/artifacts`);
  } else if (observation.reason === null) fail('VALUE_RANGE', `${path}/spec/reason`);
  unique(observation.artifacts.map(ref => ref.name), `${path}/spec/artifacts`);
  return evidence;
}
const claimShape = record({ checkId: identifier, status: checkStatus, evidenceId: nullable(identifier), reason: nullable(text()) });
export type SubmittedCheck = Infer<typeof claimShape>;
export function claimSchema(value: Json, path: string): SubmittedCheck {
  const claim = claimShape(value, path);
  if ((claim.status === 'passed') !== (claim.reason === null)) fail('VALUE_RANGE', `${path}/reason`);
  if (claim.status === 'not_run' && claim.evidenceId !== null) fail('VALUE_ENUM', `${path}/evidenceId`);
  return claim;
}
