import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { printErrors } from '../../runtime/validation.mjs';
import { implPrecheck } from '../../runtime/verify.mjs';

export function run(cli, [id]) {
  const { repo } = ctx(cli);
  if (!id) fail('用法: bp code check <id>');
  const { problems, files } = implPrecheck(repo, id);
  if (problems.length) { printErrors(problems); process.exit(1); }
  out(`${id} 预检通过,codemap 记录 ${files.length} 个文件`);
}
