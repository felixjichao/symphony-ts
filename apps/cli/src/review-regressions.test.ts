import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { DecisionPlanningGate, DecisionService, DurableDecisionStore } from '@symphony/decision';
import { githubDecisionRoot, normalizeIssueState } from '@symphony/domain';
import type { Issue } from '@symphony/domain';
import type { TrackerAdapterProfile } from '@symphony/tracker';
import { createStructuredLogger } from '@symphony/observability';
import { createHost, type CreateHostOptions } from './host';
import { FileDeliveryStateStorage } from './delivery-skill-cli';

const issue: Issue = { id: '42', identifier: 'GH-42', title: 'work', description: '', state: 'open',
  nativeRef: { repo: 'owner/repo', number: 42 }, priority: 1, branchName: null,
  url: 'https://github.com/owner/repo/issues/42', assigneeId: null, labels: [], blockedBy: [],
  dispatchable: true, createdAt: 0, updatedAt: 0 };

async function fixture(options: CreateHostOptions = {}, failSecondList: boolean | number = false,
  activeStates: readonly string[] = ['open'], currentIssue: Issue = issue, command = 'echo unused') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-continuity-'));
  let activeLists = 0;
  const profile: TrackerAdapterProfile = { kind: 'fixture', documentation: 'fixture', secretProviderKeys: [], secretEnvVars: [],
    defaultActiveStates: ['open'], defaultTerminalStates: ['closed'], createAdapter: () => ({ kind: 'fixture',
      fetchIssuesByStates: async states => {
        if (!states.some(state => normalizeIssueState(state) === normalizeIssueState(currentIssue.state))) return [];
        if (++activeLists === (typeof failSecondList === "number" ? failSecondList : 2) && failSecondList) throw new Error('temporary outage during continuity scan');
        return [currentIssue];
      }, fetchIssuesByIds: async () => [currentIssue] }) };
  const workflowPath = path.join(dir, 'WORKFLOW.md');
  await fs.writeFile(workflowPath, `---\ntracker:\n  kind: fixture\n  active_states: ${JSON.stringify(activeStates)}\nworkspace:\n  root: ${dir}/workspaces\ncodex:\n  command: ${JSON.stringify(command)}\n---\nPrompt\n`);
  let tick: (() => void) | undefined;
  const host = await createHost({ workflowPath, trackerProfiles: [profile], env: {}, enablePlanning: false,
    logger: createStructuredLogger({ sinks: [{ write() {} }] }),
    continuityGitHub: { observeWork: async () => ({ workKey: { provider: 'github', key: 'owner/repo#42' },
      issue: { state: 'open', url: issue.url! }, pullRequest: null, ci: null }) },
    scheduler: { schedule: (_delay, cb) => { tick = cb; return cb; }, cancel() {} }, ...options });
  return { dir, host, tick: () => tick!(), cleanup: async () => { await host.stop(); await fs.rm(dir, { recursive: true, force: true }); } };
}

it('does not admit coding when the continuity inventory read fails', async () => {
  let admissions = 0;
  const f = await fixture({ canDispatch: () => { admissions++; return false; } }, true);
  try {
    await f.host.start(); f.tick(); await f.host.loop.settled();
    expect(admissions).toBe(0);
  } finally { await f.cleanup(); }
});

it('observes remote CI even when the local workspace has not been provisioned', async () => {
  const f = await fixture({ continuityGitHub: { observeWork: async () => ({
    workKey: { provider: 'github', key: 'owner/repo#42' }, issue: { state: 'open', url: issue.url! },
    pullRequest: { number: 7, state: 'open', url: 'https://github.com/owner/repo/pull/7', headSha: 'a'.repeat(40), isDraft: false },
    ci: { headSha: 'a'.repeat(40), status: 'pending' },
  }) } });
  try {
    const [result] = await f.host.workContinuity.reconcile();
    expect(result?.diagnosis?.status).toBe('external_wait');
  } finally { await f.cleanup(); }
});

it('refreshes a new Delivery pause before a scheduled retry admits coding', async () => {
  let retry: (() => void) | undefined;
  let admissions = 0;
  const f = await fixture({ canDispatch: () => { admissions++; return false; },
    retryScheduler: { schedule: (_delay, cb) => { retry = cb; return cb; }, cancel() {} } });
  try {
    expect((await f.host.workContinuity.reconcile())[0]?.diagnosis?.status).toBe('stranded');
    new FileDeliveryStateStorage(path.join(f.dir, 'workspaces', 'GH-42', '.symphony', 'delivery-state.json')).writeState({
      repo: 'owner/repo', issueNumber: 42, workspaceKey: 'GH-42', spentRepairs: 0, spentWaitSeconds: 0,
      isPaused: true, pauseReason: 'manual_intervention_required', lastUpdated: 'now', pendingCompensation: false,
    });
    f.host.authority.scheduleRetry({ issueId: issue.id, identifier: issue.identifier, issueUrl: issue.url,
      attempt: 1, kind: 'continuation', reason: 'continuation', error: null });
    retry!(); await new Promise(resolve => setImmediate(resolve));
    expect(admissions).toBe(0);
  } finally { await f.cleanup(); }
});

it('does not reuse prior coding admission after a later inventory failure', async () => {
  let admissions = 0;
  const f = await fixture({ canDispatch: () => { admissions++; return false; } }, 3);
  try {
    expect((await f.host.workContinuity.reconcile())[0]?.diagnosis?.status).toBe('stranded');
    await f.host.start(); f.tick(); await f.host.loop.settled();
    expect(admissions).toBe(0);
  } finally { await f.cleanup(); }
});

it.each(['ci', 'unavailable', 'pause-during-read', 'ready'] as const)('re-reads %s before the retry commit', async change => {
  let retry: (() => void) | undefined;
  let admissions = 0;
  let changed = false;
  let reads = 0;
  let pause: () => void = () => {};
  const f = await fixture({ canDispatch: () => { admissions++; return false; },
    retryScheduler: { schedule: (_delay, cb) => { retry = cb; return cb; }, cancel() {} },
    continuityGitHub: { observeWork: async () => {
      reads++;
      if (changed && change === 'unavailable') throw new Error('temporary GitHub outage');
      if (changed && change === 'pause-during-read') pause();
      return { workKey: { provider: 'github', key: 'owner/repo#42' }, issue: { state: 'open', url: issue.url! },
        pullRequest: changed && change === 'ci' ? { number: 7, state: 'open', url: 'https://github.com/owner/repo/pull/7', headSha: 'a'.repeat(40), isDraft: false } : null,
        ci: changed && change === 'ci' ? { headSha: 'a'.repeat(40), status: 'pending' } : null };
    } } });
  pause = () => new FileDeliveryStateStorage(path.join(f.dir, 'workspaces', 'GH-42', '.symphony', 'delivery-state.json')).writeState({
    repo: 'owner/repo', issueNumber: 42, workspaceKey: 'GH-42', spentRepairs: 0, spentWaitSeconds: 0,
    isPaused: true, pauseReason: 'manual_intervention_required', lastUpdated: 'now', pendingCompensation: false });
  try {
    expect((await f.host.workContinuity.reconcile())[0]?.diagnosis?.status).toBe('stranded');
    const initialReads = reads;
    changed = true;
    f.host.authority.scheduleRetry({ issueId: issue.id, identifier: issue.identifier, issueUrl: issue.url,
      attempt: 1, kind: 'continuation', reason: 'continuation', error: null });
    retry!(); await new Promise(resolve => setImmediate(resolve));
    expect(reads).toBeGreaterThan(initialReads);
    expect(admissions).toBe(change === 'ready' ? 1 : 0);
    expect(f.host.state.running.size).toBe(0);
    if (change === 'unavailable') {
      expect(f.host.state.claimed.has(issue.id)).toBe(true);
      expect(f.host.state.retryAttempts.get(issue.id)?.error).toBe('dispatch admission refresh failed');
    }
  } finally { await f.cleanup(); }
});

it.each(['stop', 'replace'] as const)('fences a late retry admission after %s', async action => {
  let retry: (() => void) | undefined;
  let admissions = 0;
  let hold = false;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ canDispatch: () => { admissions++; return false; },
    retryScheduler: { schedule: (_delay, cb) => { retry = cb; return cb; }, cancel() {} },
    continuityGitHub: { observeWork: async () => {
      if (hold) await waiting;
      return { workKey: { provider: 'github', key: 'owner/repo#42' }, issue: { state: 'open', url: issue.url! }, pullRequest: null, ci: null };
    } } });
  try {
    await f.host.workContinuity.reconcile();
    hold = true;
    f.host.authority.scheduleRetry({ issueId: issue.id, identifier: issue.identifier, issueUrl: issue.url,
      attempt: 1, kind: 'continuation', reason: 'continuation', error: null });
    retry!(); await new Promise(resolve => setImmediate(resolve));
    let stopped = false;
    const stop = action === 'stop' ? f.host.stop().then(() => { stopped = true; }) : Promise.resolve();
    if (action === 'replace') f.host.authority.scheduleRetry({ issueId: issue.id, identifier: issue.identifier, issueUrl: issue.url,
      attempt: 2, kind: 'continuation', reason: 'continuation', error: null });
    await Promise.resolve();
    if (action === 'stop') expect(stopped).toBe(false);
    release(); await stop; await new Promise(resolve => setImmediate(resolve));
    expect(admissions).toBe(0);
    expect(f.host.state.running.size).toBe(0);
    if (action === 'replace') expect(f.host.state.retryAttempts.get(issue.id)?.attempt).toBe(2);
  } finally { release(); await f.cleanup(); }
});

it('observes a new Decision lease before the retry commit without reclaiming that owner', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-decision-'));
  const store = new DurableDecisionStore({ storeDir: dir });
  await store.open();
  const service = new DecisionService(store, { clock: () => 1000 });
  const session = await service.createSession(githubDecisionRoot('owner', 'repo', 42));
  const plan = await service.createPlanTask(session.id, { requirements: { title: issue.title, body: '' } });
  const claim = await service.claimTask(plan.id, { owner: 'planner' });
  const credentials = { owner: 'planner', token: claim.task.lease!.token, generation: claim.task.claimGeneration };
  await service.startTask(plan.id, credentials);
  await service.submitResult(plan.id, { ...credentials, result: { schemaVersion: 1, kind: 'plan', taskId: plan.id,
    sessionId: session.id, revision: plan.revision, createdAtMs: 1000, verdict: 'ready',
    content: { plan: 'plan', acceptanceCriteria: [], risks: [], clarifications: [] } } });
  await service.markPlanPublished(plan.id, { commentId: 1 });
  let retry: (() => void) | undefined;
  let admissions = 0;
  const f = await fixture({ planningGate: new DecisionPlanningGate(service), canDispatch: () => { admissions++; return false; },
    retryScheduler: { schedule: (_delay, cb) => { retry = cb; return cb; }, cancel() {} } });
  try {
    expect((await f.host.workContinuity.reconcile())[0]?.diagnosis?.status).toBe('stranded');
    const review = await service.createReviewTask(session.id, { target: { repository: 'owner/repo', prNumber: 7, headSha: 'a'.repeat(40) } });
    const owner = await service.claimTask(review.id, { owner: 'reviewer' });
    f.host.authority.scheduleRetry({ issueId: issue.id, identifier: issue.identifier, issueUrl: issue.url,
      attempt: 1, kind: 'continuation', reason: 'continuation', error: null });
    retry!(); await new Promise(resolve => setImmediate(resolve));
    expect(admissions).toBe(0);
    expect(f.host.state.running.size).toBe(0);
    expect(service.getTask(review.id)?.lease).toEqual(owner.task.lease);
  } finally { await f.cleanup(); await store.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

it.each([
  { configured: ' open ', observed: 'open' },
  { configured: ' OpEn ', observed: 'oPeN' },
  { configured: 'open', observed: ' OPEN ' },
])('normalizes "$configured" / "$observed" through real host poll and retry dispatch', async ({ configured, observed }) => {
  const appServer = fileURLToPath(new URL('../../../packages/agent/test-fixtures/app-server.mjs', import.meta.url));
  let retry: (() => void) | undefined;
  const f = await fixture({ retryScheduler: { schedule: (_delay, cb) => { retry = cb; return cb; }, cancel() {} } },
    false, [configured], { ...issue, state: observed }, `${JSON.stringify(process.execPath)} ${JSON.stringify(appServer)} --record-world world.json`);
  try {
    // The consumer normalizes; it must not depend on config parsing rewriting the values.
    expect(f.host.effective.serviceConfig.tracker.activeStates).toEqual([configured]);
    expect((await f.host.workContinuity.reconcile())[0]?.diagnosis?.status).toBe('stranded');
    await f.host.start(); f.tick(); await f.host.loop.settled();
    await f.host.authority.waitForIdle();
    const worldFile = path.join(f.dir, 'workspaces', issue.identifier, 'world.json');
    const first = JSON.parse(await fs.readFile(worldFile, 'utf8')) as { pid: number; cwd: string };
    expect(first.cwd).toBe(path.dirname(worldFile));
    expect(() => process.kill(first.pid, 0)).toThrow();
    f.host.authority.scheduleRetry({ issueId: issue.id, identifier: issue.identifier, issueUrl: issue.url,
      attempt: 1, kind: 'continuation', reason: 'continuation', error: null });
    retry!(); await new Promise(resolve => setImmediate(resolve));
    await f.host.authority.waitForIdle();
    const second = JSON.parse(await fs.readFile(worldFile, 'utf8')) as { pid: number; cwd: string };
    expect(second.pid).not.toBe(first.pid);
    expect(second.cwd).toBe(first.cwd);
    expect(() => process.kill(second.pid, 0)).toThrow();
  } finally { await f.cleanup(); }
});
