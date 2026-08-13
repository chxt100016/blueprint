import * as review from '../../lib/review.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { loadReviewFile, saveReviewFile } from '../../runtime/reviews.mjs';

export function run(cli, [id]) {
  const { repo } = ctx(cli);
  const question = cli.option('q');
  if (!id || !question) fail('用法: bp review ask <id> --q "<问题>"');
  const { file, parsed } = loadReviewFile(repo, id, true);
  const item = review.addQuestion(parsed, question);
  saveReviewFile(file, parsed);
  out(`${item.label} ${item.title}`);
}
