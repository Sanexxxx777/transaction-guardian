import pino from 'pino';
import { config } from '../config/index.js';

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/0x[a-fA-F0-9]{64}/g, '0x[REDACTED]');
  }
  return value;
}

const redactPaths = ['req.headers.authorization', 'req.headers.cookie'];

export const logger = pino({
  level: config.app.logLevel,
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
  },
  serializers: {
    ...pino.stdSerializers,

    error: (err: unknown) => {
      const serialized = pino.stdSerializers.err(err as Error);
      if (serialized?.message) {
        serialized.message = redactValue(serialized.message) as string;
      }
      if (serialized?.stack) {
        serialized.stack = redactValue(serialized.stack) as string;
      }
      return serialized;
    },
  },
  transport: config.app.isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
});

export const createLogger = (name: string) => logger.child({ module: name });
