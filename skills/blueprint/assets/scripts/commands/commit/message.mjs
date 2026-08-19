import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { pad, width } from '../../runtime/format.mjs';
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

  // id 列按本次最长的 id 撑开,不用固定宽度:活动 id 是四段式,
  // 固定宽度一遇到长一点的名字就把 kind 列顶出去,整块对不齐。
  const rows = [];
  const block = (label, list) => {
    list.forEach((item, index) => rows.push([index === 0 ? label : '', item.id, item.kind]));
  };
  block('业务描述', context.products);
  block('业务服务', context.services);
  block('业务流程', context.flows);
  block('业务活动', context.activities);
  block('领域模型', context.domains);
  const idWidth = rows.reduce((max, row) => Math.max(max, width(row[1]) + 2), 0);

  const tail = ['--- blueprint ---'];
  for (const [label, id, kind] of rows) tail.push(`${pad(label, 10)}${pad(id, idWidth)}${kind}`);
  if (context.impl_file_count) tail.push(`${pad('实现', 10)}${context.impl_file_count} 个文件`);
  if (context.migration) tail.push(`${pad('迁移', 10)}${context.migration}`);

  out([`${type}(${scope}): ${title}`, '', body, '', tail.join('\n')].join('\n').replace(/\n{3,}/g, '\n\n'));
}
