#!/usr/bin/env node
// blueprint 流水线的确定性判断全部在这里。模型不参与任何状态推理。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

import {
  findRoot, bpPath, loadConfig, resolveScope, isCapabilityId, idKind,
  activitySectionTitles, FLOW_SECTIONS, CAPABILITY_SECTIONS,
} from './lib/config.mjs';
import { loadRepo, loadLock, saveLock, anchorOf, serviceReviews, relatedCapabilities, missingForService } from './lib/repo.mjs';
import { validateId, validateService, validateActivity, validateCapability, contractFields } from './lib/schema.mjs';
import * as review from './lib/review.mjs';
import { scan, serviceStage, objectStage, nextTask, sortImplQueue } from './lib/stage.mjs';
import { loadSnapshot, checkTables, pull as schemaPull, snapshotTableFile } from './lib/db.mjs';
import { loadCodemap, validateCodemap, which as whichFile, codemapPath } from './lib/codemap.mjs';
import { findSection, readFileSafe, exists, listFiles } from './lib/parse.mjs';
import { shortHash } from './lib/hash.mjs';
import * as install from './lib/install.mjs';

const argv = process.argv.slice(2);
const out = (s = '') => process.stdout.write(s + '\n');
const errOut = (s = '') => process.stderr.write(s + '\n');

function fail(msg, code = 1) {
  errOut(msg);
  process.exit(code);
}

function flag(name) {
  return argv.includes(`--${name}`);
}

function option(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= argv.length) return fallback;
  return argv[i + 1];
}

function positional() {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function rootOrDie() {
  const root = findRoot(option('root', process.cwd()));
  if (!root) fail('未找到 blueprint/config.yaml。先运行 blueprint skill 的 init。');
  return root;
}

function ctx() {
  const root = rootOrDie();
  const cfg = loadConfig(root);
  return { root, cfg, repo: loadRepo(root, cfg) };
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

function git(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

function baseCommit(root) {
  return git(root, ['rev-parse', 'HEAD']);
}

function width(s) {
  let w = 0;
  for (const ch of String(s)) w += /[　-鿿＀-￯]/.test(ch) ? 2 : 1;
  return w;
}

function pad(s, n) {
  return String(s) + ' '.repeat(Math.max(1, n - width(s)));
}

function clip(s, n) {
  const text = String(s).split('\n')[0].trim();
  if (width(text) <= n) return text;
  let out = '';
  for (const ch of text) {
    if (width(out) + 2 > n) break;
    out += ch;
  }
  return out + '…';
}

/** review 已解决条目在确认清单里的一行:编号 + 首行标题 + 落点。 */
function resolvedLine(item) {
  const head = `${item.label || ''} ${clip(item.title, 40)}`.trim();
  return `  ${pad(head, 48)}→ ${item.notes.join(' / ') || '(未注明落点)'}`;
}

// ------------------------------------------------------------------- scan

function cmdScan() {
  const { repo } = ctx();
  const result = scan(repo);
  // pipeline 只按 next 分派:取件顺序(服务先于对象、能力先于引用它的活动、
  // 同服务内按 depends_on 拓扑)全部由脚本决定,模型不参与排序。
  result.next = nextTask(result, repo);
  if (flag('json')) {
    out(JSON.stringify(result, null, 2));
  } else {
    const rows = [];
    for (const [id, r] of Object.entries(result.services)) if (r.stage !== 'ready') rows.push([id, r.stage, r.detail]);
    for (const ref of result.unclaimed) rows.push([ref, 'unclaimed', 'product 锚点尚无对应服务']);
    for (const [id, r] of Object.entries(result.capabilities)) if (r.stage !== 'ready') rows.push([id, r.stage, r.detail]);
    for (const [id, r] of Object.entries(result.activities)) if (r.stage !== 'ready') rows.push([id, r.stage, r.detail]);
    const idWidth = Math.max(24, ...rows.map((r) => width(r[0]) + 2));
    const stageWidth = Math.max(18, ...rows.map((r) => width(r[1]) + 2));
    for (const [id, stage, detail] of rows) out(`${pad(id, idWidth)}${pad(stage, stageWidth)}${detail || ''}`.trimEnd());
    if (!rows.length) out('全部就绪');
    else out('');
    const summary = Object.entries(result.summary)
      .sort((a, b) => (a[0] === 'ready' ? -1 : b[0] === 'ready' ? 1 : a[0].localeCompare(b[0])))
      .map(([k, v]) => `${k} ${v}`).join(' | ');
    if (summary) out(summary);
    if (result.next) {
      out('');
      out(`下一步  ${result.next.id}  ${result.next.stage}`);
    }
  }
  const pendingCount = Object.values(result.summary).reduce((n, v) => n + v, 0) - (result.summary.ready || 0);
  process.exit(pendingCount > 0 ? 1 : 0);
}

// ----------------------------------------------------------------- status

function cmdStatus(id) {
  const { repo } = ctx();
  if (!id) fail('用法: bp status <id>');
  const snap = loadSnapshot(repo.root);
  const kind = idKind(id);

  if (kind === 'domain' && repo.products.has(id)) {
    const product = repo.products.get(id);
    out(`域  ${id}   ${product.rel}`);
    out('');
    for (const title of product.anchors.keys()) {
      const ref = `${id}#${title}`;
      const users = repo.anchorUsers.get(ref) || [];
      out(`${pad(title, 24)}${users.length ? users.join(', ') : '(未建服务)'}`);
    }
    return;
  }

  if (repo.services.has(id)) {
    const svc = repo.services.get(id);
    const st = serviceStage(repo, id);
    const lock = repo.lock.services?.[id] || {};
    out(`服务  ${id}   ${svc.fm.title || ''}`);
    out(`锚点  ${svc.product || '(未声明)'}`);
    out(`stage ${st.stage}${st.detail ? '   ' + st.detail : ''}`);
    out(`flow  ${shortHash(svc.hash)}   lock ${lock.flow_hash ? shortHash(lock.flow_hash) : '(未确认)'}`);
    const steps = findSection(svc.sections, '流程');
    if (steps) {
      out('');
      out('流程');
      for (const line of steps.body.split('\n').filter((l) => l.trim())) out('  ' + line);
    }
    out('');
    out('活动');
    for (const item of svc.activityList) {
      const aid = `${id}.${item.slug}`;
      const r = repo.activities.has(aid) ? objectStage(repo, aid, snap) : { stage: '(未创建)', detail: '' };
      out(`  ${pad(item.slug, 20)}${pad(r.stage, 16)}${item.summary}`);
    }
    const caps = relatedCapabilities(repo, id).map((c) => c.id);
    const missing = missingForService(repo, id);
    if (caps.length || missing.length) {
      out('');
      out('领域能力');
      for (const c of caps) out(`  ${pad(c, 20)}${objectStage(repo, c, snap).stage}`);
      for (const c of missing) out(`  ${pad(c, 20)}未设计`);
    }
    return;
  }

  const obj = repo.activities.get(id) || repo.capabilities.get(id);
  if (!obj) fail(`找不到 ${id}`);
  const isCap = isCapabilityId(id);
  const lockEntry = isCap ? repo.lock.capabilities?.[id] : repo.lock.activities?.[id];
  const r = objectStage(repo, id, snap);
  out(`${isCap ? '领域能力' : '活动'}  ${id}   ${obj.fm.title || ''}`);
  out(`stage ${r.stage}${r.detail ? '   ' + r.detail : ''}`);
  out(`文档  ${obj.rel}   ${shortHash(obj.hash)}`);
  out(`spec  ${lockEntry?.spec ? shortHash(lockEntry.spec[isCap ? 'capability_hash' : 'activity_hash']) + '  ' + lockEntry.spec.approved_at : '(未确认)'}`);
  out(`impl  ${lockEntry?.impl ? shortHash(lockEntry.impl[isCap ? 'capability_hash' : 'activity_hash']) + '  ' + lockEntry.impl.verified_at : '(未实现)'}`);
  if (!isCap) {
    out(`依赖  ${obj.depends_on.join(', ') || '无'}`);
    out(`引用  ${obj.uses.join(', ') || '无'}`);
  } else {
    out(`引用方 ${obj.usedBy.join(', ') || '无'}`);
  }
  if (lockEntry?.impl?.files?.length) {
    out('');
    out('实现文件');
    for (const f of lockEntry.impl.files) out('  ' + f);
  }
}

// ------------------------------------------------------------------ scope

function cmdScope(id) {
  const { root, cfg, repo } = ctx();
  if (!id) fail('用法: bp scope <id>');
  const lines = [];
  const seen = new Set();
  const add = (p) => { if (p && !seen.has(p)) { seen.add(p); lines.push(p); } };

  const isCap = isCapabilityId(id);
  const obj = isCap ? repo.capabilities.get(id) : repo.activities.get(id);
  if (!obj) fail(`找不到 ${id}`);

  if (!isCap) {
    const svc = repo.services.get(obj.service);
    if (svc?.exists) add(`${svc.flowRel}#流程`);
    add(obj.rel);
    for (const dep of obj.depends_on) {
      const d = repo.activities.get(dep);
      if (d) add(`${d.rel}#输入输出`);
    }
    for (const u of obj.uses) {
      const c = repo.capabilities.get(u);
      if (c) add(`${c.rel}#契约`);
      else add(`blueprint/domain/${u.slice(1).replace('.', '/')}/capability.md  (缺失)`);
    }
  } else {
    add(obj.rel);
  }

  for (const t of obj.tables || []) {
    if (!t?.name) continue;
    const f = snapshotTableFile(root, t.name);
    add(path.relative(root, f.path) + (f.exists ? '' : '  (缺失)'));
  }
  add('blueprint/CONVENTIONS.md');

  const lockEntry = isCap ? repo.lock.capabilities?.[id] : repo.lock.activities?.[id];
  const codemap = loadCodemap(root, id);
  if (lockEntry?.impl && codemap?.files?.length) {
    for (const entry of codemap.files) {
      const p = typeof entry === 'string' ? entry : entry?.path;
      add(p);
    }
  } else {
    for (const dir of Object.values(resolveScope(cfg, id))) add(dir);
  }
  for (const p of cfg.always_readable || []) add(p);

  for (const l of lines) out(l);
}

// ------------------------------------------------------------------- read

function cmdRead(ref) {
  const { repo } = ctx();
  if (!ref) fail('用法: bp read <id>#<章节>');
  const idx = ref.lastIndexOf('#');
  const id = idx === -1 ? ref : ref.slice(0, idx);
  const section = idx === -1 ? null : ref.slice(idx + 1);

  let doc = null;
  if (repo.services.has(id)) doc = repo.services.get(id);
  else if (repo.activities.has(id)) doc = repo.activities.get(id);
  else if (repo.capabilities.has(id)) doc = repo.capabilities.get(id);
  else if (repo.products.has(id) && section) {
    const anchor = repo.products.get(id).anchors.get(section);
    if (!anchor) fail(`${id} 中没有锚点「${section}」`);
    out(anchor.body);
    return;
  }
  if (!doc) fail(`找不到 ${id}`);
  if (!section) { out(doc.raw); return; }
  const sec = findSection(doc.sections, section);
  if (!sec) fail(`${id} 中没有章节「${section}」`);
  out(sec.body);
}

// --------------------------------------------------------------- validate

function printErrors(errors) {
  const byWhere = new Map();
  for (const e of errors) {
    if (!byWhere.has(e.where)) byWhere.set(e.where, []);
    byWhere.get(e.where).push(e.msg);
  }
  for (const [where, msgs] of byWhere) {
    out(where);
    for (const m of msgs) out('  - ' + m);
  }
}

function cmdValidate(id) {
  const { repo } = ctx();
  const errors = validateId(repo, id);
  if (!errors.length) { out(id ? `${id} 校验通过` : '全部校验通过'); return; }
  printErrors(errors);
  out('');
  out(`${errors.length} 项不通过`);
  process.exit(3);
}

// ----------------------------------------------------------------- review

function reviewTargets(repo, id) {
  if (repo.services.has(id)) return serviceReviews(repo, id);
  const obj = repo.activities.get(id) || repo.capabilities.get(id);
  if (!obj) return [];
  if (!obj.review) return [];
  return [{
    kind: isCapabilityId(id) ? 'capability' : 'activity',
    id, label: obj.slug || id, path: obj.reviewPath, review: obj.review,
  }];
}

function reviewFileFor(repo, id) {
  if (repo.services.has(id)) return repo.services.get(id).reviewPath;
  const obj = repo.activities.get(id) || repo.capabilities.get(id);
  if (!obj) fail(`找不到 ${id}`);
  return obj.reviewPath;
}

function cmdReviewSweep(id) {
  const { repo } = ctx();
  const targets = repo.services.has(id) ? serviceReviews(repo, id) : reviewTargets(repo, id);
  if (!targets.length) { out(`${id} 没有 review 文件`); return; }
  let total = 0;
  for (const t of targets) {
    const { text, assigned } = review.sweep(t.review);
    if (assigned.length) fs.writeFileSync(t.path, text);
    for (const a of assigned) {
      out(`${t.label}  ${a.label} ${a.title}`);
      total++;
    }
  }
  out(total ? `分配 ${total} 个编号` : '没有待分配的编号');
}

function cmdReviewResolve(id, number) {
  const { repo } = ctx();
  const note = option('note');
  if (!number) fail('用法: bp review resolve <id> <编号> --note "<落点>"');
  if (!note) fail('必须提供 --note "<落点>",落点会进入 approve 时的确认清单');
  const file = reviewFileFor(repo, id);
  const raw = readFileSafe(file);
  if (raw === null) fail(`找不到 ${path.relative(repo.root, file)}`);
  const parsed = review.parseReview(raw);
  let res;
  try { res = review.resolveItem(parsed, number, note); } catch (e) { fail(e.message); }
  fs.writeFileSync(file, res.text);
  out(`[${res.item.prefix}${res.item.number}] ${res.item.title}  → ${note}`);
}

function cmdReviewStatus(id) {
  const { repo } = ctx();
  const targets = reviewTargets(repo, id);
  out(id);
  out('');
  let open = 0;
  for (const t of targets) {
    const state = review.reviewState(t.review);
    if (state === review.STATE_APPROVABLE) continue;
    const items = state === review.STATE_AI ? review.aiItems(t.review) : review.humanItems(t.review);
    open += items.length;
    const label = t.kind === 'flow' ? 'flow.review' : t.label;
    out(`${pad(label, 22)}${state === review.STATE_AI ? '待 AI 处理' : '待人答复'} ${items.length}`);
    for (const item of items) out(`  ${item.text.split('\n')[0]}`);
    out('');
  }
  if (!open) { out('可 approve'); process.exit(0); }
  out('未达准出条件');
  process.exit(1);
}

// ---------------------------------------------------------------- approve

function resolvedItemsOf(reviewObj) {
  if (!reviewObj) return [];
  return reviewObj.areas[review.AREA_RESOLVED].items;
}

function requireEmptyReviews(repo, targets) {
  const blocking = targets.filter((t) => review.reviewState(t.review) !== review.STATE_APPROVABLE);
  if (blocking.length) {
    errOut('review 尚未处理完:');
    for (const t of blocking) {
      const state = review.reviewState(t.review);
      errOut(`  ${t.kind === 'flow' ? 'flow.review' : t.label}  ${state === review.STATE_AI ? '待 AI 处理' : '待人答复'} ${review.openCount(t.review)}`);
    }
    process.exit(1);
  }
}

function cmdApproveFlow(serviceId) {
  const { repo } = ctx();
  const svc = repo.services.get(serviceId);
  if (!svc) fail(`找不到服务 ${serviceId}`);
  if (!svc.exists) fail(`${serviceId} 缺少 flow.md`);

  const targets = serviceReviews(repo, serviceId).filter((t) => t.kind === 'flow');
  requireEmptyReviews(repo, targets);

  const errors = validateService(repo, serviceId);
  if (errors.length) { printErrors(errors); process.exit(1); }

  const anchor = anchorOf(repo, svc.product);
  if (!anchor) fail(`product 锚点 ${svc.product} 不存在`);

  const lock = repo.lock.services?.[serviceId] || {};
  const steps = (findSection(svc.sections, '流程')?.body || '').split('\n').filter((l) => /^\d+\./.test(l.trim()));
  const changedFlow = lock.flow_hash && lock.flow_hash !== svc.hash;

  out(`服务  ${serviceId}`);
  out(`锚点  ${svc.product}`);
  out('');
  out(`流程步骤  ${steps.length} 步${lock.product_hash ? (changedFlow ? '(流程已变更)' : '') : '(首次确认)'}`);
  out('');

  const resolved = resolvedItemsOf(svc.review);
  if (resolved.length) {
    out('本轮确认落点');
    for (const item of resolved) out(resolvedLine(item));
    out('');
  }

  const known = new Set(
    Object.keys(repo.lock.activities || {})
      .filter((a) => a.startsWith(serviceId + '.'))
      .map((a) => a.split('.').pop())
  );
  out('活动划分变更');
  for (const item of svc.activityList) {
    out(`  ${pad(known.has(item.slug) ? '保留' : '新增', 6)}${pad(item.slug, 20)}${item.summary}`);
  }
  for (const slug of known) {
    if (!svc.activityList.some((i) => i.slug === slug)) out(`  ${pad('删除', 6)}${slug}`);
  }
  out('');

  if (!flag('confirm')) {
    out(`确认后执行:bp approve flow ${serviceId} --confirm`);
    return;
  }

  const lockData = loadLock(repo.root);
  lockData.services[serviceId] = {
    ...(lockData.services[serviceId] || {}),
    product_anchor: svc.product,
    product_hash: anchor.anchor.hash,
    flow_approved_at: nowIso(),
  };
  saveLock(repo.root, lockData);
  if (exists(svc.reviewPath)) fs.rmSync(svc.reviewPath);
  out(`已确认 ${serviceId} 的业务流程与活动划分`);
}

function cmdApproveActivity(serviceId) {
  const { repo } = ctx();
  const svc = repo.services.get(serviceId);
  if (!svc) fail(`找不到服务 ${serviceId}`);
  const lock = repo.lock.services?.[serviceId];
  if (!lock?.product_hash) fail(`${serviceId} 尚未通过 approve flow`);

  const anchor = anchorOf(repo, svc.product);
  if (!anchor) fail(`product 锚点 ${svc.product} 不存在`);
  if (anchor.anchor.hash !== lock.product_hash) {
    fail(`product 描述在 approve flow 之后又被改过,流程需重新整理。先跑 bp scan`);
  }

  const targets = serviceReviews(repo, serviceId).filter((t) => t.kind !== 'flow');
  requireEmptyReviews(repo, targets);

  const missing = missingForService(repo, serviceId);
  if (missing.length) fail(`以下领域能力被 uses 引用但文档不存在:\n  ${missing.join('\n  ')}`);

  const listed = svc.activityList.map((i) => i.slug);
  const dirs = svc.activities.map((a) => a.split('.').pop());
  const onlyListed = listed.filter((s) => !dirs.includes(s));
  const onlyDirs = dirs.filter((s) => !listed.includes(s));
  if (onlyListed.length || onlyDirs.length) {
    errOut('「活动划分」与活动目录不一致:');
    for (const s of onlyListed) errOut(`  划分中有但目录缺失: ${s}`);
    for (const s of onlyDirs) errOut(`  目录中有但划分缺失: ${s}`);
    process.exit(1);
  }

  const caps = relatedCapabilities(repo, serviceId);
  const errors = [...validateService(repo, serviceId)];
  for (const aid of svc.activities) errors.push(...validateActivity(repo, aid));
  for (const cap of caps) errors.push(...validateCapability(repo, cap.id));
  if (errors.length) { printErrors(errors); process.exit(1); }

  const added = [];
  const modified = [];
  const unaffected = [];
  for (const aid of svc.activities) {
    const act = repo.activities.get(aid);
    const spec = repo.lock.activities?.[aid]?.spec;
    const item = svc.activityList.find((i) => i.slug === act.slug);
    const row = { id: aid, slug: act.slug, summary: item?.summary || act.fm.title || '' };
    if (!spec) added.push(row);
    else if (spec.activity_hash !== act.hash) modified.push(row);
    else unaffected.push(row);
  }
  const capAdded = [];
  const capModified = [];
  for (const cap of caps) {
    const spec = repo.lock.capabilities?.[cap.id]?.spec;
    if (!spec) capAdded.push(cap);
    else if (spec.capability_hash !== cap.hash) capModified.push(cap);
  }

  out(`服务  ${serviceId}`);
  out('');
  if (added.length) {
    out('新增');
    for (const r of added) out(`  ${pad(r.slug, 20)}${r.summary}`);
    out('');
  }
  if (modified.length) {
    out('修改');
    for (const r of modified) out(`  ${pad(r.slug, 20)}${r.summary}`);
    out('');
  }
  if (unaffected.length) {
    out('不受影响');
    for (const r of unaffected) out(`  ${pad(r.slug, 20)}${r.summary}`);
    out('');
  }
  if (capAdded.length || capModified.length) {
    out('领域能力');
    for (const c of capAdded) out(`  ${pad('新增', 6)}${pad(c.id, 22)}${c.fm.title || ''}  引用方 ${c.usedBy.join(', ')}`);
    for (const c of capModified) out(`  ${pad('修改', 6)}${pad(c.id, 22)}${c.fm.title || ''}  引用方 ${c.usedBy.join(', ')}`);
    out('');
  }

  const resolved = [];
  for (const t of serviceReviews(repo, serviceId).filter((x) => x.kind !== 'flow')) {
    for (const item of resolvedItemsOf(t.review)) resolved.push({ label: t.label, item });
  }
  if (resolved.length) {
    out('本轮确认落点');
    for (const r of resolved) out(resolvedLine(r.item));
    out('');
  }

  const todos = repo.todos.filter((t) => t.service === serviceId);
  if (todos.length) {
    out('数据库变更');
    for (const t of todos) out(`  ${t.rel}`);
    out('');
  }

  if (!flag('confirm')) {
    out(`确认后执行:bp approve activity ${serviceId} --confirm`);
    return;
  }

  const lockData = loadLock(repo.root);
  const at = nowIso();
  for (const aid of svc.activities) {
    const act = repo.activities.get(aid);
    const prev = lockData.activities[aid] || {};
    lockData.activities[aid] = {
      ...prev,
      spec: { service: serviceId, activity_hash: act.hash, approved_at: at },
    };
  }
  for (const cap of caps) {
    const prev = lockData.capabilities[cap.id] || {};
    lockData.capabilities[cap.id] = {
      ...prev,
      spec: {
        capability_hash: cap.hash,
        approved_at: at,
        introduced_by: prev.spec?.introduced_by || serviceId,
        contract_fields: contractFields(cap),
      },
    };
  }
  lockData.services[serviceId] = {
    ...(lockData.services[serviceId] || {}),
    flow_hash: svc.hash,
    activity_approved_at: at,
  };
  saveLock(repo.root, lockData);

  for (const t of serviceReviews(repo, serviceId).filter((x) => x.kind !== 'flow')) {
    if (exists(t.path)) fs.rmSync(t.path);
  }
  out(`已确认 ${serviceId} 的 ${svc.activities.length} 个活动${caps.length ? ` 与 ${caps.length} 个领域能力` : ''}`);
}

// ----------------------------------------------------------------- schema

function cmdSchemaPull() {
  const { root, cfg } = ctx();
  try {
    const res = schemaPull(root, cfg);
    out(`已导出 ${res.tables.length} 张表,source_version ${res.version || 'unknown'}`);
  } catch (e) {
    fail(`schema pull 失败,保留现有 snapshot:${e.message}`);
  }
}

function declarationsOf(repo, id) {
  if (!id) {
    return [...repo.activities.values(), ...repo.capabilities.values()];
  }
  if (repo.services.has(id)) {
    return repo.services.get(id).activities.map((a) => repo.activities.get(a));
  }
  const obj = repo.activities.get(id) || repo.capabilities.get(id);
  if (!obj) fail(`找不到 ${id}`);
  return [obj];
}

function cmdSchemaCheck(id) {
  const { root, repo } = ctx();
  const decls = declarationsOf(repo, id);
  const { gaps, snapshotExists } = checkTables(root, decls);
  if (!snapshotExists) {
    out('snapshot 尚未生成,视为全部缺失。先运行 bp schema pull');
  }
  if (!gaps.length) { out(`${id || '全部'} 的表结构声明已就绪`); return; }
  out('缺失:');
  for (const g of gaps) {
    const name = g.kind === 'table' ? g.table : `${g.table}.${g.column}`;
    out(`  ${pad(name, 28)}${g.by} 声明,${g.detail}`);
  }
  out('');
  process.exit(1);
}

// ---------------------------------------------------------------- codemap

function cmdCodemapValidate(id) {
  const { root, repo } = ctx();
  if (!id) fail('用法: bp codemap validate <id>');
  const targets = repo.services.has(id) ? repo.services.get(id).activities : [id];
  const errors = [];
  for (const t of targets) errors.push(...validateCodemap(root, t).errors);
  if (errors.length) { printErrors(errors); process.exit(1); }
  out(`${id} 的 codemap 校验通过`);
}

function cmdWhich(file) {
  const { root } = ctx();
  if (!file) fail('用法: bp which <file>');
  const hits = whichFile(root, file);
  if (!hits.length) { out('该文件不属于任何活动或领域能力'); process.exit(1); }
  for (const h of hits) out(h);
}

// ----------------------------------------------------------------- verify

function runVerify(root, cfg, scopes) {
  const list = scopes.filter((s) => cfg.verify[s]);
  if (!list.length) { out('config.verify 中没有可执行的条目,跳过'); return true; }
  for (const s of list) {
    out(`verify ${s}: ${cfg.verify[s]}`);
    try {
      execSync(cfg.verify[s], { cwd: root, stdio: 'inherit' });
    } catch {
      errOut(`verify ${s} 失败`);
      return false;
    }
  }
  return true;
}

function verifyScopesForId(cfg, id, files) {
  const scope = resolveScope(cfg, id);
  const hit = new Set();
  for (const f of files || []) {
    for (const [key, dir] of Object.entries(scope)) {
      if (String(f).startsWith(dir)) hit.add(key === 'domain' ? 'backend' : key);
    }
  }
  if (!hit.size) for (const k of Object.keys(cfg.verify)) hit.add(k);
  return [...hit];
}

function cmdVerify() {
  const { root, cfg } = ctx();
  const s = option('scope');
  const scopes = s ? [s] : Object.keys(cfg.verify);
  process.exit(runVerify(root, cfg, scopes) ? 0 : 1);
}

// -------------------------------------------------------------------- lock

function lockPrecheck(repo, id) {
  const isCap = isCapabilityId(id);
  const obj = isCap ? repo.capabilities.get(id) : repo.activities.get(id);
  const problems = [];
  if (!obj) return { problems: [{ where: id, msg: '对象不存在' }] };

  const errors = isCap ? validateCapability(repo, id) : validateActivity(repo, id);
  problems.push(...errors);

  const lockEntry = isCap ? repo.lock.capabilities?.[id] : repo.lock.activities?.[id];
  const key = isCap ? 'capability_hash' : 'activity_hash';
  if (!lockEntry?.spec) problems.push({ where: id, msg: '尚未 approve,不能盖章' });
  else if (lockEntry.spec[key] !== obj.hash) {
    problems.push({ where: id, msg: '文档在 approve 之后被改动,需重新走 approve' });
  }

  const cm = validateCodemap(repo.root, id);
  problems.push(...cm.errors);
  return { problems, files: cm.files, obj, isCap, key };
}

function cmdLockCheck(id) {
  const { repo } = ctx();
  if (!id) fail('用法: bp lock check <id>');
  const { problems, files } = lockPrecheck(repo, id);
  if (problems.length) { printErrors(problems); process.exit(1); }
  out(`${id} 预检通过,codemap 记录 ${files.length} 个文件`);
}

function cmdLockCommit(id) {
  const { root, cfg, repo } = ctx();
  if (!id) fail('用法: bp lock commit <id>');
  const isCap = isCapabilityId(id);
  const obj = isCap ? repo.capabilities.get(id) : repo.activities.get(id);
  if (!obj) fail(`找不到 ${id}`);

  const errors = isCap ? validateCapability(repo, id) : validateActivity(repo, id);
  if (errors.length) { printErrors(errors); process.exit(3); }

  const { problems, files, key } = lockPrecheck(repo, id);
  if (problems.length) { printErrors(problems); process.exit(1); }

  if (!runVerify(root, cfg, verifyScopesForId(cfg, id, files))) process.exit(1);

  const lockData = loadLock(root);
  const bucket = isCap ? lockData.capabilities : lockData.activities;
  bucket[id] = {
    ...(bucket[id] || {}),
    impl: {
      [key]: obj.hash,
      files,
      verified_at: nowIso(),
      base_commit: baseCommit(root),
    },
  };
  saveLock(root, lockData);
  out(`已盖章 ${id}(${files.length} 个文件)`);
}

function cmdLockAdopt(id) {
  const { root, repo } = ctx();
  const all = flag('all');
  if (!id && !all) fail('用法: bp lock adopt <id> | --all');
  const ids = all
    ? [...repo.capabilities.keys(), ...repo.activities.keys()]
    : (repo.services.has(id) ? repo.services.get(id).activities : [id]);

  const lockData = loadLock(root);
  const done = [];
  for (const target of ids) {
    const isCap = isCapabilityId(target);
    const obj = isCap ? repo.capabilities.get(target) : repo.activities.get(target);
    if (!obj) fail(`找不到 ${target}`);
    const errors = isCap ? validateCapability(repo, target) : validateActivity(repo, target);
    if (errors.length) { printErrors(errors); process.exit(1); }
    const cm = validateCodemap(root, target);
    if (cm.errors.length) { printErrors(cm.errors); process.exit(1); }
    const key = isCap ? 'capability_hash' : 'activity_hash';
    const bucket = isCap ? lockData.capabilities : lockData.activities;
    const prev = bucket[target] || {};
    bucket[target] = {
      ...prev,
      spec: prev.spec || {
        ...(isCap ? { introduced_by: null } : { service: obj.service }),
        [key]: obj.hash,
        approved_at: nowIso(),
        ...(isCap ? { contract_fields: contractFields(obj) } : {}),
      },
      impl: { [key]: obj.hash, files: cm.files, verified_at: nowIso(), base_commit: baseCommit(root) },
    };
    done.push(target);
  }
  saveLock(root, lockData);
  out(`已接入 ${done.length} 个对象(跳过 verify)`);
  for (const d of done) out('  ' + d);
}

// ----------------------------------------------------------------- commit

function changedFiles(root) {
  // -uall:未跟踪目录默认会被折叠成一行,那样新增的活动文档识别不出来
  const raw = git(root, ['status', '--porcelain', '-uall']);
  if (raw === null) return null;
  const files = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const status = line.slice(0, 2);
    let file = line.slice(3);
    if (file.includes(' -> ')) file = file.split(' -> ')[1];
    files.push({ status: status.trim(), file: file.replace(/^"|"$/g, '') });
  }
  return files;
}

function detectService(repo, changed) {
  const hits = new Set();
  for (const { file } of changed || []) {
    const m = file.match(/^blueprint\/spec\/([^/]+)\/([^/]+)\//);
    if (m) hits.add(`${m[1]}.${m[2]}`);
  }
  if (hits.size === 1) return [...hits][0];
  if (hits.size > 1) return [...hits].sort()[0];
  // 回退:取最近确认过活动的服务
  const entries = Object.entries(repo.lock.services || {})
    .filter(([, v]) => v.activity_approved_at)
    .sort((a, b) => String(b[1].activity_approved_at).localeCompare(String(a[1].activity_approved_at)));
  return entries.length ? entries[0][0] : null;
}

function buildCommitContext(repo) {
  const root = repo.root;
  const changed = changedFiles(root);
  const serviceId = option('service') || detectService(repo, changed);
  if (!serviceId) fail('无法确定本轮变更所属的服务,可用 --service <id> 指定');
  const svc = repo.services.get(serviceId);
  if (!svc) fail(`找不到服务 ${serviceId}`);

  const changedSet = new Map((changed || []).map((c) => [c.file, c.status]));
  const isNew = (file) => ['A', '??'].includes(changedSet.get(file));
  const isTouched = (file) => changedSet.has(file);

  const activityAdded = [];
  const activityModified = [];
  const activityUnaffected = [];
  for (const aid of svc.activities) {
    const act = repo.activities.get(aid);
    if (!changed) { activityModified.push(aid); continue; }
    if (isNew(act.rel)) activityAdded.push(aid);
    else if (isTouched(act.rel)) activityModified.push(aid);
    else activityUnaffected.push(aid);
  }
  const caps = relatedCapabilities(repo, serviceId);
  const capabilityAdded = caps.filter((c) => !changed || isNew(c.rel)).map((c) => c.id);

  const implemented = [];
  const files = new Set();
  for (const target of [...caps.map((c) => c.id), ...svc.activities]) {
    const isCap = isCapabilityId(target);
    const entry = isCap ? repo.lock.capabilities?.[target] : repo.lock.activities?.[target];
    if (!entry?.impl) continue;
    const key = isCap ? 'capability_hash' : 'activity_hash';
    if (entry.impl[key] !== entry.spec?.[key]) continue;
    implemented.push(target);
    for (const f of entry.impl.files || []) files.add(f);
    const cm = codemapPath(root, target);
    if (exists(cm)) files.add(path.relative(root, cm).split(path.sep).join('/'));
  }

  if (svc.exists) files.add(svc.flowRel);
  for (const aid of svc.activities) files.add(repo.activities.get(aid).rel);
  for (const c of caps) files.add(c.rel);
  files.add('blueprint/lock.json');
  for (const t of repo.todos.filter((x) => x.service === serviceId)) files.add(t.rel);

  const doneDir = bpPath(root, 'todo', 'done');
  const migrations = listFiles(doneDir)
    .filter((n) => n.includes(`_${serviceId}_migration`))
    .map((n) => n.slice(0, 14)).sort();

  const flowChanged = changed ? isTouched(svc.flowRel) : true;

  return {
    service: serviceId,
    anchor: svc.product,
    flow_changed: flowChanged,
    activity_added: activityAdded,
    activity_modified: activityModified,
    activity_unaffected: activityUnaffected,
    capability_added: capabilityAdded,
    implemented,
    files: [...files].filter((f) => exists(path.join(root, f))).sort(),
    migration: migrations.length ? migrations[migrations.length - 1] : null,
    flow_hash: svc.hash,
  };
}

function cmdCommitContext() {
  const { repo } = ctx();
  const c = buildCommitContext(repo);
  if (flag('json')) { out(JSON.stringify(c, null, 2)); return; }
  const lines = [
    `service: ${c.service}`,
    `anchor: ${c.anchor}`,
    `flow_changed: ${c.flow_changed}`,
    `activity_added: [${c.activity_added.join(', ')}]`,
    `activity_modified: [${c.activity_modified.join(', ')}]`,
    `activity_unaffected: [${c.activity_unaffected.join(', ')}]`,
    `capability_added: [${c.capability_added.map((x) => `"${x}"`).join(', ')}]`,
    `implemented: [${c.implemented.map((x) => (x.startsWith('@') ? `"${x}"` : x)).join(', ')}]`,
    'files:',
    ...c.files.map((f) => `  - ${f}`),
    `migration: ${c.migration || 'null'}`,
  ];
  out(lines.join('\n'));
}

function cmdCommitMessage() {
  const { cfg, repo } = ctx();
  const summary = option('summary');
  if (!summary) fail('用法: bp commit-message --summary "<正文>"');
  const c = buildCommitContext(repo);
  const rules = cfg.commit?.type_rules || {};
  const hasNew = c.activity_added.length > 0 || c.capability_added.length > 0;
  const type = hasNew ? (rules.has_new_activity || 'feat') : (rules.only_modified || 'fix');
  const scope = c.service.split('.')[0];

  const parts = String(summary).replace(/\r\n?/g, '\n').split('\n');
  const title = parts[0].trim();
  const body = parts.slice(1).join('\n').trim();

  const tail = ['--- blueprint ---', `service   ${c.service}`];
  if (c.flow_changed) tail.push(`flow      ${shortHash(c.flow_hash)}`);
  for (const a of c.activity_added) tail.push(`act+      ${a.split('.').pop()}`);
  for (const a of c.activity_modified) tail.push(`act~      ${a.split('.').pop()}`);
  for (const a of c.capability_added) tail.push(`cap+      ${a}`);
  const implFiles = new Set();
  for (const target of c.implemented) {
    const isCap = isCapabilityId(target);
    const entry = isCap ? repo.lock.capabilities?.[target] : repo.lock.activities?.[target];
    for (const f of entry?.impl?.files || []) implFiles.add(f);
  }
  tail.push(`impl      ${implFiles.size} files`);
  if (c.migration) tail.push(`migration ${c.migration}`);

  out([`${type}(${scope}): ${title}`, '', body, '', tail.join('\n')].join('\n').replace(/\n{3,}/g, '\n\n'));
}

// ----------------------------------------------------------------- delete

function sanitize(id) {
  return String(id).replace(/^@/, 'at-').replace(/[^\w.-]/g, '-');
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function similarAnchors(repo, svc) {
  const words = new Set();
  for (const item of svc.activityList) for (const ch of item.summary) words.add(ch);
  const scored = [];
  for (const product of repo.products.values()) {
    for (const title of product.anchors.keys()) {
      const ref = `${product.id}#${title}`;
      if ((repo.anchorUsers.get(ref) || []).length) continue;
      let hit = 0;
      for (const ch of title) if (words.has(ch)) hit++;
      if (hit >= 2) scored.push({ ref, hit });
    }
  }
  return scored.sort((a, b) => b.hit - a.hit).slice(0, 3);
}

function cmdDeletePlan(id) {
  const { root, repo } = ctx();
  if (!id) fail('用法: bp delete plan <id>');
  const lines = [];
  const file = bpPath(root, 'todo', `${timestamp()}_${sanitize(id)}_manual.md`);

  if (repo.services.has(id)) {
    const svc = repo.services.get(id);
    lines.push(`# ${id} 清理确认`, '', '## 情况', '');
    lines.push(`\`${svc.flowRel}\` 声明的锚点 \`${svc.product}\` 在 product 中不存在。`, '');
    lines.push('**这可能是两种情况之一:**', '');
    lines.push('- product 中该标题被重命名 → 修改 flow.md front-matter 的 `product` 字段指向新标题,删除本文件,不要执行下方清理');
    lines.push('- 该服务已废弃 → 按下方清单执行清理', '');
    const similar = similarAnchors(repo, svc);
    if (similar.length) {
      lines.push('## 疑似重命名目标', '');
      for (const s of similar) lines.push(`- \`${s.ref}\`(与活动划分有词面重合)`);
      lines.push('');
    }
    const onlyMine = [];
    for (const cap of relatedCapabilities(repo, id)) {
      const others = cap.usedBy.filter((a) => !a.startsWith(id + '.'));
      if (!others.length) onlyMine.push(cap.id);
    }
    if (onlyMine.length) {
      lines.push('## 引用关系', '', '以下领域能力仅被本服务引用,清理后将变为 orphaned:', '');
      for (const c of onlyMine) lines.push(`- ${c}`);
      lines.push('');
    }
    lines.push('## 待删除(文档层)', '');
    lines.push(`- ${svc.rel}/  整个目录`);
    lines.push(`- blueprint/codemap/${svc.domain}/${svc.slug}/  整个目录`);
    lines.push(`- lock.json 中 services.${id} 与 activities 下全部 ${id}.* 条目`, '');
    const codeFiles = new Set();
    for (const aid of svc.activities) {
      for (const f of repo.lock.activities?.[aid]?.impl?.files || []) codeFiles.add(f);
    }
    lines.push('## 待删除(代码层,需人再次确认)', '');
    if (codeFiles.size) for (const f of codeFiles) lines.push(`- ${f}`);
    else lines.push('- (codemap 中没有记录代码文件)');
    lines.push('');
  } else {
    const isCap = isCapabilityId(id);
    const obj = isCap ? repo.capabilities.get(id) : repo.activities.get(id);
    if (!obj) fail(`找不到 ${id}`);
    lines.push(`# ${id} 清理确认`, '', '## 情况', '');
    if (isCap) lines.push(`领域能力 \`${id}\` 已无任何活动 \`uses\` 引用。`, '');
    else lines.push(`活动 \`${id}\` 不在 ${obj.service} 的「活动划分」中。`, '');
    lines.push('若这是重命名,请改回 id 或补上引用,并删除本文件。', '');
    lines.push('## 待删除(文档层)', '');
    lines.push(`- ${path.relative(root, obj.dir)}/  整个目录`);
    lines.push(`- ${path.relative(root, codemapPath(root, id))}`);
    lines.push(`- lock.json 中 ${isCap ? 'capabilities' : 'activities'}.${id}`, '');
    const entry = isCap ? repo.lock.capabilities?.[id] : repo.lock.activities?.[id];
    lines.push('## 待删除(代码层,需人再次确认)', '');
    const fl = entry?.impl?.files || [];
    if (fl.length) for (const f of fl) lines.push(`- ${f}`);
    else lines.push('- (codemap 中没有记录代码文件)');
    lines.push('');
    if (!isCap) {
      const orphanCaps = [];
      for (const u of obj.uses) {
        const cap = repo.capabilities.get(u);
        if (cap && cap.usedBy.length === 1 && cap.usedBy[0] === id) orphanCaps.push(u);
      }
      if (orphanCaps.length) {
        lines.push('## 引用关系', '', '以下领域能力仅被本活动引用,清理后将变为 orphaned:', '');
        for (const c of orphanCaps) lines.push(`- ${c}`);
        lines.push('');
      }
    }
  }
  lines.push('## 执行后', '', '运行 `node blueprint/scripts/bp.mjs scan` 确认无残留。', '');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'));
  out(`已生成清理清单: ${path.relative(root, file)}`);
}

// ----------------------------------------------------------------- doctor

function cmdDoctor() {
  const { root, cfg } = ctx();
  const problems = install.doctor(root, cfg.project);
  const current = cfg.blueprint_version;
  if (current !== install.BP_VERSION) {
    problems.push({ level: 'warn', msg: `config 记录 v${current},脚本为 v${install.BP_VERSION},可运行 blueprint skill 的 upgrade` });
  }
  if (!problems.length) { out(`安装完整,blueprint v${install.BP_VERSION}`); return; }
  for (const p of problems) out(`${p.level === 'error' ? '[错误]' : '[提示]'} ${p.msg}`);
  process.exit(problems.some((p) => p.level === 'error') ? 1 : 0);
}

// ------------------------------------------------------------ init/upgrade

function cmdInit() {
  const root = path.resolve(option('root', process.cwd()));
  const type = option('type', 'backend');
  const project = option('project');
  if (!project) fail('用法: bp init --type <backend|frontend|fullstack> --project <名称> [--root <目录>]');
  if (!['backend', 'frontend', 'fullstack'].includes(type)) fail(`type 只能是 backend / frontend / fullstack`);
  const opts = { type, project, layout: {}, verify: {}, db: {} };
  for (const key of ['backend', 'frontend', 'domain']) {
    const v = option(`layout-${key}`);
    if (v) opts.layout[key] = v;
  }
  for (const key of ['backend', 'frontend']) {
    const v = option(`verify-${key}`);
    if (v) opts.verify[key] = v;
  }
  const dialect = option('db-dialect');
  if (dialect) opts.db.dialect = dialect;
  const migrationTable = option('db-migration-table');
  if (migrationTable) opts.db.migration_table = migrationTable;

  const created = install.init(root, opts);
  out(`已在 ${root} 初始化 blueprint v${install.BP_VERSION}(${type})`);
  for (const c of created) out('  ' + c);
  out('');
  out('接下来:');
  out('  1. 手写 blueprint/CONVENTIONS.md 与 blueprint/context/db.yaml');
  out('  2. node blueprint/scripts/bp.mjs schema pull');
  out(`  3. 在 blueprint/product/ 写第一个域,然后调用 pipeline-${project} skill`);
}

function cmdUpgrade() {
  const root = rootOrDie();
  const cfg = loadConfig(root);
  const project = option('project', cfg.project);
  const type = option('type', cfg.type);
  const from = cfg.blueprint_version;
  const added = install.upgrade(root, { project, type, oldProject: cfg.project });
  out(`已升级 v${from} → v${install.BP_VERSION}`);
  if (added.length) {
    out('config.yaml 新增字段(已带默认值追加到文件末尾):');
    for (const a of added) out('  ' + a);
  }
}

// -------------------------------------------------------------------- 入口

function usage() {
  out(`blueprint v${install.BP_VERSION}

  bp scan [--json]                      全量扫描,输出每个对象的 stage
  bp status <id>                        详情
  bp scope <id>                         输出读取清单
  bp read <id>#<章节>                    输出章节纯文本
  bp validate [<id>]                    模板与引用校验
  bp review sweep <id>                  分配编号
  bp review resolve <id> <编号> --note   迁移条目到已解决
  bp review status <id>                 剩余条目列举
  bp approve flow <service> [--confirm]      第一道门
  bp approve activity <service> [--confirm]  第二道门
  bp schema pull                        导出全库到 snapshot
  bp schema check <id>                  比对声明与 snapshot
  bp codemap validate <id>              检查文件均存在
  bp which <file>                       反查文件所属活动或能力
  bp verify [--scope <s>]               执行 config.verify
  bp lock check <id>                    盖章前预检
  bp lock commit <id>                   跑 verify,通过则写 impl 段
  bp lock adopt <id>|--all              存量接入,跳过 verify
  bp commit-context [--json]            本轮变更的结构化摘要
  bp commit-message --summary "<文本>"   拼装完整提交信息
  bp delete plan <id>                   生成清理清单到 todo
  bp doctor                             检查安装完整性
  bp init --type <t> --project <p>      初始化项目
  bp upgrade                            升级生成物`);
}

function main() {
  const args = positional();
  const cmd = args[0];
  try {
    switch (cmd) {
      case 'scan': return cmdScan();
      case 'status': return cmdStatus(args[1]);
      case 'scope': return cmdScope(args[1]);
      case 'read': return cmdRead(args[1]);
      case 'validate': return cmdValidate(args[1]);
      case 'review': {
        const sub = args[1];
        if (sub === 'sweep') return cmdReviewSweep(args[2]);
        if (sub === 'resolve') return cmdReviewResolve(args[2], args[3]);
        if (sub === 'status') return cmdReviewStatus(args[2]);
        return fail('用法: bp review sweep|resolve|status <id>');
      }
      case 'approve': {
        const sub = args[1];
        if (sub === 'flow') return cmdApproveFlow(args[2]);
        if (sub === 'activity') return cmdApproveActivity(args[2]);
        return fail('用法: bp approve flow|activity <service> [--confirm]');
      }
      case 'schema': {
        const sub = args[1];
        if (sub === 'pull') return cmdSchemaPull();
        if (sub === 'check') return cmdSchemaCheck(args[2]);
        return fail('用法: bp schema pull|check');
      }
      case 'codemap': {
        if (args[1] === 'validate') return cmdCodemapValidate(args[2]);
        return fail('用法: bp codemap validate <id>');
      }
      case 'which': return cmdWhich(args[1]);
      case 'verify': return cmdVerify();
      case 'lock': {
        const sub = args[1];
        if (sub === 'check') return cmdLockCheck(args[2]);
        if (sub === 'commit') return cmdLockCommit(args[2]);
        if (sub === 'adopt') return cmdLockAdopt(args[2]);
        return fail('用法: bp lock check|commit|adopt <id>');
      }
      case 'commit-context': return cmdCommitContext();
      case 'commit-message': return cmdCommitMessage();
      case 'delete': {
        if (args[1] === 'plan') return cmdDeletePlan(args[2]);
        return fail('用法: bp delete plan <id>');
      }
      case 'doctor': return cmdDoctor();
      case 'init': return cmdInit();
      case 'upgrade': return cmdUpgrade();
      case undefined:
      case 'help':
      case '--help':
      case '-h': return usage();
      default: return fail(`未知命令: ${cmd}\n运行 bp help 查看全部命令`);
    }
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
  }
}

main();
