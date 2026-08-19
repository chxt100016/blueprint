import { loadSnapshot } from '../../lib/db.mjs';
import { listRpcSnapshot } from '../../lib/rpc.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { clip, table } from '../../runtime/format.mjs';

const USAGE = '用法: bp snapshot list <db|rpc> [<capability>]';

export function run(cli, [type, scope]) {
  const { root } = ctx(cli);
  if (type === 'db') {
    const snap = loadSnapshot(root);
    if (!snap.tables.size) { out('db 快照为空,跑 bp snapshot pull db'); return; }
    table([...snap.tables.values()]
      .sort((a, b) => a.table.localeCompare(b.table))
      .map((t) => [t.table, `${t.columns.length} 列`, clip(t.comment, 40)]));
    return;
  }
  if (type === 'rpc') {
    const items = listRpcSnapshot(root, { capability: scope || null });
    if (!items.length) { out('rpc 快照为空,跑 bp snapshot pull rpc'); return; }
    table(items.map((item) => [
      item.id,
      clip(item.summary, 40),
      `${item.method} ${item.url}`,
      item.at,
    ]));
    return;
  }
  fail(USAGE);
}
