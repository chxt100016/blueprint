// 澄清记录(.review.md)的解析与读写。
//
// 这个文件由 bp review 命令独占读写,skill 不解析它、不拼它的格式、不分配编号。
// 一条澄清的生命周期有四步,前三步各对应一条命令,末步由 approve 触发:
//
//   ask      AI 想到一个拿不准的点     → 分配编号,进「待答复」
//   answer   人给了答复                → 带答复迁入「已答复」
//   resolve  AI 把答复落进文档         → 补一条落点
//   settle   人在确认门盖章            → 整批迁入「已确认」,永久留在文件里
//
// 「待答复」非空 = 还有事没问清;「已答复」里有条目没落点 = AI 说处理了但没说落在哪。
// 两者任一非空都不许 approve——后者是 AI 声称改了却没改的唯一捕获时机。
//
// 「已确认」区不参与上面任何判定,它是盖过章的抉择存档,给人回溯用:
// 这个服务当初为什么拆成两个流程、某个边界值为什么取这个数,答案只存在这里。
// approve 时删掉整份记录会让这些一次性蒸发,所以迁而不删。
// 区隔靠二级标题,因此 isClean 之类的判定不必知道存档的存在,照旧只看前两区。
import { splitSections } from './parse.mjs';
import { BpError } from './error.mjs';

export const AREA_PENDING = '待答复';
export const AREA_ANSWERED = '已答复';
export const AREA_SETTLED = '已确认';
// parseReview / render / maxNumber 遍历本表。已确认区列进来,编号才会跨轮唯一——
// 上一轮盖章到 Q5,新一轮就从 Q6 起,不会撞上存档里的旧编号。
export const AREAS = [AREA_PENDING, AREA_ANSWERED, AREA_SETTLED];

export const HEADER_NOTE = '<!-- 本文件由 bp review 命令维护,请勿手工编辑 -->';

function parseItems(body) {
  const lines = String(body ?? '').split('\n');
  const groups = [];
  let cur = null;
  for (const line of lines) {
    if (/^-\s+/.test(line)) {
      if (cur) groups.push(cur);
      cur = [line];
      continue;
    }
    if (cur) cur.push(line);
  }
  if (cur) groups.push(cur);
  return groups.map(buildItem);
}

function buildItem(lines) {
  const body = [...lines];
  while (body.length && body[body.length - 1].trim() === '') body.pop();
  const first = body[0] || '';
  const m = first.match(/\[Q(\d+)\]/);
  const answers = [];
  const notes = [];
  const textLines = [];
  body.forEach((line, idx) => {
    const t = line.trim();
    if (idx > 0 && t.startsWith('>')) { answers.push(t.replace(/^>\s?/, '')); return; }
    if (idx > 0 && t.startsWith('→')) { notes.push(t.replace(/^→\s?/, '')); return; }
    textLines.push(idx === 0 ? line.replace(/^-\s+/, '') : line.trim());
  });
  const text = textLines.join('\n').trim();
  return {
    number: m ? Number(m[1]) : null,
    label: m ? m[0] : null,
    text,
    title: text.replace(/\[Q\d+\]\s*/, '').trim(),
    answer: answers.join('\n'),
    note: notes.join(' / '),
    hasAnswer: answers.length > 0,
    hasNote: notes.length > 0,
  };
}

function renderItem(item) {
  const out = [`- ${item.text}`];
  for (const line of String(item.answer || '').split('\n')) {
    if (line.trim()) out.push(`  > ${line.trim()}`);
  }
  if (item.note) out.push(`  → ${item.note}`);
  return out.join('\n');
}

export function parseReview(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const { preamble, sections } = splitSections(src);
  const areas = {};
  for (const name of AREAS) {
    const sec = sections.find((s) => s.title === name);
    areas[name] = sec ? parseItems(sec.body) : [];
  }
  return { header: preamble.trim(), areas, raw: src };
}

export function render(review) {
  const out = [];
  if (review.header) out.push(review.header, '');
  for (const name of AREAS) {
    out.push(`## ${name}`, '');
    for (const item of review.areas[name]) out.push(renderItem(item), '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function emptyReview(id) {
  const areas = AREAS.map((name) => `## ${name}\n`).join('\n');
  return `# ${id} 澄清记录\n\n${HEADER_NOTE}\n\n${areas}`;
}

// ------------------------------------------------------------------- 状态

export function pendingItems(review) {
  return review ? review.areas[AREA_PENDING] : [];
}

export function answeredItems(review) {
  return review ? review.areas[AREA_ANSWERED] : [];
}

/** 盖过章的存档。不参与任何判定,只有回溯抉择时才读。 */
export function settledItems(review) {
  return review ? review.areas[AREA_SETTLED] : [];
}

/** 已答复但还没写落点的条目:AI 说处理了,但没说落在文档哪里。 */
export function unresolvedItems(review) {
  return answeredItems(review).filter((i) => !i.hasNote);
}

/** 可以 approve 吗:没有待答复,且每条已答复都写了落点。 */
export function isClean(review) {
  if (!review) return true;
  return pendingItems(review).length === 0 && unresolvedItems(review).length === 0;
}

/** 一句话状态,给 scan 的 detail 用。 */
export function stateLabel(review) {
  if (!review) return '';
  const p = pendingItems(review).length;
  const u = unresolvedItems(review).length;
  const parts = [];
  if (p) parts.push(`${p} 项待答复`);
  if (u) parts.push(`${u} 项已答复未落实`);
  return parts.join(', ');
}

// ------------------------------------------------------------------- 变更

function maxNumber(review) {
  let max = 0;
  for (const name of AREAS) {
    for (const it of review.areas[name]) {
      if (it.number && it.number > max) max = it.number;
    }
  }
  return max;
}

/** 追加一条待答复的澄清问题,返回分配到的编号。 */
export function addQuestion(review, text) {
  const clean = String(text ?? '').trim().replace(/\s*\n\s*/g, ' ');
  if (!clean) throw new BpError('澄清问题不能为空');
  const num = maxNumber(review) + 1;
  const label = `[Q${num}]`;
  review.areas[AREA_PENDING].push(buildItem([`- ${label} ${clean}`]));
  return { number: num, label, title: clean };
}

function findIn(review, area, num) {
  const list = review.areas[area];
  const idx = list.findIndex((i) => i.number === num);
  return idx === -1 ? null : { list, idx, item: list[idx] };
}

/** 记录人的答复,条目从「待答复」迁到「已答复」。 */
export function answerQuestion(review, number, answer) {
  const num = Number(number);
  const clean = String(answer ?? '').trim();
  if (!clean) throw new BpError('答复不能为空');
  const hit = findIn(review, AREA_PENDING, num);
  if (!hit) {
    if (findIn(review, AREA_ANSWERED, num)) throw new BpError(`Q${num} 已经答复过了`);
    throw new BpError(`Q${num} 不存在`);
  }
  const [item] = hit.list.splice(hit.idx, 1);
  item.answer = clean;
  item.hasAnswer = true;
  review.areas[AREA_ANSWERED].push(item);
  return item;
}

/** 记录该答复落在文档的什么位置。 */
export function resolveQuestion(review, number, note) {
  const num = Number(number);
  const clean = String(note ?? '').trim();
  if (!clean) throw new BpError('落点不能为空');
  const hit = findIn(review, AREA_ANSWERED, num);
  if (!hit) {
    if (findIn(review, AREA_PENDING, num)) throw new BpError(`Q${num} 还没有答复,不能落实`);
    throw new BpError(`Q${num} 不存在`);
  }
  hit.item.note = hit.item.note ? `${hit.item.note} / ${clean}` : clean;
  hit.item.hasNote = true;
  return hit.item;
}

/**
 * 盖章:把「已答复」整批迁入「已确认」,返回迁移条数。
 *
 * 只由各层 approve 调用,没有对应的 bp 子命令——盖章的时机由 lock 决定,
 * 不该由 skill 自己挑。迁移前每条都已有落点,这由 approve 里的
 * requireCleanReviews 保证,本函数不重复检查。
 */
export function settleAll(review) {
  const done = review.areas[AREA_ANSWERED];
  if (!done.length) return 0;
  review.areas[AREA_SETTLED].push(...done);
  review.areas[AREA_ANSWERED] = [];
  return done.length;
}
