import { isDomainId, idKind, ACTIVITY_MARK } from '../lib/config.mjs';
import { loadSnapshot } from '../lib/db.mjs';
import { findSection } from '../lib/parse.mjs';
import { relatedDomains, missingForService, flowsOfActivity } from '../lib/repo.mjs';
import { scanLayer, LAYERS } from '../lib/stage.mjs';
import { shortHash } from '../lib/hash.mjs';
import { fail, out } from '../runtime/cli.mjs';
import { ctx } from '../runtime/context.mjs';
import { pad } from '../runtime/format.mjs';

function entryText(flow) {
  return Object.entries(flow.entry || {}).map(([k, v]) => `${k} ${v}`).join('  ') || '(未声明)';
}

export function run(cli, [id]) {
  const { repo } = ctx(cli);
  if (!id) fail('用法: bp status <id>');
  loadSnapshot(repo.root);
  const kind = idKind(id);

  if (kind === 'capability' && repo.products.has(id)) {
    const product = repo.products.get(id);
    out(`商业能力  ${id}   ${product.rel}`);
    out('');
    for (const title of product.anchors.keys()) {
      const ref = `${id}#${title}`;
      const users = repo.anchorUsers.get(ref) || [];
      out(`${pad(title, 24)}${users.length ? users.join(', ') : '(未认领)'}`);
    }
    return;
  }

  if (repo.services.has(id)) {
    const service = repo.services.get(id);
    const lock = repo.lock.services?.[id] || {};
    out(`业务服务  ${id}`);
    out(`目录      ${service.rel}${service.hasServiceDoc ? '' : '   (无 service.md)'}`);
    out('');
    out('业务流程');
    const flowRows = scanLayer(repo, 'flow');
    for (const fid of service.flows) {
      const flow = repo.flows.get(fid);
      const hit = flowRows.find((row) => row.id === fid);
      out(`  ${pad(flow.slug, 20)}${pad(hit ? hit.state : '(未产出)', 10)}${entryText(flow)}`);
    }
    const hitActivity = scanLayer(repo, 'activity').find((row) => row.id === id);
    if (hitActivity) out(`\n活动层    ${pad(hitActivity.state, 10)}${hitActivity.detail}`);
    out('');
    out('业务活动');
    const codeRows = scanLayer(repo, 'code');
    for (const item of service.activityList) {
      const activityId = `${id}.${ACTIVITY_MARK}.${item.slug}`;
      const hit = codeRows.find((row) => row.id === activityId);
      const flows = flowsOfActivity(repo, activityId).map((f) => f.split('.').pop());
      out(`  ${pad(item.slug, 20)}${pad(hit ? hit.state : '(未产出)', 12)}${flows.join(', ')}`);
    }
    const domains = relatedDomains(repo, id).map((domain) => domain.id);
    const missing = missingForService(repo, id);
    if (domains.length || missing.length) {
      out('');
      out('领域能力');
      for (const domain of domains) {
        const hit = codeRows.find((row) => row.id === domain);
        out(`  ${pad(domain, 22)}${hit ? hit.state : '(未确认)'}`);
      }
      for (const domain of missing) out(`  ${pad(domain, 22)}未设计`);
    }
    return;
  }

  if (repo.flows.has(id)) {
    const flow = repo.flows.get(id);
    const lock = repo.lock.flows?.[id]?.flow;
    out(`业务流程  ${id}   ${flow.fm.title || ''}`);
    out(`业务服务  ${flow.service}`);
    out(`锚点      ${flow.product || '(未声明)'}`);
    out(`对外接口  ${entryText(flow)}`);
    const hit = scanLayer(repo, 'flow').find((row) => row.id === id);
    if (hit) out(`${pad('flow', 10)}${pad(hit.state, 10)}${hit.detail}`);
    out(`文档      ${flow.rel}   ${shortHash(flow.hash)}`);
    out(`已确认    ${lock?.flow_hash ? shortHash(lock.flow_hash) + '  ' + lock.approved_at : '(未确认)'}`);
    const steps = findSection(flow.sections, '流程');
    if (steps) {
      out('');
      out('流程');
      for (const line of steps.body.split('\n').filter((item) => item.trim())) out('  ' + line);
    }
    out('');
    out('活动编排');
    for (const item of flow.activityList) out(`  ${pad(item.slug, 20)}${item.summary || ''}`);
    return;
  }

  const obj = repo.activities.get(id) || repo.domains.get(id);
  if (!obj) fail(`找不到 ${id}`);
  const isDomain = isDomainId(id);
  const lockEntry = isDomain ? repo.lock.domains?.[id] : repo.lock.activities?.[id];
  const key = isDomain ? 'domain_hash' : 'activity_hash';
  out(`${isDomain ? '领域能力' : '业务活动'}  ${id}   ${obj.fm.title || ''}`);
  for (const layer of LAYERS) {
    const hit = scanLayer(repo, layer).find((row) => row.id === id);
    if (hit) out(`${pad(layer, 10)}${pad(hit.state, 10)}${hit.detail}`);
  }
  out(`文档      ${obj.rel}   ${shortHash(obj.hash)}`);
  out(`spec      ${lockEntry?.spec ? shortHash(lockEntry.spec[key]) + '  ' + lockEntry.spec.approved_at : '(未确认)'}`);
  out(`impl      ${lockEntry?.impl ? shortHash(lockEntry.impl[key]) + '  ' + lockEntry.impl.verified_at : '(未实现)'}`);
  if (!isDomain) {
    out(`被编排    ${flowsOfActivity(repo, id).join(', ') || '(无)'}`);
    out(`依赖      ${obj.depends_on.join(', ') || '无'}`);
    out(`引用      ${obj.uses.join(', ') || '无'}`);
  } else {
    out(`引用方    ${obj.usedBy.join(', ') || '无'}`);
  }
  if (lockEntry?.impl?.files?.length) {
    out('');
    out('实现文件');
    for (const file of lockEntry.impl.files) out('  ' + file);
  }
}
