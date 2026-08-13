import fs from 'node:fs';

import { exists } from '../../lib/parse.mjs';
import { loadLock, saveLock, servicesOfDomain } from '../../lib/repo.mjs';
import { contractFields, validateDomain } from '../../lib/schema.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx, nowIso } from '../../runtime/context.mjs';
import { domainOrDie } from '../../runtime/entities.mjs';
import { requireCleanReviews } from '../../runtime/reviews.mjs';
import { printErrors } from '../../runtime/validation.mjs';

export function run(cli, [id]) {
  const { repo } = ctx(cli);
  if (!id) fail('用法: bp domain approve <@id>');
  const domain = domainOrDie(repo, id);

  if (domain.review) requireCleanReviews([{ label: id, review: domain.review }]);

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
  if (exists(domain.reviewPath)) fs.rmSync(domain.reviewPath);
  out(`已确认领域能力 ${id} 的契约`);
}
