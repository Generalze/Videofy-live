# @videofy-live/connect-control

The Videofy Connect control plane (P6.5, R1): the `/v1` partner API router,
the project registry (`connect-projects.json`, hash-only credentials), the
public↔internal live-call map, the single-use join-token module, and the
synchronous join gate the gateway consults on `call:join`.

This package never touches the call-session store or the call runtime
directly. The gateway hands it a narrow `ConnectCallFacade` (preregister,
snapshot, authority mode change, authority end) and mounts
`createConnectV1Router(...)` in front of its 404 catch-all.

Load-bearing invariants (tested):

- **Separate credential system.** Join tokens sign with `CONNECT_AUTH_SECRET`
  and carry `aud: 'vc-join'`; an account session token can never verify as a
  connect token, nor the reverse — even under an identical secret.
- **R6 single use.** `ConnectJtiRegistry.claim` is a synchronous
  check-and-set; the join path calls it before its first await, so two
  simultaneous joins on one token have exactly one winner. A claimed token
  that fails later is burned; the partner re-mints.
- **R7 origin is authorization.** After verification, the handshake Origin is
  compared to the token's own project's `allowedOrigins`; missing origins
  pass only under explicit `allowOriginless: true`. No wildcards.
- **R12 fail closed.** No registry file → `/v1` cleanly disabled (503
  UNSUPPORTED_CAPABILITY); malformed registry → load throws and gateway
  startup fails; no usable secret → token mint/verify unavailable.
- **R13 restart truth.** The live-call map and jti set are in-memory only; a
  gateway restart voids them and outstanding tokens die on the live-registry
  membership check.
- **Internal ids never leak.** `/v1` responses and token claims carry only
  public `vc_` ids; `connect_<proj8>_<rand12>` stays inside the process.
