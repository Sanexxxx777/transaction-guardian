import { z } from 'zod';

export const ethereumAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Неверный формат адреса Ethereum');

export const clientNameSchema = z
  .string()
  .min(1, 'Имя не может быть пустым')
  .max(100, 'Имя слишком длинное (макс. 100 символов)')
  .regex(/^[a-zA-Zа-яА-ЯёЁ0-9\s\-_\.]+$/, 'Имя содержит недопустимые символы');

export const chatIdSchema = z
  .string()
  .regex(/^-?\d+$/, 'Chat ID должен быть числом')
  .transform(Number);

export const chainIdSchema = z.coerce
  .number()
  .int()
  .positive('Chain ID должен быть положительным');

export function validate<T>(schema: z.ZodSchema<T>, value: unknown): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(value);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error.issues[0]?.message || 'Невалидные данные' };
}
