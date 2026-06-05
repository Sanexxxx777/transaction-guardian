import { createLogger } from '../utils/logger.js';
import { redis, isRedisAvailable } from '../db/redis.js';
import { config } from '../config/index.js';

const logger = createLogger('monitoring-control');

const MONITORING_MODE_KEY = 'monitoring:mode';
const MONITORING_LAST_ACTIVITY_KEY = 'monitoring:last_activity';

const LEGACY_STATE_KEY = 'monitoring:active';

export type MonitoringMode = 'off' | 'standby' | 'active';

type StartFn = () => Promise<void>;
type StopFn = () => void;
type ModeChangeFn = (newMode: MonitoringMode, intervalMs: number) => void;
type AutoSwitchFn = (from: MonitoringMode, to: MonitoringMode) => void;

let mode: MonitoringMode = 'off';
let startFn: StartFn | null = null;
let stopFn: StopFn | null = null;
let modeChangeFn: ModeChangeFn | null = null;
let autoSwitchFn: AutoSwitchFn | null = null;
let inactivityTimer: NodeJS.Timeout | null = null;
let lastActivityTs = 0;

function getInactivityMs(): number {
  return config.polling.smartPollingInactivityMinutes * 60 * 1000;
}

function getIntervalForMode(m: MonitoringMode): number {
  const webhookMode = config.webhook.enabled;
  if (m === 'active') {
    return webhookMode ? Math.max(config.polling.safeActiveIntervalMs, 60_000) : config.polling.safeActiveIntervalMs;
  }
  return webhookMode ? Math.max(config.polling.safeStandbyIntervalMs, 1_800_000) : config.polling.safeStandbyIntervalMs;
}

function clearInactivityTimer(): void {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
}

function startInactivityTimer(): void {
  clearInactivityTimer();
  inactivityTimer = setTimeout(async () => {
    if (mode === 'active') {
      logger.info(
        { inactivityMinutes: config.polling.smartPollingInactivityMinutes },
        'No activity — auto-switching to standby'
      );
      const prevMode = mode;
      await monitoringControl.setMode('standby');
      autoSwitchFn?.(prevMode, 'standby');
    }
  }, getInactivityMs());
}

async function persistMode(m: MonitoringMode): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    await redis.set(MONITORING_MODE_KEY, m);

    await redis.del(LEGACY_STATE_KEY);
  } catch {}
}

async function persistLastActivity(ts: number): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    await redis.set(MONITORING_LAST_ACTIVITY_KEY, String(ts));
  } catch {}
}

export const monitoringControl = {
  register(
    start: StartFn,
    stop: StopFn,
    onModeChange?: ModeChangeFn,
    onAutoSwitch?: AutoSwitchFn
  ): void {
    startFn = start;
    stopFn = stop;
    modeChangeFn = onModeChange ?? null;
    autoSwitchFn = onAutoSwitch ?? null;
  },

  async restoreState(): Promise<void> {
    if (config.manualModeOnly) {
      logger.info('MANUAL_MODE_ONLY=true — skipping monitoring state restore (mode forced to off)');
      mode = 'off';
      await persistMode('off');
      return;
    }
    if (!isRedisAvailable()) return;
    try {
      let savedMode = await redis.get(MONITORING_MODE_KEY);

      if (!savedMode) {
        const legacyState = await redis.get(LEGACY_STATE_KEY);
        if (legacyState === '1') {
          savedMode = 'standby';
          logger.info('Migrated legacy monitoring:active=1 → mode=standby');
        }
      }

      if (savedMode === 'standby' || savedMode === 'active') {
        if (savedMode === 'active') {
          const lastActivityStr = await redis.get(MONITORING_LAST_ACTIVITY_KEY);
          const lastActivity = lastActivityStr ? Number(lastActivityStr) : 0;
          const staleMs = getInactivityMs();
          if (Date.now() - lastActivity > staleMs) {
            logger.info(
              { lastActivity: lastActivity ? new Date(lastActivity).toISOString() : 'never', staleMinutes: config.polling.smartPollingInactivityMinutes },
              'Restoring monitoring: was active but stale → standby'
            );
            savedMode = 'standby';
          }
        }

        logger.info({ mode: savedMode }, 'Restoring monitoring state');
        await this.setMode(savedMode as MonitoringMode);
      }
    } catch (error) {
      logger.error({ error }, 'Failed to restore monitoring state');
    }
  },

  async setMode(newMode: MonitoringMode): Promise<void> {
    if (config.manualModeOnly && newMode !== 'off') {
      logger.warn({ requested: newMode }, 'MANUAL_MODE_ONLY=true — ignoring request to enable polling');
      if (mode !== 'off') {
        clearInactivityTimer();
        if (stopFn) stopFn();
        mode = 'off';
        await persistMode('off');
      }
      return;
    }

    const prevMode = mode;
    if (prevMode === newMode) return;

    logger.info({ from: prevMode, to: newMode, intervalMs: getIntervalForMode(newMode) }, 'Monitoring mode change');

    if (newMode === 'off') {
      clearInactivityTimer();
      if (stopFn && prevMode !== 'off') stopFn();
      mode = 'off';
      await persistMode('off');
      return;
    }

    if (prevMode === 'off') {
      if (!startFn) {
        logger.error('Monitoring start function not registered');
        return;
      }
      mode = newMode;
      await persistMode(newMode);
      modeChangeFn?.(newMode, getIntervalForMode(newMode));
      await startFn();
    } else {
      mode = newMode;
      await persistMode(newMode);
      modeChangeFn?.(newMode, getIntervalForMode(newMode));
    }

    if (newMode === 'active') {
      startInactivityTimer();
    } else {
      clearInactivityTimer();
    }
  },

  async recordActivity(): Promise<void> {
    lastActivityTs = Date.now();
    await persistLastActivity(lastActivityTs);

    if (mode === 'standby') {
      logger.info('Pending tx detected — switching to active mode');
      const prevMode = mode;
      await this.setMode('active');
      autoSwitchFn?.(prevMode, 'active');
    } else if (mode === 'active') {
      startInactivityTimer();
    }
  },

  getMode(): MonitoringMode {
    return mode;
  },

  isActive(): boolean {
    return mode !== 'off';
  },

  getIntervalMs(): number {
    return getIntervalForMode(mode);
  },

  async start(): Promise<void> {
    await this.setMode('standby');
  },

  stop(): void {
    this.setMode('off').catch(() => {});
  },
};
