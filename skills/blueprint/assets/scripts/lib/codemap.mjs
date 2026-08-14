// 活动与领域能力到代码文件的索引。不存哈希,代码的变更历史由 git 承担。
// codemap 文件本身由 code skill 手写,脚本只负责读与校验。
//
// 除了「文件在不在」,它还承担一件确定性判定:**每个业务动作都被实现了**。
// 文档的「动作」章节是 A1 A2 A3 这样的连续编号,codemap 的每个文件用 `covers`
// 声明自己落实了哪几条,脚本比对两个集合。code 层没有确认门,verify 又只管编译过不过,
// 漏实现一条规则在这两关都不会响——这条比对是它唯一的守门人。
import path from 'node:path';
import { parseYaml, readFileSafe, exists, findSection, parseRules } from './parse.mjs';
import { bpPath, isDomainId, splitDomainId } from './config.mjs';

export function codemapPath(root, id) {
  if (isDomainId(id)) {
    const [group, name] = splitDomainId(id);
    return bpPath(root, 'codemap', `@${group}`, `${name}.yaml`);
  }
  // 活动 id 是 <cap>.<svc>.activity.<name>,标记段不进路径:codemap 下只有活动与领域能力
  const [capability, service, , activity] = String(id).split('.');
  return bpPath(root, 'codemap', capability, service, `${activity}.yaml`);
}

export function loadCodemap(root, id) {
  const file = codemapPath(root, id);
  const raw = readFileSafe(file);
  if (raw === null) return null;
  const data = parseYaml(raw) || {};
  data.files = Array.isArray(data.files) ? data.files : [];
  return { file, rel: path.relative(root, file), ...data };
}

/** `covers: [A1, A2]` → [1, 2]。写法不合规的编号原样带出,由调用方报错。 */
function parseCovers(entry, prefix) {
  const raw = entry && typeof entry === 'object' ? entry.covers : null;
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const nums = [];
  const bad = [];
  const re = new RegExp(`^${prefix}(\\d+)$`, 'i');
  for (const item of list) {
    const m = String(item).trim().match(re);
    if (m) nums.push(Number(m[1]));
    else bad.push(String(item).trim());
  }
  return { nums, bad };
}

/**
 * 业务动作的覆盖比对:文档里的 A1..An 与 codemap 各文件 `covers` 的并集必须相等。
 *
 * 少了 = 有规则没落到代码上;多了 = 声明了文档里不存在的编号(多半是文档改过而 codemap 没跟)。
 * 两种都拦,因为这里放行之后再没有第二道关。
 */
function checkCovers(errors, id, map, doc) {
  if (!doc?.numbered) return;
  const { section: title, prefix } = doc.numbered;
  const sec = findSection(doc.sections, title);
  if (!sec) return;
  const declared = parseRules(sec.body, prefix);
  if (!declared.length) return; // 编号本身不合规,validate 那边已经报过

  const covered = new Set();
  for (const entry of map.files) {
    const { nums, bad } = parseCovers(entry, prefix);
    const where = (entry && typeof entry === 'object' ? entry.path : entry) || '(未知文件)';
    for (const item of bad) {
      errors.push({ where: id, msg: `codemap ${where} 的 covers 中 \`${item}\` 不是形如 ${prefix}1 的动作编号` });
    }
    for (const n of nums) {
      if (!declared.includes(n)) {
        errors.push({ where: id, msg: `codemap ${where} 声明覆盖 ${prefix}${n},但「${title}」里没有这一条` });
        continue;
      }
      covered.add(n);
    }
  }
  const missing = declared.filter((n) => !covered.has(n));
  if (missing.length) {
    errors.push({
      where: id,
      msg: `「${title}」有 ${missing.map((n) => prefix + n).join(', ')} 没有任何文件声明 covers`
        + '——每条动作都要落到代码上,实现了就在对应文件的 covers 里写上编号',
    });
  }
}

/**
 * codemap 校验:文件是否都存在,以及业务动作是否都被覆盖。
 * `doc` 给 { sections, numbered } 时才做覆盖比对,不给就只校验文件。
 */
export function validateCodemap(root, id, doc = null) {
  const map = loadCodemap(root, id);
  const errors = [];
  if (!map) return { errors: [{ where: id, msg: `缺少 codemap: ${path.relative(root, codemapPath(root, id))}` }], files: [] };
  if (!map.files.length) errors.push({ where: id, msg: 'codemap 的 files 为空' });
  const files = [];
  for (const entry of map.files) {
    const p = typeof entry === 'string' ? entry : entry?.path;
    if (!p) { errors.push({ where: id, msg: 'codemap files 中存在缺少 path 的条目' }); continue; }
    files.push(p);
    if (!exists(path.join(root, p))) errors.push({ where: id, msg: `codemap 指向的文件不存在: ${p}` });
  }
  checkCovers(errors, id, map, doc);
  return { errors, files, map };
}

