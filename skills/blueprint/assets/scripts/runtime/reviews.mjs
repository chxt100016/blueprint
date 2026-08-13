import fs from 'node:fs';
import path from 'node:path';

import * as review from '../lib/review.mjs';
import { readFileSafe } from '../lib/parse.mjs';
import { errOut, fail, out } from './cli.mjs';
import { clip, table } from './format.mjs';

export function reviewFileFor(repo, id) {
  const obj = repo.flows.get(id) || repo.activities.get(id) || repo.domains.get(id);
  if (!obj) fail(`找不到 ${id}`);
  return obj.reviewPath;
}

export function loadReviewFile(repo, id, createIfMissing = false) {
  const file = reviewFileFor(repo, id);
  let raw = readFileSafe(file);
  if (raw === null) {
    if (!createIfMissing) fail(`${id} 还没有澄清记录(${path.relative(repo.root, file)})`);
    raw = review.emptyReview(id);
  }
  return { file, parsed: review.parseReview(raw) };
}

export function saveReviewFile(file, parsed) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, review.render(parsed));
}

export function requireCleanReviews(targets) {
  const dirty = targets.filter((target) => !review.isClean(target.review));
  if (dirty.length) {
    errOut('澄清尚未结清:');
    for (const target of dirty) errOut(`  ${target.label}  ${review.stateLabel(target.review)}`);
    errOut('');
    errOut('待答复的用 bp review answer 记录人的答复,已答复未落实的用 bp review resolve 写落点。');
    process.exit(1);
  }
}

export function printResolved(targets) {
  const rows = [];
  for (const target of targets) {
    for (const item of review.answeredItems(target.review)) {
      rows.push([`  [Q${item.number}]`, clip(item.title, 38), `→ ${item.note}`]);
    }
  }
  if (!rows.length) return;
  out('本轮澄清落点');
  table(rows);
  out('');
}
