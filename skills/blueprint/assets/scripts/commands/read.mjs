import { findSection } from '../lib/parse.mjs';
import { fail, out } from '../runtime/cli.mjs';
import { ctx } from '../runtime/context.mjs';

export function run(cli, [ref]) {
  const { repo } = ctx(cli);
  if (!ref) fail('用法: bp read <id>#<章节>');
  const index = ref.lastIndexOf('#');
  const id = index === -1 ? ref : ref.slice(0, index);
  const section = index === -1 ? null : ref.slice(index + 1);

  let doc = null;
  if (repo.flows.has(id)) doc = repo.flows.get(id);
  else if (repo.activities.has(id)) doc = repo.activities.get(id);
  else if (repo.domains.has(id)) doc = repo.domains.get(id);
  else if (repo.products.has(id) && section) {
    const anchor = repo.products.get(id).anchors.get(section);
    if (!anchor) fail(`${id} 中没有锚点「${section}」`);
    out(anchor.body);
    return;
  }
  if (!doc) fail(`找不到 ${id}`);
  if (!section) { out(doc.raw); return; }
  const found = findSection(doc.sections, section);
  if (!found) fail(`${id} 中没有章节「${section}」`);
  out(found.body);
}
