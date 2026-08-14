import path from 'node:path';

import { bpPath, ACTIVITY_MARK, FLOW_MARK } from '../../lib/config.mjs';
import { codemapPath } from '../../lib/codemap.mjs';
import { exists, listFiles } from '../../lib/parse.mjs';
import { git } from '../../runtime/context.mjs';

function changedFiles(root) {
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

export function buildCommitContext(repo) {
  const root = repo.root;
  const changed = changedFiles(root) || [];
  const isNew = (status) => ['A', '??'].includes(status);

  const products = [];
  const services = [];
  const flows = [];
  const activities = [];
  const domains = [];
  const others = [];

  // 同一份文件在 git status 里出现多行时(索引里删了又作为未跟踪文件回来那类),
  // 只留先出现的那条,否则提交信息里同一个 id 会重复成两行。
  const add = (list, id, kind) => {
    if (!list.some((item) => item.id === id)) list.push({ id, kind });
  };

  for (const { status, file } of changed) {
    const kind = isNew(status) ? '新增' : '修改';
    let match;
    if ((match = file.match(/^blueprint\/product\/([^/]+)\/([^/]+)\.md$/))) {
      // 人写的业务描述:一份文件一个业务服务,路径即 id
      add(products, `${match[1]}.${match[2]}`, kind);
    } else if ((match = file.match(/^blueprint\/spec\/([^/]+)\/([^/]+)\/service\.md$/))) {
      add(services, `${match[1]}.${match[2]}`, kind);
    } else if ((match = file.match(/^blueprint\/spec\/([^/]+)\/([^/]+)\/([^/]+)\/activity\.md$/))) {
      add(activities, `${match[1]}.${match[2]}.${ACTIVITY_MARK}.${match[3]}`, kind);
    } else if ((match = file.match(/^blueprint\/spec\/([^/]+)\/([^/]+)\/([^/]+)\.md$/))) {
      // 流程是服务目录下的 .md 文件,澄清记录不算
      if (!match[3].endsWith('.review')) {
        add(flows, `${match[1]}.${match[2]}.${FLOW_MARK}.${match[3]}`, kind);
      }
    } else if ((match = file.match(/^blueprint\/domain\/([^/]+)\/([^/]+)\/domain\.md$/))) {
      add(domains, `@${match[1]}.${match[2]}`, kind);
    } else if (!file.startsWith('blueprint/')) {
      others.push(file);
    }
  }

  const implemented = [];
  const files = new Set();
  for (const [id, entry] of Object.entries(repo.lock.activities || {})) {
    if (entry.impl && entry.spec && entry.impl.activity_hash === entry.spec.activity_hash) {
      implemented.push(id);
      for (const file of entry.impl.files || []) files.add(file);
    }
  }
  for (const [id, entry] of Object.entries(repo.lock.domains || {})) {
    if (entry.impl && entry.spec && entry.impl.domain_hash === entry.spec.domain_hash) {
      implemented.push(id);
      for (const file of entry.impl.files || []) files.add(file);
    }
  }
  for (const id of implemented) {
    const codemap = codemapPath(root, id);
    if (exists(codemap)) files.add(path.relative(root, codemap).split(path.sep).join('/'));
  }
  for (const { file } of changed) {
    if (file.startsWith('blueprint/')) files.add(file);
  }

  const capabilities = [...new Set([
    ...products.map((product) => product.id.split('.')[0]),
    ...services.map((service) => service.id.split('.')[0]),
    ...flows.map((flow) => flow.id.split('.')[0]),
    ...activities.map((activity) => activity.id.split('.')[0]),
  ])].sort();

  const migrations = listFiles(bpPath(root, 'todo', 'done'))
    .filter((name) => /_migration\.md$/.test(name))
    .map((name) => name.slice(0, 14)).sort();

  return {
    capabilities,
    products,
    services,
    flows,
    activities,
    domains,
    implemented: implemented.sort(),
    impl_file_count: files.size ? [...files].filter((file) => !file.startsWith('blueprint/')).length : 0,
    files: [...files].filter((file) => exists(path.join(root, file))).sort(),
    untracked_code: others,
    migration: migrations.length ? migrations[migrations.length - 1] : null,
  };
}
