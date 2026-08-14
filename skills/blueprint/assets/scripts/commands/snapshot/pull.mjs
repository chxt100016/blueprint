import { pull as pullDb } from '../../lib/db.mjs';
import { listRpcContext, pullRpcFile, rpcContextDir } from '../../lib/rpc.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx, nowIso } from '../../runtime/context.mjs';

const USAGE = '用法: bp snapshot pull <db|rpc> [<capability>[/<外部系统>]]';

function pullRpc(root, scope) {
  const [capability, system] = String(scope || '').split('/');
  const targets = listRpcContext(root, { capability: capability || null, system: system || null });
  if (!targets.length) {
    fail(`${rpcContextDir(root)} 下没有匹配的文件。\n`
      + '一个 capability 一层目录,一个外部系统一份 md,见该目录的 README.md', 2);
  }
  const at = nowIso();
  let ok = 0;
  const failed = [];
  for (const target of targets) {
    const result = pullRpcFile(root, target, at);
    ok += result.ok;
    for (const message of result.failed) failed.push(`${target.rel} ${message}`);
  }
  out(`已采样 ${ok} 个接口,来自 ${targets.length} 份文件`);
  if (failed.length) {
    out('');
    out(`未成功 ${failed.length} 个(其余接口不受影响,失败的保留上一次结果):`);
    for (const message of failed) out(`  ${message}`);
  }
}

export function run(cli, [type, scope]) {
  const { root } = ctx(cli);
  if (!type) fail(USAGE);
  if (type === 'db') {
    try {
      const result = pullDb(root);
      out(`已导出 ${result.tables.length} 张表`);
    } catch (error) {
      fail(`snapshot pull db 失败,保留现有 snapshot:${error.message}`);
    }
    return;
  }
  if (type === 'rpc') return pullRpc(root, scope);
  fail(USAGE);
}
