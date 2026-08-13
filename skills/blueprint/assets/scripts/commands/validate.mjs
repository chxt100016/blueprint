import { validateId } from '../lib/schema.mjs';
import { out } from '../runtime/cli.mjs';
import { ctx } from '../runtime/context.mjs';
import { printErrors } from '../runtime/validation.mjs';

export function run(cli, [id]) {
  const { repo } = ctx(cli);
  const errors = validateId(repo, id);
  if (!errors.length) { out(id ? `${id} 校验通过` : '全部校验通过'); return; }
  printErrors(errors);
  out('');
  out(`${errors.length} 项不通过`);
  process.exit(3);
}
