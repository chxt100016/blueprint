import { execSync } from 'node:child_process';

import { isDomainId, resolveScope } from '../lib/config.mjs';
import { validateCodemap } from '../lib/codemap.mjs';
import { validateActivity, validateDomain } from '../lib/schema.mjs';
import { activityChange, domainChange } from '../lib/stage.mjs';
import { errOut, out } from './cli.mjs';

export function runVerify(root, cfg, scopes) {
  const list = scopes.filter((scope) => cfg.verify[scope]);
  if (!list.length) { out('config.verify 中没有可执行的条目,跳过'); return true; }
  for (const scope of list) {
    out(`verify ${scope}: ${cfg.verify[scope]}`);
    try {
      execSync(cfg.verify[scope], { cwd: root, stdio: 'inherit' });
    } catch {
      errOut(`verify ${scope} 失败`);
      return false;
    }
  }
  return true;
}

export function verifyScopesForId(cfg, id, files) {
  const scope = resolveScope(cfg, id);
  const hit = new Set();
  for (const file of files || []) {
    for (const [key, dir] of Object.entries(scope)) {
      if (String(file).startsWith(dir)) hit.add(key === 'domain' ? 'app' : key);
    }
  }
  if (!hit.size) for (const key of Object.keys(cfg.verify)) hit.add(key);
  return [...hit];
}

export function implPrecheck(repo, id) {
  const isDom = isDomainId(id);
  const obj = isDom ? repo.domains.get(id) : repo.activities.get(id);
  const problems = [];
  if (!obj) return { problems: [{ where: id, msg: '对象不存在' }] };

  problems.push(...(isDom ? validateDomain(repo, id) : validateActivity(repo, id)));

  // 判据与 scan 共用:「新增」= 还没盖过章,「修改」= 盖章之后又被改过
  const key = isDom ? 'domain_hash' : 'activity_hash';
  const change = isDom ? domainChange(repo, id) : activityChange(repo, id);
  if (change === '新增') problems.push({ where: id, msg: '尚未 approve,不能记录实现' });
  else if (change === '修改') {
    problems.push({ where: id, msg: '文档在 approve 之后被改动,需重新走 approve' });
  }

  // 编号章节由模板给出(活动 A,聚合 I 与 C,领域服务 R),codemap 的 covers 与它比对:
  // 这一层没有确认门,verify 只判编译过不过,漏实现一条全靠这里拦。
  const tplName = isDom ? obj.tplName : 'activity';
  const numbered = repo.cfg.templates[tplName]?.numbered;
  const codemap = validateCodemap(repo.root, id, { sections: obj.sections, numbered });
  problems.push(...codemap.errors);
  return { problems, files: codemap.files, obj, isDom, key };
}
