import { isDomainId } from '../../lib/config.mjs';
import { validateCodemap } from '../../lib/codemap.mjs';
import { loadLock, saveLock } from '../../lib/repo.mjs';
import { contractFields, validateActivity, validateDomain } from '../../lib/schema.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { baseCommit, ctx, nowIso } from '../../runtime/context.mjs';
import { printErrors } from '../../runtime/validation.mjs';

export function run(cli, [id]) {
  const { root, repo } = ctx(cli);
  const all = cli.flag('all');
  if (!id && !all) fail('用法: bp code adopt <id> | --all');
  const ids = all
    ? [...repo.domains.keys(), ...repo.activities.keys()]
    : (repo.services.has(id) ? repo.services.get(id).activities : [id]);

  const lockData = loadLock(root);
  const done = [];
  for (const target of ids) {
    const isDomain = isDomainId(target);
    const obj = isDomain ? repo.domains.get(target) : repo.activities.get(target);
    if (!obj) fail(`找不到 ${target}`);
    const errors = isDomain ? validateDomain(repo, target) : validateActivity(repo, target);
    if (errors.length) { printErrors(errors); process.exit(1); }
    const codemap = validateCodemap(root, target);
    if (codemap.errors.length) { printErrors(codemap.errors); process.exit(1); }
    const key = isDomain ? 'domain_hash' : 'activity_hash';
    const bucket = isDomain ? lockData.domains : lockData.activities;
    const previous = bucket[target] || {};
    bucket[target] = {
      ...previous,
      spec: previous.spec || {
        ...(isDomain ? { introduced_by: null } : { service: obj.service }),
        [key]: obj.hash,
        approved_at: nowIso(),
        ...(isDomain ? { contract_fields: contractFields(obj) } : {}),
      },
      impl: {
        [key]: obj.hash,
        files: codemap.files,
        verified_at: nowIso(),
        base_commit: baseCommit(root),
      },
    };
    done.push(target);
  }
  saveLock(root, lockData);
  out(`已接入 ${done.length} 个对象(跳过 verify)`);
  for (const target of done) out('  ' + target);
}
