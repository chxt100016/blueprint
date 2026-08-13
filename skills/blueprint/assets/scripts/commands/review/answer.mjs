import * as review from '../../lib/review.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { loadReviewFile, saveReviewFile } from '../../runtime/reviews.mjs';

export function run(cli, [id, number]) {
  const { repo } = ctx(cli);
  const answer = cli.option('a');
  if (!id || !number || !answer) fail('用法: bp review answer <id> <Qn> --a "<答复>"');
  const { file, parsed } = loadReviewFile(repo, id);
  let item;
  try { item = review.answerQuestion(parsed, String(number).replace(/^Q/i, ''), answer); } catch (error) { fail(error.message); }
  saveReviewFile(file, parsed);
  out(`${item.label} 已记录答复`);
}
