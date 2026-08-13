import * as review from '../../lib/review.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { loadReviewFile, saveReviewFile } from '../../runtime/reviews.mjs';

export function run(cli, [id, number]) {
  const { repo } = ctx(cli);
  const note = cli.option('note');
  if (!id || !number || !note) fail('用法: bp review resolve <id> <Qn> --note "<落点>"');
  const { file, parsed } = loadReviewFile(repo, id);
  let item;
  try { item = review.resolveQuestion(parsed, String(number).replace(/^Q/i, ''), note); } catch (error) { fail(error.message); }
  saveReviewFile(file, parsed);
  out(`${item.label} → ${note}`);
}
