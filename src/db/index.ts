import { PrismaClient } from '../generated/prisma/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('db');

export let prisma = new PrismaClient({
  log: [
    { emit: 'event', level: 'query' },
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'warn' },
  ],
});

prisma.$on('query', (e: { duration: number; query: string }) => {
  if (e.duration > 100) {
    logger.warn({ duration: e.duration, query: e.query }, 'Slow query detected');
  }
});

prisma.$on('error', (e: { message: string }) => {
  logger.error({ error: e }, 'Database error');
});

let dbHealthy = true;
let healthCheckTimer: NodeJS.Timeout | null = null;
const HEALTH_CHECK_INTERVAL = 30_000;
const MAX_RECONNECT_ATTEMPTS = 10;
let reconnectAttempts = 0;

export function isDatabaseHealthy(): boolean {
  return dbHealthy;
}

export async function pingDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    if (!dbHealthy) {
      logger.info('Database connection restored');
      reconnectAttempts = 0;
    }
    dbHealthy = true;
    return true;
  } catch {
    dbHealthy = false;
    return false;
  }
}

async function reconnect(): Promise<boolean> {
  reconnectAttempts++;
  logger.warn({ attempt: reconnectAttempts }, 'Attempting database reconnect...');

  try {
    await prisma.$disconnect().catch(() => {});

    const newClient = new PrismaClient({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ],
    });

    newClient.$on('query', (e: { duration: number; query: string }) => {
      if (e.duration > 100) {
        logger.warn({ duration: e.duration, query: e.query }, 'Slow query detected');
      }
    });

    newClient.$on('error', (e: { message: string }) => {
      logger.error({ error: e }, 'Database error');
    });

    await newClient.$connect();
    await newClient.$queryRawUnsafe('SELECT 1');

    prisma = newClient;
    dbHealthy = true;
    reconnectAttempts = 0;
    logger.info('Database reconnected successfully');
    return true;
  } catch (error) {
    logger.error({ error, attempt: reconnectAttempts }, 'Database reconnect failed');
    return false;
  }
}

async function healthCheck(): Promise<void> {
  const alive = await pingDatabase();
  if (!alive) {
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      await reconnect();
    } else {
      logger.fatal(
        { attempts: reconnectAttempts },
        'Database reconnect failed after max attempts, exiting for PM2 restart'
      );
      process.exit(1);
    }
  }
}

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    dbHealthy = true;
    logger.info('Database connected');

    healthCheckTimer = setInterval(healthCheck, HEALTH_CHECK_INTERVAL);
  } catch (error) {
    logger.error({ error }, 'Failed to connect to database');
    throw error;
  }
}

export async function disconnectDatabase(): Promise<void> {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
  await prisma.$disconnect();
  logger.info('Database disconnected');
}
