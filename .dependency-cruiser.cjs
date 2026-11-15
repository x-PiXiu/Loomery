/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-zero-deps',
      comment: 'domain 零依赖（node 内建 core 模块除外）——02 §6 不变量 1',
      severity: 'error',
      from: { path: '^packages/domain' },
      to: { pathNot: '^packages/domain', dependencyTypesNot: ['core'] },
    },
    {
      name: 'ports-only-domain',
      comment: 'ports 仅允许依赖 domain（与 node core）',
      severity: 'error',
      from: { path: '^packages/ports' },
      to: {
        pathNot: '^(packages/ports|packages/domain|node_modules)',
        dependencyTypesNot: ['core'],
      },
    },
    {
      name: 'core-only-domain-ports',
      comment: 'agent-core 仅允许依赖 domain 与 ports（与 node core）',
      severity: 'error',
      from: { path: '^packages/agent-core' },
      to: {
        pathNot:
          '^(packages/agent-core|packages/domain|packages/ports|node_modules)',
        dependencyTypesNot: ['core'],
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    includeOnly: '^packages',
    progress: { type: 'none' },
  },
};
