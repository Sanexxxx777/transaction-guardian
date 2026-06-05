import type { PolicyViolation, PolicyCheckInput } from '../../../models/policy.js';
import { addressEquals } from '../../../utils/address.js';
import { isAddressWhitelisted, isSafeWallet, isProtocolWhitelisted } from '../whitelist.js';
import { isERC20Method, decodeERC20 } from '../../calldata-decoder/index.js';

export async function checkRecipient(
  input: PolicyCheckInput
): Promise<PolicyViolation[]> {
  const violations: PolicyViolation[] = [];
  const { transaction, effectiveWhitelists, detectedRecipient } = input;

  if (transaction.data && isERC20Method(transaction.data)) {
    const decoded = decodeERC20(transaction.data);
    if (decoded && decoded.method === 'approve') {
      return violations;
    }
  }

  if (!detectedRecipient) {
    if (input.detectedProtocol) {
      return violations;
    }

    if (transaction.data && transaction.data !== '0x') {
      const protocolCheck = isProtocolWhitelisted(transaction.to, transaction.chainId, effectiveWhitelists);
      if (!protocolCheck.whitelisted) {
        violations.push({
          ruleId: 'RECIPIENT_UNKNOWN',
          severity: 'warning',
          title: 'Не удалось определить получателя',
          description: 'Проверьте транзакцию вручную',
          details: {
            method: input.decodedMethod || 'unknown',
          },
        });
      }
    }
    return violations;
  }

  if (addressEquals(detectedRecipient, transaction.from)) {
    return violations;
  }

  if (typeof detectedRecipient !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(detectedRecipient)) {
    violations.push({
      ruleId: 'RECIPIENT_INVALID',
      severity: 'warning',
      title: 'Некорректный адрес получателя',
      description: `Адрес получателя не прошёл валидацию: ${detectedRecipient}`,
      details: { recipient: detectedRecipient },
    });
    return violations;
  }

  const isOwnSafe = detectedRecipient ? await isSafeWallet(detectedRecipient, transaction.chainId) : false;
  if (isOwnSafe) {
    return violations;
  }

  const whitelistCheck = isAddressWhitelisted(
    detectedRecipient,
    transaction.chainId,
    effectiveWhitelists
  );

  if (whitelistCheck.whitelisted) {
    if (whitelistCheck.isSafeOwner) {
      return violations;
    }

    violations.push({
      ruleId: 'RECIPIENT_EXTERNAL_WHITELISTED',
      severity: 'warning',
      title: 'Получатель — известный внешний адрес',
      description: whitelistCheck.label
        ? `Адрес ${detectedRecipient} — «${whitelistCheck.label}». В вашем списке доверенных, но это не ваш кошелёк. Сверьте, что переводите именно туда, куда планировали.`
        : `Адрес ${detectedRecipient} — в вашем списке доверенных, но это не ваш кошелёк. Сверьте, что переводите именно туда, куда планировали.`,
      details: {
        recipient: detectedRecipient,
        label: whitelistCheck.label,
      },
    });
  } else {
    violations.push({
      ruleId: 'UNKNOWN_RECIPIENT',
      severity: 'warning',
      title: 'Получатель впервые встречается',
      description: `Адрес ${detectedRecipient} раньше не использовался и не в списке доверенных. Сверьте его посимвольно с тем, что вы ввели в интерфейсе — если ошибка, средства не вернуть.`,
      details: {
        recipient: detectedRecipient,
      },
    });
  }

  return violations;
}

export function checkCalldataRecipientMismatch(
  input: PolicyCheckInput
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const { transaction, detectedRecipient } = input;

  if (!detectedRecipient) return violations;

  return violations;
}
