#!/usr/bin/env node
// 独立的母版安装器，不依赖项目内 blueprint 运行时。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(SKILL_DIR, 'assets');
const VERSION = '1.0.0';
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
    console.log('用法: bootstrap.mjs --project <名称> [--root <目录>]');
    return;
  }

  const project = option('project');
  const root = path.resolve(option('root', process.cwd()));
  if (!project) throw new Error('缺少 --project <名称>');

  const values = {
    PROJECT: project,
    VERSION,
    LAYOUT_APP: option('layout-app', 'src/modules/{capability}/'),
    LAYOUT_DOMAIN: option('layout-domain', 'src/domain/{name}/'),
    VERIFY_APP: option('verify-app', 'npx tsc --noEmit'),
  };
  const blueprint = (...parts) => path.join(root, 'blueprint', ...parts);

  // 生成物：刷新时覆盖。
  copy(path.join(ASSETS, 'scripts'), blueprint('scripts'));
  for (const stale of ['commands/init.mjs', 'lib/install.mjs']) {
    fs.rmSync(blueprint('scripts', ...stale.split('/')), { force: true });
  }
  fs.rmSync(blueprint('WORKFLOW.md'), { force: true });
  fs.rmSync(blueprint('templates'), { recursive: true, force: true });
  copy(path.join(ASSETS, 'templates'), blueprint('templates'));

  for (const name of ['pipeline', 'product', 'flow', 'activity', 'domain', 'code', 'commit', 'ui']) {
    const target = path.join(root, '.claude', 'skills', `${name}-${project}`, 'SKILL.md');
    write(target, render(path.join(ASSETS, 'skills', `${name}.md`), values));
  }

  // 定制物：只在首次初始化时创建。
  const config = blueprint('config.yaml');
  if (!fs.existsSync(config)) {
    write(config, render(path.join(ASSETS, 'config.yaml'), values));
  }
  for (const directory of ['product', 'spec', 'domain', 'codemap', 'context/rpc', 'snapshot', 'todo/done', 'ui']) {
    fs.mkdirSync(blueprint(...directory.split('/')), { recursive: true });
  }

  const lock = blueprint('lock.json');
  if (!fs.existsSync(lock)) {
    write(lock, JSON.stringify({
      version: 5,
      blueprint_version: VERSION,
      services: {}, flows: {}, activities: {}, domains: {},
    }, null, 2) + '\n');
  }
  const contextReadme = blueprint('context', 'README.md');
  if (!fs.existsSync(contextReadme)) {
    write(contextReadme, render(path.join(ASSETS, 'context-README.md'), values));
  }
  const rpcReadme = blueprint('context', 'rpc', 'README.md');
  if (!fs.existsSync(rpcReadme)) {
    write(rpcReadme, render(path.join(ASSETS, 'rpc-README.md'), values));
  }

  const gitignoreFile = path.join(root, '.gitignore');
  const gitignore = fs.existsSync(gitignoreFile) ? read(gitignoreFile) : '';
  const missing = ['blueprint/context/db.yaml', 'blueprint/lock.json.tmp']
    .filter((entry) => !gitignore.split('\n').some((line) => line.trim() === entry));
  if (missing.length) {
    write(gitignoreFile, `${gitignore.replace(/\n*$/, '')}\n\n# blueprint\n${missing.join('\n')}\n`);
  }

  console.log(`已在 ${root} 初始化 blueprint v${VERSION}`);
  console.log(`接下来:拉取 schema,然后调用 pipeline-${project} skill`);
  console.log(`实现界面时:调用 ui-${project} skill 并提供 flow ID`);
}

try {
  main();
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
