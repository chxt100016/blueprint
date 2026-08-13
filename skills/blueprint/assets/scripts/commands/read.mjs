import { findSection } from '../lib/parse.mjs';
import { fail, out } from '../runtime/cli.mjs';
import { ctx } from '../runtime/context.mjs';

export function run(cli, [ref]) {
  const { repo } = ctx(cli);
  if (!ref) fail('用法: bp read <id>[#<章节>]');
  const index = ref.lastIndexOf('#');
  const id = index === -1 ? ref : ref.slice(0, index);
  const section = index === -1 ? null : ref.slice(index + 1);

  // 业务服务读的是人写的业务描述:流程层的上游就是它,spec 下的 service.md 是本层自己的产出
  const service = repo.services.get(id);
  let doc = service ? service.product : null;
  if (service && !doc) fail(`${id} 的业务描述 ${service.productRel} 不存在`);
  if (!doc) doc = repo.flows.get(id) || repo.activities.get(id) || repo.domains.get(id) || null;
  if (!doc) fail(`找不到 ${id}`);

  if (!section) { out(doc.raw); return; }
  const found = findSection(doc.sections, section);
  if (!found) fail(`${id} 中没有章节「${section}」`);
  out(found.body);
}
