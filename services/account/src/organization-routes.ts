/** @author masterzee001 */
/**
 * Organization endpoints.
 *
 * EVERY route here builds its authorization context the same way, through one
 * helper, because the interesting failure is not a missing check — it is a
 * check that exists on nine routes and was forgotten on the tenth.
 *
 * The context is assembled from things the SERVER established:
 *
 *   accountId   from the signed session token
 *   trust       from the account record
 *   membership  from the organization's own member list
 *   state       from the organization record
 *
 * The `:organizationId` in the path contributes exactly one thing: which
 * organization to LOOK UP. It never contributes authority. A valid id belonging
 * to a company you have nothing to do with resolves to `membership: null`, and
 * the resolver refuses.
 */
import type express from 'express';
import { authorize, type Capability } from '@videofy-live/workspace-authority';
import type { AccountStore } from './account-store.js';
import type { Caller } from './routes.js';
import type { OrganizationStore } from './organization-store.js';

export interface OrganizationRouteDependencies {
  readonly store: AccountStore;
  readonly organizations: OrganizationStore;
  /**
   * Resolves the caller from the request, or null. Shared with the account
   * routes, so both surfaces answer "who is this" the same way and neither can
   * drift into trusting something the other would refuse.
   */
  readonly callerAccountId: (req: express.Request) => Caller | null;
  readonly onEvent?: (event: string, detail: Record<string, string | number>) => void;
}

/**
 * One refusal shape for every denial.
 *
 * A caller learns that they may not do this, and nothing about why — in
 * particular, nothing that distinguishes "that organization does not exist"
 * from "it exists and you are not in it". The second answer is a membership
 * oracle for anybody willing to iterate ids.
 */
function refuse(res: express.Response): void {
  res.status(404).json({ error: 'Not found.' });
}

export function registerOrganizationRoutes(
  app: express.Express,
  deps: OrganizationRouteDependencies,
): void {
  /**
   * Resolve the caller's standing IN a specific organization.
   *
   * Returns null when anything at all is wrong, so every caller has exactly one
   * failure path and cannot accidentally continue on a partial result.
   */
  const contextFor = (req: express.Request, organizationId: string) => {
    const caller = deps.callerAccountId(req);
    if (caller === null) return null;
    const accountId = caller.accountId;
    const organization = deps.organizations.get(organizationId);
    if (!organization) return null;
    return {
      accountId,
      trust: deps.store.trustOf(accountId),
      workspaceKind: 'organization' as const,
      membership: deps.organizations.membershipOf(organizationId, accountId),
      organizationState: organization.state,
      organization,
    };
  };

  const guard = (
    req: express.Request,
    res: express.Response,
    organizationId: string,
    capability: Capability,
  ) => {
    const context = contextFor(req, organizationId);
    if (context === null) {
      refuse(res);
      return null;
    }
    const decision = authorize(context, capability);
    if (!decision.ok) {
      deps.onEvent?.('organization.denied', { capability, reason: decision.reason });
      refuse(res);
      return null;
    }
    return context;
  };

  /** Create an organization. Requires a fully verified individual. */
  app.post('/organizations', (req, res) => {
    const caller = deps.callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    const decision = authorize(
      { accountId: caller.accountId, trust: caller.trust, workspaceKind: 'personal' },
      'organization.create',
    );
    if (!decision.ok) {
      // This one DOES say why: the person is looking at their own account, and
      // "complete verification first" is the actionable answer.
      res.status(403).json({
        error: 'Complete verification before creating an organization.',
        reason: decision.reason,
      });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const legalName = typeof body['legalName'] === 'string' ? body['legalName'].trim() : '';
    const displayName =
      typeof body['displayName'] === 'string' ? body['displayName'].trim() : legalName;
    const packageId = body['packageId'] === 'enterprise' ? 'enterprise' : 'corporate';
    const contractedSeats =
      typeof body['contractedSeats'] === 'number' && Number.isFinite(body['contractedSeats'])
        ? body['contractedSeats']
        : 1;

    if (legalName.length < 2 || legalName.length > 200 || displayName.length > 200) {
      res.status(400).json({ error: 'Enter the registered name of the organization.' });
      return;
    }

    const organization = deps.organizations.create({
      legalName,
      displayName,
      packageId,
      contractedSeats,
      createdByAccountId: caller.accountId,
    });
    deps.onEvent?.('organization.created', { packageId });
    res.status(201).json({
      organizationId: organization.organizationId,
      displayName: organization.displayName,
      // Created UNVERIFIED. Typing a name is not evidence of anything, and the
      // response must not imply it was.
      state: organization.state,
      packageId: organization.packageId,
      contractedSeats: organization.contractedSeats,
    });
  });

  /** The organizations this account is actually a member of. */
  app.get('/organizations', (req, res) => {
    const caller = deps.callerAccountId(req);
    if (caller === null) {
      res.status(401).json({ error: 'Sign in to continue.' });
      return;
    }
    // Built from memberships, never from a list the client asked for.
    res.status(200).json({ organizations: deps.organizations.organizationsFor(caller.accountId) });
  });

  app.get('/organizations/:organizationId', (req, res) => {
    const organizationId = req.params['organizationId'] ?? '';
    const context = guard(req, res, organizationId, 'organization.view');
    if (!context) return;

    const seats = deps.organizations.seats(organizationId);
    res.status(200).json({
      organizationId,
      displayName: context.organization.displayName,
      // The legal name only once something checked it; shown earlier it reads
      // as corroboration it has not earned.
      ...(context.organization.state === 'verified'
        ? { legalName: context.organization.legalName }
        : {}),
      state: context.organization.state,
      packageId: context.organization.packageId,
      role: context.membership?.role ?? null,
      seats,
    });
  });

  app.get('/organizations/:organizationId/people', (req, res) => {
    const organizationId = req.params['organizationId'] ?? '';
    const context = guard(req, res, organizationId, 'organization.view');
    if (!context) return;

    const members = deps.organizations
      .membersOf(organizationId)
      .filter((member) => member.active)
      .map((member) => ({ accountId: member.accountId, role: member.role, joinedAt: member.joinedAt }));

    // Pending invitations are organization management information, shown only
    // to somebody who may manage people.
    const mayManage = authorize(context, 'organization.managePeople').ok;
    res.status(200).json({
      members,
      ...(mayManage
        ? {
            invitations: deps.organizations
              .invitationsOf(organizationId)
              .filter((invitation) => invitation.status === 'pending')
              .map((invitation) => ({
                invitationId: invitation.invitationId,
                email: invitation.email,
                role: invitation.role,
                expiresAtMs: invitation.expiresAtMs,
              })),
          }
        : {}),
    });
  });

  app.post('/organizations/:organizationId/invitations', (req, res) => {
    const organizationId = req.params['organizationId'] ?? '';
    const context = guard(req, res, organizationId, 'organization.invite');
    if (!context) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof body['email'] === 'string' ? body['email'] : '';
    const role =
      body['role'] === 'organization-admin' ||
      body['role'] === 'billing-admin' ||
      body['role'] === 'member'
        ? body['role']
        : 'member';

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      res.status(400).json({ error: 'Enter a valid email address.' });
      return;
    }

    void deps.organizations
      .invite({ organizationId, email, role, invitedByAccountId: context.accountId })
      .then((outcome) => {
        if (outcome.ok) {
          deps.onEvent?.('organization.invited', { role });
          // The token is NOT returned. It goes to the invited address; handing
          // it back here would let an administrator accept on someone's behalf.
          res.status(201).json({
            invitationId: outcome.invitation.invitationId,
            expiresAtMs: outcome.invitation.expiresAtMs,
            seats: deps.organizations.seats(organizationId),
          });
          return;
        }
        if (outcome.reason === 'no-seats-available' || outcome.reason === 'over-capacity') {
          deps.onEvent?.('organization.seat_refused', { reason: outcome.reason });
          res.status(409).json({
            error:
              outcome.reason === 'over-capacity'
                ? 'This organization is over capacity. Add seats before inviting anybody else.'
                : 'No seats available. Add seats or upgrade the package.',
            reason: outcome.reason,
            seats: deps.organizations.seats(organizationId),
          });
          return;
        }
        if (outcome.reason === 'already-invited') {
          res.status(409).json({ error: 'That address already has a pending invitation.' });
          return;
        }
        refuse(res);
      })
      .catch(() => res.status(500).json({ error: 'The invitation could not be created.' }));
  });

  app.delete('/organizations/:organizationId/invitations/:invitationId', (req, res) => {
    const organizationId = req.params['organizationId'] ?? '';
    const context = guard(req, res, organizationId, 'organization.invite');
    if (!context) return;

    void deps.organizations
      .cancelInvitation(organizationId, req.params['invitationId'] ?? '')
      .then((cancelled) => {
        if (!cancelled) {
          refuse(res);
          return;
        }
        res.status(200).json({ cancelled: true, seats: deps.organizations.seats(organizationId) });
      })
      .catch(() => res.status(500).json({ error: 'The invitation could not be cancelled.' }));
  });

  app.delete('/organizations/:organizationId/members/:accountId', (req, res) => {
    const organizationId = req.params['organizationId'] ?? '';
    const context = guard(req, res, organizationId, 'organization.removeMember');
    if (!context) return;

    void deps.organizations
      .removeMember(organizationId, req.params['accountId'] ?? '')
      .then((outcome) => {
        if (outcome.ok) {
          deps.onEvent?.('organization.member_removed', {});
          res.status(200).json({ removed: true, seats: deps.organizations.seats(organizationId) });
          return;
        }
        if (outcome.reason === 'last-owner') {
          res.status(409).json({
            error: 'An organization must keep an owner. Transfer ownership first.',
          });
          return;
        }
        refuse(res);
      })
      .catch(() => res.status(500).json({ error: 'The member could not be removed.' }));
  });

  app.post('/organizations/:organizationId/transfer-ownership', (req, res) => {
    const organizationId = req.params['organizationId'] ?? '';
    const context = guard(req, res, organizationId, 'organization.transferOwnership');
    if (!context) return;

    const toAccountId = (req.body as { toAccountId?: unknown } | undefined)?.toAccountId;
    if (typeof toAccountId !== 'string' || toAccountId.length === 0) {
      res.status(400).json({ error: 'Choose who should become the owner.' });
      return;
    }

    void deps.organizations
      .transferOwnership(organizationId, context.accountId, toAccountId)
      .then((outcome) => {
        if (outcome.ok) {
          deps.onEvent?.('organization.ownership_transferred', {});
          res.status(200).json({ transferred: true });
          return;
        }
        refuse(res);
      })
      .catch(() => res.status(500).json({ error: 'Ownership could not be transferred.' }));
  });
}
