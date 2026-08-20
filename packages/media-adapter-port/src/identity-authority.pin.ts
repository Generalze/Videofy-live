/** @author masterzee001 */
/**
 * A compile-time pin. This file asserts nothing at runtime and emits nothing.
 *
 * It lives in `src/` rather than `src/__tests__/` on purpose: the package's
 * tsconfig excludes the test directory, so a type-level assertion placed there
 * would never be checked by `npm run typecheck` — it would look like a pin and
 * verify nothing, which is worse than having none.
 *
 * Each `@ts-expect-error` below FAILS COMPILATION if the error it expects stops
 * happening. So if either brand ever collapses back to a bare `string`, or the
 * two become mutually assignable, the build breaks here rather than six months
 * later when an adapter-minted identifier is quietly accepted as platform
 * authority.
 *
 * The distinction being protected:
 *
 *     AdapterSessionRef   an adapter's own name for a call it is handling
 *     VideofySessionId    the platform's authoritative session identity
 *
 * Nothing an adapter mints may become the second one.
 */
import type { AdapterSessionRef } from './identity.js';
import type { VideofySessionId } from './platform-identity.js';

declare const adapterRef: AdapterSessionRef;
declare const platformId: VideofySessionId;
declare const plainString: string;

// An adapter reference must never satisfy platform authority. This is the
// assignment the whole branding exists to prevent: it is what "the adapter
// chooses which session its audio lands in" looks like in a type system.
// @ts-expect-error
const authorityFromAdapter: VideofySessionId = adapterRef;

// And the reverse, so the boundary is not merely one-way. A platform identity
// is not an adapter's to hold or echo.
// @ts-expect-error
const adapterRefFromAuthority: AdapterSessionRef = platformId;

// A bare string is neither. Both must be reached through their constructors,
// so that "where do these come from?" has exactly one answer per kind.
// @ts-expect-error
const adapterRefFromString: AdapterSessionRef = plainString;

// @ts-expect-error
const authorityFromString: VideofySessionId = plainString;

// Referenced so the declarations are not merely unused bindings; `void` keeps
// this file free of runtime behaviour.
void authorityFromAdapter;
void adapterRefFromAuthority;
void adapterRefFromString;
void authorityFromString;
