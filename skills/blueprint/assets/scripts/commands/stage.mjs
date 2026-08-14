import { globalStage, STAGE_ACTION } from '../lib/stage.mjs';
import { out } from '../runtime/cli.mjs';
import { ctx } from '../runtime/context.mjs';
import { table } from '../runtime/format.mjs';

export function run(cli) {
  const { repo } = ctx(cli);
  const result = globalStage(repo);
  const action = STAGE_ACTION[result.stage];

  // 告警打在最前面,但它不改变 stage:引用断裂不该拦住其他服务往下走
  if (result.warnings.length) {
    out(`告警    ${result.warnings.length} 个对象引用断裂,清理用 bp delete plan <id>`);
    table(result.warnings.map((row) => [`  ${row.id}`, row.detail]));
    out('');
  }

  out(`stage   ${result.stage}`);
  out(`动作    ${action.text}`);
  if (result.rows.length) {
    out('');
    table(result.rows.map((row) => [row.id, row.detail]));
  }

  // 等人的对象附在末尾。它们不占 stage——人做完之前,上游各层照样能推进,
  // 所以只有 stage 已经是 none 时,这一段才是「现在轮到人了」的意思。
  if (result.blocked.length) {
    out('');
    out(result.stage === 'none'
      ? `${result.blocked.length} 个对象等人处理:`
      : `另有 ${result.blocked.length} 个对象等人处理(不影响当前 stage):`);
    table(result.blocked.map((row) => [`  ${row.id}`, row.detail]));
  }
}
