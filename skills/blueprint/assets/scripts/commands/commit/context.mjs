import { out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { table } from '../../runtime/format.mjs';
import { buildCommitContext } from './shared.mjs';

export function run(cli) {
  const { repo } = ctx(cli);
  const context = buildCommitContext(repo);
  const line = (label, list) => {
    if (!list.length) return;
    out(label);
    table(list.map((item) => [`  ${item.kind}`, item.id]));
  };
  out(`商业能力范围  ${context.capabilities.join(', ') || '(无)'}`);
  out('');
  line('业务描述', context.products);
  line('业务服务', context.services);
  line('业务流程', context.flows);
  line('业务活动', context.activities);
  line('领域模型', context.domains);
  out('');
  out(`已实现对象  ${context.implemented.length}`);
  out(`提交文件    ${context.files.length}(其中代码 ${context.impl_file_count})`);
  if (context.migration) out(`数据库迁移  ${context.migration}`);
  out('');
  out('files:');
  for (const file of context.files) out(`  ${file}`);
}
