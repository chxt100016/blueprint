// `bp domain show <id>`:取一个领域模型的全文,与 `bp flow <id>` / `bp activity <id>` 同构。
//
// activity 层要读它:写活动前先看已有的聚合与领域服务能不能复用,
// 只给 domain list 的一行概要不足以判断,得看边界与命令。
import { out, fail } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';

const KIND_LABEL = { aggregate: '聚合', service: '领域服务' };

export function run(cli, [id]) {
  if (!id) fail('用法: bp domain show "<domainId>"');
  const { repo } = ctx(cli);
  const dom = repo.domains.get(id);
  if (!dom) {
    const missing = repo.missingDomains.find((m) => m.id === id);
    if (missing) fail(`${id} 还没有文档,引用方 ${missing.usedBy.join(', ')}(它是 domain 层的待办)`);
    fail(`找不到领域模型 ${id}`);
  }
  out(`\n── ${KIND_LABEL[dom.kind] || dom.kind} ──  ${dom.rel}\n`);
  out(dom.raw);
}
