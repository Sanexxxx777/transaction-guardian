import type { PolicyViolation, PolicyCheckInput } from '../../../models/policy.js';
import { isProtocolWhitelisted } from '../whitelist.js';
import { isERC20Method, decodeERC20 } from '../../calldata-decoder/index.js';

export function checkProtocol(
  input: PolicyCheckInput
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const { transaction, effectiveWhitelists } = input;

  if (transaction.data && isERC20Method(transaction.data)) {
    const decoded = decodeERC20(transaction.data);
    if (decoded && decoded.method === 'approve') {
      const spenderCheck = isProtocolWhitelisted(
        decoded.spender,
        transaction.chainId,
        effectiveWhitelists
      );
      if (!spenderCheck.whitelisted) {
        violations.push({
          ruleId: 'UNKNOWN_PROTOCOL',
          severity: 'warning',
          title: 'Контракту впервые выдаётся approve',
          description: `Подписав, вы дадите контракту ${decoded.spender} право списывать ваш токен в будущем. Сверьте, что approve выдаётся именно тому протоколу, который вы видели в интерфейсе.`,
          details: {
            contractAddress: decoded.spender,
            chainId: transaction.chainId,
          },
        });
      }

      return violations;
    }
  }

  const check = isProtocolWhitelisted(
    transaction.to,
    transaction.chainId,
    effectiveWhitelists
  );

  if (!check.whitelisted) {
    violations.push({
      ruleId: 'UNKNOWN_PROTOCOL',
      severity: 'warning',
      title: 'Контракт впервые встречается',
      description: `Контракт ${transaction.to} не в списке проверенных. Если вы не вызывали его намеренно — отмените транзакцию. Если знаете протокол и доверяете ему — можно подписать.`,
      details: {
        contractAddress: transaction.to,
        chainId: transaction.chainId,
      },
    });
  }

  return violations;
}

export function checkContractUpgrade(
  input: PolicyCheckInput
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  const UPGRADE_SELECTORS = [
    '0x3659cfe6',
    '0x4f1ef286',
    '0x99a88ec4',
  ];

  const data = input.transaction.data;
  if (data && data.length >= 10) {
    const selector = data.slice(0, 10).toLowerCase();
    if (UPGRADE_SELECTORS.includes(selector)) {
      violations.push({
        ruleId: 'CONTRACT_UPGRADE',
        severity: 'warning',
        title: 'Обновление контракта',
        description: 'Транзакция выполняет обновление прокси-контракта',
        details: {
          selector,
        },
      });
    }
  }

  return violations;
}
