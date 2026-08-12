#!/usr/bin/env node
// blueprint 流水线的确定性判断全部在这里。模型不参与任何状态推理。
//
// 命令一律三级:bp <场景> <操作> [参数]
//   场景 = 一个业务架构层(flow / activity / domain / code / commit)或一类资源(review / schema / …)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

import {
  findRoot, bpPath, loadConfig, resolveScope, isDomainId, idKind,
} from './lib/config.mjs';
import {
  loadRepo, loadLock, saveLock, anchorOf, serviceReviews,
  relatedDomains, missingForService, servicesOfDomain,
} from './lib/repo.mjs';
import {
  validateId, validateService, validateActivity, validateDomain, contractFields,
} from './lib/schema.mjs';
import * as review from './lib/review.mjs';
import { globalStage, scanLayer, STAGE_ACTION, LAYERS } from './lib/stage.mjs';
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

function table(rows) {
  if (!rows.length) return;
  const widths = [];
  for (const r of rows) {
    r.forEach((c, i) => { widths[i] = Math.max(widths[i] || 0, width(c) + 2); });
  }
  for (const r of rows) {
    out(r.map((c, i) => (i === r.length - 1 ? String(c) : pad(c, widths[i]))).join('').trimEnd());
  }
}

// ------------------------------------------------------------------- stage

function cmdStage() {
  const { repo } = ctx();
  const result = globalStage(repo);
  const action = STAGE_ACTION[result.stage];
  if (flag('json')) {
    out(JSON.stringify({ stage: result.stage, action, rows: result.rows }, null, 2));
    return;
  }
  out(`stage   ${result.stage}`);
  out(`动作    ${action.text}`);
  if (result.rows.length) {
    out('');
    table(result.rows.map((r) => [r.id, r.state, r.detail || '']));
  }
}

// -------------------------------------------------------------------- scan

function cmdScanProduct(repo) {
  for (const product of [...repo.products.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    out(`${product.id}.md`);
    for (const title of product.anchors.keys()) {
      const users = repo.anchorUsers.get(`${product.id}#${title}`) || [];
      out(`  ${pad(title, 28)}${users.length ? users.join(', ') : '(未认领)'}`);
    }
  }
  if (!repo.products.size) out('blueprint/product/ 下还没有商业能力文件');
}

function cmdScanOverview(repo) {
  const result = globalStage(repo);
  const rows = [];
  for (const layer of LAYERS) {
    const all = scanLayer(repo, layer);
    const open = all.filter((r) => r.state !== 'done');
    const by = {};
    for (const r of open) by[r.state] = (by[r.state] || 0) + 1;
    const detail = Object.entries(by).map(([k, v]) => `${k} ${v}`).join('  ') || '全部就绪';
    rows.push([layer, `${all.length - open.length}/${all.length} done`, detail]);
  }
  table(rows);
  out('');
  out(`当前 stage  ${result.stage}   ${STAGE_ACTION[result.stage].text}`);
}

function cmdScan(layer) {
  const { repo } = ctx();
  if (!layer) return cmdScanOverview(repo);
  if (layer === 'product') return cmdScanProduct(repo);
  if (!LAYERS.includes(layer)) {
    fail(`未知的层: ${layer}(可选 product / ${LAYERS.join(' / ')})`);
  }
  const rows = scanLayer(repo, layer);
  const open = flag('all') ? rows : rows.filter((r) => r.state !== 'done');
  if (flag('json')) { out(JSON.stringify(open, null, 2)); return; }
  if (!open.length) { out(`${layer} 层全部就绪`); return; }
  table(open.map((r) => [r.id, r.state, r.detail || '']));
}

// ----------------------------------------------------------------- status

function cmdStatus(id) {
  const { repo } = ctx();
  if (!id) fail('用法: bp status <id>');
  const snap = loadSnapshot(repo.root);
  const kind = idKind(id);

  if (kind === 'capability' && repo.products.has(id)) {
    const product = repo.products.get(id);
    out(`商业能力  ${id}   ${product.rel}`);
    out('');
    for (const title of product.anchors.keys()) {
      const ref = `${id}#${title}`;
      const users = repo.anchorUsers.get(ref) || [];
      out(`${pad(title, 24)}${users.length ? users.join(', ') : '(未认领)'}`);
    }
    return;
  }

  if (repo.services.has(id)) {
    const svc = repo.services.get(id);
    const lock = repo.lock.services?.[id] || {};
    out(`业务服务  ${id}   ${svc.fm.title || ''}`);
    out(`锚点      ${svc.product || '(未声明)'}`);
    for (const layer of ['flow', 'activity']) {
      const hit = scanLayer(repo, layer).find((r) => r.id === id);
      if (hit) out(`${pad(layer, 10)}${pad(hit.state, 10)}${hit.detail}`);
    }
    out(`flow hash ${shortHash(svc.hash)}   已确认 ${lock.flow?.flow_hash ? shortHash(lock.flow.flow_hash) : '(未确认)'}`);
    const steps = findSection(svc.sections, '流程');
    if (steps) {
      out('');
      out('流程');
      for (const line of steps.body.split('\n').filter((l) => l.trim())) out('  ' + line);
    }
    out('');
    out('业务活动');
    const codeRows = scanLayer(repo, 'code');
    for (const item of svc.activityList) {
      const aid = `${id}.${item.slug}`;
      const hit = codeRows.find((r) => r.id === aid);
      out(`  ${pad(item.slug, 20)}${pad(hit ? hit.state : '(未产出)', 12)}${item.summary}`);
    }
    const doms = relatedDomains(repo, id).map((c) => c.id);
    const missing = missingForService(repo, id);
    if (doms.length || missing.length) {
      out('');
      out('领域能力');
      for (const c of doms) {
        const hit = codeRows.find((r) => r.id === c);
        out(`  ${pad(c, 22)}${hit ? hit.state : '(未确认)'}`);
      }
      for (const c of missing) out(`  ${pad(c, 22)}未设计`);
    }
    return;
  }

  const obj = repo.activities.get(id) || repo.domains.get(id);
  if (!obj) fail(`找不到 ${id}`);
  const isDom = isDomainId(id);
  const lockEntry = isDom ? repo.lock.domains?.[id] : repo.lock.activities?.[id];
  const key = isDom ? 'domain_hash' : 'activity_hash';
  out(`${isDom ? '领域能力' : '业务活动'}  ${id}   ${obj.fm.title || ''}`);
  for (const layer of LAYERS) {
    const hit = scanLayer(repo, layer).find((r) => r.id === id);
    if (hit) out(`${pad(layer, 10)}${pad(hit.state, 10)}${hit.detail}`);
  }
  out(`文档      ${obj.rel}   ${shortHash(obj.hash)}`);
  out(`spec      ${lockEntry?.spec ? shortHash(lockEntry.spec[key]) + '  ' + lockEntry.spec.approved_at : '(未确认)'}`);
  out(`impl      ${lockEntry?.impl ? shortHash(lockEntry.impl[key]) + '  ' + lockEntry.impl.verified_at : '(未实现)'}`);
  if (!isDom) {
    out(`依赖      ${obj.depends_on.join(', ') || '无'}`);
    out(`引用      ${obj.uses.join(', ') || '无'}`);
  } else {
    out(`引用方    ${obj.usedBy.join(', ') || '无'}`);
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

  const isDom = isDomainId(id);
  const obj = isDom ? repo.domains.get(id) : repo.activities.get(id);
  if (!obj) fail(`找不到 ${id}`);

  if (!isDom) {
    const svc = repo.services.get(obj.service);
    if (svc?.exists) add(`${svc.flowRel}#流程`);
    add(obj.rel);
    for (const dep of obj.depends_on) {
      const d = repo.activities.get(dep);
      if (d) add(`${d.rel}#输入输出`);
    }
    for (const u of obj.uses) {
      const c = repo.domains.get(u);
      if (c) add(`${c.rel}#契约`);
      else add(`blueprint/domain/${u.slice(1).replace('.', '/')}/domain.md  (缺失)`);
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

  const lockEntry = isDom ? repo.lock.domains?.[id] : repo.lock.activities?.[id];
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
  else if (repo.domains.has(id)) doc = repo.domains.get(id);
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

/** 澄清记录的落点:服务 → flow.review,活动 → activity.review,领域能力 → domain.review。 */
function reviewFileFor(repo, id) {
  if (repo.services.has(id)) return repo.services.get(id).reviewPath;
  const obj = repo.activities.get(id) || repo.domains.get(id);
  if (!obj) fail(`找不到 ${id}`);
  return obj.reviewPath;
}

function loadReviewFile(repo, id, createIfMissing = false) {
  const file = reviewFileFor(repo, id);
  let raw = readFileSafe(file);
  if (raw === null) {
    if (!createIfMissing) fail(`${id} 还没有澄清记录(${path.relative(repo.root, file)})`);
    raw = review.emptyReview(id);
  }
  return { file, parsed: review.parseReview(raw) };
}

function saveReviewFile(file, parsed) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, review.render(parsed));
}

function cmdReviewAsk(id) {
  const { repo } = ctx();
  const q = option('q');
  if (!id || !q) fail('用法: bp review ask <id> --q "<问题>"');
  const { file, parsed } = loadReviewFile(repo, id, true);
  const item = review.addQuestion(parsed, q);
  saveReviewFile(file, parsed);
  out(`${item.label} ${item.title}`);
}

function cmdReviewAnswer(id, number) {
  const { repo } = ctx();
  const a = option('a');
  if (!id || !number || !a) fail('用法: bp review answer <id> <Qn> --a "<答复>"');
  const { file, parsed } = loadReviewFile(repo, id);
  let item;
  try { item = review.answerQuestion(parsed, String(number).replace(/^Q/i, ''), a); } catch (e) { fail(e.message); }
  saveReviewFile(file, parsed);
  out(`${item.label} 已记录答复`);
}

function cmdReviewResolve(id, number) {
  const { repo } = ctx();
  const note = option('note');
  if (!id || !number || !note) fail('用法: bp review resolve <id> <Qn> --note "<落点>"');
  const { file, parsed } = loadReviewFile(repo, id);
  let item;
  try { item = review.resolveQuestion(parsed, String(number).replace(/^Q/i, ''), note); } catch (e) { fail(e.message); }
  saveReviewFile(file, parsed);
  out(`${item.label} → ${note}`);
}

function cmdReviewList(id) {
  const { repo } = ctx();
  if (!id) fail('用法: bp review list <id>');
  const file = reviewFileFor(repo, id);
  const raw = readFileSafe(file);
  if (raw === null) { out(`${id} 没有澄清记录`); return; }
  const parsed = review.parseReview(raw);
  const pending = review.pendingItems(parsed);
  const answered = review.answeredItems(parsed);
  if (flag('json')) {
    out(JSON.stringify({
      id,
      pending: pending.map((i) => ({ number: i.number, question: i.title })),
      answered: answered.map((i) => ({ number: i.number, question: i.title, answer: i.answer, note: i.note || null })),
    }, null, 2));
    return;
  }
  if (pending.length) {
    out('待答复');
    for (const i of pending) out(`  [Q${i.number}] ${i.title}`);
    out('');
  }
  if (answered.length) {
    out('已答复');
    for (const i of answered) {
      out(`  [Q${i.number}] ${clip(i.title, 46)}`);
      out(`      > ${clip(i.answer, 60)}`);
      out(`      → ${i.note || '(未写落点)'}`);
    }
    out('');
  }
  out(review.isClean(parsed) ? '澄清已结清,可以 approve' : `未结清:${review.stateLabel(parsed)}`);
}

// ---------------------------------------------------------------- 澄清落点

function requireCleanReviews(targets) {
  const dirty = targets.filter((t) => !review.isClean(t.review));
  if (dirty.length) {
    errOut('澄清尚未结清:');
    for (const t of dirty) errOut(`  ${t.label}  ${review.stateLabel(t.review)}`);
    errOut('');
    errOut('待答复的用 bp review answer 记录人的答复,已答复未落实的用 bp review resolve 写落点。');
    process.exit(1);
  }
}

function printResolved(targets) {
  const rows = [];
  for (const t of targets) {
    for (const item of review.answeredItems(t.review)) {
      rows.push([`  [Q${item.number}]`, clip(item.title, 38), `→ ${item.note}`]);
    }
  }
  if (!rows.length) return;
  out('本轮澄清落点');
  table(rows);
  out('');
}

// ------------------------------------------------------------------- flow

function serviceOrDie(repo, id) {
  const svc = repo.services.get(id);
  if (!svc) fail(`找不到业务服务 ${id}`);
  if (!svc.exists) fail(`${id} 缺少 flow.md`);
  return svc;
}

function cmdFlowChanges(serviceId) {
  const { repo } = ctx();
  if (!serviceId) fail('用法: bp flow changes <service>');
  const svc = serviceOrDie(repo, serviceId);
  const lock = repo.lock.services?.[serviceId]?.flow;
  const anchor = anchorOf(repo, svc.product);
  if (!anchor) fail(`product 锚点 ${svc.product} 不存在`);

  const steps = (findSection(svc.sections, '流程')?.body || '')
    .split('\n').filter((l) => /^\d+\./.test(l.trim()));

  out(`业务服务  ${serviceId}   ${svc.fm.title || ''}`);
  out(`商业能力  ${svc.product}`);
  out('');
  out(`流程步骤  ${steps.length} 步${lock ? (svc.hash !== lock.flow_hash ? '(已变更)' : '') : '(首次确认)'}`);
  out('');
  for (const line of steps) out(`  ${line.trim()}`);
  out('');

  printResolved(serviceReviews(repo, serviceId).filter((t) => t.kind === 'flow'));

  const known = new Set(
    Object.keys(repo.lock.activities || {})
      .filter((a) => a.startsWith(serviceId + '.'))
      .map((a) => a.split('.').pop())
  );
  out('活动划分');
  const rows = [];
  for (const item of svc.activityList) {
    rows.push([`  ${known.has(item.slug) ? '保留' : '新增'}`, item.slug, item.summary]);
  }
  for (const slug of known) {
    if (!svc.activityList.some((i) => i.slug === slug)) rows.push(['  删除', slug, '']);
  }
  table(rows);
}

function cmdFlowApprove(serviceId) {
  const { repo } = ctx();
  if (!serviceId) fail('用法: bp flow approve <service>');
  const svc = serviceOrDie(repo, serviceId);

  requireCleanReviews(serviceReviews(repo, serviceId).filter((t) => t.kind === 'flow'));

  const errors = validateService(repo, serviceId);
  if (errors.length) { printErrors(errors); process.exit(1); }

  const anchor = anchorOf(repo, svc.product);
  if (!anchor) fail(`product 锚点 ${svc.product} 不存在`);

  const lockData = loadLock(repo.root);
  const prev = lockData.services[serviceId] || {};
  lockData.services[serviceId] = {
    ...prev,
    product_anchor: svc.product,
    flow: {
      product_hash: anchor.anchor.hash,
      flow_hash: svc.hash,
      approved_at: nowIso(),
    },
  };
  saveLock(repo.root, lockData);
  if (exists(svc.reviewPath)) fs.rmSync(svc.reviewPath);
  out(`已确认 ${serviceId} 的业务流程与活动划分`);
}

// --------------------------------------------------------------- activity

function cmdActivityChanges(serviceId) {
  const { repo } = ctx();
  if (!serviceId) fail('用法: bp activity changes <service>');
  const svc = serviceOrDie(repo, serviceId);
  if (!repo.lock.services?.[serviceId]?.flow) fail(`${serviceId} 尚未通过 bp flow approve`);

  const added = [];
  const modified = [];
  const unaffected = [];
  for (const aid of svc.activities) {
    const act = repo.activities.get(aid);
    const spec = repo.lock.activities?.[aid]?.spec;
    const item = svc.activityList.find((i) => i.slug === act.slug);
    const row = [`  ${act.slug}`, item?.summary || act.fm.title || ''];
    if (!spec) added.push(row);
    else if (spec.activity_hash !== act.hash) modified.push(row);
    else unaffected.push(row);
  }

  out(`业务服务  ${serviceId}`);
  out('');
  for (const [title, rows] of [['新增', added], ['修改', modified], ['不受影响', unaffected]]) {
    if (!rows.length) continue;
    out(title);
    table(rows);
    out('');
  }

  const missing = missingForService(repo, serviceId);
  if (missing.length) {
    out('待设计的领域能力(activity 只登记引用,设计由 domain 阶段完成)');
    for (const m of missing) out(`  ${m}`);
    out('');
  }

  printResolved(serviceReviews(repo, serviceId).filter((t) => t.kind === 'activity'));

  const todos = repo.todos.filter((t) => t.service === serviceId);
  if (todos.length) {
    out('数据库变更');
    for (const t of todos) out(`  ${t.rel}`);
    out('');
  }
}

function cmdActivityApprove(serviceId) {
  const { repo } = ctx();
  if (!serviceId) fail('用法: bp activity approve <service>');
  const svc = serviceOrDie(repo, serviceId);
  const svcLock = repo.lock.services?.[serviceId];
  if (!svcLock?.flow) fail(`${serviceId} 尚未通过 bp flow approve`);

  const anchor = anchorOf(repo, svc.product);
  if (!anchor) fail(`product 锚点 ${svc.product} 不存在`);
  if (anchor.anchor.hash !== svcLock.flow.product_hash) {
    fail(`product 描述在 flow approve 之后又被改过,流程需重新整理。先跑 bp stage`);
  }

  requireCleanReviews(serviceReviews(repo, serviceId).filter((t) => t.kind === 'activity'));

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

  const errors = [...validateService(repo, serviceId)];
  for (const aid of svc.activities) errors.push(...validateActivity(repo, aid));
  if (errors.length) { printErrors(errors); process.exit(1); }

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
  lockData.services[serviceId] = {
    ...(lockData.services[serviceId] || {}),
    activity: { flow_hash: svc.hash, approved_at: at },
  };
  saveLock(repo.root, lockData);

  for (const t of serviceReviews(repo, serviceId).filter((x) => x.kind === 'activity')) {
    if (exists(t.path)) fs.rmSync(t.path);
  }
  const missing = missingForService(repo, serviceId);
  out(`已确认 ${serviceId} 的 ${svc.activities.length} 个业务活动`);
  if (missing.length) out(`其中登记了 ${missing.length} 个待设计的领域能力:${missing.join(', ')}`);
}

// ----------------------------------------------------------------- domain

function domainOrDie(repo, id) {
  const dom = repo.domains.get(id);
  if (!dom) fail(`找不到领域能力 ${id}`);
  return dom;
}

function cmdDomainList() {
  const { repo } = ctx();
  const rows = [];
  for (const id of [...repo.domains.keys()].sort()) {
    const dom = repo.domains.get(id);
    const spec = repo.lock.domains?.[id]?.spec;
    rows.push([id, spec ? (spec.domain_hash === dom.hash ? '已确认' : '已更新') : '待确认',
      `引用方 ${dom.usedBy.join(', ') || '无'}`]);
  }
  for (const m of repo.missingDomains) {
    rows.push([m.id, '待设计', `引用方 ${m.usedBy.join(', ')}`]);
  }
  for (const [id, r] of Object.entries(repo.lock.rejected_domains || {})) {
    rows.push([id, '已否决', `${r.reason || ''}${r.at ? '  ' + r.at.slice(0, 10) : ''}`]);
  }
  if (!rows.length) { out('还没有登记任何领域能力'); return; }
  table(rows.sort((a, b) => a[0].localeCompare(b[0])));
}

function cmdDomainReject(id) {
  const { repo } = ctx();
  const reason = option('reason');
  if (!id || !reason) fail('用法: bp domain reject <@id> --reason "<理由>"');
  if (!isDomainId(id)) fail('领域能力 id 应以 @ 开头');
  const lockData = loadLock(repo.root);
  lockData.rejected_domains = lockData.rejected_domains || {};
  lockData.rejected_domains[id] = { reason, at: nowIso() };
  saveLock(repo.root, lockData);
  out(`已记录:${id} 不提取为领域能力(${reason})`);
  out('activity skill 之后不会再就该项反复询问。');
}

function cmdDomainChanges(id) {
  const { repo } = ctx();
  if (!id) fail('用法: bp domain changes <@id>');
  const dom = domainOrDie(repo, id);
  const spec = repo.lock.domains?.[id]?.spec;

  out(`领域能力  ${id}   ${dom.fm.title || ''}`);
  out(`引用方    ${dom.usedBy.join(', ') || '无'}`);
  out(`所属服务  ${servicesOfDomain(repo, dom).join(', ') || '无'}`);
  out('');

  const now = contractFields(dom);
  const before = spec?.contract_fields || [];
  out(`契约字段  ${now.length} 项${spec ? '' : '(首次确认)'}`);
  const rows = [];
  for (const f of now) rows.push([`  ${before.includes(f) ? '保留' : '新增'}`, f]);
  table(rows);
  out('');

  const duty = findSection(dom.sections, '职责');
  if (duty) {
    out('职责');
    for (const line of duty.body.split('\n').filter((l) => l.trim())) out(`  ${line}`);
    out('');
  }

  if (dom.review) printResolved([{ label: id, review: dom.review }]);
}

function cmdDomainApprove(id) {
  const { repo } = ctx();
  if (!id) fail('用法: bp domain approve <@id>');
  const dom = domainOrDie(repo, id);

  if (dom.review) requireCleanReviews([{ label: id, review: dom.review }]);

  const errors = validateDomain(repo, id);
  if (errors.length) { printErrors(errors); process.exit(1); }

  const lockData = loadLock(repo.root);
  const prev = lockData.domains[id] || {};
  lockData.domains[id] = {
    ...prev,
    spec: {
      domain_hash: dom.hash,
      approved_at: nowIso(),
      introduced_by: prev.spec?.introduced_by || servicesOfDomain(repo, dom)[0] || null,
      contract_fields: contractFields(dom),
    },
  };
  saveLock(repo.root, lockData);
  if (exists(dom.reviewPath)) fs.rmSync(dom.reviewPath);
  out(`已确认领域能力 ${id} 的契约`);
}

// ------------------------------------------------------------------- code

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

function implPrecheck(repo, id) {
  const isDom = isDomainId(id);
  const obj = isDom ? repo.domains.get(id) : repo.activities.get(id);
  const problems = [];
  if (!obj) return { problems: [{ where: id, msg: '对象不存在' }] };

  problems.push(...(isDom ? validateDomain(repo, id) : validateActivity(repo, id)));

  const lockEntry = isDom ? repo.lock.domains?.[id] : repo.lock.activities?.[id];
  const key = isDom ? 'domain_hash' : 'activity_hash';
  if (!lockEntry?.spec) problems.push({ where: id, msg: '尚未 approve,不能记录实现' });
  else if (lockEntry.spec[key] !== obj.hash) {
    problems.push({ where: id, msg: '文档在 approve 之后被改动,需重新走 approve' });
  }

  const cm = validateCodemap(repo.root, id);
  problems.push(...cm.errors);
  return { problems, files: cm.files, obj, isDom, key };
}

function cmdCodeCheck(id) {
  const { repo } = ctx();
  if (!id) fail('用法: bp code check <id>');
  const { problems, files } = implPrecheck(repo, id);
  if (problems.length) { printErrors(problems); process.exit(1); }
  out(`${id} 预检通过,codemap 记录 ${files.length} 个文件`);
}

function cmdCodeDone(id) {
  const { root, cfg, repo } = ctx();
  if (!id) fail('用法: bp code done <id>');
  const { problems, files, obj, isDom, key } = implPrecheck(repo, id);
  if (problems.length) { printErrors(problems); process.exit(1); }

  if (!runVerify(root, cfg, verifyScopesForId(cfg, id, files))) process.exit(1);

  const lockData = loadLock(root);
  const bucket = isDom ? lockData.domains : lockData.activities;
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
  out(`已记录 ${id} 的实现(${files.length} 个文件)`);
}

function cmdCodeAdopt(id) {
  const { root, repo } = ctx();
  const all = flag('all');
  if (!id && !all) fail('用法: bp code adopt <id> | --all');
  const ids = all
    ? [...repo.domains.keys(), ...repo.activities.keys()]
    : (repo.services.has(id) ? repo.services.get(id).activities : [id]);

  const lockData = loadLock(root);
  const done = [];
  for (const target of ids) {
    const isDom = isDomainId(target);
    const obj = isDom ? repo.domains.get(target) : repo.activities.get(target);
    if (!obj) fail(`找不到 ${target}`);
    const errors = isDom ? validateDomain(repo, target) : validateActivity(repo, target);
    if (errors.length) { printErrors(errors); process.exit(1); }
    const cm = validateCodemap(root, target);
    if (cm.errors.length) { printErrors(cm.errors); process.exit(1); }
    const key = isDom ? 'domain_hash' : 'activity_hash';
    const bucket = isDom ? lockData.domains : lockData.activities;
    const prev = bucket[target] || {};
    bucket[target] = {
      ...prev,
      spec: prev.spec || {
        ...(isDom ? { introduced_by: null } : { service: obj.service }),
        [key]: obj.hash,
        approved_at: nowIso(),
        ...(isDom ? { contract_fields: contractFields(obj) } : {}),
      },
      impl: { [key]: obj.hash, files: cm.files, verified_at: nowIso(), base_commit: baseCommit(root) },
    };
    done.push(target);
  }
  saveLock(root, lockData);
  out(`已接入 ${done.length} 个对象(跳过 verify)`);
  for (const d of done) out('  ' + d);
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
  if (!id) return [...repo.activities.values(), ...repo.domains.values()];
  if (repo.services.has(id)) {
    return repo.services.get(id).activities.map((a) => repo.activities.get(a));
  }
  const obj = repo.activities.get(id) || repo.domains.get(id);
  if (!obj) fail(`找不到 ${id}`);
  return [obj];
}

function cmdSchemaCheck(id) {
  const { root, repo } = ctx();
  const decls = declarationsOf(repo, id);
  const { gaps, snapshotExists } = checkTables(root, decls);
  // snapshot 为空不等于库里没有这些表。此时列出「缺失」会让调用方据此生成建表工单,
  // 而那些表很可能早就存在——最坏情况是一份把既有表重建的 SQL。宁可停下。
  if (!snapshotExists) {
    fail('snapshot 尚未生成,无法判断表结构是否就绪。\n'
      + '先配好 blueprint/context/db.yaml 再运行 bp schema pull。\n'
      + '(snapshot 为空只说明还没导出过,不代表库里没有这些表,不要据此生成建表工单)', 2);
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
  if (!hits.length) { out('该文件不属于任何业务活动或领域能力'); process.exit(1); }
  for (const h of hits) out(h);
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

/**
 * 本轮变更的结构化摘要。范围是整条流水线,不限单个服务——
 * 一波需求里多个业务服务一起推进,它们属于同一次提交。
 */
function buildCommitContext(repo) {
  const root = repo.root;
  const changed = changedFiles(root) || [];
  const isNew = (s) => ['A', '??'].includes(s);

  const products = [];
  const services = [];
  const activities = [];
  const domains = [];
  const others = [];

  for (const { status, file } of changed) {
    const kind = isNew(status) ? '新增' : '修改';
    let m;
    if ((m = file.match(/^blueprint\/product\/([^/]+)\.md$/))) {
      products.push({ id: m[1], kind });
    } else if ((m = file.match(/^blueprint\/spec\/([^/]+)\/([^/]+)\/flow\.md$/))) {
      services.push({ id: `${m[1]}.${m[2]}`, kind });
    } else if ((m = file.match(/^blueprint\/spec\/([^/]+)\/([^/]+)\/([^/]+)\/activity\.md$/))) {
      activities.push({ id: `${m[1]}.${m[2]}.${m[3]}`, kind });
    } else if ((m = file.match(/^blueprint\/domain\/([^/]+)\/([^/]+)\/domain\.md$/))) {
      domains.push({ id: `@${m[1]}.${m[2]}`, kind });
    } else if (!file.startsWith('blueprint/')) {
      others.push(file);
    }
  }

  // 已记录实现的对象,连同它们的 codemap 一起进入本次提交
  const implemented = [];
  const files = new Set();
  for (const [id, entry] of Object.entries(repo.lock.activities || {})) {
    if (entry.impl && entry.spec && entry.impl.activity_hash === entry.spec.activity_hash) {
      implemented.push(id);
      for (const f of entry.impl.files || []) files.add(f);
    }
  }
  for (const [id, entry] of Object.entries(repo.lock.domains || {})) {
    if (entry.impl && entry.spec && entry.impl.domain_hash === entry.spec.domain_hash) {
      implemented.push(id);
      for (const f of entry.impl.files || []) files.add(f);
    }
  }
  for (const id of implemented) {
    const cm = codemapPath(root, id);
    if (exists(cm)) files.add(path.relative(root, cm).split(path.sep).join('/'));
  }
  // blueprint/ 下的全部改动一律进本次提交
  for (const { file } of changed) {
    if (file.startsWith('blueprint/')) files.add(file);
  }

  const capabilities = [...new Set([
    ...products.map((p) => p.id),
    ...services.map((s) => s.id.split('.')[0]),
    ...activities.map((a) => a.id.split('.')[0]),
  ])].sort();

  const migrations = listFiles(bpPath(root, 'todo', 'done'))
    .filter((n) => /_migration\.md$/.test(n))
    .map((n) => n.slice(0, 14)).sort();

  return {
    capabilities,
    products,
    services,
    activities,
    domains,
    implemented: implemented.sort(),
    impl_file_count: files.size ? [...files].filter((f) => !f.startsWith('blueprint/')).length : 0,
    files: [...files].filter((f) => exists(path.join(root, f))).sort(),
    untracked_code: others,
    migration: migrations.length ? migrations[migrations.length - 1] : null,
  };
}

function cmdCommitContext() {
  const { repo } = ctx();
  const c = buildCommitContext(repo);
  if (flag('json')) { out(JSON.stringify(c, null, 2)); return; }
  const line = (label, list) => {
    if (!list.length) return;
    out(label);
    table(list.map((x) => [`  ${x.kind}`, x.id]));
  };
  out(`商业能力范围  ${c.capabilities.join(', ') || '(无)'}`);
  out('');
  line('商业能力', c.products);
  line('业务服务', c.services);
  line('业务活动', c.activities);
  line('领域能力', c.domains);
  out('');
  out(`已实现对象  ${c.implemented.length}`);
  out(`提交文件    ${c.files.length}(其中代码 ${c.impl_file_count})`);
  if (c.migration) out(`数据库迁移  ${c.migration}`);
  out('');
  out('files:');
  for (const f of c.files) out(`  ${f}`);
}

function cmdCommitMessage() {
  const { cfg, repo } = ctx();
  const summary = option('summary');
  if (!summary) fail('用法: bp commit message --summary "<正文>"');
  const c = buildCommitContext(repo);
  const rules = cfg.commit?.type_rules || {};
  const hasNew = [...c.services, ...c.activities, ...c.domains].some((x) => x.kind === '新增');
  const type = hasNew ? (rules.has_new_activity || 'feat') : (rules.only_modified || 'fix');
  const scope = c.capabilities.join(',') || 'blueprint';

  const parts = String(summary).replace(/\r\n?/g, '\n').split('\n');
  const title = parts[0].trim();
  const body = parts.slice(1).join('\n').trim();

  const tail = ['--- blueprint ---'];
  const block = (label, list) => {
    list.forEach((x, i) => tail.push(`${pad(i === 0 ? label : '', 10)}${pad(x.id, 34)}${x.kind}`));
  };
  block('商业能力', c.products);
  block('业务服务', c.services);
  block('业务活动', c.activities);
  block('领域能力', c.domains);
  if (c.impl_file_count) tail.push(`${pad('实现', 10)}${c.impl_file_count} 个文件`);
  if (c.migration) tail.push(`${pad('迁移', 10)}${c.migration}`);

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
    lines.push('- 该业务服务已废弃 → 按下方清单执行清理', '');
    const similar = similarAnchors(repo, svc);
    if (similar.length) {
      lines.push('## 疑似重命名目标', '');
      for (const s of similar) lines.push(`- \`${s.ref}\`(与活动划分有词面重合)`);
      lines.push('');
    }
    const onlyMine = [];
    for (const dom of relatedDomains(repo, id)) {
      const others = dom.usedBy.filter((a) => !a.startsWith(id + '.'));
      if (!others.length) onlyMine.push(dom.id);
    }
    if (onlyMine.length) {
      lines.push('## 引用关系', '', '以下领域能力仅被本服务引用,清理后将变为 orphaned:', '');
      for (const c of onlyMine) lines.push(`- ${c}`);
      lines.push('');
    }
    lines.push('## 待删除(文档层)', '');
    lines.push(`- ${svc.rel}/  整个目录`);
    lines.push(`- blueprint/codemap/${svc.capability}/${svc.slug}/  整个目录`);
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
    const isDom = isDomainId(id);
    const obj = isDom ? repo.domains.get(id) : repo.activities.get(id);
    if (!obj) fail(`找不到 ${id}`);
    lines.push(`# ${id} 清理确认`, '', '## 情况', '');
    if (isDom) lines.push(`领域能力 \`${id}\` 已无任何业务活动 \`uses\` 引用。`, '');
    else lines.push(`业务活动 \`${id}\` 不在 ${obj.service} 的「活动划分」中。`, '');
    lines.push('若这是重命名,请改回 id 或补上引用,并删除本文件。', '');
    lines.push('## 待删除(文档层)', '');
    lines.push(`- ${path.relative(root, obj.dir)}/  整个目录`);
    lines.push(`- ${path.relative(root, codemapPath(root, id))}`);
    lines.push(`- lock.json 中 ${isDom ? 'domains' : 'activities'}.${id}`, '');
    const entry = isDom ? repo.lock.domains?.[id] : repo.lock.activities?.[id];
    lines.push('## 待删除(代码层,需人再次确认)', '');
    const fl = entry?.impl?.files || [];
    if (fl.length) for (const f of fl) lines.push(`- ${f}`);
    else lines.push('- (codemap 中没有记录代码文件)');
    lines.push('');
    if (!isDom) {
      const orphanDoms = [];
      for (const u of obj.uses) {
        const dom = repo.domains.get(u);
        if (dom && dom.usedBy.length === 1 && dom.usedBy[0] === id) orphanDoms.push(u);
      }
      if (orphanDoms.length) {
        lines.push('## 引用关系', '', '以下领域能力仅被本活动引用,清理后将变为 orphaned:', '');
        for (const c of orphanDoms) lines.push(`- ${c}`);
        lines.push('');
      }
    }
  }
  lines.push('## 执行后', '', '运行 `node blueprint/scripts/bp.mjs stage` 确认无残留。', '');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n'));
  out(`已生成清理清单: ${path.relative(root, file)}`);
}

// ------------------------------------------------------------------- init

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
  out(`  3. 在 blueprint/product/ 写第一个商业能力,然后调用 pipeline-${project} skill`);
}

// -------------------------------------------------------------------- 入口

function usage() {
  out(`blueprint v${install.BP_VERSION}

  bp stage [--json]                     全项目当前 stage 与该调的 skill
  bp scan [product|flow|activity|domain|code] [--all] [--json]
                                        某一层的待办清单;不带层名为总览

  bp review ask <id> --q "<问题>"        提一个澄清问题,返回编号
  bp review answer <id> <Qn> --a "<答复>" 记录人的答复
  bp review resolve <id> <Qn> --note "<落点>"  记录落在文档的什么位置
  bp review list <id> [--json]          列出澄清记录

  bp flow changes <service>             打印待确认的流程与活动划分
  bp flow approve <service>             确认并盖章
  bp activity changes <service>         打印活动文档变更
  bp activity approve <service>         确认并盖章
  bp domain list                        全部领域能力及状态
  bp domain changes <@id>               打印契约变更
  bp domain approve <@id>               确认并盖章
  bp domain reject <@id> --reason "…"   记录不提取的决定

  bp code check <id>                    记录实现前的预检
  bp code done <id>                     跑 verify,通过则记录实现
  bp code adopt <id>|--all              存量接入,跳过 verify

  bp commit context [--json]            本轮变更的结构化摘要
  bp commit message --summary "<文本>"   拼装完整提交信息

  bp status <id>                        单个对象详情
  bp scope <id>                         输出读取清单
  bp read <id>#<章节>                    输出章节纯文本
  bp validate [<id>]                    模板与引用校验
  bp schema pull                        导出全库到 snapshot
  bp schema check [<id>]                比对声明与 snapshot
  bp codemap validate <id>              检查文件均存在
  bp which <file>                       反查文件所属活动或能力
  bp verify [--scope <s>]               执行 config.verify
  bp delete plan <id>                   生成清理清单到 todo
  bp init --type <t> --project <p>      初始化项目(幂等,重跑可刷新生成物)`);
}

function main() {
  const args = positional();
  const cmd = args[0];
  try {
    switch (cmd) {
      case 'stage': return cmdStage();
      case 'scan': return cmdScan(args[1]);
      case 'status': return cmdStatus(args[1]);
      case 'scope': return cmdScope(args[1]);
      case 'read': return cmdRead(args[1]);
      case 'validate': return cmdValidate(args[1]);
      case 'review': {
        const sub = args[1];
        if (sub === 'ask') return cmdReviewAsk(args[2]);
        if (sub === 'answer') return cmdReviewAnswer(args[2], args[3]);
        if (sub === 'resolve') return cmdReviewResolve(args[2], args[3]);
        if (sub === 'list') return cmdReviewList(args[2]);
        return fail('用法: bp review ask|answer|resolve|list <id>');
      }
      case 'flow': {
        const sub = args[1];
        if (sub === 'changes') return cmdFlowChanges(args[2]);
        if (sub === 'approve') return cmdFlowApprove(args[2]);
        return fail('用法: bp flow changes|approve <service>');
      }
      case 'activity': {
        const sub = args[1];
        if (sub === 'changes') return cmdActivityChanges(args[2]);
        if (sub === 'approve') return cmdActivityApprove(args[2]);
        return fail('用法: bp activity changes|approve <service>');
      }
      case 'domain': {
        const sub = args[1];
        if (sub === 'list') return cmdDomainList();
        if (sub === 'changes') return cmdDomainChanges(args[2]);
        if (sub === 'approve') return cmdDomainApprove(args[2]);
        if (sub === 'reject') return cmdDomainReject(args[2]);
        return fail('用法: bp domain list|changes|approve|reject');
      }
      case 'code': {
        const sub = args[1];
        if (sub === 'check') return cmdCodeCheck(args[2]);
        if (sub === 'done') return cmdCodeDone(args[2]);
        if (sub === 'adopt') return cmdCodeAdopt(args[2]);
        return fail('用法: bp code check|done|adopt <id>');
      }
      case 'commit': {
        const sub = args[1];
        if (sub === 'context') return cmdCommitContext();
        if (sub === 'message') return cmdCommitMessage();
        return fail('用法: bp commit context|message');
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
      case 'delete': {
        if (args[1] === 'plan') return cmdDeletePlan(args[2]);
        return fail('用法: bp delete plan <id>');
      }
      case 'init': return cmdInit();
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
