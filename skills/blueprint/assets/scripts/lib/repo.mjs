// 仓库模型:一次性把 product / spec / domain / lock / todo 读进内存,
// 其余模块(schema / stage / codemap)全部基于这个模型工作。
import fs from 'node:fs';
import path from 'node:path';
import {
  parseFrontMatter, splitSections, findSection, sectionsText,
  parseActivityList, listDirs, listFiles, readFileSafe, exists,
} from './parse.mjs';
import { hashAnchor, hashDoc, omit } from './hash.mjs';
import { parseReview } from './review.mjs';
import {
  bpPath, loadConfig, ACTIVITY_HASHED_SECTIONS, CAPABILITY_HASHED_SECTIONS,
} from './config.mjs';

const HASHED_FLOW_SECTIONS = ['流程图', '流程', '分支与异常', '活动划分'];

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
  if (raw === null) return { version: 2, services: {}, activities: {}, capabilities: {} };
  let lock;
  try { lock = JSON.parse(raw); } catch (e) { throw new Error(`lock.json 解析失败: ${e.message}`); }
  lock.services = lock.services || {};
  lock.activities = lock.activities || {};
  lock.capabilities = lock.capabilities || {};
  return lock;
}

export function saveLock(root, lock) {
  const file = bpPath(root, 'lock.json');
  const tmp = file + '.tmp';
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

function loadServices(root, cfg, capabilityUses) {
  const specDir = bpPath(root, 'spec');
  const services = new Map();
  const activities = new Map();
  for (const domain of listDirs(specDir)) {
    for (const slug of listDirs(path.join(specDir, domain))) {
      const dir = path.join(specDir, domain, slug);
      const id = `${domain}.${slug}`;
      const flowPath = path.join(dir, 'flow.md');
      const doc = readDoc(flowPath);
      const reviewPath = path.join(dir, 'flow.review.md');
      const service = {
        id, domain, slug, dir,
        rel: path.relative(root, dir),
        flowPath, flowRel: path.relative(root, flowPath),
        exists: !!doc,
        fm: doc?.fm || {},
        sections: doc?.sections || [],
        raw: doc?.raw || '',
        product: doc?.fm?.product || null,
        hash: doc ? hashDoc({
          fm: omit(doc.fm, ['title']),
          text: sectionsText(doc.sections, HASHED_FLOW_SECTIONS),
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
          id: aid, service: id, domain, slug: aslug, dir: adir,
          file: afile, rel: path.relative(root, afile),
          fm: adoc.fm, sections: adoc.sections, raw: adoc.raw,
          hash: hashDoc({
            fm: omit(adoc.fm, ['title']),
            text: sectionsText(adoc.sections, ACTIVITY_HASHED_SECTIONS(cfg)),
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
          if (!capabilityUses.has(u)) capabilityUses.set(u, []);
          capabilityUses.get(u).push(aid);
        }
      }
    }
  }
  return { services, activities };
}

// ------------------------------------------------------------------- domain

function loadCapabilities(root, capabilityUses) {
  const domainDir = bpPath(root, 'domain');
  const capabilities = new Map();
  for (const domain of listDirs(domainDir)) {
    for (const slug of listDirs(path.join(domainDir, domain))) {
      const dir = path.join(domainDir, domain, slug);
      const file = path.join(dir, 'capability.md');
      if (!exists(file)) continue;
      const doc = readDoc(file);
      const id = `@${domain}.${slug}`;
      const reviewPath = path.join(dir, 'capability.review.md');
      capabilities.set(id, {
        id, domain, slug, dir, file, rel: path.relative(root, file),
        fm: doc.fm, sections: doc.sections, raw: doc.raw,
        hash: hashDoc({
          fm: omit(doc.fm, ['title']),
          text: sectionsText(doc.sections, CAPABILITY_HASHED_SECTIONS),
        }),
        tables: toArray(doc.fm.tables),
        reviewPath,
        reviewRel: path.relative(root, reviewPath),
        review: readReview(reviewPath),
        usedBy: capabilityUses.get(id) || [],
      });
    }
  }
  // 被引用但文档不存在的能力
  const missing = [];
  for (const [id, users] of capabilityUses) {
    if (!capabilities.has(id)) missing.push({ id, usedBy: users });
  }
  return { capabilities, missingCapabilities: missing };
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
  const capabilityUses = new Map();
  const products = loadProducts(root);
  const { services, activities } = loadServices(root, config, capabilityUses);
  const { capabilities, missingCapabilities } = loadCapabilities(root, capabilityUses);
  const lock = loadLock(root);
  const todos = loadTodos(root);

  const repo = {
    root, cfg: config, products, services, activities, capabilities,
    missingCapabilities, lock, todos,
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

/** 解析 `<domain>#<二级标题>` 形式的锚点引用。 */
export function anchorOf(repo, ref) {
  if (!ref || typeof ref !== 'string') return null;
  const idx = ref.indexOf('#');
  if (idx === -1) return null;
  const domain = ref.slice(0, idx);
  const title = ref.slice(idx + 1);
  const product = repo.products.get(domain);
  if (!product) return null;
  const anchor = product.anchors.get(title);
  if (!anchor) return null;
  return { product, anchor, domain, title };
}

/** 该服务下的全部 review 文件(flow + activities + 本服务引用的 capabilities)。 */
export function serviceReviews(repo, serviceId) {
  const svc = repo.services.get(serviceId);
  if (!svc) return [];
  const out = [];
  if (svc.review) out.push({ kind: 'flow', id: serviceId, label: 'flow.review', path: svc.reviewPath, review: svc.review });
  for (const aid of svc.activities) {
    const a = repo.activities.get(aid);
    if (a?.review) out.push({ kind: 'activity', id: aid, label: a.slug, path: a.reviewPath, review: a.review });
  }
  for (const cap of relatedCapabilities(repo, serviceId)) {
    if (cap.review) out.push({ kind: 'capability', id: cap.id, label: cap.id, path: cap.reviewPath, review: cap.review });
  }
  return out;
}

/** 本服务活动 uses 引用到的能力(已有文档的)。 */
export function relatedCapabilities(repo, serviceId) {
  const svc = repo.services.get(serviceId);
  if (!svc) return [];
  const ids = new Set();
  for (const aid of svc.activities) {
    for (const u of repo.activities.get(aid)?.uses || []) ids.add(u);
  }
  return [...ids].map((id) => repo.capabilities.get(id)).filter(Boolean);
}

export function missingForService(repo, serviceId) {
  const svc = repo.services.get(serviceId);
  if (!svc) return [];
  const out = new Set();
  for (const aid of svc.activities) {
    for (const u of repo.activities.get(aid)?.uses || []) {
      if (!repo.capabilities.has(u)) out.add(u);
    }
  }
  return [...out];
}

export function findObject(repo, id) {
  if (repo.services.has(id)) return { kind: 'service', obj: repo.services.get(id) };
  if (repo.activities.has(id)) return { kind: 'activity', obj: repo.activities.get(id) };
  if (repo.capabilities.has(id)) return { kind: 'capability', obj: repo.capabilities.get(id) };
  if (repo.products.has(id)) return { kind: 'product', obj: repo.products.get(id) };
  return null;
}
