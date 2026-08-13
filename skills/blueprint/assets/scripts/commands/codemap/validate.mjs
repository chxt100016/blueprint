import { validateCodemap } from '../../lib/codemap.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { printErrors } from '../../runtime/validation.mjs';

export function run(cli, [id]) {
  const { root, repo } = ctx(cli);
  if (!id) fail('用法: bp codemap validate <id>');
  const targets = repo.services.has(id) ? repo.services.get(id).activities : [id];
  const errors = [];
  for (const target of targets) errors.push(...validateCodemap(root, target).errors);
  if (errors.length) { printErrors(errors); process.exit(1); }
  out(`${id} 的 codemap 校验通过`);
}
