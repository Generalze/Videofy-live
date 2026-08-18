import { describe, expect, it } from 'vitest';
import {
  CallAudioOutputController,
  detectAudioOutputCapability,
  listAudioOutputs,
  type AudioOutputElementLike,
  type MediaDeviceInfoLike,
} from './callAudioOutput';

class FakeSinkElement implements AudioOutputElementLike {
  readonly sinkIds: string[] = [];
  rejectWith: unknown = null;

  async setSinkId(sinkId: string): Promise<void> {
    if (this.rejectWith !== null) throw this.rejectWith;
    this.sinkIds.push(sinkId);
  }
}

function device(kind: string, deviceId: string, label: string): MediaDeviceInfoLike {
  return { kind, deviceId, label };
}

describe('capability detection is a matrix, not an assumption', () => {
  const setSinkId = async () => {};
  const enumerateDevices = async () => [];

  it('selectable only when BOTH setSinkId and enumerateDevices exist', () => {
    expect(
      detectAudioOutputCapability({
        mediaElementPrototype: { setSinkId },
        mediaDevices: { enumerateDevices },
      }),
    ).toEqual({ kind: 'selectable' });
  });

  it('system-only without setSinkId (Safari-shaped platform)', () => {
    expect(
      detectAudioOutputCapability({
        mediaElementPrototype: {},
        mediaDevices: { enumerateDevices },
      }),
    ).toEqual({ kind: 'system-only' });
  });

  it('system-only without enumerateDevices, even though setSinkId exists', () => {
    // An "apply" with nothing to list is pretend selection.
    expect(
      detectAudioOutputCapability({
        mediaElementPrototype: { setSinkId },
        mediaDevices: {},
      }),
    ).toEqual({ kind: 'system-only' });
  });

  it('system-only when neither surface exists', () => {
    expect(detectAudioOutputCapability({})).toEqual({ kind: 'system-only' });
  });

  it('system-only when mediaDevices is null (insecure context)', () => {
    expect(
      detectAudioOutputCapability({
        mediaElementPrototype: { setSinkId },
        mediaDevices: null,
      }),
    ).toEqual({ kind: 'system-only' });
  });

  it('a non-function setSinkId property does not count as the mechanism', () => {
    expect(
      detectAudioOutputCapability({
        mediaElementPrototype: { setSinkId: true },
        mediaDevices: { enumerateDevices },
      }),
    ).toEqual({ kind: 'system-only' });
  });

  it('defaults to system-only where there is no DOM at all', () => {
    // These suites run in node; the default deps must not throw there.
    expect(detectAudioOutputCapability()).toEqual({ kind: 'system-only' });
  });
});

describe('device listing reports what exists, nothing more', () => {
  it('filters to audiooutput and keeps id and label as given', async () => {
    const outputs = await listAudioOutputs({
      mediaDevices: {
        enumerateDevices: async () => [
          device('audioinput', 'mic-1', 'Microphone'),
          device('audiooutput', 'out-1', 'Speakers'),
          device('videoinput', 'cam-1', 'Camera'),
          device('audiooutput', 'out-2', 'Headset'),
        ],
      },
    });

    expect(outputs).toEqual([
      { deviceId: 'out-1', label: 'Speakers' },
      { deviceId: 'out-2', label: 'Headset' },
    ]);
  });

  it('surfaces pre-permission empty labels as-is', async () => {
    // The UI labels generically; inventing a name here would be a fake route.
    const outputs = await listAudioOutputs({
      mediaDevices: { enumerateDevices: async () => [device('audiooutput', 'out-1', '')] },
    });

    expect(outputs).toEqual([{ deviceId: 'out-1', label: '' }]);
  });

  it('carries ONLY deviceId and label per device', async () => {
    const outputs = await listAudioOutputs({
      mediaDevices: {
        enumerateDevices: async () => [
          { ...device('audiooutput', 'out-1', 'Speakers'), groupId: 'group-9' } as never,
        ],
      },
    });

    expect(Object.keys(outputs[0]!).sort()).toEqual(['deviceId', 'label']);
  });

  it('returns an empty list where enumeration does not exist', async () => {
    await expect(listAudioOutputs({})).resolves.toEqual([]);
    await expect(listAudioOutputs({ mediaDevices: {} })).resolves.toEqual([]);
    await expect(listAudioOutputs({ mediaDevices: null })).resolves.toEqual([]);
  });
});

describe('CallAudioOutputController applies one selection to every element', () => {
  it('routes already-registered elements when an output is selected', async () => {
    const controller = new CallAudioOutputController();
    const a = new FakeSinkElement();
    const b = new FakeSinkElement();
    controller.registerElement(a);
    controller.registerElement(b);

    await controller.setOutput('out-1');

    expect(a.sinkIds).toEqual(['out-1']);
    expect(b.sinkIds).toEqual(['out-1']);
  });

  it('routes an element registered AFTER the selection was made', () => {
    const controller = new CallAudioOutputController();
    const late = new FakeSinkElement();
    void controller.setOutput('out-1');

    controller.registerElement(late);

    expect(late.sinkIds).toEqual(['out-1']);
  });

  it('leaves a fresh element alone while the selection is system default', () => {
    const controller = new CallAudioOutputController();
    const element = new FakeSinkElement();

    controller.registerElement(element);

    expect(element.sinkIds).toEqual([]);
  });

  it('null reverts every element to the system default (empty sinkId)', async () => {
    const controller = new CallAudioOutputController();
    const element = new FakeSinkElement();
    controller.registerElement(element);
    await controller.setOutput('out-1');

    await controller.setOutput(null);

    expect(element.sinkIds).toEqual(['out-1', '']);
    expect(controller.currentSinkId()).toBeNull();
  });

  it('an unregistered element receives no further routing', async () => {
    const controller = new CallAudioOutputController();
    const element = new FakeSinkElement();
    controller.registerElement(element);
    controller.unregisterElement(element);

    await controller.setOutput('out-1');

    expect(element.sinkIds).toEqual([]);
  });

  it('holds the current selection for the picker UI', async () => {
    const controller = new CallAudioOutputController();
    expect(controller.currentSinkId()).toBeNull();

    await controller.setOutput('out-2');

    expect(controller.currentSinkId()).toBe('out-2');
  });

  it('tolerates an element without setSinkId rather than faking a route', async () => {
    const errors: unknown[] = [];
    const controller = new CallAudioOutputController({
      onError: (...args) => errors.push(args),
    });
    controller.registerElement({});

    await expect(controller.setOutput('out-1')).resolves.toBeUndefined();

    // Staying on the system default is not a failure.
    expect(errors).toEqual([]);
  });
});

describe('per-element failure is tolerated and never names the device', () => {
  it('one refusing element does not strand the others', async () => {
    const errors: [string, string | null][] = [];
    const controller = new CallAudioOutputController({
      onError: (routeLabel, errorName) => errors.push([routeLabel, errorName]),
    });
    const good = new FakeSinkElement();
    const bad = new FakeSinkElement();
    const alsoGood = new FakeSinkElement();
    bad.rejectWith = Object.assign(new Error('device out-secret-7 not found'), {
      name: 'NotFoundError',
    });
    controller.registerElement(good);
    controller.registerElement(bad);
    controller.registerElement(alsoGood);

    await controller.setOutput('out-secret-7');

    expect(good.sinkIds).toEqual(['out-secret-7']);
    expect(alsoGood.sinkIds).toEqual(['out-secret-7']);
    expect(errors).toHaveLength(1);
  });

  it('the report is the caller-provided route label plus the error NAME — no deviceId, no message', async () => {
    const reports: unknown[] = [];
    const controller = new CallAudioOutputController({
      onError: (routeLabel, errorName) => reports.push({ routeLabel, errorName }),
    });
    const element = new FakeSinkElement();
    element.rejectWith = Object.assign(new Error('Requested device out-secret-7 not found'), {
      name: 'NotFoundError',
    });
    controller.registerElement(element);

    await controller.setOutput('out-secret-7', 'headset-route');

    expect(reports).toEqual([{ routeLabel: 'headset-route', errorName: 'NotFoundError' }]);
    // The privacy rule, asserted literally: nothing reported contains the id.
    expect(JSON.stringify(reports)).not.toContain('out-secret-7');
  });

  it('falls back to stable generic labels when the caller gives none', async () => {
    const labels: string[] = [];
    const controller = new CallAudioOutputController({
      onError: (routeLabel) => labels.push(routeLabel),
    });
    const element = new FakeSinkElement();
    element.rejectWith = new Error('refused');
    controller.registerElement(element);

    await controller.setOutput('out-1');
    await controller.setOutput(null);

    expect(labels).toEqual(['selected-output', 'system-default']);
    expect(JSON.stringify(labels)).not.toContain('out-1');
  });

  it('a non-Error rejection reports a null error name, never the value', async () => {
    const reports: [string, string | null][] = [];
    const controller = new CallAudioOutputController({
      onError: (routeLabel, errorName) => reports.push([routeLabel, errorName]),
    });
    const element = new FakeSinkElement();
    element.rejectWith = 'device out-1 rejected';
    controller.registerElement(element);

    await controller.setOutput('out-1');

    expect(reports).toEqual([['selected-output', null]]);
  });

  it('a rejecting late registration reports without the deviceId as well', async () => {
    const reports: [string, string | null][] = [];
    const controller = new CallAudioOutputController({
      onError: (routeLabel, errorName) => reports.push([routeLabel, errorName]),
    });
    await controller.setOutput('out-secret-9', 'dock-route');
    const element = new FakeSinkElement();
    element.rejectWith = Object.assign(new Error('no out-secret-9 here'), { name: 'AbortError' });

    controller.registerElement(element);
    // The registration-time application settles off the synchronous path.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reports).toEqual([['dock-route', 'AbortError']]);
    expect(JSON.stringify(reports)).not.toContain('out-secret-9');
  });
});
