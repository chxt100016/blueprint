import { loadLock, saveLock, usesHash } from '../../lib/repo.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { baseCommit, ctx, nowIso } from '../../runtime/context.mjs';
import { printErrors } from '../../runtime/validation.mjs';
import { implPrecheck, runVerify, verifyScopesForId } from '../../runtime/verify.mjs';

export function run(cli, [id]) {
  const { root, cfg, repo } = ctx(cli);
  if (!id) fail('用法: bp code done <id>');
  const { problems, files, obj, isDom, key } = implPrecheck(repo, id);
  if (problems.length) { printErrors(problems); process.exit(1); }

  if (!runVerify(root, cfg, verifyScopesForId(cfg, id, files))) process.exit(1);

  const lockData = loadLock(root);
  const bucket = isDom ? lockData.domains : lockData.activities;
  bucket[id] = {
    ...(bucket[id] || {}),
    impl: {
      [key]: obj.hash,
      // 活动另记它引用的领域契约:那些改了活动文档不会跟着变,
      // 只有这个字段能把调用方的实现重新拉回 code 层
      ...(isDom ? {} : { uses_hash: usesHash(repo, id) }),
      files,
      verified_at: nowIso(),
      base_commit: baseCommit(root),
    },
  };
  saveLock(root, lockData);
  out(`已记录 ${id} 的实现(${files.length} 个文件)`);
}
