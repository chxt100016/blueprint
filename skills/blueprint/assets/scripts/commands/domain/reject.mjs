import { isDomainId } from '../../lib/config.mjs';
import { loadLock, saveLock } from '../../lib/repo.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx, nowIso } from '../../runtime/context.mjs';

export function run(cli, [id]) {
  const { repo } = ctx(cli);
  const reason = cli.option('reason');
  if (!id || !reason) fail('用法: bp domain reject <@id> --reason "<理由>"');
  if (!isDomainId(id)) fail('领域能力 id 应以 @ 开头');
  const lockData = loadLock(repo.root);
  lockData.rejected_domains = lockData.rejected_domains || {};
  lockData.rejected_domains[id] = { reason, at: nowIso() };
  saveLock(repo.root, lockData);
  out(`已记录:${id} 不提取为领域能力(${reason})`);
  out('activity skill 之后不会再就该项反复询问。');
}
