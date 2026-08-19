import { fail } from './cli.mjs';

export function serviceOrDie(repo, id) {
  const service = repo.services.get(id);
  if (!service) fail(`找不到业务服务 ${id}`);
  if (!service.flows.length) fail(`${id} 下没有任何业务流程文件`);
  return service;
}

export function flowOrDie(repo, id) {
  const flow = repo.flows.get(id);
  if (!flow) fail(`找不到业务流程 ${id}(应形如 <capability>.<service>.flow.<name>)`);
  return flow;
}

export function domainOrDie(repo, id) {
  const domain = repo.domains.get(id);
  if (!domain) fail(`找不到领域模型 ${id}`);
  return domain;
}
