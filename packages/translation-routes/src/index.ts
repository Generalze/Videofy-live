/** @author masterzee001 */
/**
 * The pure entry point: types, validation and the gate, with no `node:` import
 * anywhere beneath it. Reading a document off disk lives at the
 * `@videofy-live/translation-routes/document-file` subpath.
 *
 * Note what is NOT exported: nothing that approves a route, enables a provider
 * or turns an engine on. Approval is a fact stated in a reviewed document, not
 * a function anybody can call.
 */
export {
  DEFAULT_REVIEW_REQUIRED_LANGUAGES,
  SERVICE_SCOPES,
  UNASSIGNED_PROVIDER,
  directionKey,
  isServiceScope,
  normaliseLanguageTag,
  type CommercialUse,
  type ExecutionClass,
  type HumanReviewStatus,
  type LatencyProfile,
  type LicenceStatus,
  type ScopeApproval,
  type ServiceScope,
  type TechnicalEvidence,
  type TranslationRouteRecord,
} from './route-record.js';

export {
  parseRouteDocument,
  type DocumentParse,
  type DocumentProblem,
  type ParseOptions,
  type RouteDocument,
} from './validate.js';

export {
  TranslationRouteRegistry,
  createTranslationRouteRegistry,
  type RegistryCreation,
  type RegistryOptions,
  type RouteDirection,
  type TranslationAllowed,
  type TranslationDecision,
  type TranslationRefusal,
  type TranslationRefused,
} from './registry.js';
