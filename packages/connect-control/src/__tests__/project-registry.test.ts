/** @owner masterzee001 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConnectLiveCallRegistry,
  ConnectProjectRegistry,
  loadConnectProjectRegistry,
  parseConnectProjectRegistry,
  type ConnectProjectRecord,
} from '../project-registry.js';

const RAW_KEY = 'vfk_dev_0123456789abcdef0123456789abcdef';

function record(overrides: Partial<ConnectProjectRecord> = {}): ConnectProjectRecord {
  return {
    projectId: 'proj_abc123def456',
    name: 'Acme Support',
    keyHash: createHash('sha256').update(RAW_KEY, 'utf8').digest('hex'),
    allowedOrigins: ['https://support.acme.example'],
    allowOriginless: false,
    createdAt: '2026-08-18T00:00:00.000Z',
    active: true,
    ...overrides,
  };
}

function fileJson(projects: ConnectProjectRecord[]): string {
  return JSON.stringify({ version: 1, projects });
}

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('registry file loading (R12 fail-closed)', () => {
  it('an absent file yields the disabled state, not an error', () => {
    const state = loadConnectProjectRegistry(join(tmpdir(), 'nope', 'connect-projects.json'));
    expect(state.status).toBe('disabled');
    if (state.status === 'disabled') expect(state.reason).toContain('connect-projects.json');
  });

  it('a present, valid file yields an active registry', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'connect-registry-'));
    const filePath = join(tempDir, 'connect-projects.json');
    writeFileSync(filePath, fileJson([record()]), 'utf8');
    const state = loadConnectProjectRegistry(filePath);
    expect(state.status).toBe('active');
    if (state.status === 'active') {
      expect(state.registry.getProject('proj_abc123def456')?.name).toBe('Acme Support');
    }
  });

  it('malformed content throws so gateway startup fails visibly', () => {
    expect(() => parseConnectProjectRegistry('{not json', 'x.json')).toThrow(/not valid JSON/);
    expect(() => parseConnectProjectRegistry('{"version":2,"projects":[]}', 'x.json')).toThrow(
      /malformed/,
    );
    expect(() =>
      parseConnectProjectRegistry(
        JSON.stringify({ version: 1, projects: [{ projectId: 'p' }] }),
        'x.json',
      ),
    ).toThrow(/malformed/);
    expect(() =>
      parseConnectProjectRegistry(
        fileJson([record({ keyHash: 'not-a-hash' })]),
        'x.json',
      ),
    ).toThrow(/malformed/);
  });
});

describe('project authentication', () => {
  it('authenticates the raw key against its stored sha256 hash', () => {
    const registry = new ConnectProjectRegistry([record()]);
    const outcome = registry.authenticate(RAW_KEY);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.project.projectId).toBe('proj_abc123def456');
  });

  it('refuses wrong keys, empty keys, and keys without the vfk_ prefix', () => {
    const registry = new ConnectProjectRegistry([record()]);
    for (const bad of [null, '', 'vfk_dev_wrong', RAW_KEY.slice(4), `${RAW_KEY}x`]) {
      expect(registry.authenticate(bad)).toEqual({ ok: false, reason: 'invalid-key' });
    }
  });

  it('distinguishes a deactivated project from an unknown key', () => {
    const registry = new ConnectProjectRegistry([record({ active: false })]);
    expect(registry.authenticate(RAW_KEY)).toEqual({ ok: false, reason: 'inactive-project' });
  });
});

describe('origin authorization (R7)', () => {
  const registry = new ConnectProjectRegistry([record()]);
  const project = record();

  it('matches origins exactly — no wildcards, no prefixes', () => {
    expect(registry.isOriginAllowed(project, 'https://support.acme.example')).toBe(true);
    expect(registry.isOriginAllowed(project, 'https://support.acme.example.evil.io')).toBe(false);
    expect(registry.isOriginAllowed(project, 'http://support.acme.example')).toBe(false);
  });

  it('a missing origin passes only under explicit allowOriginless', () => {
    expect(registry.isOriginAllowed(project, null)).toBe(false);
    expect(registry.isOriginAllowed(record({ allowOriginless: true }), null)).toBe(true);
  });

  it('unions only ACTIVE projects into the socket CORS origin list', () => {
    const multi = new ConnectProjectRegistry([
      record(),
      record({
        projectId: 'proj_second000000',
        allowedOrigins: ['https://two.example'],
        active: false,
      }),
    ]);
    expect(multi.activeOrigins()).toEqual(['https://support.acme.example']);
  });
});

describe('live-call registry (project-scoped public↔internal map, R13 in-memory)', () => {
  function liveRecord(publicCallId: string, projectId: string) {
    return {
      publicCallId,
      internalCallId: `connect_abc123de_${publicCallId.slice(3, 15)}`,
      projectId,
      callType: 'personal' as const,
      mode: 'translated' as const,
      createdAt: '2026-08-18T00:00:00.000Z',
      ended: false,
    };
  }

  it('resolves a public id only inside its own project', () => {
    const live = new ConnectLiveCallRegistry();
    live.register(liveRecord('vc_aaaaaaaaaaaaaaaa', 'proj_one'));
    expect(live.lookup('proj_one', 'vc_aaaaaaaaaaaaaaaa')?.internalCallId).toContain('connect_');
    // Cross-project reads are indistinguishable from nonexistence.
    expect(live.lookup('proj_two', 'vc_aaaaaaaaaaaaaaaa')).toBeNull();
    expect(live.lookup('proj_one', 'vc_bbbbbbbbbbbbbbbb')).toBeNull();
  });

  it('refuses duplicate registration and marks ended in place', () => {
    const live = new ConnectLiveCallRegistry();
    const entry = liveRecord('vc_aaaaaaaaaaaaaaaa', 'proj_one');
    live.register(entry);
    expect(() => live.register(liveRecord('vc_aaaaaaaaaaaaaaaa', 'proj_one'))).toThrow(
      /already registered/,
    );
    live.markEnded('vc_aaaaaaaaaaaaaaaa');
    expect(live.lookup('proj_one', 'vc_aaaaaaaaaaaaaaaa')?.ended).toBe(true);
    expect(live.lookupByInternalId(entry.internalCallId)?.ended).toBe(true);
  });
});
