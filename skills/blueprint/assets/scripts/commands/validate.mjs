import { loadSnapshot } from '../lib/db.mjs';
import { validateId } from '../lib/schema.mjs';
import { out } from '../runtime/cli.mjs';
import { ctx } from '../runtime/context.mjs';
import { printErrors } from '../runtime/validation.mjs';

/**
 * 表结构比对是 validate 的一部分,但 snapshot 没导出过时只能跳过:
 * 空 snapshot 只说明还没跑过 pull,不代表库里没有这些表——据此生成建表工单会建错。
 */
function snapshotNotice(root, repo) {
  const declared = [...repo.activities.values(), ...repo.domains.values()]
    .some((decl) => decl.tables?.length || decl.reads?.length);
  if (!declared || loadSnapshot(root).exists) return;
  out('');
  out('提示: snapshot 尚未生成,表结构比对已跳过。先配好 blueprint/context/db.yaml');
  out('      再运行 bp snapshot pull db。snapshot 为空只说明还没导出过,不代表库里');
  out('      没有这些表,不要据此生成建表工单。');
}

export function run(cli, [id]) {
  const { root, repo } = ctx(cli);
  const errors = validateId(repo, id);
  if (!errors.length) {
    out(id ? `${id} 校验通过` : '全部校验通过');
    snapshotNotice(root, repo);
    return;
  }
  printErrors(errors);
  out('');
  out(`${errors.length} 项不通过`);
  snapshotNotice(root, repo);
  process.exit(3);
}
