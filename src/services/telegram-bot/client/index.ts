import { Bot } from 'grammy';
import type { BotContext } from '../index.js';
import { setupHistoryHandler } from './history.js';
import { setupWalletsHandler } from './wallets.js';
import { setupPolicyHandler } from './policy.js';

export function setupClientHandlers(bot: Bot<BotContext>): void {
  setupHistoryHandler(bot);
  setupWalletsHandler(bot);
  setupPolicyHandler(bot);
}
