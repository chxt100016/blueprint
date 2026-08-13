import fs from 'node:fs';

import { exists } from '../../lib/parse.mjs';
import { anchorOf, loadLock, saveLock, flowReviews } from '../../lib/repo.mjs';
import { validateFlow, validateService } from '../../lib/schema.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx, nowIso } from '../../runtime/context.mjs';
import { flowOrDie } from '../../runtime/entities.mjs';
import { requireCleanReviews } from '../../runtime/reviews.mjs';
import { printErrors } from '../../runtime/validation.mjs';

export function run(cli, [flowId]) {
  const { repo } = ctx(cli);
  if (!flowId) fail('用法: bp flow approve <flow>');
  const flow = flowOrDie(repo, flowId);

  requireCleanReviews(flowReviews(repo, flowId));

  // 服务级校验一并跑:锚点归属、活动编排与目录的对应关系都是跨流程才成立的事实
  const errors = [...validateFlow(repo, flowId), ...validateService(repo, flow.service)];
  if (errors.length) { printErrors(errors); process.exit(1); }

  const anchor = anchorOf(repo, flow.product);
  if (!anchor) fail(`product 锚点 ${flow.product} 不存在`);

  const lockData = loadLock(repo.root);
  const previous = lockData.flows[flowId] || {};
  lockData.flows[flowId] = {
    ...previous,
    product_anchor: flow.product,
    flow: {
      product_hash: anchor.anchor.hash,
      flow_hash: flow.hash,
      approved_at: nowIso(),
    },
  };
  saveLock(repo.root, lockData);
  if (exists(flow.reviewPath)) fs.rmSync(flow.reviewPath);
  out(`已确认 ${flowId} 的业务流程与活动编排`);
}
