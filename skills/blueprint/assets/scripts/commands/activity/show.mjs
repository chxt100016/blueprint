// `bp activity <id>`:activity 层按 id 取上下文,与 `bp flow <id>` 同构。
//
// 服务 id 给的是上游流程的全文 + 本服务活动池的现状。上游给全文而不是清单:
// 活动契约是从流程步骤逐条译出来的,只给概要等于让 skill 去猜步骤。
import { idKind } from '../../lib/config.mjs';
import { activityPool } from '../../lib/repo.mjs';
import { isClean, stateLabel } from '../../lib/review.mjs';
import { dirtyActivities, flowsChanged } from '../../lib/stage.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';

const USAGE = '用法: bp activity <serviceId>|<activityId>(子命令见 bp activity changes|approve)';

const band = (title, note) => out(`\n── ${title} ──${note ? `  ${note}` : ''}\n`);

const openReview = (review) => (review && !isClean(review) ? stateLabel(review) : null);

export function run(cli, [id]) {
  if (!id) fail(USAGE);
  const { repo } = ctx(cli);
  const kind = idKind(id);
  if (kind === 'service') return showService(repo, id);
  if (kind === 'activity') return showActivity(repo, id);
  fail(`${id} 不是业务服务或业务活动的 id\n${USAGE}`);
}

function showService(repo, id) {
  const svc = repo.services.get(id);
  if (!svc) fail(`找不到业务服务 ${id}`);
  if (!svc.flows.length) fail(`${id} 还没有流程,activity 层无事可做`);
  out(id);

  band('上游流程', flowsChanged(repo, id) ? '已变更' : '');
  for (const fid of svc.flows) {
    out(`\n${'='.repeat(4)} ${fid} ${'='.repeat(4)}\n`);
    out(repo.flows.get(fid).raw.trimEnd());
  }

  const dirty = new Map(dirtyActivities(repo, id).map((d) => [d.id, d.kind]));
  const pool = activityPool(repo, id);
  band('活动', pool.length ? '' : '(无)');
  for (const item of pool) {
    const act = repo.activities.get(item.id);
    const marks = [act ? dirty.get(item.id) : '未产出', openReview(act?.review)].filter(Boolean).join('  ');
    out(`${item.id}${marks ? `   ${marks}` : '   已确认'}`);
    out(`  概要  ${item.summary.split('\n')[0].trim() || '(未写)'}`);
    out(`  编排  ${item.usedBy.join('  ') || '(无)'}`);
    if (act?.uses.length) out(`  领域依赖  ${act.uses.join('  ')}`);
  }
}

function showActivity(repo, id) {
  const act = repo.activities.get(id);
  if (!act) fail(`找不到业务活动 ${id}`);
  // 带上路径:读既有活动多半是为了改它,只给全文等于让 skill 自己拼路径
  band('活动文档', act.rel);
  out(act.raw);
}
