// P2.0 batch1：pipeline.ts 结果段改造（产物拦截 + 三个新事件通道）
const fs = require('node:fs');
const p = 'agent-core/src/tools/pipeline.ts';
let s = fs.readFileSync(p, 'utf8');
const oldBlock = `    if (proposal) {
      emit('diffResolved', { proposalId: proposal.id, status: 'accepted' });
    }
    const t = truncateText(result.content, this.config.toolResultCharCap);
    if (result.checkpointCreated && result.checkpointCreated.length > 0 && ctx.turnId) {
      emit('checkpointCreated', { turnId: ctx.turnId, files: result.checkpointCreated });
    }
    emit('toolExecuted', {
      toolCallId: req.toolCallId,
      durationMs: this.clock.now() - startedAt,
      affectedPaths: result.affectedPaths ?? [],
    });
    emit('observationAdded', {
      toolCallId: req.toolCallId,
      truncated: t.truncated,
      originalChars: t.originalChars,
      finalChars: t.finalChars,
      preview: t.content.slice(0, 200),
      content: t.content,
    });
    return {
      ok: result.ok,
      observation: t.content,
      truncated: t.truncated,
      originalChars: t.originalChars,
      affectedPaths: result.affectedPaths ?? [],
      ...(proposal ? { proposal } : {}),
    };`;

const newBlock = `    if (proposal) {
      emit('diffResolved', { proposalId: proposal.id, status: 'accepted' });
    }
    if (result.checkpointCreated && result.checkpointCreated.length > 0 && ctx.turnId) {
      emit('checkpointCreated', { turnId: ctx.turnId, files: result.checkpointCreated });
    }
    // ---- ADR-0021/0022：结果侧事件（handler 不持有 emit 通道，管道统一发射，与 checkpointCreated 同模式）----
    if (result.pinnedFact) emit('memoryPinned', { fact: result.pinnedFact });
    if (result.briefUpdate) emit('briefUpdated', { ...result.briefUpdate, actor: 'agent' });
    if (result.skillUsed) emit('skillUsed', { name: result.skillUsed.name, scope: result.skillUsed.scope, ...(ctx.turnId ? { turnId: ctx.turnId } : {}) });

    // ---- ADR-0021 产物拦截：超阈值结果整体入库，observation 只留一行摘要+hash ----
    const artifacts = this.config.artifacts;
    const cap = this.config.artifactThresholdTokens ?? 0;
    if (artifacts && result.content.length > 0 && decideArtifactCapture(result.content, cap).capture) {
      const ref = await artifacts.put(result.content, {
        threadId: ctx.threadId,
        ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
        kind: 'tool-output',
        ...artifactMeta(result.content, 'tool-output'),
      });
      emit('artifactStored', { ref });
      const tokens = decideArtifactCapture(result.content, cap).tokens;
      const observation = '[结果超长（约 ' + tokens + ' tokens），已存为产物 ' + ref.hash + '。' + (ref.summary ? '摘要：' + ref.summary + ' ' : '') + '用 read_artifact(hash: "' + ref.hash + '") 分页取回。]';
      emit('toolExecuted', {
        toolCallId: req.toolCallId,
        durationMs: this.clock.now() - startedAt,
        affectedPaths: result.affectedPaths ?? [],
      });
      emit('observationAdded', {
        toolCallId: req.toolCallId,
        truncated: false,
        originalChars: result.content.length,
        finalChars: observation.length,
        preview: observation.slice(0, 200),
        content: observation,
      });
      return {
        ok: result.ok,
        observation,
        truncated: false,
        originalChars: result.content.length,
        affectedPaths: result.affectedPaths ?? [],
        ...(proposal ? { proposal } : {}),
      };
    }
    const t = truncateText(result.content, this.config.toolResultCharCap);
    emit('toolExecuted', {
      toolCallId: req.toolCallId,
      durationMs: this.clock.now() - startedAt,
      affectedPaths: result.affectedPaths ?? [],
    });
    emit('observationAdded', {
      toolCallId: req.toolCallId,
      truncated: t.truncated,
      originalChars: t.originalChars,
      finalChars: t.finalChars,
      preview: t.content.slice(0, 200),
      content: t.content,
    });
    return {
      ok: result.ok,
      observation: t.content,
      truncated: t.truncated,
      originalChars: t.originalChars,
      affectedPaths: result.affectedPaths ?? [],
      ...(proposal ? { proposal } : {}),
    };`;

if (!s.includes(oldBlock)) { console.error('OLD BLOCK NOT FOUND'); process.exit(1); }
s = s.replace(oldBlock, newBlock);
fs.writeFileSync(p, s);
console.log('pipeline part2 patched');
