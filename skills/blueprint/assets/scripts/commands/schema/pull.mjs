import { pull as schemaPull } from '../../lib/db.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';

export function run(cli) {
  const { root } = ctx(cli);
  try {
    const result = schemaPull(root);
    out(`已导出 ${result.tables.length} 张表`);
  } catch (error) {
    fail(`schema pull 失败,保留现有 snapshot:${error.message}`);
  }
}
