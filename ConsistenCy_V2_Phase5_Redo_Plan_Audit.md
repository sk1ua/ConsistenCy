# ConsistenCy V2 Phase 5 Redo 计划审计

## 结论

**暂不批准开始编码。**

新版计划覆盖了上一轮审计的大部分方向，但仍有 4 个会导致实现失败或测试假阳性的
阻断点。完成以下计划修订后，可以直接进入编码，无需再次扩展范围。

## P0-1：forceRefresh 没有贯穿 composition root

### 当前计划缺口

`phase5_implementation_plan.md:111-112` 只修改
`GitHubAppAuthenticator.getInstallationToken()`，
`phase5_implementation_plan.md:142-145` 只修改 Worker 的 `tokenFetcher` 签名。

当前 `apps/api/src/server.ts` 的适配器仍是：

```ts
tokenFetcher: async (job, signal) => {
  const tokenInfo = await authenticator.getInstallationToken(job.installationId, signal);
  return tokenInfo.token;
}
```

如果 Worker 调用：

```ts
tokenFetcher(job, signal, { forceRefresh: true })
```

第三个参数会被 JavaScript 静默忽略，最终仍可能返回 Octokit 缓存 token。

### 必须补入计划

同时修改：

- `apps/api/src/github/auth.ts`
- `apps/api/src/publish/worker.ts`
- `apps/api/src/server.ts`
- `AppAuth` TypeScript 类型

```ts
export type AppAuth = (options: {
  type: "installation";
  installationId: number;
  refresh?: boolean;
}) => Promise<InstallationToken>;

tokenFetcher: async (job, signal, options) => {
  const tokenInfo = await authenticator.getInstallationToken(
    job.installationId!,
    signal,
    options?.forceRefresh ?? false
  );
  return tokenInfo.token;
}
```

测试必须直接断言底层 injected `AppAuth` 的第二次调用包含：

```ts
{ type: "installation", installationId, refresh: true }
```

并补齐边界语义：

- 刷新 token 的请求本身发生 transient error：进入正常 transient retry；
- 第二次 publish 返回非 401 的 5xx：进入正常 transient retry；
- 只有第二次 publish 仍为 401，才立即永久失败。

## P0-2：expired lease 恢复与 job changes 计数要求互相矛盾

### 当前计划冲突

`phase5_implementation_plan.md:93-98` 允许领取：

```sql
o.status = 'leased'
AND o.lease_expires_at <= ?
AND j.status = 'publishing'
```

但 `phase5_implementation_plan.md:105` 又要求：

> Throw FencingRollbackError if job updates fail to match claimed count.

expired lease 对应的 job 本来就是 `publishing`。如果 job UPDATE 仍使用：

```sql
WHERE status = 'awaiting_publish'
```

它的 changes 为 0，合法的 lease recovery 会被错误回滚。

此外，一个 job 将来可能存在多个 target 的 outbox row，因此 claimed row 数也不一定
等于 distinct job 数。

### 必须补入计划

claim 事务应按以下顺序：

1. 单条 `UPDATE ... RETURNING *` 领取 outbox；
2. 提取返回行的 distinct `job_id`；
3. 只把这些 job 中的 `awaiting_publish` 更新为 `publishing`；
4. 再查询这些 distinct job；
5. 断言它们最终全部为 `publishing`，而不是断言 UPDATE changes 等于 claimed row
   数；
6. 任一 job 不为 `publishing` 才抛出 `FencingRollbackError` 回滚整个 claim。

测试必须分别覆盖：

- pending/retrying + `awaiting_publish`；
- expired leased + 已经 `publishing`；
- 同一 job 多 target 时的 distinct job 计数。

## P0-3：P2 清理项和原七阶段主计划被遗漏

### 当前计划缺口

专项计划声称处理全部 8 项问题，但没有任何章节删除或隔离：

- `apps/api/src/publish/publisher.ts`
- `apps/api/src/publish/dbPublisher.ts`
- `apps/api/src/github/comment.ts`

同时，新的 `implementation_plan.md:16-17` 把原来的：

- Phase 6：Cleanup；
- Phase 7：Node 22.x + Python 3.12.x Baseline Verification；

改成了 Web Dashboard 和泛化 E2E，导致 V1 清理与正式运行时基线从主计划消失。

### 必须补入计划

恢复主计划约定：

- Phase 6：Cleanup，删除 V1/orphan/direct-publish 入口；
- Phase 7：在 Node 22.x + Python 3.12.x 下执行最终基线验收。

二选一：

- 在本次 Phase 5 Redo 直接删除上述三个无引用发布入口；或
- 明确把 P2 标记为“Phase 6 Cleanup 的强制门禁”，不得声称 Phase 5 已修复 P2。

不得用 Web Dashboard 工作覆盖原 Cleanup 阶段。

## P1-1：两个验收测试仍可能产生假阳性

### SQLite 并发

`phase5_implementation_plan.md:176-178` 只写了创建两个
`SQLiteJobStore`。`better-sqlite3` 是同步 API；如果在同一个 JS 线程中用
`Promise.all()` 调用，两次 claim 仍是串行执行，不能证明 WAL 多连接竞争安全。

必须使用两个 `worker_threads` 或两个子进程，并用 barrier 同时释放 claim。断言：

- 总领取数恰好 1；
- 两个执行方均没有未处理的 `SQLITE_BUSY*`；
- `lease_generation` 只增加一次。

### CI 静态检查

`phase5_implementation_plan.md:171-172` 的正则文本如果直接写入
`.github/workflows/ci.yml`，再扫描整个 `.github`，会匹配检查命令自身。
另外，`rg` 在零匹配时退出码为 1，不能作为普通成功命令直接运行。

应在 `.github` 目录外增加 Vitest，例如：

```ts
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
expect(workflow).not.toContain("backend/cli.py");
expect(workflow).not.toContain("review_suggestions");
expect(workflow).not.toContain("issues.createComment");
```

或在 shell 中使用显式反向断言，但禁止把待搜索的完整字面量写进被扫描目录。

## P1-2：shutdown 验收还需覆盖幂等与 rejection

`phase5_implementation_plan.md:179-180` 目前只验证 sleep 中 stop。

计划还必须明确：

- `stop()` 先保存当前 `loopPromise`，再设置 `running = false`、abort、wake；
- 即使 `running === false`，只要 `loopPromise` 存在，重复 `stop()` 仍等待同一个
  Promise；
- `wakePoll` 在 resolve 后清空，timer 同时清理；
- `start -> stop -> start -> stop` 不残留旧 loop；
- store completion/retry/failure mutation 抛错时，任务 rejection 被消费并通过
  `onError` 或 logger 暴露，不产生 `unhandledRejection`。

## 批准条件

只需修订计划，不需要先写代码。计划补齐以下内容后即可批准：

- `forceRefresh` 贯穿 auth、worker、server 和类型；
- claim 使用“最终 job 状态验证”，不比较 claimed row 数；
- 恢复 Phase 6 Cleanup 和 Phase 7 固定运行时基线；
- 明确 P2 的处理阶段；
- 并发测试使用真实并发执行单元；
- CI 静态检查不会自匹配；
- shutdown 测试覆盖幂等重启与 rejection。
