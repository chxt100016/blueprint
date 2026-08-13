import { out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { table } from '../../runtime/format.mjs';

export function run(cli) {
  const { repo } = ctx(cli);
  const rows = [];
  for (const id of [...repo.domains.keys()].sort()) {
    const domain = repo.domains.get(id);
    const spec = repo.lock.domains?.[id]?.spec;
    rows.push([
      id,
      spec ? (spec.domain_hash === domain.hash ? '已确认' : '已更新') : '待确认',
      `引用方 ${domain.usedBy.join(', ') || '无'}`,
    ]);
  }
  for (const missing of repo.missingDomains) {
    rows.push([missing.id, '待设计', `引用方 ${missing.usedBy.join(', ')}`]);
  }
  for (const [id, rejected] of Object.entries(repo.lock.rejected_domains || {})) {
    rows.push([id, '已否决', `${rejected.reason || ''}${rejected.at ? '  ' + rejected.at.slice(0, 10) : ''}`]);
  }
  if (!rows.length) { out('还没有登记任何领域能力'); return; }
  table(rows.sort((a, b) => a[0].localeCompare(b[0])));
}
