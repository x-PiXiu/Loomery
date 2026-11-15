// ADR-0020：纯 diff 规则已下沉 domain（渲染层 DiffPane 与适配器共用），此处转发保持兼容
export { validateHunks, resolveHunks, applyHunks, makeHunkProposal, makeFullFileProposal } from '@loomery/domain';
