import { checkTables } from '../../lib/db.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { pad } from '../../runtime/format.mjs';

function declarationsOf(repo, id) {
  if (!id) return [...repo.activities.values(), ...repo.domains.values()];
  if (repo.services.has(id)) {
    return repo.services.get(id).activities.map((activity) => repo.activities.get(activity));
  }
  const obj = repo.activities.get(id) || repo.domains.get(id);
  if (!obj) fail(`找不到 ${id}`);
  return [obj];
}

export function run(cli, [id]) {
  const { root, repo } = ctx(cli);
  const declarations = declarationsOf(repo, id);
  const { gaps, snapshotExists } = checkTables(root, declarations);
  if (!snapshotExists) {
    fail('snapshot 尚未生成,无法判断表结构是否就绪。\n'
      + '先配好 blueprint/context/db.yaml 再运行 bp schema pull。\n'
      + '(snapshot 为空只说明还没导出过,不代表库里没有这些表,不要据此生成建表工单)', 2);
  }
  if (!gaps.length) { out(`${id || '全部'} 的表结构声明已就绪`); return; }
  out('缺失:');
  for (const gap of gaps) {
    const name = gap.kind === 'table' ? gap.table : `${gap.table}.${gap.column}`;
    out(`  ${pad(name, 28)}${gap.by} 声明,${gap.detail}`);
  }
  out('');
  process.exit(1);
}
