import { loadLock, saveLock, servicesOfDomain } from '../../lib/repo.mjs';
import { validateDomain } from '../../lib/schema.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx, nowIso } from '../../runtime/context.mjs';
import { domainOrDie } from '../../runtime/entities.mjs';
import { requireCleanReviews, settleReviews } from '../../runtime/reviews.mjs';
import { printErrors } from '../../runtime/validation.mjs';

const KIND_LABEL = { aggregate: '聚合', service: '领域服务' };

export function run(cli, [id]) {
  const { repo } = ctx(cli);
  if (!id) fail('用法: bp domain approve <@id>');
  const domain = domainOrDie(repo, id);

  const reviews = domain.review
    ? [{ label: id, path: domain.reviewPath, review: domain.review }]
    : [];
  requireCleanReviews(reviews);

  const errors = validateDomain(repo, id);
  if (errors.length) { printErrors(errors); process.exit(1); }

  const lockData = loadLock(repo.root);
  const previous = lockData.domains[id] || {};
  lockData.domains[id] = {
    ...previous,
    spec: {
      domain_hash: domain.hash,
      approved_at: nowIso(),
      introduced_by: previous.spec?.introduced_by || servicesOfDomain(repo, domain)[0] || null,
    },
  };
  saveLock(repo.root, lockData);
  const settled = settleReviews(reviews);
  out(`已确认${KIND_LABEL[domain.kind] || '领域模型'} ${id} 的契约`);
  if (settled) out(`${settled} 条澄清已存档到 ${domain.reviewRel} 的「已确认」`);
}
