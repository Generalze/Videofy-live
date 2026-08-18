/** @owner masterzee001 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildConnectOpenApiDocument } from '../index.js';

const openapiPath = fileURLToPath(new URL('../../openapi.json', import.meta.url));

function loadCommitted(): Record<string, unknown> {
  return JSON.parse(readFileSync(openapiPath, 'utf8')) as Record<string, unknown>;
}

describe('openapi.json drift', () => {
  it('matches the schemas exactly (regenerate with `npm run generate:openapi`)', () => {
    const committed = loadCommitted();
    const regenerated = JSON.parse(JSON.stringify(buildConnectOpenApiDocument())) as Record<
      string,
      unknown
    >;
    expect(committed).toEqual(regenerated);
  });
});

describe('document shape', () => {
  const document = buildConnectOpenApiDocument() as unknown as {
    paths: Record<string, Record<string, { parameters?: Array<{ $ref?: string }>; responses: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }> }>>;
    components: Record<string, Record<string, unknown>>;
  };

  it('covers exactly the six /v1 paths', () => {
    expect(Object.keys(document.paths).sort()).toEqual([
      '/v1/calls',
      '/v1/calls/{callId}',
      '/v1/calls/{callId}/end',
      '/v1/calls/{callId}/join-tokens',
      '/v1/calls/{callId}/state',
      '/v1/capabilities',
    ]);
  });

  it('gives every operation a default error response using the shared envelope', () => {
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const fallback = operation.responses['default'];
        expect(fallback, `${method.toUpperCase()} ${path} lacks a default error response`).toBeDefined();
        const schemaRef = fallback?.content?.['application/json']?.schema?.$ref;
        expect(schemaRef, `${method.toUpperCase()} ${path} error response`).toBe(
          '#/components/schemas/ErrorEnvelope',
        );
      }
    }
  });

  it('declares the Idempotency-Key parameter on every POST and only there', () => {
    const idempotencyRef = '#/components/parameters/IdempotencyKey';
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const refs = (operation.parameters ?? []).map((parameter) => parameter.$ref);
        if (method === 'post') {
          expect(refs, `POST ${path}`).toContain(idempotencyRef);
        } else {
          expect(refs, `${method.toUpperCase()} ${path}`).not.toContain(idempotencyRef);
        }
      }
    }
  });

  it('publishes the TTL ceiling of 900 on the join-token request schema', () => {
    const schemas = document.components['schemas'] as Record<
      string,
      { properties?: Record<string, Record<string, unknown>> }
    >;
    const joinTokenRequest = schemas['JoinTokenRequest'];
    expect(joinTokenRequest).toBeDefined();
    const ttl = joinTokenRequest?.properties?.['expiresInSeconds'];
    expect(ttl?.['maximum']).toBe(900);
    expect(ttl?.['minimum']).toBe(1);
    expect(ttl?.['type']).toBe('integer');
  });

  it('publishes the metadata byte cap in the create-call request schema', () => {
    const schemas = document.components['schemas'] as Record<
      string,
      { properties?: Record<string, Record<string, unknown>> }
    >;
    const metadata = schemas['CreateCallRequest']?.properties?.['metadata'];
    expect(metadata?.['type']).toBe('object');
    expect(String(metadata?.['description'])).toContain('1024');
  });

  it('locks strict objects into the document: no silent surface growth', () => {
    const schemas = document.components['schemas'] as Record<string, Record<string, unknown>>;
    for (const name of [
      'CreateCallRequest',
      'CallResource',
      'CallState',
      'JoinTokenRequest',
      'JoinTokenResponse',
      'UpdateCallModeRequest',
      'CapabilitiesResponse',
      'ErrorEnvelope',
    ]) {
      const schema = schemas[name];
      expect(schema, `components.schemas.${name}`).toBeDefined();
      expect(schema?.['additionalProperties'], `components.schemas.${name}`).toBe(false);
    }
  });

  it('authenticates with a bearer project key', () => {
    const securitySchemes = document.components['securitySchemes'] as Record<
      string,
      { type?: string; scheme?: string }
    >;
    expect(securitySchemes['projectKey']?.type).toBe('http');
    expect(securitySchemes['projectKey']?.scheme).toBe('bearer');
  });
});
