// 按 id 建一份空的文档骨架。id 即路径,所以一条命令覆盖全部层级:
//
//   bp new <cap>.<svc>                    → spec/<cap>/<svc>/service.md
//   bp new <cap>.<svc>.flow.<name>        → spec/<cap>/<svc>/<name>.md
//   bp new <cap>.<svc>.activity.<name>    → spec/<cap>/<svc>/<name>/activity.md
//   bp new @<领域>.<能力名>                → domain/<领域>/<能力名>/domain.md
//
// 存在的理由有两个,后一个才是主要的:
//
// 1. 路径与 id 的对应关系由脚本算,skill 不必自己拼路径,也不必保证 front-matter 的 id
//    与路径一致——拼错的后果分别是 error 和 validate 失败,都要绕一圈才发现。
// 2. `bp review ask` 要求实体已存在(reviewPath 由 repo 里的对象持有),
//    所以没有骨架就没法登记澄清。有了这条命令,顺序可以变成
//    「定改动范围 → 建骨架 → 只写核心章节 → 澄清 → 补全」,
//    人第一次看到的东西不再是一整份用假设填满的文档。
//
// 骨架保留模板正文里的括号说明,它就是填写指令本身,别在这里剥掉。
// 只改 front-matter 的 id 一行:模板是章节与字段的真相源,这条命令不该有自己的一份。
import fs from 'node:fs';
import path from 'node:path';

import { bpPath, idToDoc, idToProductPath, serviceOf } from '../lib/config.mjs';
import { dumpYaml, exists, parseFrontMatter, readFileSafe } from '../lib/parse.mjs';
import { fail, out } from '../runtime/cli.mjs';
import { ctx } from '../runtime/context.mjs';

const USAGE = `用法: bp new <id>

  bp new <cap>.<svc>                   建 service.md 骨架
  bp new <cap>.<svc>.flow.<name>       建业务流程骨架
  bp new <cap>.<svc>.activity.<name>   建业务活动骨架
  bp new @<领域>.<能力名>               建领域能力骨架`;

export function run(cli, [id]) {
  const { repo } = ctx(cli);
  if (!id) fail(USAGE);

  const doc = idToDoc(id);
  if (!doc) fail(`${id} 不是合法的 id。\n\n${USAGE}`);

  // 业务服务由人写的 product 文档定义,脚本不替人建它:
  // 建了就等于替人决定了「有这么一个服务」,而那是本流水线唯一由人起头的判断
  if (doc.kind !== 'domain') {
    const serviceId = doc.kind === 'service' ? id : serviceOf(id);
    const productPath = bpPath(repo.root, idToProductPath(serviceId));
    if (!exists(productPath)) {
      fail(`业务服务 ${serviceId} 还没有业务描述,先让人写 ${path.relative(repo.root, productPath)}`);
    }
  }

  const file = bpPath(repo.root, doc.file);
  if (exists(file)) fail(`${path.relative(repo.root, file)} 已存在,要改就直接编辑它`);

  const created = [write(repo.root, file, doc.template, id)];
  // 流程是服务目录里第一个出现的东西,顺手把轻文档 service.md 也建出来
  if (doc.kind === 'flow') {
    const serviceId = serviceOf(id);
    const servicePath = bpPath(repo.root, idToDoc(serviceId).file);
    if (!exists(servicePath)) created.push(write(repo.root, servicePath, 'service.md', serviceId));
  }

  out(`已创建 ${id}`);
  for (const rel of created) out(`  ${rel}`);
  out('');
  out('下一步:先只写核心章节(流程写「概要」与「流程」),再用 bp review ask 登记澄清。');
  out('骨架阶段不要跑 validate——章节还空着,必然报错。');
}

function write(root, file, template, id) {
  const raw = readFileSafe(bpPath(root, 'templates', template));
  if (raw === null) fail(`找不到 blueprint/templates/${template}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fillId(raw, id, template));
  return path.relative(root, file);
}

/** 把模板 front-matter 里的 `id:` 一行填上,其余原样保留(含注释)。 */
function fillId(template, id, name) {
  const { fmRaw, body, hasFm } = parseFrontMatter(template);
  if (!hasFm) fail(`模板 blueprint/templates/${name} 没有 front-matter`);
  let done = false;
  const lines = fmRaw.replace(/\n$/, '').split('\n').map((line) => {
    if (done || !/^id\s*:/.test(line)) return line;
    done = true;
    // 领域能力 id 以 @ 开头,YAML 里那是保留字符,必须让 dumpYaml 决定要不要加引号
    return `id: ${dumpYaml(id)}`;
  });
  if (!done) fail(`模板 blueprint/templates/${name} 的 front-matter 缺少 id 字段`);
  return `---\n${lines.join('\n')}\n---\n\n${body.replace(/^\n+/, '')}`;
}
