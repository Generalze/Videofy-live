/** @author masterzee001 */
/**
 * The pure entry point: types, validation and the gate, with no `node:` import
 * anywhere beneath it. Reading a document off disk lives at the
 * `@videofy-live/translation-routes/document-file` subpath.
 *
 * Note what is NOT exported HERE: nothing that approves a route, enables a
 * provider or turns an engine on. Approval is a fact stated in a reviewed
 * document, not a function a service can reach for while it is deciding
 * whether it may translate something.
 *
 * Since 2026-09-20 there IS a way to state that fact -- `promoteRoute` at the
 * `/promotion` subpath, and the command that drives it -- because before there
 * was one, the only way to approve anything was to hand-edit the document and
 * hope the fail-closed validator agreed. It lives at its own subpath rather
 * than here so that nothing on the reading path can import it by accident, and
 * so this entry point stays what it says it is: the gate, and the types the
 * gate is made of.
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
  type RouteApprovalRecord,
  type RouteReviewEvidence,
  type ScopeApproval,
  type ServiceScope,
  type SupersededReview,
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
