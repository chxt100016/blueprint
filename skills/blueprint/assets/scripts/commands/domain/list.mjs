import { domainChange } from '../../lib/stage.mjs';
import { out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { clip, table } from '../../runtime/format.mjs';

export function run(cli) {
  const { repo } = ctx(cli);
  const rows = [];
  for (const id of [...repo.domains.keys()].sort()) {
    const domain = repo.domains.get(id);
    // 「新增 / 修改」与其余各层同名同义,判据也是同一个函数
    rows.push([
      id,
      domainChange(repo, id) || '已确认',
      // 概要摆在引用方前面:这张表最主要的用途是「我要的能力是不是已经有了」
      clip(domain.summary, 44) || '(未写概要)',
      `引用方 ${domain.usedBy.join(', ') || '无'}`,
    ]);
  }
  for (const missing of repo.missingDomains) {
    rows.push([missing.id, '待设计', '', `引用方 ${missing.usedBy.join(', ')}`]);
  }
  if (!rows.length) { out('还没有登记任何领域能力'); return; }
  table(rows.sort((a, b) => a[0].localeCompare(b[0])));
}
