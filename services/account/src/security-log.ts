/**
 * Where security events go on this deployment.
 *
 * STRUCTURED JSON TO STDOUT, which journald collects and `journalctl` can
 * filter. That is not a compromise for want of something better: it is the same
 * shape every other log line in this service already uses, it needs no agent,
 * no network path and no credential, and it cannot fail in a way that takes the
 * service down. A log destination that can break is a log destination that
 * breaks during the incident you needed it for.
 *
 * THE PAYLOAD IS THE EVENT AND NOTHING ELSE. `securityEvent` builds a value
 * with a closed set of safe fields, and this sink writes exactly that. There is
 * no spread of a request, no error object, no "extra" bag -- because every such
 * field eventually receives a request body, and that is how OTP codes and reset
 * tokens end up in a log that far more people can read than can read the
 * database.
 */
import {
  containsForbiddenField,
  securityEvent,
  targetDigest,
  type SecurityEvent,
  type SecurityEventKind,
  type SecurityEventSink,
  type SecurityReasonCode,
} from '@videofy-live/account-trust';

export interface SecurityLogOptions {
  /**
   * Salt for hashing addresses, so velocity per address is countable without
   * the address being retained. Absent means addresses are simply omitted --
   * never logged in the clear as a fallback.
   */
  readonly targetSalt?: string;
  readonly write?: (line: string) => void;
}

export function createSecurityLog(options: SecurityLogOptions = {}): SecurityEventSink {
  const write =
    options.write ??
    ((line: string) => {
      // eslint-disable-next-line no-console
      console.log(line);
    });

  return {
    record(event: SecurityEvent) {
      /*
       * The backstop firing means the event type grew a hole, and the right
       * response is to drop the event rather than write it. Losing one line is
       * recoverable; writing a credential into a log that is shipped, indexed
       * and retained is not.
       */
      const forbidden = containsForbiddenField(event);
      if (forbidden !== null) {
        write(
          JSON.stringify({
            service: 'account',
            level: 'error',
            message: 'security event dropped: it carried a forbidden field',
            field: forbidden,
            kind: event.kind,
          }),
        );
        return;
      }
      write(JSON.stringify({ service: 'account', level: 'security', ...event }));
    },
  };
}

/**
 * Build and record in one call, so a call site cannot forget the alert table.
 *
 * `securityEvent` decides alertability from one place; constructing the object
 * by hand at each site is how that decision drifts and "what pages us?" stops
 * having a readable answer.
 */
export function recordSecurity(
  sink: SecurityEventSink,
  input: {
    kind: SecurityEventKind;
    correlationId: string;
    atMs: number;
    accountId?: string;
    organizationId?: string;
    target?: string;
    salt?: string;
    reasonCode?: SecurityReasonCode;
    sourceIp?: string;
  },
): void {
  const digest =
    input.target && input.salt && input.salt.length >= 16
      ? targetDigest(input.target, input.salt)
      : undefined;

  sink.record(
    securityEvent({
      kind: input.kind,
      correlationId: input.correlationId,
      atMs: input.atMs,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      ...(digest ? { targetDigest: digest } : {}),
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
      ...(input.sourceIp ? { sourceIp: input.sourceIp } : {}),
    }),
  );
}
