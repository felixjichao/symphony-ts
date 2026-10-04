export {
  runGithubDogfoodCli,
  createRealDogfoodDeps,
  parseStructuredLogLine,
  parseStructuredErrorCode,
  hasCleanupCompletedFor,
  resolveToken,
  DogfoodError,
} from "./github-dogfood";
export type {
  DogfoodIo,
  DogfoodDeps,
  DogfoodProcessRunner,
  DogfoodProcessResult,
  DogfoodHostHandle,
} from "./github-dogfood";
export {
  DOGFOOD_SCENARIOS,
  PRODUCT_REPOSITORY,
  AUTHORIZED_TARGET_REPOSITORY,
  DOGFOOD_READY_LABEL,
  DEFAULT_TEMPLATE_PATH,
  DEFAULT_EVIDENCE_DIR,
  FOREIGN_REFUSAL_CODE,
  CONFLICT_REFUSAL_CODE,
  parseDogfoodArgs,
  validateDogfoodTarget,
  decideDogfoodGate,
  classifyDogfoodOutcome,
  buildEvidenceManifest,
  serializeEvidence,
  scenarioNeedsHost,
} from "./contracts";
export type {
  DogfoodArgs,
  DogfoodScenario,
  DogfoodGate,
  DogfoodFacts,
  DogfoodVerdict,
  DogfoodEvidence,
  TargetDecision,
  CheckConclusion,
  PrState,
} from "./contracts";
