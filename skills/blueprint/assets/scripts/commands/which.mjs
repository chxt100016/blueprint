import { which as whichFile } from '../lib/codemap.mjs';
import { fail, out } from '../runtime/cli.mjs';
import { ctx } from '../runtime/context.mjs';

export function run(cli, [file]) {
  const { root } = ctx(cli);
  if (!file) fail('用法: bp which <file>');
  const hits = whichFile(root, file);
  if (!hits.length) { out('该文件不属于任何业务活动或领域能力'); process.exit(1); }
  for (const hit of hits) out(hit);
}
