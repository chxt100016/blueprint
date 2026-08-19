// 各层的待办清单:每层一张扁平表,一行一个待办对象,只给 id 与状态。
//
// 详情不在这里给。scan 的读者一次只推进其中一个对象,把每个对象的全景都铺开
// 等于让待办数量去乘全景长度——20 个服务就是 20 倍的浪费,而其中 19 份读完即弃。
// 拿到 id 之后用 `bp flow <id>` / `bp activity <id>` 取那一条的全部上下文。
import { scanLayer, scanCode, openRows, LAYERS } from '../lib/stage.mjs';
import { fail, out } from '../runtime/cli.mjs';
import { ctx } from '../runtime/context.mjs';
import { table } from '../runtime/format.mjs';

export function run(cli, [layer]) {
  const { repo } = ctx(cli);
  if (!layer) fail(`用法: bp scan <${LAYERS.join('|')}>(全局进度看 bp stage)`);
  if (!LAYERS.includes(layer)) fail(`未知的层: ${layer}(可选 ${LAYERS.join(' / ')})`);

  // code 层的「等人」那组单独列在末尾:它们的动作方是人,skill 对它们什么也做不了
  const blocked = layer === 'code' ? scanCode(repo).blocked : [];
  const open = openRows(scanLayer(repo, layer));

  if (!open.length && !blocked.length) { out(`${layer} 层全部就绪`); return; }
  if (open.length) table(open.map((row) => [row.id, row.detail]));
  else out(`${layer} 层没有可做的对象`);
  if (blocked.length) {
    out('');
    out(`等人处理(跳过,不阻断本层完成):`);
    table(blocked.map((row) => [`  ${row.id}`, row.detail]));
  }
}
