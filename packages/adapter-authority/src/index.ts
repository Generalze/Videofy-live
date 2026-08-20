/** @author masterzee001 */
/**
 * Adapter authority: service identity, route authorization, session capability.
 *
 * Platform-owned. The gateway hosts this; adapters only ever hold the opaque
 * strings it issues. A package rather than a file in the gateway so the
 * security properties are testable in isolation, which is the only way a
 * negative-security matrix is worth having.
 */
export { AdapterAuthority } from './authority.js';
export type {
  AdapterAuthorityDeps,
  AuthorityRefusal,
  CapabilityOperation,
  IssuedRouteCredential,
  ResolvedCapability,
  RouteOperation,
  SessionGrant,
} from './authority.js';
