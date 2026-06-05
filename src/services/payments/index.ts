import { Bot } from 'grammy';
import type { BotContext } from '../telegram-bot/index.js';

export function setupPaymentHandlers(_bot: Bot<BotContext>): void {
}

export async function checkExpiredSubscriptions(): Promise<void> {
}
