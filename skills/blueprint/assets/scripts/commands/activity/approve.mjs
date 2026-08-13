import fs from 'node:fs';

import { exists } from '../../lib/parse.mjs';
import {
  anchorOf, loadLock, missingForService, saveLock, activityReviews, flowsHash,
} from '../../lib/repo.mjs';
import { validateActivity, validateFlow, validateService } from '../../lib/schema.mjs';
import { errOut, fail, out } from '../../runtime/cli.mjs';
import { ctx, nowIso } from '../../runtime/context.mjs';
import { serviceOrDie } from '../../runtime/entities.mjs';
import { requireCleanReviews } from '../../runtime/reviews.mjs';
import { printErrors } from '../../runtime/validation.mjs';

export function run(cli, [serviceId]) {
  const { repo } = ctx(cli);
  if (!serviceId) fail('用法: bp activity approve <service>');
  const service = serviceOrDie(repo, serviceId);

  // 活动被本服务的多个流程共用,所以要求全部流程都已定稿才进活动层
  const pending = service.flows.filter((fid) => !repo.lock.flows?.[fid]?.flow);
  if (pending.length) fail(`以下业务流程尚未通过 bp flow approve: ${pending.join(', ')}`);

  for (const fid of service.flows) {
    const flow = repo.flows.get(fid);
    const anchor = anchorOf(repo, flow.product);
    if (!anchor) fail(`product 锚点 ${flow.product} 不存在`);
    if (anchor.anchor.hash !== repo.lock.flows[fid].flow.product_hash) {
      fail(`product 描述在 ${fid} 的 flow approve 之后又被改过,流程需重新整理。先跑 bp stage`);
    }
  }

  requireCleanReviews(activityReviews(repo, serviceId));

  const listed = service.activityList.map((item) => item.slug);
  const dirs = service.activities.map((activity) => activity.split('.').pop());
  const onlyListed = listed.filter((slug) => !dirs.includes(slug));
  const onlyDirs = dirs.filter((slug) => !listed.includes(slug));
  if (onlyListed.length || onlyDirs.length) {
    errOut('「活动编排」与活动目录不一致:');
    for (const slug of onlyListed) errOut(`  编排中有但目录缺失: ${slug}`);
    for (const slug of onlyDirs) errOut(`  目录中有但不被任何流程编排: ${slug}`);
    process.exit(1);
  }

  const errors = [...validateService(repo, serviceId)];
  for (const flowId of service.flows) errors.push(...validateFlow(repo, flowId));
  for (const activityId of service.activities) errors.push(...validateActivity(repo, activityId));
  if (errors.length) { printErrors(errors); process.exit(1); }

  const lockData = loadLock(repo.root);
  const approvedAt = nowIso();
  for (const activityId of service.activities) {
    const activity = repo.activities.get(activityId);
    const previous = lockData.activities[activityId] || {};
    lockData.activities[activityId] = {
      ...previous,
      spec: { service: serviceId, activity_hash: activity.hash, approved_at: approvedAt },
    };
  }
  lockData.services[serviceId] = {
    ...(lockData.services[serviceId] || {}),
    activity: { flows_hash: flowsHash(repo, serviceId), approved_at: approvedAt },
  };
  saveLock(repo.root, lockData);

  for (const target of activityReviews(repo, serviceId)) {
    if (exists(target.path)) fs.rmSync(target.path);
  }
  const missing = missingForService(repo, serviceId);
  out(`已确认 ${serviceId} 的 ${service.activities.length} 个业务活动(供 ${service.flows.length} 个流程编排)`);
  if (missing.length) out(`其中登记了 ${missing.length} 个待设计的领域能力:${missing.join(', ')}`);
}
