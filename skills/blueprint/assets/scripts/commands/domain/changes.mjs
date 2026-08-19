import { servicesOfDomain } from '../../lib/repo.mjs';
import { fail, out } from '../../runtime/cli.mjs';
import { ctx } from '../../runtime/context.mjs';
import { domainOrDie } from '../../runtime/entities.mjs';
import { clip } from '../../runtime/format.mjs';
import { printResolved } from '../../runtime/reviews.mjs';

export function run(cli, [id]) {
  const { repo } = ctx(cli);
  if (!id) fail('用法: bp domain changes <@id>');
  const domain = domainOrDie(repo, id);

  out(`领域模型  ${id}`);
  out(`概要      ${clip(domain.summary, 44) || '(未写)'}`);
  out(`引用方    ${domain.usedBy.join(', ') || '无'}`);
  out(`所属服务  ${servicesOfDomain(repo, domain).join(', ') || '无'}`);
  out('');

  if (domain.review) printResolved([{ label: id, review: domain.review }]);
}
