import path from 'node:path';

import { readFileSafe } from '../../lib/parse.mjs';
import * as review from '../../lib/review.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { clip } from '../../runtime/format.mjs';
import { reviewFileFor } from '../../runtime/reviews.mjs';

export function run(cli, [id]) {
  const { repo } = ctx(cli);
  if (!id) fail('用法: bp review list <id>');
  const file = reviewFileFor(repo, id);
  const raw = readFileSafe(file);
  if (raw === null) { out(`${id} 没有澄清记录`); return; }
  const parsed = review.parseReview(raw);
  const pending = review.pendingItems(parsed);
  const answered = review.answeredItems(parsed);
  if (cli.flag('json')) {
    out(JSON.stringify({
      id,
      pending: pending.map((item) => ({ number: item.number, question: item.title })),
      answered: answered.map((item) => ({
        number: item.number, question: item.title, answer: item.answer, note: item.note || null,
      })),
    }, null, 2));
    return;
  }
  if (pending.length) {
    out('待答复');
    for (const item of pending) out(`  [Q${item.number}] ${item.title}`);
    out('');
  }
  if (answered.length) {
    out('已答复');
    for (const item of answered) {
      out(`  [Q${item.number}] ${clip(item.title, 46)}`);
      out(`      > ${clip(item.answer, 60)}`);
      out(`      → ${item.note || '(未写落点)'}`);
    }
    out('');
  }
  out(review.isClean(parsed) ? '澄清已结清,可以 approve' : `未结清:${review.stateLabel(parsed)}`);
  // 已确认区不展开:它是往轮次的存档,列出来会把当前待办淹掉。给个条数和路径就够,
  // 要回溯的人自己去翻文件。
  const settled = review.settledItems(parsed).length;
  if (settled) out(`往轮已确认 ${settled} 条,见 ${path.relative(repo.root, file)}`);
}
