import { escapeMarkdown } from './formatters.js';

export function tg(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += recookEscapes(strings.raw[i]);
    if (i < values.length) {
      const v = values[i];
      if (v && typeof v === 'object' && '__raw__' in v) {
        out += String((v as { __raw__: string }).__raw__);
      } else {
        out += escapeMarkdown(String(v));
      }
    }
  }
  return out;
}

function recookEscapes(raw: string): string {
  return raw.replace(/\\(.)/g, (match, c) => {
    switch (c) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'v': return '\v';
      case '0': return '\0';
      case '\\': return '\\';
      case "'": return "'";
      case '"': return '"';
      case '`': return '`';

      default: return match;
    }
  });
}

export function raw(s: string): { __raw__: string } {
  return { __raw__: s };
}

export function code(s: string | number | bigint): { __raw__: string } {
  const inner = String(s).replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  return { __raw__: '`' + inner + '`' };
}
