// 仓库模型:一次性把 product / spec / domain / lock / todo 读进内存,
// 其余模块(schema / stage / codemap)全部基于这个模型工作。
//
// 命名对应业务架构:
//   services    product/<capability>/<service>.md      业务服务:一次对外交付,人写的业务描述
//               spec/<capability>/<service>/           同一个服务的产出目录
//   flows       spec/<capability>/<service>/<flow>.md  业务流程:一个对外接口
//   activities  spec/<capability>/<service>/<act>/     业务活动:一次状态变更
//   domains     domain/<domain>/<name>/                领域能力(横切层)
//
// **路径即 id**:`product/order/checkout.md` 就是业务服务 `order.checkout`,
// 不再有「文件内二级标题作为锚点」那一层间接。文档里因此不需要声明自己属于谁,
// front-matter 的 id 只是给人看的冗余,校验时与路径比对。
//
// 业务活动归属服务而不是流程:同一次交付的多个入口共享一个活动池,
// 流程只是活动的编排。所以活动目录与流程文件同层。
//
// id 的第三段是固定的层级标记,`flow` 或 `activity`:
//   <capability>.<service>.flow.<name>       ↔ spec/<cap>/<svc>/<name>.md
//   <capability>.<service>.activity.<name>   ↔ spec/<cap>/<svc>/<name>/activity.md
// 标记段让 id 自解释,层级判定不必查表,流程名与活动名也不会撞车。
import fs from 'node:fs';
import path from 'node:path';
import {
  parseFrontMatter, splitSections, findSection, sectionsText,
  parseActivityList, listDirs, listFiles, readFileSafe, exists,
} from './parse.mjs';
import { hashDoc, sha256 } from './hash.mjs';
import { parseReview } from './review.mjs';
import { bpPath, loadConfig, FLOW_MARK, ACTIVITY_MARK } from './config.mjs';

export const LOCK_VERSION = 5;

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

const MIGRATE_HINT = `lock.json 是 v%OLD%,当前脚本要求 v${LOCK_VERSION}。

v5 做了两件事:取消 product 锚点(商业能力从一个文件变成一个目录,业务服务从二级标题
变成目录下的一份 .md,路径直接就是 id),以及把每份文档的一句话说明统一成「## 概要」章节。
需要人工迁移:

  1. product/<cap>.md 拆开:每个二级标题各成一份 product/<cap>/<service>.md,
     文件名用英文 kebab-case,与 spec/<cap>/<service>/ 的目录名一致
  2. 各流程文件的 front-matter:去掉 flow、title、product 三个字段,换成
     id: <cap>.<svc>.flow.<name>
  3. 各 activity.md 去掉 title 与 summary,各 domain.md 去掉 title
  4. 三种文档(flow / activity / domain)都在正文最前面加一节「## 概要」:
     单行、不超过 40 字。activity 的概要就是原来 front-matter 里那个 summary
  5. service.md 的 front-matter:service / title / product 三个字段换成 id: <cap>.<svc>
  6. lock.json:flows.<id>.product_anchor 删除,flows.<id>.flow.product_hash 移到
     services.<svc>.flow.product_hash(值需重算),version 改 5
  7. 重新走一遍三层 approve(front-matter 与章节都变了,哈希必然失效)`;

export function loadLock(root) {
  const file = bpPath(root, 'lock.json');
  const raw = readFileSafe(file);
  if (raw === null) return { version: LOCK_VERSION, services: {}, flows: {}, activities: {}, domains: {} };
  let lock;
  try { lock = JSON.parse(raw); } catch (e) { throw new Error(`lock.json 解析失败: ${e.message}`); }
  const hasContent = Object.keys(lock.services || {}).length ||
    Object.keys(lock.activities || {}).length || Object.keys(lock.domains || {}).length;
  if (hasContent && Number(lock.version) < LOCK_VERSION) {
    throw new Error(MIGRATE_HINT.replace('%OLD%', lock.version ?? '(未知)'));
  }
  lock.services = lock.services || {};
  lock.flows = lock.flows || {};
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

/**
 * 人写的业务描述:`product/<capability>/<service>.md`,一份文件一个业务服务。
 *
 * 整份正文参与哈希,不设自由区。改动即触发本服务在 flow 层重新过一遍,
 * 而「这次改动不影响流程」有 `bp flow approve <service>` 这条零成本出口,
 * 所以不必再为了让人放心记笔记而在文档里划一块不参与判定的区域。
 */
function loadProductDocs(root) {
  const dir = bpPath(root, 'product');
  const docs = new Map();
  for (const capability of listDirs(dir)) {
    for (const name of listFiles(path.join(dir, capability))) {
      if (!name.endsWith('.md')) continue;
      const slug = name.replace(/\.md$/, '');
      const file = path.join(dir, capability, name);
      const raw = readFileSafe(file);
      const { fm, body } = parseFrontMatter(raw);
      const { sections } = splitSections(body);
      docs.set(`${capability}.${slug}`, {
        id: `${capability}.${slug}`,
        capability,
        slug,
        file,
        rel: path.relative(root, file),
        raw, fm, body, sections,
        hash: hashDoc({ text: body }),
      });
    }
  }
  return docs;
}

// --------------------------------------------------------------------- spec

/** 该服务目录下的流程文件:排除 service.md 与澄清记录。 */
function isFlowFile(name) {
  return name.endsWith('.md') && name !== 'service.md' && !name.endsWith('.review.md');
}

function makeService(root, id, product) {
  const [capability, slug] = id.split('.');
  const dir = bpPath(root, 'spec', capability, slug);
  const servicePath = path.join(dir, 'service.md');
  return {
    id, capability, slug, dir,
    rel: path.relative(root, dir),
    // 人写的业务描述。缺失说明服务被删或改名,由 orphaned 层处理
    product,
    productRel: product ? product.rel : path.join('blueprint', 'product', capability, `${slug}.md`),
    hasSpecDir: exists(dir),
    // service.md 是轻文档:只记录服务边界与上下游,不校验、不哈希、不进 lock
    servicePath,
    serviceRel: path.relative(root, servicePath),
    hasServiceDoc: exists(servicePath),
    flows: [],
    activities: [],
    activityList: [],   // 各流程「活动编排」的并集
  };
}

function loadSpec(root, cfg, products, domainUses, activityUsers) {
  const specDir = bpPath(root, 'spec');
  const services = new Map();
  const flows = new Map();
  const activities = new Map();
  const strays = [];

  // 服务由 product 文档定义:人写一份 md 就是新增一个服务
  for (const [id, product] of products) services.set(id, makeService(root, id, product));

  for (const capability of listDirs(specDir)) {
    for (const slug of listDirs(path.join(specDir, capability))) {
      const id = `${capability}.${slug}`;
      // spec 目录在、product 文档不在:多半是人改了 product 里的文件名,交 orphaned 层处理
      if (!services.has(id)) { services.set(id, makeService(root, id, null)); strays.push(id); }
      const service = services.get(id);
      const dir = service.dir;

      // 业务流程:目录下的 .md 文件,一个文件一个对外接口
      for (const name of listFiles(dir)) {
        if (!isFlowFile(name)) continue;
        const fslug = name.replace(/\.md$/, '');
        const file = path.join(dir, name);
        const doc = readDoc(file);
        if (!doc) continue;
        const fid = `${id}.${FLOW_MARK}.${fslug}`;
        const reviewPath = path.join(dir, `${fslug}.review.md`);
        const flow = {
          id: fid, service: id, capability, slug: fslug, dir,
          file, rel: path.relative(root, file),
          fm: doc.fm, sections: doc.sections, raw: doc.raw,
          summary: (findSection(doc.sections, '概要')?.body || '').trim(),
          entry: doc.fm.entry || {},
          hash: hashDoc({
            fm: doc.fm,
            text: sectionsText(doc.sections, cfg.templates.flow.hashed),
          }),
          reviewPath,
          reviewRel: path.relative(root, reviewPath),
          review: readReview(reviewPath),
          activityList: parseActivityList(findSection(doc.sections, '活动编排')?.body || ''),
        };
        flows.set(fid, flow);
        service.flows.push(fid);
      }

      // 业务活动:目录下的子目录。归属服务,可被同服务的多个流程编排
      for (const aslug of listDirs(dir)) {
        const adir = path.join(dir, aslug);
        const afile = path.join(adir, 'activity.md');
        if (!exists(afile)) continue;
        const adoc = readDoc(afile);
        const aid = `${id}.${ACTIVITY_MARK}.${aslug}`;
        const areviewPath = path.join(adir, 'activity.review.md');
        const activity = {
          id: aid, service: id, capability, slug: aslug, dir: adir,
          file: afile, rel: path.relative(root, afile),
          fm: adoc.fm, sections: adoc.sections, raw: adoc.raw,
          // 概要由活动自己持有:它被多个流程编排,说明不能寄存在某一份流程文档里
          summary: (findSection(adoc.sections, '概要')?.body || '').trim(),
          hash: hashDoc({
            fm: adoc.fm,
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

      // 活动清单 = 各流程编排的并集;引用关系正向存放,反查表由此推出
      const seen = new Map();
      for (const fid of service.flows) {
        for (const item of flows.get(fid).activityList) {
          if (!seen.has(item.slug)) seen.set(item.slug, item);
          const aid = `${id}.${ACTIVITY_MARK}.${item.slug}`;
          if (!activityUsers.has(aid)) activityUsers.set(aid, []);
          activityUsers.get(aid).push(fid);
        }
      }
      service.activityList = [...seen.values()];
    }
  }
  return { services, flows, activities, strays };
}

/**
 * 服务下全部流程的组合哈希,活动层拿它当上游。
 * 任一流程变更都要求活动层复核——活动被多个流程共用,改一个流程可能牵动共用的活动。
 */
export function flowsHash(repo, serviceId) {
  const svc = repo.services.get(serviceId);
  if (!svc) return null;
  const parts = [...svc.flows].sort()
    .map((fid) => `${fid}:${repo.flows.get(fid)?.hash || ''}`);
  return sha256(parts.join('\n'));
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
        summary: (findSection(doc.sections, '概要')?.body || '').trim(),
        hash: hashDoc({
          fm: doc.fm,
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
  const activityUsers = new Map();
  const products = loadProductDocs(root);
  const { services, flows, activities, strays } = loadSpec(root, config, products, domainUses, activityUsers);
  const { domains, missingDomains } = loadDomains(root, config, domainUses);
  const lock = loadLock(root);
  const todos = loadTodos(root);

  return {
    root, cfg: config, services, flows, activities, domains,
    missingDomains, lock, todos,
    // spec 目录存在但 product 文档不存在的服务 id
    strayServices: strays,
    // 活动 id → 编排它的流程 id 列表。正向引用写在 flow.md 的「活动编排」里,
    // 这张表由脚本反推,活动文档不记录自己被谁用(与 domainUses 同构)
    activityUsers,
  };
}

/** 编排了该活动的流程 id 列表。 */
export function flowsOfActivity(repo, activityId) {
  return repo.activityUsers.get(activityId) || [];
}

/** 服务的活动池:各流程编排的并集,含「有没有文档」「被谁编排」。 */
export function activityPool(repo, serviceId) {
  const svc = repo.services.get(serviceId);
  if (!svc) return [];
  return svc.activityList.map((item) => {
    const aid = `${serviceId}.${ACTIVITY_MARK}.${item.slug}`;
    return {
      slug: item.slug,
      id: aid,
      summary: repo.activities.get(aid)?.summary || item.summary || '',
      hasDoc: repo.activities.has(aid),
      usedBy: flowsOfActivity(repo, aid),
    };
  });
}

/** 按商业能力分组的业务服务 id。 */
export function byCapability(repo) {
  const out = new Map();
  for (const id of [...repo.services.keys()].sort()) {
    const cap = repo.services.get(id).capability;
    if (!out.has(cap)) out.set(cap, []);
    out.get(cap).push(id);
  }
  return out;
}

export function toArray(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** 单个流程的澄清记录。flow 层逐个流程确认,不跨流程合并。 */
export function flowReviews(repo, flowId) {
  const flow = repo.flows.get(flowId);
  if (!flow?.review) return [];
  return [{ kind: 'flow', id: flowId, label: flow.slug, path: flow.reviewPath, review: flow.review }];
}

/** 该服务全部活动的澄清记录。活动层按服务确认,一次覆盖服务下所有活动。 */
export function activityReviews(repo, serviceId) {
  const svc = repo.services.get(serviceId);
  if (!svc) return [];
  const out = [];
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
  if (repo.flows.has(id)) return { kind: 'flow', obj: repo.flows.get(id) };
  if (repo.activities.has(id)) return { kind: 'activity', obj: repo.activities.get(id) };
  if (repo.domains.has(id)) return { kind: 'domain', obj: repo.domains.get(id) };
  return null;
}
