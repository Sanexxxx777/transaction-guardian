import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  TENDERLY_ACCOUNT_SLUG: z.string().optional(),
  TENDERLY_PROJECT_SLUG: z.string().optional(),
  TENDERLY_ACCESS_KEY: z.string().optional(),

  TELEGRAM_BOT_TOKEN: z.string(),
  TELEGRAM_ADMIN_USER_ID: z.coerce.number().optional(),

  COINGECKO_API_KEY: z.string().optional(),

  GEMINI_API_KEY: z.string().optional(),

  ETHERSCAN_API_KEY: z.string().optional(),

  SAFE_API_KEY: z.string().optional(),

  SAFE_WEBHOOK_SECRET: z.string().optional(),
  WEBHOOK_ENABLED: z.string().default('true').transform(v => v === 'true' || v === '1'),

  SENTRY_DSN: z.string().optional(),

  REGISTRATION_OPEN: z.string().optional(),

  MANUAL_MODE_ONLY: z.string().default('false').transform(v => v === 'true' || v === '1'),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  SAFE_POLLING_INTERVAL_MS: z.coerce.number().default(600000),
  SAFE_STANDBY_INTERVAL_MS: z.coerce.number().default(600000),
  SAFE_ACTIVE_INTERVAL_MS: z.coerce.number().default(10000),
  SMART_POLLING_INACTIVITY_MINUTES: z.coerce.number().default(30),
  EOA_POLLING_INTERVAL_MS: z.coerce.number().default(15000),

  EOA_INCOMING_MIN_VALUE_WEI: z.string().default('0'),
  PRICE_CACHE_TTL_SECONDS: z.coerce.number().default(60),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  database: {
    url: parsed.data.DATABASE_URL,
  },
  redis: {
    url: parsed.data.REDIS_URL,
  },
  tenderly: {
    accountSlug: parsed.data.TENDERLY_ACCOUNT_SLUG,
    projectSlug: parsed.data.TENDERLY_PROJECT_SLUG,
    accessKey: parsed.data.TENDERLY_ACCESS_KEY,
    isConfigured: Boolean(
      parsed.data.TENDERLY_ACCOUNT_SLUG &&
      parsed.data.TENDERLY_PROJECT_SLUG &&
      parsed.data.TENDERLY_ACCESS_KEY
    ),
  },
  telegram: {
    botToken: parsed.data.TELEGRAM_BOT_TOKEN,
    adminUserId: parsed.data.TELEGRAM_ADMIN_USER_ID,
  },
  coingecko: {
    apiKey: parsed.data.COINGECKO_API_KEY,
  },
  ai: {
    geminiApiKey: parsed.data.GEMINI_API_KEY,
    isConfigured: Boolean(parsed.data.GEMINI_API_KEY),
  },
  sentry: {
    dsn: parsed.data.SENTRY_DSN,
  },
  app: {
    env: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
    isDev: parsed.data.NODE_ENV === 'development',
    isProd: parsed.data.NODE_ENV === 'production',
  },
  etherscan: {
    apiKey: parsed.data.ETHERSCAN_API_KEY,
    isConfigured: Boolean(parsed.data.ETHERSCAN_API_KEY),
  },
  safe: {
    apiKey: parsed.data.SAFE_API_KEY,
    isConfigured: Boolean(parsed.data.SAFE_API_KEY),
  },
  webhook: {
    secret: parsed.data.SAFE_WEBHOOK_SECRET,
    enabled: parsed.data.WEBHOOK_ENABLED,
    isConfigured: Boolean(parsed.data.SAFE_WEBHOOK_SECRET && parsed.data.WEBHOOK_ENABLED),
  },
  manualModeOnly: parsed.data.MANUAL_MODE_ONLY,
  polling: {
    safeIntervalMs: parsed.data.SAFE_POLLING_INTERVAL_MS,
    safeStandbyIntervalMs: parsed.data.SAFE_STANDBY_INTERVAL_MS,
    safeActiveIntervalMs: parsed.data.SAFE_ACTIVE_INTERVAL_MS,
    smartPollingInactivityMinutes: parsed.data.SMART_POLLING_INACTIVITY_MINUTES,
    eoaIntervalMs: parsed.data.EOA_POLLING_INTERVAL_MS,
    eoaIncomingMinValueWei: parsed.data.EOA_INCOMING_MIN_VALUE_WEI,
    priceCacheTtlSeconds: parsed.data.PRICE_CACHE_TTL_SECONDS,
  },
} as const;

export type Config = typeof config;
