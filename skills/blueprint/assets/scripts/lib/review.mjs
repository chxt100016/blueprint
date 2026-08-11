// review 文件的解析、编号分配与条目迁移。
// 状态判定只看两件确定性的事:区是否为空、条目下有没有 `>` 行。
import { splitSections } from './parse.mjs';

export const AREA_PENDING = '待确定';
export const AREA_CHANGES = '改动建议';
export const AREA_RESOLVED = '已解决';
export const AREAS = [AREA_PENDING, AREA_CHANGES, AREA_RESOLVED];

/** 状态。 */
export const STATE_APPROVABLE = 'approvable';
export const STATE_AI = 'ai';
export const STATE_HUMAN = 'human';

function parseItems(body) {
  const lines = String(body ?? '').split('\n');
  const items = [];
  const lead = [];
  let cur = null;
  for (const line of lines) {
    if (/^-\s+/.test(line)) {
      if (cur) items.push(cur);
      cur = { lines: [line] };
      continue;
    }
    if (cur) cur.lines.push(line);
    else lead.push(line);
  }
  if (cur) items.push(cur);
  return {
    lead: lead.join('\n').trim(),
    items: items.map((it) => buildItem(it.lines)),
  };
}

function buildItem(lines) {
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const raw = lines.join('\n');
  const first = lines[0];
  const m = first.match(/\[([QC])(\d*)\]/);
  const prefix = m ? m[1] : null;
  const number = m && m[2] ? Number(m[2]) : null;
  const answers = [];
  const notes = [];
  const textLines = [];
  lines.forEach((line, idx) => {
    const t = line.trim();
    if (idx > 0 && t.startsWith('>')) { answers.push(t.replace(/^>\s?/, '')); return; }
    if (idx > 0 && t.startsWith('→')) { notes.push(t.replace(/^→\s?/, '')); return; }
    textLines.push(idx === 0 ? line.replace(/^-\s+/, '') : line.trim());
  });
  const text = textLines.join('\n').trim();
  return {
    raw,
    prefix,
    number,
    text,
    title: text.replace(/~~/g, '').replace(/\[[QC]\d*\]\s*/, '').trim(),
    label: m ? m[0] : null,
    answers,
    notes,
    hasAnswer: answers.length > 0,
  };
}

export function parseReview(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const { preamble, sections } = splitSections(src);
  const header = preamble.trim();
  const areas = {};
  for (const name of AREAS) {
    const sec = sections.find((s) => s.title === name);
    areas[name] = sec ? parseItems(sec.body) : { lead: '', items: [] };
  }
  const extra = sections.filter((s) => !AREAS.includes(s.title));
  return { header, areas, extra, raw: src };
}

export function reviewState(review) {
  if (!review) return STATE_APPROVABLE;
  const pending = review.areas[AREA_PENDING].items;
  const changes = review.areas[AREA_CHANGES].items;
  if (!pending.length && !changes.length) return STATE_APPROVABLE;
  if (changes.length || pending.some((i) => i.hasAnswer)) return STATE_AI;
  return STATE_HUMAN;
}

/** 待 AI 处理的条目 */
export function aiItems(review) {
  if (!review) return [];
  return [
    ...review.areas[AREA_CHANGES].items,
    ...review.areas[AREA_PENDING].items.filter((i) => i.hasAnswer),
  ];
}

/** 待人答复的条目 */
export function humanItems(review) {
  if (!review) return [];
  return review.areas[AREA_PENDING].items.filter((i) => !i.hasAnswer);
}

export function openCount(review) {
  if (!review) return 0;
  return review.areas[AREA_PENDING].items.length + review.areas[AREA_CHANGES].items.length;
}

function maxNumber(review) {
  let max = 0;
  for (const name of AREAS) {
    for (const it of review.areas[name].items) {
      if (it.number && it.number > max) max = it.number;
    }
    // 正文里可能出现「已转 [Q5]」这类引用,也纳入取最大值,避免编号重用
    const all = review.areas[name].items.map((i) => i.raw).join('\n');
    for (const m of all.matchAll(/\[[QC](\d+)\]/g)) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return max;
}

/** 为占位条目分配编号。返回 { text, assigned } */
export function sweep(review) {
  let next = maxNumber(review) + 1;
  const assigned = [];
  for (const [area, prefix] of [[AREA_PENDING, 'Q'], [AREA_CHANGES, 'C']]) {
    for (const item of review.areas[area].items) {
      if (item.number) continue;
      const num = next++;
      const label = `[${item.prefix || prefix}${num}]`;
      if (item.label) {
        item.raw = item.raw.replace(item.label, label);
        item.text = item.text.replace(item.label, label);
      } else {
        item.raw = item.raw.replace(/^-\s+/, `- ${label} `);
        item.text = `${label} ${item.text}`;
      }
      item.number = num;
      item.prefix = item.prefix || prefix;
      item.label = label;
      assigned.push({ label, title: item.title, area });
    }
  }
  return { text: render(review), assigned };
}

/** 把条目迁移到已解决区。 */
export function resolveItem(review, number, note) {
  const num = Number(number);
  for (const area of [AREA_PENDING, AREA_CHANGES]) {
    const list = review.areas[area].items;
    const idx = list.findIndex((i) => i.number === num);
    if (idx === -1) continue;
    const [item] = list.splice(idx, 1);
    const lines = [];
    const head = item.text.split('\n');
    lines.push(`- ~~${head[0].trim()}~~`);
    for (const extra of head.slice(1)) {
      if (extra.trim()) lines.push(`  ${extra.trim()}`);
    }
    for (const a of item.answers) lines.push(`  > ${a}`);
    for (const n of item.notes) lines.push(`  → ${n}`);
    if (note) lines.push(`  → ${note}`);
    review.areas[AREA_RESOLVED].items.push(buildItem(lines));
    return { text: render(review), item };
  }
  const done = review.areas[AREA_RESOLVED].items.find((i) => i.number === num);
  if (done) throw new Error(`条目 ${num} 已在「已解决」区`);
  throw new Error(`条目 ${num} 不存在于「待确定」或「改动建议」区`);
}

/** 追加一条待确定条目(占位编号,由 sweep 分配)。 */
export function addPending(review, text) {
  review.areas[AREA_PENDING].items.push(buildItem([`- [Q] ${text}`]));
  return render(review);
}

export function render(review) {
  const out = [];
  if (review.header) out.push(review.header, '');
  for (const name of AREAS) {
    const area = review.areas[name];
    out.push(`## ${name}`, '');
    if (area.lead) out.push(area.lead, '');
    for (const item of area.items) out.push(item.raw.trimEnd(), '');
  }
  for (const sec of review.extra) out.push(sec.raw.trim(), '');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function emptyReview(id, template) {
  if (template) return template.replace(/<id>/g, id);
  return `# ${id} 确认\n\n## 待确定\n\n## 改动建议\n\n## 已解决\n`;
}
