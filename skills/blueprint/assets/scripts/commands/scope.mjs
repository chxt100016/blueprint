import path from 'node:path';

import { isDomainId, resolveScope } from '../lib/config.mjs';
import { loadCodemap } from '../lib/codemap.mjs';
import { flowsOfActivity } from '../lib/repo.mjs';
import { snapshotTableFile } from '../lib/db.mjs';
import { fail, out } from '../runtime/cli.mjs';
import { ctx } from '../runtime/context.mjs';

export function run(cli, [id]) {
  const { root, cfg, repo } = ctx(cli);
  if (!id) fail('用法: bp scope <id>');
  const lines = [];
  const seen = new Set();
  const add = (value) => { if (value && !seen.has(value)) { seen.add(value); lines.push(value); } };

  const isDomain = isDomainId(id);
  const obj = isDomain ? repo.domains.get(id) : repo.activities.get(id);
  if (!obj) fail(`找不到 ${id}`);

  if (!isDomain) {
    // 编排了本活动的流程给整份:同一个活动可能服务于多个接口,
    // 入口的出入参与对外失败码映射只写在流程文档里
    for (const flowId of flowsOfActivity(repo, id)) {
      const flow = repo.flows.get(flowId);
      if (flow) add(flow.rel);
    }
    const service = repo.services.get(obj.service);
    if (service?.hasServiceDoc) add(service.serviceRel);
    add(obj.rel);
    for (const dependency of obj.depends_on) {
      const activity = repo.activities.get(dependency);
      // 契约与失败形态各占一节:调用方既要知道传什么,也要知道会被报什么错
      if (activity) { add(`${activity.rel}#活动契约`); add(`${activity.rel}#异常分支`); }
    }
    for (const use of obj.uses) {
      const domain = repo.domains.get(use);
      // 两类骨架章节不同:聚合要看能调哪些命令,领域服务要看出入参
      if (domain) add(`${domain.rel}#${domain.kind === 'service' ? '契约' : '命令'}`);
      else add(`blueprint/domain/${use.slice(1).replace('.', '/')}/domain.md  (缺失)`);
    }
  } else {
    add(obj.rel);
  }

  // tables 是聚合的读写所有权,reads 是领域服务与查询活动的只读引用
  for (const table of [...(obj.tables || []), ...(obj.reads || [])]) {
    if (!table?.name) continue;
    const file = snapshotTableFile(root, table.name);
    add(path.relative(root, file.path) + (file.exists ? '' : '  (缺失)'));
  }
  const lockEntry = isDomain ? repo.lock.domains?.[id] : repo.lock.activities?.[id];
  const codemap = loadCodemap(root, id);
  // 已实现过的先给 codemap 登记的文件,让改动落回原处而不是重写一份
  if (lockEntry?.impl && codemap?.files?.length) {
    for (const entry of codemap.files) add(typeof entry === 'string' ? entry : entry?.path);
  }
  // 目录两种情况都给:增量实现同样会需要新文件,只给旧文件等于没有落点。
  // 标注是为了与 always_readable 区分——那些是只读的共享路径,这里才是能写的地方
  for (const dir of Object.values(resolveScope(cfg, id))) add(`${dir}  (代码落点)`);
  for (const readable of cfg.always_readable || []) add(readable);
  for (const line of lines) out(line);
}
