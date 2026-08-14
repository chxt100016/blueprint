import { snapshotTableFile } from '../../lib/db.mjs';
import { listRpcSnapshot } from '../../lib/rpc.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { readFileSafe } from '../../lib/parse.mjs';

const USAGE = '用法: bp snapshot show <db <表名>|rpc <id>>';

export function run(cli, [type, id]) {
  const { root } = ctx(cli);
  if (!type || !id) fail(USAGE);
  if (type === 'db') {
    const { path: file, exists } = snapshotTableFile(root, id);
    if (!exists) fail(`db 快照里没有 ${id},先跑 bp snapshot pull db`, 2);
    out(readFileSafe(file).trimEnd());
    return;
  }
  if (type === 'rpc') {
    const items = listRpcSnapshot(root);
    // id 是 <capability>.<文件名>.<##标题>,标题里可能带点,所以按前缀匹配而不是切三段
    const hit = items.find((item) => item.id === id)
      || items.filter((item) => item.id.includes(id));
    if (!hit || (Array.isArray(hit) && !hit.length)) {
      fail(`rpc 快照里没有 ${id},用 bp snapshot list rpc 看有哪些`, 2);
    }
    if (Array.isArray(hit) && hit.length > 1) {
      out(`${id} 匹配到多个,请写全:`);
      for (const item of hit) out(`  ${item.id}`);
      return;
    }
    const item = Array.isArray(hit) ? hit[0] : hit;
    out(`# ${item.id}`);
    out(`来源 ${item.rel}`);
    out('');
    out(item.raw.trimEnd());
    return;
  }
  fail(USAGE);
}
