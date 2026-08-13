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
    // 编排了本活动的流程,全部要读:同一个活动可能服务于多个接口
    for (const flowId of flowsOfActivity(repo, id)) {
      const flow = repo.flows.get(flowId);
      if (flow) add(`${flow.rel}#流程`);
    }
    const service = repo.services.get(obj.service);
    if (service?.hasServiceDoc) add(service.serviceRel);
    add(obj.rel);
    for (const dependency of obj.depends_on) {
      const activity = repo.activities.get(dependency);
      if (activity) add(`${activity.rel}#输入输出`);
    }
    for (const use of obj.uses) {
      const domain = repo.domains.get(use);
      if (domain) add(`${domain.rel}#契约`);
      else add(`blueprint/domain/${use.slice(1).replace('.', '/')}/domain.md  (缺失)`);
    }
  } else {
    add(obj.rel);
  }

  for (const table of obj.tables || []) {
    if (!table?.name) continue;
    const file = snapshotTableFile(root, table.name);
    add(path.relative(root, file.path) + (file.exists ? '' : '  (缺失)'));
  }
  add('blueprint/CONVENTIONS.md');

  const lockEntry = isDomain ? repo.lock.domains?.[id] : repo.lock.activities?.[id];
  const codemap = loadCodemap(root, id);
  if (lockEntry?.impl && codemap?.files?.length) {
    for (const entry of codemap.files) add(typeof entry === 'string' ? entry : entry?.path);
  } else {
    for (const dir of Object.values(resolveScope(cfg, id))) add(dir);
  }
  for (const readable of cfg.always_readable || []) add(readable);
  for (const line of lines) out(line);
}
