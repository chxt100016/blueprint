import path from 'node:path';

import { bpPath, ACTIVITY_MARK, FLOW_MARK } from '../../lib/config.mjs';
import { codemapPath } from '../../lib/codemap.mjs';
import { listFiles } from '../../lib/parse.mjs';
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

  // lock 是累积的:遍历它只能得到「当前处于已实现状态」的历史全集,不是本轮做了什么。
  // 本轮范围以工作区的实际改动为准 —— 拿 changed 与各对象的实现文件取交集,
  // 否则提交清单会膨胀成历史全量,`git add` 就等价于被明令禁止的 `git add -A`。
  const touched = new Set(changed.map((item) => item.file));
  const implemented = [];
  const files = new Set();
  const collect = (bucket, key) => {
    for (const [id, entry] of Object.entries(bucket || {})) {
      if (!entry.impl || !entry.spec || entry.impl[key] !== entry.spec[key]) continue;
      const own = (entry.impl.files || []).filter((file) => touched.has(file));
      // codemap 只改了 covers、代码没动也算本轮产出;它在 blueprint/ 下,由下面的循环收进清单
      const codemap = path.relative(root, codemapPath(root, id)).split(path.sep).join('/');
      if (!own.length && !touched.has(codemap)) continue;
      implemented.push(id);
      for (const file of own) files.add(file);
    }
  };
  collect(repo.lock.activities, 'activity_hash');
  collect(repo.lock.domains, 'domain_hash');
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
    files: [...files].sort(),
    untracked_code: others,
    migration: migrations.length ? migrations[migrations.length - 1] : null,
  };
}
