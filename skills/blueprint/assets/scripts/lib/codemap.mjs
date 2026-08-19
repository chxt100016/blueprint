// 活动与领域模型到代码文件的索引。不存哈希,代码的变更历史由 git 承担。
// codemap 文件本身由 code skill 手写,脚本只负责读与校验。
//
// 除了「文件在不在」,它还承担一件确定性判定:**每条编号项都被实现了**。
// 编号章节各层不同——活动的「业务动作」A、聚合的「不变量」I 与「命令」C、
// 领域服务的「规则」R——codemap 的每个文件用 `covers` 声明自己落实了哪几条,
// 脚本逐组比对。code 层没有确认门,verify 又只管编译过不过,
// 漏实现一条规则在这两关都不会响——这条比对是它唯一的守门人。
import path from 'node:path';
import { parseYaml, readFileSafe, exists, findSection, parseRules } from './parse.mjs';
import { bpPath, isDomainId, splitDomainId } from './config.mjs';

export function codemapPath(root, id) {
  if (isDomainId(id)) {
    const [group, name] = splitDomainId(id);
    return bpPath(root, 'codemap', `@${group}`, `${name}.yaml`);
  }
  // 活动 id 是 <cap>.<svc>.activity.<name>,标记段不进路径:codemap 下只有活动与领域模型
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

/**
 * `covers: [C1, I2]` → { byPrefix: { C: [1], I: [2] }, bad: [] }。
 * 一个文档可以有多组编号,所以要一次认全部前缀:只认一组的话,
 * 处理 I 组时 C1 会被误判成写法不合规。
 */
function parseCovers(entry, prefixes) {
  const raw = entry && typeof entry === 'object' ? entry.covers : null;
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const byPrefix = {};
  for (const p of prefixes) byPrefix[p] = [];
  const bad = [];
  const re = new RegExp(`^(${prefixes.join('|')})(\\d+)$`, 'i');
  for (const item of list) {
    const m = String(item).trim().match(re);
    if (m) byPrefix[m[1].toUpperCase()].push(Number(m[2]));
    else bad.push(String(item).trim());
  }
  return { byPrefix, bad };
}

/**
 * 编号项的覆盖比对:文档里每组编号与 codemap 各文件 `covers` 的并集必须相等。
 *
 * 少了 = 有规则没落到代码上;多了 = 声明了文档里不存在的编号(多半是文档改过而 codemap 没跟)。
 * 两种都拦,因为这里放行之后再没有第二道关。
 */
function checkCovers(errors, id, map, doc) {
  const groups = doc?.numbered || [];
  if (!groups.length) return;
  const prefixes = groups.map((g) => g.prefix);

  // 写法不合规的编号只报一次,它与具体是哪一组无关
  for (const entry of map.files) {
    const { bad } = parseCovers(entry, prefixes);
    const where = (entry && typeof entry === 'object' ? entry.path : entry) || '(未知文件)';
    for (const item of bad) {
      errors.push({
        where: id,
        msg: `codemap ${where} 的 covers 中 \`${item}\` 不是形如 ${prefixes.map((p) => `${p}1`).join(' / ')} 的编号`,
      });
    }
  }

  for (const { section: title, prefix } of groups) {
    const sec = findSection(doc.sections, title);
    if (!sec) continue;
    if (sec.body.trim() === '无') continue;
    const declared = parseRules(sec.body, prefix);
    if (!declared.length) continue; // 编号本身不合规,validate 那边已经报过

    const covered = new Set();
    for (const entry of map.files) {
      const { byPrefix } = parseCovers(entry, prefixes);
      const where = (entry && typeof entry === 'object' ? entry.path : entry) || '(未知文件)';
      for (const n of byPrefix[prefix] || []) {
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
          + '——每条都要落到代码上,实现了就在对应文件的 covers 里写上编号',
      });
    }
  }
}

/**
 * codemap 校验:文件是否都存在,以及编号项是否都被覆盖。
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

