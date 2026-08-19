// owner: masterzee001
/**
 * Build-time configuration. The Videofy gateway origin is the one address
 * the browser SDK itself dials; it is public infrastructure (the join token
 * is the credential), so shipping it in the bundle leaks nothing.
 */
export function gatewayUrl(): string {
  const env = import.meta.env as Record<string, unknown> | undefined;
  const configured = env?.['VITE_GATEWAY_URL'];
  if (typeof configured === 'string' && configured.length > 0) return configured;
  return 'http://localhost:3001';
}
