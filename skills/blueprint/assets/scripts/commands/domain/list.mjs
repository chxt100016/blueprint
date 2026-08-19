import { domainChange } from '../../lib/stage.mjs';
import { out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { clip, table } from '../../runtime/format.mjs';

// 两类的形态差别很大,清单第一眼就要能分开:聚合有状态有表,领域服务只算不改
const KIND_LABEL = { aggregate: '聚合', service: '领域服务' };

/**
 * 状态词与 `bp scan domain` 的 detail 一一对应:同一个模型在两处显示成两个词,
 * 读者会以为是两件事。判据仍是 domainChange,只是这里说成状态而不是变更类型。
 */
function stateOf(repo, id) {
  if (!repo.lock.domains?.[id]?.spec) return '待确认';
  return domainChange(repo, id) ? '需重新确认' : '已确认';
}

export function run(cli) {
  const { repo } = ctx(cli);
  const rows = [];
  for (const id of [...repo.domains.keys()].sort()) {
    const domain = repo.domains.get(id);
    rows.push([
      id,
      KIND_LABEL[domain.kind] || domain.kind,
      stateOf(repo, id),
      // 概要摆在引用方前面:这张表最主要的用途是「我要的能力是不是已经有了」
      clip(domain.summary, 44) || '(未写概要)',
      `引用方 ${domain.usedBy.join(', ') || '无'}`,
    ]);
  }
  for (const missing of repo.missingDomains) {
    rows.push([missing.id, '?', '待设计', '', `引用方 ${missing.usedBy.join(', ')}`]);
  }
  if (!rows.length) { out('还没有登记任何领域模型'); return; }
  table(rows.sort((a, b) => a[0].localeCompare(b[0])));
}
