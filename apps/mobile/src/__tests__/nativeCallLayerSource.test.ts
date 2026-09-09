/** @author masterzee001 */
import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\r\n/gu, '\n');

const incomingService = read(
  '../../modules/videofy-call/android/src/main/java/com/consummate7/videofy/call/IncomingCallService.kt',
);
const connectionService = read(
  '../../modules/videofy-call/android/src/main/java/com/consummate7/videofy/call/VideofyConnectionService.kt',
);
const nativeModule = read(
  '../../modules/videofy-call/android/src/main/java/com/consummate7/videofy/call/VideofyCallModule.kt',
);
const nativeTs = read('../native/videofyCall.ts');
const screen = read('../screens/CallScreen.tsx');
const app = read('../../App.tsx');

describe('native incoming ring ordering', () => {
  it('validates once, presents the ring, then acknowledges ringing', () => {
    const validation = incomingService.indexOf('val verdict = validator.check(callId)');
    const postPresentation = incomingService.indexOf('handler.post {', validation);
    const ack = incomingService.indexOf('ackRinging(callId)', validation);

    expect(validation).toBeGreaterThanOrEqual(0);
    expect(postPresentation).toBeGreaterThan(validation);
    expect(ack).toBeGreaterThan(postPresentation);
  });

  it('posts the ringtone surface before the ringing ack starts', () => {
    const present = incomingService.indexOf('fun present(');
    const notification = incomingService.indexOf('startInForeground(NOTIFICATION_ID', present);
    const incomingEvent = incomingService.indexOf('VideofyCallModule.emitIncoming', present);
    const ackStart = incomingService.indexOf('ackPresentedRing(callId)', present);

    expect(notification).toBeGreaterThan(present);
    expect(incomingEvent).toBeGreaterThan(notification);
    expect(ackStart).toBeGreaterThan(incomingEvent);
  });
});

describe('native Telecom disconnect routing', () => {
  it('does not report active system hangup as decline', () => {
    expect(connectionService).toContain(
      'NativeDisconnectAction.DECLINE -> CallActionReceiver.decline(context, callId)',
    );
    expect(connectionService).toContain(
      'NativeDisconnectAction.END -> VideofyCallModule.emitEnded(callId)',
    );
    expect(connectionService).not.toContain('override fun onDisconnect() {\n    VideofyCallModule.emitDecline(callId)');
  });

  it('exposes native ended to JS and routes it through the call screen end path', () => {
    expect(nativeModule).toContain('Events("incoming", "answer", "decline", "timeout", "ended", "audioRoute")');
    expect(nativeTs).toContain("native?.addListener('ended'");
    expect(app).toContain('videofyCall.onEnded');
    expect(screen).toContain('nativeEndToken');
    expect(screen).toContain('requestDirectEnd(0)');
  });
});

describe('join failure cleanup', () => {
  it('closes native Telecom and releases the call connection when join fails', () => {
    expect(screen).toContain('const finishFailedJoin = (message: string): void => {');
    expect(screen).toContain('videofyCall.reportCallEnded(callId);');
    expect(screen).toContain('link.leave();');
  });
});
