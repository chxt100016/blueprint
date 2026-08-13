import { findSection } from '../../lib/parse.mjs';
import { servicesOfDomain } from '../../lib/repo.mjs';
import { contractFields } from '../../lib/schema.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { domainOrDie } from '../../runtime/entities.mjs';
import { table } from '../../runtime/format.mjs';
import { printResolved } from '../../runtime/reviews.mjs';

export function run(cli, [id]) {
  const { repo } = ctx(cli);
  if (!id) fail('用法: bp domain changes <@id>');
  const domain = domainOrDie(repo, id);
  const spec = repo.lock.domains?.[id]?.spec;

  out(`领域能力  ${id}   ${domain.fm.title || ''}`);
  out(`引用方    ${domain.usedBy.join(', ') || '无'}`);
  out(`所属服务  ${servicesOfDomain(repo, domain).join(', ') || '无'}`);
  out('');

  const current = contractFields(domain);
  const before = spec?.contract_fields || [];
  out(`契约字段  ${current.length} 项${spec ? '' : '(首次确认)'}`);
  const rows = [];
  for (const field of current) rows.push([`  ${before.includes(field) ? '保留' : '新增'}`, field]);
  table(rows);
  out('');

  const duty = findSection(domain.sections, '职责');
  if (duty) {
    out('职责');
    for (const line of duty.body.split('\n').filter((item) => item.trim())) out(`  ${line}`);
    out('');
  }

  if (domain.review) printResolved([{ label: id, review: domain.review }]);
}
