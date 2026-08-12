// 仓库模型:一次性把 product / spec / domain / lock / todo 读进内存,
// 其余模块(schema / stage / codemap)全部基于这个模型工作。
//
// 命名对应五层业务架构:
//   products    product/<capability>.md         商业能力(文件)+ 业务服务(二级标题锚点)
//   services    spec/<capability>/<service>/    业务流程
//   activities  .../<activity>/activity.md      业务活动
//   domains     domain/<domain>/<name>/         领域能力(横切层)
import fs from 'node:fs';
import path from 'node:path';
import {
  parseFrontMatter, splitSections, findSection, sectionsText,
  parseActivityList, listDirs, listFiles, readFileSafe, exists,
} from './parse.mjs';
import { hashAnchor, hashDoc, omit } from './hash.mjs';
import { parseReview } from './review.mjs';
import { bpPath, loadConfig } from './config.mjs';

export const LOCK_VERSION = 3;

function readDoc(file) {
  const raw = readFileSafe(file);
  if (raw === null) return null;
  const { fm, body } = parseFrontMatter(raw);
  const { sections } = splitSections(body);
  return { raw, fm, body, sections };
}

function readReview(file) {
  const raw = readFileSafe(file);
  if (raw === null) return null;
  return parseReview(raw);
}

export function loadLock(root) {
  const file = bpPath(root, 'lock.json');
  const raw = readFileSafe(file);
  if (raw === null) return { version: LOCK_VERSION, services: {}, activities: {}, domains: {} };
  let lock;
  try { lock = JSON.parse(raw); } catch (e) { throw new Error(`lock.json 解析失败: ${e.message}`); }
  lock.services = lock.services || {};
  lock.activities = lock.activities || {};
  lock.domains = lock.domains || {};
  lock.rejected_domains = lock.rejected_domains || {};
  return lock;
}

export function saveLock(root, lock) {
  const file = bpPath(root, 'lock.json');
  const tmp = file + '.tmp';
  lock.version = LOCK_VERSION;
  fs.writeFileSync(tmp, JSON.stringify(lock, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------------ product

function loadProducts(root) {
  const dir = bpPath(root, 'product');
  const products = new Map();
  for (const name of listFiles(dir)) {
    if (!name.endsWith('.md')) continue;
    const id = name.replace(/\.md$/, '');
    const file = path.join(dir, name);
    const raw = readFileSafe(file);
    const { fm, body } = parseFrontMatter(raw);
    const { preamble, sections } = splitSections(body);
    const anchors = new Map();
    for (const sec of sections) {
      anchors.set(sec.title, { title: sec.title, body: sec.body, hash: hashAnchor(sec.title, sec.body) });
    }
    products.set(id, { id, file, rel: path.relative(root, file), fm, free: preamble, anchors });
  }
  return products;
}

// --------------------------------------------------------------------- spec

function loadServices(root, cfg, domainUses) {
  const specDir = bpPath(root, 'spec');
  const services = new Map();
  const activities = new Map();
  for (const capability of listDirs(specDir)) {
    for (const slug of listDirs(path.join(specDir, capability))) {
      const dir = path.join(specDir, capability, slug);
      const id = `${capability}.${slug}`;
      const flowPath = path.join(dir, 'flow.md');
      const doc = readDoc(flowPath);
      const reviewPath = path.join(dir, 'flow.review.md');
      const service = {
        id, capability, slug, dir,
        rel: path.relative(root, dir),
        flowPath, flowRel: path.relative(root, flowPath),
        exists: !!doc,
        fm: doc?.fm || {},
        sections: doc?.sections || [],
        raw: doc?.raw || '',
        product: doc?.fm?.product || null,
        hash: doc ? hashDoc({
          fm: omit(doc.fm, ['title']),
          text: sectionsText(doc.sections, cfg.templates.flow.hashed),
        }) : null,
        reviewPath,
        reviewRel: path.relative(root, reviewPath),
        review: readReview(reviewPath),
        activityList: doc ? parseActivityList(findSection(doc.sections, '活动划分')?.body || '') : [],
        activities: [],
      };
      services.set(id, service);

      for (const aslug of listDirs(dir)) {
        const adir = path.join(dir, aslug);
        const afile = path.join(adir, 'activity.md');
        if (!exists(afile)) continue;
        const adoc = readDoc(afile);
        const aid = `${id}.${aslug}`;
        const areviewPath = path.join(adir, 'activity.review.md');
        const activity = {
          id: aid, service: id, capability, slug: aslug, dir: adir,
          file: afile, rel: path.relative(root, afile),
          fm: adoc.fm, sections: adoc.sections, raw: adoc.raw,
          hash: hashDoc({
            fm: omit(adoc.fm, ['title']),
            text: sectionsText(adoc.sections, cfg.templates.activity.hashed),
          }),
          depends_on: toArray(adoc.fm.depends_on),
          uses: toArray(adoc.fm.uses),
          tables: toArray(adoc.fm.tables),
          reviewPath: areviewPath,
          reviewRel: path.relative(root, areviewPath),
          review: readReview(areviewPath),
        };
        activities.set(aid, activity);
        service.activities.push(aid);
        for (const u of activity.uses) {
          if (!domainUses.has(u)) domainUses.set(u, []);
          domainUses.get(u).push(aid);
        }
      }
    }
  }
  return { services, activities };
}

// ------------------------------------------------------------------- domain

function loadDomains(root, cfg, domainUses) {
  const domainDir = bpPath(root, 'domain');
  const domains = new Map();
  for (const group of listDirs(domainDir)) {
    for (const name of listDirs(path.join(domainDir, group))) {
      const dir = path.join(domainDir, group, name);
      const file = path.join(dir, 'domain.md');
      if (!exists(file)) continue;
      const doc = readDoc(file);
      const id = `@${group}.${name}`;
      const reviewPath = path.join(dir, 'domain.review.md');
      domains.set(id, {
        id, group, name, slug: name, dir, file, rel: path.relative(root, file),
        fm: doc.fm, sections: doc.sections, raw: doc.raw,
        hash: hashDoc({
          fm: omit(doc.fm, ['title']),
          text: sectionsText(doc.sections, cfg.templates.domain.hashed),
        }),
        tables: toArray(doc.fm.tables),
        reviewPath,
        reviewRel: path.relative(root, reviewPath),
        review: readReview(reviewPath),
        usedBy: domainUses.get(id) || [],
      });
    }
  }
  // 被 uses 引用但文档不存在的领域能力
  const missing = [];
  for (const [id, users] of domainUses) {
    if (!domains.has(id)) missing.push({ id, usedBy: users });
  }
  return { domains, missingDomains: missing };
}

// --------------------------------------------------------------------- todo

function loadTodos(root) {
  const dir = bpPath(root, 'todo');
  const out = [];
  for (const name of listFiles(dir)) {
    if (!name.endsWith('.md')) continue;
    const m = name.match(/^(\d{14})_(.+?)_(migration|manual)\.md$/);
    out.push({
      file: path.join(dir, name),
      rel: path.relative(root, path.join(dir, name)),
      name,
      ts: m ? m[1] : null,
      service: m ? m[2] : null,
      kind: m ? m[3] : null,
    });
  }
  return out;
}

// -------------------------------------------------------------------- 入口

export function loadRepo(root, cfg = null) {
  const config = cfg || loadConfig(root);
  const domainUses = new Map();
  const products = loadProducts(root);
  const { services, activities } = loadServices(root, config, domainUses);
  const { domains, missingDomains } = loadDomains(root, config, domainUses);
  const lock = loadLock(root);
  const todos = loadTodos(root);

  const repo = {
    root, cfg: config, products, services, activities, domains,
    missingDomains, lock, todos,
    anchorUsers: new Map(),
  };

  for (const svc of services.values()) {
    if (!svc.product) continue;
    if (!repo.anchorUsers.has(svc.product)) repo.anchorUsers.set(svc.product, []);
    repo.anchorUsers.get(svc.product).push(svc.id);
  }
  return repo;
}

export function toArray(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** 解析 `<capability>#<二级标题>` 形式的锚点引用。 */
export function anchorOf(repo, ref) {
  if (!ref || typeof ref !== 'string') return null;
  const idx = ref.indexOf('#');
  if (idx === -1) return null;
  const capability = ref.slice(0, idx);
  const title = ref.slice(idx + 1);
  const product = repo.products.get(capability);
  if (!product) return null;
  const anchor = product.anchors.get(title);
  if (!anchor) return null;
  return { product, anchor, capability, title };
}

/** 该服务下的全部澄清记录(flow + 各活动)。领域能力的记录不挂在服务上。 */
export function serviceReviews(repo, serviceId) {
  const svc = repo.services.get(serviceId);
  if (!svc) return [];
  const out = [];
  if (svc.review) out.push({ kind: 'flow', id: serviceId, label: 'flow', path: svc.reviewPath, review: svc.review });
  for (const aid of svc.activities) {
    const a = repo.activities.get(aid);
    if (a?.review) out.push({ kind: 'activity', id: aid, label: a.slug, path: a.reviewPath, review: a.review });
  }
  return out;
}

/** 本服务活动 uses 引用到的领域能力(已有文档的)。 */
export function relatedDomains(repo, serviceId) {
  const svc = repo.services.get(serviceId);
  if (!svc) return [];
  const ids = new Set();
  for (const aid of svc.activities) {
    for (const u of repo.activities.get(aid)?.uses || []) ids.add(u);
  }
  return [...ids].map((id) => repo.domains.get(id)).filter(Boolean);
}

/** 本服务 uses 引用了但还没有文档的领域能力。 */
export function missingForService(repo, serviceId) {
  const svc = repo.services.get(serviceId);
  if (!svc) return [];
  const out = new Set();
  for (const aid of svc.activities) {
    for (const u of repo.activities.get(aid)?.uses || []) {
      if (!repo.domains.has(u)) out.add(u);
    }
  }
  return [...out];
}

/** 引用该领域能力的服务集合。 */
export function servicesOfDomain(repo, domain) {
  const set = new Set(domain.usedBy.map((a) => a.split('.').slice(0, 2).join('.')));
  const introduced = repo.lock.domains?.[domain.id]?.spec?.introduced_by;
  if (introduced) set.add(introduced);
  return [...set];
}

export function findObject(repo, id) {
  if (repo.services.has(id)) return { kind: 'service', obj: repo.services.get(id) };
  if (repo.activities.has(id)) return { kind: 'activity', obj: repo.activities.get(id) };
  if (repo.domains.has(id)) return { kind: 'domain', obj: repo.domains.get(id) };
  if (repo.products.has(id)) return { kind: 'product', obj: repo.products.get(id) };
  return null;
}
