/** @author masterzee001 */
/**
 * No test in this service may reach the network.
 *
 * A suite that makes real outbound calls depends on somebody else's uptime and
 * on DNS, and it fails in the one place that is hardest to read: a timeout in
 * a full run that passes in isolation. That is not a hypothetical -- it is
 * what a fixture key reaching ElevenLabs actually did here.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = String(input);
  if (/^https?:\/\//u.test(url) && !url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost')) {
    throw new Error(`A test tried to reach the network: ${url}`);
  }
  return realFetch(input, init);
}) as typeof fetch;
