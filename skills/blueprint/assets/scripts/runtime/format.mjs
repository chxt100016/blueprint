import { out } from './cli.mjs';

export function width(s) {
  let w = 0;
  for (const ch of String(s)) w += /[　-鿿＀-￯]/.test(ch) ? 2 : 1;
  return w;
}

export function pad(s, n) {
  return String(s) + ' '.repeat(Math.max(1, n - width(s)));
}

export function clip(s, n) {
  const text = String(s).split('\n')[0].trim();
  if (width(text) <= n) return text;
  let result = '';
  for (const ch of text) {
    if (width(result) + 2 > n) break;
    result += ch;
  }
  return result + '…';
}

export function table(rows) {
  if (!rows.length) return;
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => { widths[i] = Math.max(widths[i] || 0, width(cell) + 2); });
  }
  for (const row of rows) {
    out(row.map((cell, i) => (i === row.length - 1 ? String(cell) : pad(cell, widths[i]))).join('').trimEnd());
  }
}
