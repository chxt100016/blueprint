import fs from 'node:fs';
import path from 'node:path';

import { bpPath, isDomainId, ACTIVITY_MARK } from '../../lib/config.mjs';
import { codemapPath } from '../../lib/codemap.mjs';
import { relatedDomains } from '../../lib/repo.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';

function sanitize(id) {
  return String(id).replace(/^@/, 'at-').replace(/[^\w.-]/g, '-');
}

function timestamp() {
  const date = new Date();
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function similarAnchors(repo, flow) {
  const words = new Set();
  for (const item of flow.activityList) for (const char of item.summary || '') words.add(char);
  const scored = [];
  for (const product of repo.products.values()) {
    for (const title of product.anchors.keys()) {
      const ref = `${product.id}#${title}`;
      if ((repo.anchorUsers.get(ref) || []).length) continue;
      let hit = 0;
      for (const char of title) if (words.has(char)) hit++;
      if (hit >= 2) scored.push({ ref, hit });
    }
  }
  return scored.sort((a, b) => b.hit - a.hit).slice(0, 3);
}

export function run(cli, [id]) {
  const { root, repo } = ctx(cli);
  if (!id) fail('用法: bp delete plan <id>');
  const lines = [];
  const file = bpPath(root, 'todo', `${timestamp()}_${sanitize(id)}_manual.md`);

  if (repo.flows.has(id)) {
    const flow = repo.flows.get(id);
    const service = repo.services.get(flow.service);
    lines.push(`# ${id} 清理确认`, '', '## 情况', '');
    lines.push(`\`${flow.rel}\` 声明的锚点 \`${flow.product}\` 在 product 中不存在。`, '');
    lines.push('**这可能是两种情况之一:**', '');
    lines.push(`- product 中该标题被重命名 → 修改 ${flow.slug}.md front-matter 的 \`product\` 字段指向新标题,删除本文件,不要执行下方清理`);
    lines.push('- 该业务流程(对外接口)已废弃 → 按下方清单执行清理', '');
    const similar = similarAnchors(repo, flow);
    if (similar.length) {
      lines.push('## 疑似重命名目标', '');
      for (const item of similar) lines.push(`- \`${item.ref}\`(与活动编排有词面重合)`);
      lines.push('');
    }
    // 活动归属服务、可被多个流程编排,只有仅被本流程编排的才随之删除
    const exclusive = [];
    const shared = [];
    for (const item of flow.activityList) {
      const aid = `${flow.service}.${ACTIVITY_MARK}.${item.slug}`;
      const others = (repo.activityUsers.get(aid) || []).filter((fid) => fid !== id);
      (others.length ? shared : exclusive).push({ slug: item.slug, aid, others });
    }
    if (shared.length) {
      lines.push('## 保留的活动(其他流程还在编排)', '');
      for (const item of shared) lines.push(`- ${item.slug}  仍被 ${item.others.join(', ')} 编排`);
      lines.push('');
    }
    const onlyMine = [];
    for (const domain of relatedDomains(repo, flow.service)) {
      const users = domain.usedBy.filter((activity) => exclusive.every((e) => e.aid !== activity));
      if (!users.length) onlyMine.push(domain.id);
    }
    if (onlyMine.length) {
      lines.push('## 引用关系', '', '以下领域能力仅被本流程独占的活动引用,清理后将变为 orphaned:', '');
      for (const domain of onlyMine) lines.push(`- ${domain}`);
      lines.push('');
    }
    lines.push('## 待删除(文档层)', '');
    lines.push(`- ${flow.rel}`);
    lines.push(`- ${path.relative(root, flow.reviewPath)}(若存在)`);
    for (const item of exclusive) {
      lines.push(`- ${service.rel}/${item.slug}/  整个目录(仅被本流程编排)`);
      lines.push(`- blueprint/codemap/${flow.capability}/${service.slug}/${item.slug}.yaml`);
    }
    lines.push(`- lock.json 中 flows.${id}${exclusive.length ? ` 与 activities 下 ${exclusive.map((e) => e.aid).join('、')}` : ''}`, '');
    if (service.flows.length === 1) {
      lines.push(`> 这是 ${flow.service} 的最后一个流程,删除后整个服务目录 \`${service.rel}/\` 都可以删掉。`, '');
    }
    const codeFiles = new Set();
    for (const item of exclusive) {
      for (const codeFile of repo.lock.activities?.[item.aid]?.impl?.files || []) codeFiles.add(codeFile);
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
    if (isDomain) lines.push(`领域能力 \`${id}\` 已无任何业务活动 \`uses\` 引用。`, '');
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
        lines.push('## 引用关系', '', '以下领域能力仅被本活动引用,清理后将变为 orphaned:', '');
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
