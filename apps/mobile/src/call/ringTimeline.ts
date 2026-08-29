/** @author masterzee001 */
/**
 * Where a ring's seconds went: the device's side of T0..T11.
 *
 * The founder's targets (29 Aug): tap Call -> callee ringing under 3 s
 * typical / 5 s p95; Answer -> usable two-way audio under 2 s / 4 s. The
 * gateway holds T1 (call created), T2/T3 (push sent / FCM answered, on the
 * account service), T6 (ringing ack received) and T10/T11 (peer joined,
 * two-way proven). The device holds T4 (push arrived), T5 (validated), T7
 * (presented), T8 (answer tapped), T9 (app foreground with the call). This
 * posts the device's stamps once per call so one line in the gateway log
 * carries the whole chain. Ids and times only.
 */

export interface RingTimeline {
  readonly [point: string]: number;
}

export async function reportRingTimeline(
  gatewayUrl: string,
  sessionToken: string | null,
  callId: string,
  timeline: RingTimeline,
  role: 'caller' | 'callee',
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (sessionToken === null) return false;
  const stamps = Object.fromEntries(Object.entries(timeline).filter(([, v]) => typeof v === 'number'));
  if (role === 'callee' && Object.keys(stamps).length === 0) return false;
  try {
    const response = await fetchImpl(`${gatewayUrl.replace(/\/+$/, '')}/calls/direct/${encodeURIComponent(callId)}/timing`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role, stamps, reportedAtMs: Date.now() }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
