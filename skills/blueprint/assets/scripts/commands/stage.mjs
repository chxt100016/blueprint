import { globalStage, STAGE_ACTION } from '../lib/stage.mjs';
import { out } from '../runtime/cli.mjs';
import { ctx } from '../runtime/context.mjs';
import { table } from '../runtime/format.mjs';

export function run(cli) {
  const { repo } = ctx(cli);
  const result = globalStage(repo);
  const action = STAGE_ACTION[result.stage];
  if (cli.flag('json')) {
    out(JSON.stringify({ stage: result.stage, action, rows: result.rows }, null, 2));
    return;
  }
  out(`stage   ${result.stage}`);
  out(`动作    ${action.text}`);
  if (result.rows.length) {
    out('');
    table(result.rows.map((row) => [row.id, row.state, row.detail || '']));
  }
}
