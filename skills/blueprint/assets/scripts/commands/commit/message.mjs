import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { pad } from '../../runtime/format.mjs';
import { buildCommitContext } from './shared.mjs';

export function run(cli) {
  const { cfg, repo } = ctx(cli);
  const summary = cli.option('summary');
  if (!summary) fail('用法: bp commit message --summary "<正文>"');
  const context = buildCommitContext(repo);
  const rules = cfg.commit?.type_rules || {};
  const hasNew = [...context.flows, ...context.activities, ...context.domains]
    .some((item) => item.kind === '新增');
  const type = hasNew ? (rules.has_new_activity || 'feat') : (rules.only_modified || 'fix');
  const scope = context.capabilities.join(',') || 'blueprint';

  const parts = String(summary).replace(/\r\n?/g, '\n').split('\n');
  const title = parts[0].trim();
  const body = parts.slice(1).join('\n').trim();

  const tail = ['--- blueprint ---'];
  const block = (label, list) => {
    list.forEach((item, index) => tail.push(`${pad(index === 0 ? label : '', 10)}${pad(item.id, 34)}${item.kind}`));
  };
  block('商业能力', context.products);
  block('业务服务', context.services);
  block('业务流程', context.flows);
  block('业务活动', context.activities);
  block('领域能力', context.domains);
  if (context.impl_file_count) tail.push(`${pad('实现', 10)}${context.impl_file_count} 个文件`);
  if (context.migration) tail.push(`${pad('迁移', 10)}${context.migration}`);

  out([`${type}(${scope}): ${title}`, '', body, '', tail.join('\n')].join('\n').replace(/\n{3,}/g, '\n\n'));
}
