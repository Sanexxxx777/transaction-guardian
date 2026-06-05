import Fastify, { type FastifyInstance } from 'fastify';
import { createHmac } from 'crypto';
import { config } from './config/index.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('server');

let app: FastifyInstance | null = null;

export interface WebhookCallbacks {
  onWebhookEvent: (event: SafeWebhookEvent) => Promise<void>;
}

export interface SafeWebhookEvent {
  address: string;
  type: string;
  safeTxHash?: string;
  txHash?: string;
  chainId: string;
}

let webhookCallbacks: WebhookCallbacks | null = null;

export function registerWebhookCallbacks(callbacks: WebhookCallbacks): void {
  webhookCallbacks = callbacks;
}

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const hmac = createHmac('sha256', secret);
  hmac.update(payload);
  const expected = hmac.digest('hex');

  if (expected.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

export async function startServer(): Promise<void> {
  app = Fastify({
    logger: false,
  });

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, body);
    }
  );

  app.get('/health', async (_request, reply) => {
    return reply.send({ status: 'ok', version: '3.3.14' });
  });

  app.post('/webhook/safe', async (request, reply) => {
    const rawBody = request.body as string;

    if (!config.webhook.secret) {
      logger.debug('Webhook received without HMAC verification');
    }
    if (config.webhook.secret) {
      const signature = request.headers['x-webhook-signature'] as string
        || request.headers['x-safe-signature'] as string
        || '';

      if (!signature) {
        logger.warn('Webhook received without signature header');
        return reply.status(401).send({ error: 'Missing signature' });
      }

      if (!verifySignature(rawBody, signature, config.webhook.secret)) {
        logger.warn('Webhook signature verification failed');
        return reply.status(401).send({ error: 'Invalid signature' });
      }
    }

    let event: SafeWebhookEvent;
    try {
      event = JSON.parse(rawBody);
    } catch {
      logger.warn('Webhook received invalid JSON');
      return reply.status(400).send({ error: 'Invalid JSON' });
    }

    if (!event.type || !event.address) {
      logger.warn({ event }, 'Webhook missing required fields');
      return reply.status(400).send({ error: 'Missing type or address' });
    }

    logger.info(
      { type: event.type, address: event.address, safeTxHash: event.safeTxHash, chainId: event.chainId },
      'Webhook event received'
    );

    if (!webhookCallbacks) {
      logger.warn('Webhook callbacks not registered');
      return reply.status(503).send({ error: 'Not ready' });
    }

    webhookCallbacks.onWebhookEvent(event).catch(err => {
      logger.error({ error: err, type: event.type, address: event.address }, 'Webhook handler error');
    });

    return reply.status(200).send({ status: 'accepted' });
  });

  const port = config.app.port;
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'HTTP server started');
}

export async function stopServer(): Promise<void> {
  if (app) {
    await app.close();
    app = null;
    logger.info('HTTP server stopped');
  }
}
