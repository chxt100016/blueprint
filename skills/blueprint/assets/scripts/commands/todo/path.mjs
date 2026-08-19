// 工单该叫什么名字。文件内容由 skill 写,这里只回答命名——
// 归属 id 拼错的工单谁也挡不住,而这条规则不该散落在几份 skill 里各写一遍。
import path from 'node:path';

import { todoPath, TODO_KINDS } from '../../lib/todo.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';

export function run(cli, [id, kind]) {
  const { root, repo } = ctx(cli);
  if (!id || !TODO_KINDS.includes(kind)) fail(`用法: bp todo path <id> <${TODO_KINDS.join('|')}>`);

  // 归属必须是真实存在的对象:名字对不上任何东西的工单等于没建
  if (!repo.activities.has(id) && !repo.domains.has(id) && !repo.services.has(id)) {
    fail(`找不到 ${id}(工单要挂在业务活动、领域模型或业务服务上)`);
  }

  // 同一个对象的同类工单只有一份:人还没执行完就又来一轮时原地重写,时间戳保持不变,
  // 否则盘上会堆起同一件事的好几个副本,人不知道该执行哪个
  const existing = repo.todos.find((todo) => todo.owner === id && todo.kind === kind);
  out(existing ? existing.rel : path.relative(root, todoPath(root, id, kind)));
}
