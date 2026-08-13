import { loadLock, saveLock, servicesOfDomain } from '../../lib/repo.mjs';
import { contractFields, validateDomain } from '../../lib/schema.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx, nowIso } from '../../runtime/context.mjs';
import { domainOrDie } from '../../runtime/entities.mjs';
import { requireCleanReviews, settleReviews } from '../../runtime/reviews.mjs';
import { printErrors } from '../../runtime/validation.mjs';

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
      contract_fields: contractFields(domain),
    },
  };
  saveLock(repo.root, lockData);
  const settled = settleReviews(reviews);
  out(`已确认领域能力 ${id} 的契约`);
  if (settled) out(`${settled} 条澄清已存档到 ${domain.reviewRel} 的「已确认」`);
}
