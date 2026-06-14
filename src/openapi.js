'use strict';

// OpenAPI 3.0 description of the public API, served as live Swagger UI at /docs
// (see app.js). Hand-written rather than generated so it stays a single source
// of truth a reviewer can read without cloning the repo. Keep it in sync with
// the routes under src/routes/.

const uuid = { type: 'string', format: 'uuid' };

const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Webhook Delivery Engine',
    version: '0.1.0',
    description:
      'A self-hostable webhook delivery engine: durable persistence, ' +
      'Stripe-style HMAC-signed deliveries, retries with exponential backoff, ' +
      'dead-lettering, and one-click replay.\n\n' +
      '**Signature verification recipe.** Each signed delivery carries ' +
      '`X-Webhook-Id`, `X-Webhook-Timestamp` (unix seconds), and ' +
      '`X-Webhook-Signature: sha256=<hex>`. The signature is ' +
      '`HMAC-SHA256(secret, timestamp + "." + raw_body)` over the **exact raw ' +
      'bytes** received — never a re-serialization. To verify: recompute the ' +
      'HMAC over `` `${timestamp}.${rawBody}` `` using your subscription secret, ' +
      'compare in constant time against the header value, and reject if the ' +
      'timestamp is outside your tolerated replay window.',
  },
  tags: [
    { name: 'subscriptions', description: 'Delivery destinations' },
    { name: 'events', description: 'Event ingestion and inspection' },
    { name: 'dead-letters', description: 'Recovery of failed deliveries' },
    { name: 'observability', description: 'Metrics and health checks' },
  ],
  paths: {
    '/api/subscriptions': {
      post: {
        tags: ['subscriptions'],
        summary: 'Register a subscription',
        description:
          'Creates a delivery destination. When `generate_secret` is true ' +
          '(default) a signing secret is generated and returned **exactly once** ' +
          'in this response — it is never exposed again.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SubscriptionCreate' },
            },
          },
        },
        responses: {
          201: {
            description: 'Created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SubscriptionWithSecret' },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
        },
      },
      get: {
        tags: ['subscriptions'],
        summary: 'List subscriptions',
        description:
          'Lists destinations newest-first. The secret is never re-exposed; ' +
          '`has_secret` indicates whether signing is enabled.',
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/Subscription' },
                },
              },
            },
          },
        },
      },
    },
    '/api/subscriptions/{id}': {
      delete: {
        tags: ['subscriptions'],
        summary: 'Delete a subscription',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: uuid },
        ],
        responses: {
          204: { description: 'Deleted' },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/events': {
      post: {
        tags: ['events'],
        summary: 'Ingest an event',
        description:
          'Durably persists the **exact request body bytes** as the payload to ' +
          'deliver, then enqueues delivery (the outbox pattern). Routing and ' +
          'idempotency metadata travel in headers so the body stays verbatim.\n\n' +
          'Returns `202` for a freshly accepted event, or `200` with the original ' +
          'event when the `Idempotency-Key` was already seen.',
        parameters: [
          {
            name: 'X-Subscription-Id',
            in: 'header',
            required: true,
            schema: uuid,
            description: 'Target subscription.',
          },
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            schema: { type: 'string' },
            description:
              'Caller-supplied dedup key. A UUID is generated when omitted ' +
              '(note: an auto-generated key does NOT dedup keyless retries).',
          },
        ],
        requestBody: {
          required: true,
          description: 'The exact payload bytes to deliver.',
          content: {
            'application/json': { schema: { type: 'object' } },
            '*/*': { schema: { type: 'string', format: 'binary' } },
          },
        },
        responses: {
          202: {
            description: 'Accepted (new event, delivery enqueued)',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Event' } },
            },
          },
          200: {
            description: 'Idempotency-key conflict (original event returned)',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Event' } },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
      get: {
        tags: ['events'],
        summary: 'List recent events',
        description:
          'Recent events newest-first, each with its delivery-attempt timeline. ' +
          'Events currently `dead` carry the `dead_letter_id` of their most ' +
          'recent unreplayed dead-letter row, for one-click replay.',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        ],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/EventWithAttempts' },
                },
              },
            },
          },
        },
      },
    },
    '/api/events/{id}': {
      get: {
        tags: ['events'],
        summary: 'Get an event and its attempt timeline',
        parameters: [{ name: 'id', in: 'path', required: true, schema: uuid }],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EventWithAttempts' },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/events/{id}/signature': {
      get: {
        tags: ['events'],
        summary: "Compute the event's expected signature",
        description:
          'Returns the signing headers a receiver should expect for this event, ' +
          'computed from the stored secret over the exact raw body. The timestamp ' +
          '(and thus the signature) is freshly computed per call — a verification ' +
          'sample, not a record of a past delivery. `signed:false` when the ' +
          'subscription has no secret.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: uuid }],
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Signature' } },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/api/dead-letters/{id}/replay': {
      post: {
        tags: ['dead-letters'],
        summary: 'Replay a dead-lettered event',
        description:
          'Recovers a dead-lettered event by flipping it back to `pending` and ' +
          're-enqueuing it, reusing the existing event row so the idempotency key ' +
          'and attempt history are preserved. Safe to trigger twice: a repeat call ' +
          'finds the event no longer `dead` and returns `409`.',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: uuid,
            description: 'The dead_letter row id (not the event id).',
          },
        ],
        responses: {
          200: {
            description: 'Replay accepted',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { event_id: uuid, status: { type: 'string', example: 'pending' } },
                },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          404: { $ref: '#/components/responses/NotFound' },
          409: {
            description: 'Event is not currently dead; replay not allowed',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Error' } },
            },
          },
        },
      },
    },
    '/metrics': {
      get: {
        tags: ['observability'],
        summary: 'Queue depth and event counts by status',
        description:
          'Queue depth from Redis and event counts by status from Postgres. ' +
          'Results are cached ~10s so a left-open dashboard does not hammer the ' +
          'datastores.',
        responses: {
          200: {
            description: 'OK',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Metrics' } },
            },
          },
        },
      },
    },
    '/health': {
      get: {
        tags: ['observability'],
        summary: 'Shallow liveness check',
        description:
          'Returns 200 + process uptime only. Deliberately touches NEITHER ' +
          'Postgres NOR Redis so an uptime monitor can keep the instance awake ' +
          'without keeping the metered database awake.',
        responses: {
          200: {
            description: 'Alive',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    uptime: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/health/ready': {
      get: {
        tags: ['observability'],
        summary: 'Deep readiness check',
        description: 'On-demand check of Postgres and Redis connectivity.',
        responses: {
          200: {
            description: 'Ready',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Readiness' } },
            },
          },
          503: {
            description: 'Not ready (a dependency is down)',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Readiness' } },
            },
          },
        },
      },
    },
  },
  components: {
    responses: {
      BadRequest: {
        description: 'Invalid request',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      NotFound: {
        description: 'Resource not found',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              details: { description: 'Optional structured detail' },
            },
          },
        },
      },
      SubscriptionCreate: {
        type: 'object',
        required: ['target_url'],
        properties: {
          target_url: { type: 'string', format: 'uri', example: 'https://example.com/hook' },
          description: { type: 'string', maxLength: 1000 },
          generate_secret: { type: 'boolean', default: true },
        },
      },
      Subscription: {
        type: 'object',
        properties: {
          id: uuid,
          target_url: { type: 'string', format: 'uri' },
          description: { type: 'string', nullable: true },
          has_secret: { type: 'boolean' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      SubscriptionWithSecret: {
        type: 'object',
        properties: {
          id: uuid,
          target_url: { type: 'string', format: 'uri' },
          description: { type: 'string', nullable: true },
          secret: {
            type: 'string',
            nullable: true,
            description: 'Returned exactly once. Null when generate_secret was false.',
          },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      Event: {
        type: 'object',
        properties: {
          id: uuid,
          subscription_id: uuid,
          idempotency_key: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'delivering', 'delivered', 'failed', 'dead'],
          },
          payload: { type: 'string', description: 'raw_body rendered as UTF-8', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
      DeliveryAttempt: {
        type: 'object',
        properties: {
          attempt_number: { type: 'integer' },
          status_code: { type: 'integer', nullable: true },
          duration_ms: { type: 'integer', nullable: true },
          response_body: { type: 'string', nullable: true },
          error: { type: 'string', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      EventWithAttempts: {
        allOf: [
          { $ref: '#/components/schemas/Event' },
          {
            type: 'object',
            properties: {
              attempts: {
                type: 'array',
                items: { $ref: '#/components/schemas/DeliveryAttempt' },
              },
              dead_letter_id: {
                ...uuid,
                nullable: true,
                description: 'Present (list endpoint) when the event is replayable.',
              },
            },
          },
        ],
      },
      Signature: {
        type: 'object',
        properties: {
          event_id: uuid,
          signed: { type: 'boolean' },
          header: { type: 'string', example: 'x-webhook-signature' },
          timestamp: { type: 'string', example: '1718513400' },
          signature: { type: 'string', example: 'sha256=...' },
        },
      },
      Metrics: {
        type: 'object',
        properties: {
          queue: {
            type: 'object',
            properties: {
              waiting: { type: 'integer' },
              active: { type: 'integer' },
              delayed: { type: 'integer' },
              failed: { type: 'integer' },
              paused: { type: 'integer' },
              depth: { type: 'integer', description: 'waiting + active + delayed' },
            },
          },
          events: {
            type: 'object',
            properties: {
              pending: { type: 'integer' },
              delivering: { type: 'integer' },
              delivered: { type: 'integer' },
              failed: { type: 'integer' },
              dead: { type: 'integer' },
              total: { type: 'integer' },
            },
          },
          generated_at: { type: 'string', format: 'date-time' },
          cached: { type: 'boolean' },
        },
      },
      Readiness: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'ready' },
          checks: {
            type: 'object',
            properties: {
              postgres: { type: 'boolean' },
              redis: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
};

module.exports = openapiSpec;
