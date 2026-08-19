import fs from 'node:fs';
import path from 'node:path';

import { bpPath, isDomainId } from '../../lib/config.mjs';
import { codemapPath } from '../../lib/codemap.mjs';
import { todoPath } from '../../lib/todo.mjs';
import { relatedDomains } from '../../lib/repo.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';

/** 与被删服务名字接近、且还没有 spec 产出的业务服务:多半是人改名后的新名字。 */
function similarServices(repo, service) {
  const chars = new Set(service.slug);
  const scored = [];
  for (const other of repo.services.values()) {
    if (other.id === service.id || !other.product || other.flows.length) continue;
    let hit = 0;
    for (const char of new Set(other.slug)) if (chars.has(char)) hit++;
    if (hit >= 3) scored.push({ id: other.id, rel: other.productRel, hit });
  }
  return scored.sort((a, b) => b.hit - a.hit).slice(0, 3);
}

export function run(cli, [id]) {
  const { root, repo } = ctx(cli);
  if (!id) fail('用法: bp delete plan <id>');
  const lines = [];
  const file = todoPath(root, id, 'manual');

  // 服务由 product 文档定义,文档没了就是整个服务待清理——比逐个流程报废更贴近实际:
  // 人改的是 product 里的文件名,受影响的从来不是某一个接口
  if (repo.services.has(id) && !repo.services.get(id).product) {
    const service = repo.services.get(id);
    lines.push(`# ${id} 清理确认`, '', '## 情况', '');
    lines.push(`业务服务 \`${id}\` 的业务描述 \`${service.productRel}\` 不存在,`
      + `但 \`${service.rel}/\` 下已有 ${service.flows.length} 个流程、${service.activities.length} 个活动。`, '');
    lines.push('**这可能是两种情况之一:**', '');
    lines.push(`- product 里的文件被重命名 → 把 \`${service.rel}/\` 一并改成同样的名字,删除本文件,不要执行下方清理`);
    lines.push('- 该业务服务已废弃 → 按下方清单执行清理', '');
    const similar = similarServices(repo, service);
    if (similar.length) {
      lines.push('## 疑似重命名目标', '');
      for (const item of similar) lines.push(`- \`${item.id}\`(${item.rel},名字相近且还没有产出)`);
      lines.push('');
    }
    const domains = relatedDomains(repo, id)
      .filter((domain) => domain.usedBy.every((activity) => activity.startsWith(`${id}.`)));
    if (domains.length) {
      lines.push('## 引用关系', '', '以下领域模型仅被本服务的活动引用,清理后将变为 error:', '');
      for (const domain of domains) lines.push(`- ${domain.id}`);
      lines.push('');
    }
    lines.push('## 待删除(文档层)', '');
    lines.push(`- ${service.rel}/  整个目录(含 ${service.flows.length} 个流程文件与全部活动目录)`);
    lines.push(`- blueprint/codemap/${service.capability}/${service.slug}/  整个目录`);
    lines.push(`- lock.json 中 services["${id}"]、flows 下 ${service.flows.join('、') || '(无)'}`
      + `、activities 下 ${service.activities.join('、') || '(无)'}`, '');
    const codeFiles = new Set();
    for (const aid of service.activities) {
      for (const codeFile of repo.lock.activities?.[aid]?.impl?.files || []) codeFiles.add(codeFile);
    }
    lines.push('## 待删除(代码层,需人再次确认)', '');
    if (codeFiles.size) for (const codeFile of codeFiles) lines.push(`- ${codeFile}`);
    else lines.push('- (codemap 中没有记录代码文件)');
    lines.push('');
  } else {
    const isDomain = isDomainId(id);
    const obj = isDomain ? repo.domains.get(id) : repo.activities.get(id);
    if (!obj) fail(`找不到 ${id}`);
    lines.push(`# ${id} 清理确认`, '', '## 情况', '');
    if (isDomain) lines.push(`领域模型 \`${id}\` 已无任何业务活动的「领域依赖」引用。`, '');
    else lines.push(`业务活动 \`${id}\` 不被 ${obj.service} 的任何流程编排。`, '');
    lines.push('若这是重命名,请改回 id 或补上引用,并删除本文件。', '');
    lines.push('## 待删除(文档层)', '');
    lines.push(`- ${path.relative(root, obj.dir)}/  整个目录`);
    lines.push(`- ${path.relative(root, codemapPath(root, id))}`);
    lines.push(`- lock.json 中 ${isDomain ? 'domains' : 'activities'}.${id}`, '');
    const entry = isDomain ? repo.lock.domains?.[id] : repo.lock.activities?.[id];
    lines.push('## 待删除(代码层,需人再次确认)', '');
    const files = entry?.impl?.files || [];
    if (files.length) for (const codeFile of files) lines.push(`- ${codeFile}`);
    else lines.push('- (codemap 中没有记录代码文件)');
    lines.push('');
    if (!isDomain) {
      const orphanDomains = [];
      for (const use of obj.uses) {
        const domain = repo.domains.get(use);
        if (domain && domain.usedBy.length === 1 && domain.usedBy[0] === id) orphanDomains.push(use);
      }
      if (orphanDomains.length) {
        lines.push('## 引用关系', '', '以下领域模型仅被本活动引用,清理后将变为 error:', '');
        for (const domain of orphanDomains) lines.push(`- ${domain}`);
        lines.push('');
      }
    }
  }
  lines.push('## 执行后', '', '运行 `node blueprint/scripts/bp.mjs stage` 确认无残留。', '');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'));
  out(`已生成清理清单: ${path.relative(root, file)}`);
}
