// 活动与领域能力到代码文件的索引。不存哈希,代码的变更历史由 git 承担。
import fs from 'node:fs';
import path from 'node:path';
import { parseYaml, toYamlFile, readFileSafe, walkFiles, exists } from './parse.mjs';
import { bpPath, isDomainId, splitDomainId, resolveScope } from './config.mjs';

export function codemapPath(root, id) {
  if (isDomainId(id)) {
    const [group, name] = splitDomainId(id);
    return bpPath(root, 'codemap', `@${group}`, `${name}.yaml`);
  }
  const [capability, service, activity] = String(id).split('.');
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

export function writeCodemap(root, id, cfg, files) {
  const file = codemapPath(root, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const doc = { id, scope: resolveScope(cfg, id), files };
  fs.writeFileSync(file, toYamlFile(doc));
  return file;
}

/** codemap 中的文件是否都存在。 */
export function validateCodemap(root, id) {
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
  return { errors, files, map };
}

export function allCodemaps(root) {
  const dir = bpPath(root, 'codemap');
  const out = [];
  for (const file of walkFiles(dir)) {
    if (!file.endsWith('.yaml')) continue;
    const data = parseYaml(readFileSafe(file) || '') || {};
    out.push({ file, rel: path.relative(root, file), id: data.id, files: Array.isArray(data.files) ? data.files : [] });
  }
  return out;
}

/** 反查文件归属。 */
export function which(root, target) {
  const norm = path.relative(root, path.resolve(root, target)).split(path.sep).join('/');
  const hits = [];
  for (const map of allCodemaps(root)) {
    for (const entry of map.files) {
      const p = typeof entry === 'string' ? entry : entry?.path;
      if (p && p.split(path.sep).join('/') === norm) hits.push(map.id);
    }
  }
  return [...new Set(hits)];
}

export function removeCodemap(root, id) {
  const file = codemapPath(root, id);
  if (exists(file)) fs.rmSync(file);
}
