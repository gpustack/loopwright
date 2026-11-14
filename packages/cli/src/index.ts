export { parseArguments, UsageError, type Arguments } from './arguments.js';
export { canonicalPath, initDraft, writeOutput, appendStepSummary } from './draft.js';
export { encoded, diagnosticExit, executionExit, closureExitCode, main, type Envelope } from './main.js';
export {
  CLOSURE_CAPABILITY_LEDGER,
  CLOSURE_EVIDENCE_MISSING,
  CLOSURE_EVIDENCE_UNTRUSTED,
  CLOSURE_FALSIFICATION_FORBIDDEN,
  evaluateClosureMatrix,
  verifyClosureLedgerIntegrity,
} from './closure.js';
export type {
  ClosureCapabilityEntry,
  ClosureCapabilityId,
  ClosureDiagnostic,
  ClosureDiagnosticCode,
  ClosureDisposition,
  ClosureEvaluationOptions,
  ClosureEvidenceFailure,
  ClosureEvidenceLevel,
  ClosureIntegrityReport,
  ClosureMatrixReport,
  ClosureOwnerPackage,
  ClosureSubsystem,
  ExternalQualificationReceipt,
  IntegratedFailureMatrixReport,
  IntegratedFailureScenarioId,
  IntegratedFailureScenarioResult,
} from './closure.js';
export { INTEGRATED_FAILURE_SCENARIO_IDS, runIntegratedFailureMatrix, type IntegratedFailureMatrixOptions } from './failure-matrix.js';
