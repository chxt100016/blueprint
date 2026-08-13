#!/usr/bin/env node
// 独立的母版文件安装器，不依赖项目内 blueprint 运行时。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

function option(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? fallback : argv[index + 1];
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function copy(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
}

function render(file, values) {
  return read(file).replace(/<<(\w+)>>/g, (match, key) => values[key] ?? match);
}

function main() {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法: bootstrap.mjs --type <backend|fullstack> --project <名称> [--root <目录>]');
    return;
  }

  const project = option('project');
  const type = option('type', 'backend');
  const root = path.resolve(option('root', process.cwd()));
  if (!project) throw new Error('缺少 --project <名称>');
  if (!['backend', 'fullstack'].includes(type)) {
    throw new Error('type 只能是 backend / fullstack');
  }

  const manifest = JSON.parse(read(path.join(ASSETS, 'bp-assets.json')));
  if (!manifest.blueprint_assets || !manifest.version) throw new Error('母版资产标记无效');

  const values = {
    PROJECT: project,
    TYPE: type,
    VERSION: manifest.version,
    LAYOUT_BACKEND: option('layout-backend', 'src/modules/{capability}/'),
    LAYOUT_FRONTEND: option('layout-frontend', 'src/pages/{capability}/'),
    LAYOUT_DOMAIN: option('layout-domain', 'src/domain/{name}/'),
    VERIFY_BACKEND: option('verify-backend', 'npx tsc --noEmit'),
    VERIFY_FRONTEND: option('verify-frontend', 'npx tsc --noEmit'),
  };
  const blueprint = (...parts) => path.join(root, 'blueprint', ...parts);

  // 生成物：刷新时覆盖。
  copy(path.join(ASSETS, 'scripts'), blueprint('scripts'));
  for (const stale of ['commands/init.mjs', 'lib/install.mjs']) {
    fs.rmSync(blueprint('scripts', ...stale.split('/')), { force: true });
  }
  fs.rmSync(blueprint('templates'), { recursive: true, force: true });
  copy(path.join(ASSETS, 'templates', type), blueprint('templates'));
  write(blueprint('WORKFLOW.md'), render(path.join(ASSETS, 'WORKFLOW.md'), values));

  for (const name of ['pipeline', 'flow', 'activity', 'domain', 'code', 'commit']) {
    const target = path.join(root, '.claude', 'skills', `${name}-${project}`, 'SKILL.md');
    write(target, render(path.join(ASSETS, 'skills', `${name}.md`), values));
  }

  // 定制物：只在首次初始化时创建。
  const config = blueprint('config.yaml');
  if (!fs.existsSync(config)) {
    write(config, render(path.join(ASSETS, 'config', `${type}.yaml`), values));
  }
  for (const directory of ['product', 'spec', 'domain', 'codemap', 'context', 'snapshot', 'todo/done']) {
    fs.mkdirSync(blueprint(...directory.split('/')), { recursive: true });
  }

  const lock = blueprint('lock.json');
  if (!fs.existsSync(lock)) {
    write(lock, JSON.stringify({
      version: 4,
      blueprint_version: manifest.version,
      services: {}, flows: {}, activities: {}, domains: {}, rejected_domains: {},
    }, null, 2) + '\n');
  }
  for (const [source, target] of [
    ['context-README.md', blueprint('context', 'README.md')],
    ['CONVENTIONS.md', blueprint('CONVENTIONS.md')],
  ]) {
    if (!fs.existsSync(target)) write(target, render(path.join(ASSETS, source), values));
  }

  const gitignoreFile = path.join(root, '.gitignore');
  const gitignore = fs.existsSync(gitignoreFile) ? read(gitignoreFile) : '';
  const missing = ['blueprint/context/db.yaml', 'blueprint/lock.json.tmp']
    .filter((entry) => !gitignore.split('\n').some((line) => line.trim() === entry));
  if (missing.length) {
    write(gitignoreFile, `${gitignore.replace(/\n*$/, '')}\n\n# blueprint\n${missing.join('\n')}\n`);
  }

  console.log(`已在 ${root} 初始化 blueprint v${manifest.version}(${type})`);
  console.log(`接下来:手写 blueprint/CONVENTIONS.md,拉取 schema,然后调用 pipeline-${project} skill`);
}

try {
  main();
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
