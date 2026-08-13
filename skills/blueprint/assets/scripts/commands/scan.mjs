import { globalStage, scanLayer, STAGE_ACTION, LAYERS } from '../lib/stage.mjs';
import { fail, out } from '../runtime/cli.mjs';
import { ctx } from '../runtime/context.mjs';
import { pad, table } from '../runtime/format.mjs';

function scanProduct(repo) {
  for (const product of [...repo.products.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    out(`${product.id}.md`);
    for (const title of product.anchors.keys()) {
      // 一个锚点(业务服务)可以有多个流程,每个流程是一个对外接口
      const users = repo.anchorUsers.get(`${product.id}#${title}`) || [];
      if (!users.length) { out(`  ${pad(title, 28)}(未开始)`); continue; }
      out(`  ${pad(title, 28)}${users.length} 个流程`);
      for (const fid of users) {
        const flow = repo.flows.get(fid);
        const entry = Object.values(flow?.entry || {}).join(' ');
        out(`    ${pad(fid, 40)}${entry}`);
      }
    }
  }
  if (!repo.products.size) out('blueprint/product/ 下还没有商业能力文件');
}

function scanOverview(repo) {
  const result = globalStage(repo);
  const rows = [];
  for (const layer of LAYERS) {
    const all = scanLayer(repo, layer);
    const open = all.filter((row) => row.state !== 'done');
    const by = {};
    for (const row of open) by[row.state] = (by[row.state] || 0) + 1;
    const detail = Object.entries(by).map(([key, count]) => `${key} ${count}`).join('  ') || '全部就绪';
    rows.push([layer, `${all.length - open.length}/${all.length} done`, detail]);
  }
  table(rows);
  out('');
  out(`当前 stage  ${result.stage}   ${STAGE_ACTION[result.stage].text}`);
}

export function run(cli, [layer]) {
  const { repo } = ctx(cli);
  if (!layer) return scanOverview(repo);
  if (layer === 'product') return scanProduct(repo);
  if (!LAYERS.includes(layer)) fail(`未知的层: ${layer}(可选 product / ${LAYERS.join(' / ')})`);
  const rows = scanLayer(repo, layer);
  const open = cli.flag('all') ? rows : rows.filter((row) => row.state !== 'done');
  if (cli.flag('json')) { out(JSON.stringify(open, null, 2)); return; }
  if (!open.length) { out(`${layer} 层全部就绪`); return; }
  table(open.map((row) => [row.id, row.state, row.detail || '']));
}
