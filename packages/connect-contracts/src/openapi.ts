/** @author masterzee001 */
/**
 * OpenAPI 3.1 document, generated from the zod schemas in this package.
 *
 * Hand-built rather than via a generator dependency: this package must stay
 * dependency-light (both public SDKs bundle it) and the workspace lockfile is
 * not this package's to change. The converter therefore supports EXACTLY the
 * zod constructs this contract uses and throws on anything else — adding a new
 * construct forces a deliberate decision here rather than a silent gap in the
 * document — and the committed openapi.json is drift-tested against this
 * builder.
 */
import { z } from 'zod';
import {
  CallResourceSchema,
  CallStateResponseSchema,
  CapabilitiesResponseSchema,
  CreateCallRequestSchema,
  IDEMPOTENCY_KEY_HEADER,
  JoinTokenRequestSchema,
  JoinTokenResponseSchema,
  REQUEST_ID_HEADER,
  UpdateCallModeRequestSchema,
} from './api-v1.js';
import { ErrorEnvelopeSchema } from './error-codes.js';
import { PublicCallIdSchema } from './identifiers.js';

export type OpenApiSchemaObject = { [key: string]: unknown };

export interface ConnectOpenApiDocument {
  openapi: string;
  info: OpenApiSchemaObject;
  servers: OpenApiSchemaObject[];
  security: OpenApiSchemaObject[];
  paths: OpenApiSchemaObject;
  components: OpenApiSchemaObject;
}

interface ZodDefLike {
  typeName: z.ZodFirstPartyTypeKind;
  description?: string;
  [key: string]: unknown;
}

/**
 * Convert one of this package's zod schemas to a JSON Schema fragment.
 * Supports only the closed construct set the contract uses; anything else is
 * an error by design, never a silent omission.
 */
export function openApiSchemaFromZod(schema: z.ZodTypeAny): OpenApiSchemaObject {
  const def = schema._def as ZodDefLike;
  const described = (body: OpenApiSchemaObject): OpenApiSchemaObject =>
    def.description === undefined ? body : { ...body, description: def.description };
  const unwrapped = (inner: z.ZodTypeAny, extra?: OpenApiSchemaObject): OpenApiSchemaObject =>
    described({ ...openApiSchemaFromZod(inner), ...extra });

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodString: {
      const out: OpenApiSchemaObject = { type: 'string' };
      const checks = (def.checks ?? []) as Array<{ kind: string; value?: unknown; regex?: RegExp }>;
      for (const check of checks) {
        if (check.kind === 'min') out.minLength = check.value;
        else if (check.kind === 'max') out.maxLength = check.value;
        else if (check.kind === 'regex' && check.regex) out.pattern = check.regex.source;
        else if (check.kind === 'datetime') out.format = 'date-time';
        // 'trim' is input normalisation; the wire document has nothing to say.
      }
      return described(out);
    }
    case z.ZodFirstPartyTypeKind.ZodNumber: {
      const out: OpenApiSchemaObject = { type: 'number' };
      const checks = (def.checks ?? []) as Array<{ kind: string; value?: number; inclusive?: boolean }>;
      for (const check of checks) {
        if (check.kind === 'int') out.type = 'integer';
        else if (check.kind === 'min') {
          if (check.inclusive) out.minimum = check.value;
          else out.exclusiveMinimum = check.value;
        } else if (check.kind === 'max') {
          if (check.inclusive) out.maximum = check.value;
          else out.exclusiveMaximum = check.value;
        }
      }
      return described(out);
    }
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return described({ type: 'boolean' });
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return described({ const: def.value });
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return described({ type: 'string', enum: [...(def.values as readonly string[])] });
    case z.ZodFirstPartyTypeKind.ZodUnion: {
      const options = def.options as readonly z.ZodTypeAny[];
      return described({ anyOf: options.map((option) => openApiSchemaFromZod(option)) });
    }
    case z.ZodFirstPartyTypeKind.ZodArray: {
      const out: OpenApiSchemaObject = {
        type: 'array',
        items: openApiSchemaFromZod(def.type as z.ZodTypeAny),
      };
      const minLength = def.minLength as { value: number } | null;
      const maxLength = def.maxLength as { value: number } | null;
      if (minLength) out.minItems = minLength.value;
      if (maxLength) out.maxItems = maxLength.value;
      return described(out);
    }
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = (def.shape as () => Record<string, z.ZodTypeAny>)();
      const properties: OpenApiSchemaObject = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = openApiSchemaFromZod(value);
        if (!value.isOptional()) required.push(key);
      }
      const out: OpenApiSchemaObject = {
        type: 'object',
        properties,
        additionalProperties: def.unknownKeys !== 'strict',
      };
      if (required.length > 0) out.required = required;
      return described(out);
    }
    case z.ZodFirstPartyTypeKind.ZodRecord: {
      const valueType = def.valueType as z.ZodTypeAny;
      const valueDef = valueType._def as ZodDefLike;
      const additionalProperties =
        valueDef.typeName === z.ZodFirstPartyTypeKind.ZodUnknown
          ? true
          : openApiSchemaFromZod(valueType);
      return described({ type: 'object', additionalProperties });
    }
    case z.ZodFirstPartyTypeKind.ZodUnknown:
      return described({});
    case z.ZodFirstPartyTypeKind.ZodOptional:
      return unwrapped(def.innerType as z.ZodTypeAny);
    case z.ZodFirstPartyTypeKind.ZodDefault:
      return unwrapped(def.innerType as z.ZodTypeAny, {
        default: (def.defaultValue as () => unknown)(),
      });
    case z.ZodFirstPartyTypeKind.ZodBranded:
      return unwrapped(def.type as z.ZodTypeAny);
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return unwrapped(def.schema as z.ZodTypeAny);
    case z.ZodFirstPartyTypeKind.ZodReadonly:
      return unwrapped(def.innerType as z.ZodTypeAny);
    default:
      throw new Error(`Unsupported zod construct for OpenAPI generation: ${def.typeName}`);
  }
}

const SCHEMA_REF_PREFIX = '#/components/schemas/';

function schemaRef(name: string): OpenApiSchemaObject {
  return { $ref: `${SCHEMA_REF_PREFIX}${name}` };
}

function paramRef(name: string): OpenApiSchemaObject {
  return { $ref: `#/components/parameters/${name}` };
}

function jsonContent(schemaName: string): OpenApiSchemaObject {
  return { 'application/json': { schema: schemaRef(schemaName) } };
}

function requestIdHeaderRef(): OpenApiSchemaObject {
  return { [REQUEST_ID_HEADER]: { $ref: '#/components/headers/XRequestId' } };
}

function successResponse(description: string, schemaName: string): OpenApiSchemaObject {
  return {
    description,
    headers: requestIdHeaderRef(),
    content: jsonContent(schemaName),
  };
}

function defaultErrorResponse(): OpenApiSchemaObject {
  return {
    description:
      'Error envelope; retryable is derived from the code classification and the two never disagree.',
    headers: requestIdHeaderRef(),
    content: jsonContent('ErrorEnvelope'),
  };
}

export function buildConnectOpenApiDocument(): ConnectOpenApiDocument {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Videofy Connect API',
      version: '1.0.0',
      description:
        'Public control plane for Videofy Connect v1. Authentication is a project API key ' +
        'presented as a Bearer token; join tokens minted here are opaque, single-use ' +
        'credentials the partner hands to the client SDK. Live calls and outstanding join ' +
        'tokens are process-bound: a gateway restart voids them, and the client SDK reports ' +
        'needsNewJoinToken when a fresh one must be minted. Every response carries an ' +
        `${REQUEST_ID_HEADER} header for correlation.`,
    },
    servers: [
      {
        url: '/',
        description: 'Paths are gateway-relative; /v1 is served by the gateway process.',
      },
    ],
    security: [{ projectKey: [] }],
    paths: {
      '/v1/calls': {
        post: {
          operationId: 'createCall',
          summary: 'Create a call',
          parameters: [paramRef('RequestId'), paramRef('IdempotencyKey')],
          requestBody: { required: true, content: jsonContent('CreateCallRequest') },
          responses: {
            '201': successResponse('Call created.', 'CallResource'),
            default: defaultErrorResponse(),
          },
        },
      },
      '/v1/calls/{callId}': {
        get: {
          operationId: 'getCall',
          summary: 'Fetch a call',
          parameters: [paramRef('CallId'), paramRef('RequestId')],
          responses: {
            '200': successResponse('The call.', 'CallResource'),
            default: defaultErrorResponse(),
          },
        },
        patch: {
          operationId: 'updateCallMode',
          summary: 'Change call mode (project authority)',
          parameters: [paramRef('CallId'), paramRef('RequestId')],
          requestBody: { required: true, content: jsonContent('UpdateCallModeRequest') },
          responses: {
            '200': successResponse('Mode changed.', 'CallResource'),
            default: defaultErrorResponse(),
          },
        },
      },
      '/v1/calls/{callId}/state': {
        get: {
          operationId: 'getCallState',
          summary: 'Fetch live participant state',
          parameters: [paramRef('CallId'), paramRef('RequestId')],
          responses: {
            '200': successResponse('Current participant state.', 'CallState'),
            default: defaultErrorResponse(),
          },
        },
      },
      '/v1/calls/{callId}/join-tokens': {
        post: {
          operationId: 'createJoinToken',
          summary: 'Mint a single-use join token',
          description:
            'Tokens are single-use with first-claim-wins semantics, default lifetime 300 ' +
            'seconds and hard maximum 900. A token burned by a failed join is replaced by ' +
            'minting a fresh one, never retried.',
          parameters: [paramRef('CallId'), paramRef('RequestId'), paramRef('IdempotencyKey')],
          requestBody: { required: true, content: jsonContent('JoinTokenRequest') },
          responses: {
            '201': successResponse('Token minted.', 'JoinTokenResponse'),
            default: defaultErrorResponse(),
          },
        },
      },
      '/v1/calls/{callId}/end': {
        post: {
          operationId: 'endCall',
          summary: 'End a call (project authority)',
          parameters: [paramRef('CallId'), paramRef('RequestId'), paramRef('IdempotencyKey')],
          responses: {
            '200': successResponse('Call ended.', 'CallResource'),
            default: defaultErrorResponse(),
          },
        },
      },
      '/v1/capabilities': {
        get: {
          operationId: 'getCapabilities',
          summary: 'Discover platform capabilities',
          description:
            'Additive-only: fields are never removed or renamed within v1, and no provider, ' +
            'model, or internal detail ever appears here.',
          parameters: [paramRef('RequestId')],
          responses: {
            '200': successResponse('Capability document.', 'CapabilitiesResponse'),
            default: defaultErrorResponse(),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        projectKey: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Project API key (vfk_...) sent as a Bearer token. Server-side only; it must never reach a browser.',
        },
      },
      headers: {
        XRequestId: {
          description:
            'Correlation id; echoes the inbound request id when one was sent, otherwise server-generated.',
          schema: { type: 'string' },
        },
      },
      parameters: {
        CallId: {
          name: 'callId',
          in: 'path',
          required: true,
          schema: openApiSchemaFromZod(PublicCallIdSchema),
        },
        RequestId: {
          name: REQUEST_ID_HEADER,
          in: 'header',
          required: false,
          schema: { type: 'string' },
          description: 'Optional caller correlation id, echoed on the response.',
        },
        IdempotencyKey: {
          name: IDEMPOTENCY_KEY_HEADER,
          in: 'header',
          required: false,
          schema: { type: 'string' },
          description:
            'Replay guard for POSTs: the same key with the same body returns the stored ' +
            'outcome; the same key with a different body is refused as IDEMPOTENCY_CONFLICT.',
        },
      },
      schemas: {
        CreateCallRequest: openApiSchemaFromZod(CreateCallRequestSchema),
        CallResource: openApiSchemaFromZod(CallResourceSchema),
        CallState: openApiSchemaFromZod(CallStateResponseSchema),
        JoinTokenRequest: openApiSchemaFromZod(JoinTokenRequestSchema),
        JoinTokenResponse: openApiSchemaFromZod(JoinTokenResponseSchema),
        UpdateCallModeRequest: openApiSchemaFromZod(UpdateCallModeRequestSchema),
        CapabilitiesResponse: openApiSchemaFromZod(CapabilitiesResponseSchema),
        ErrorEnvelope: openApiSchemaFromZod(ErrorEnvelopeSchema),
      },
    },
  };
}
