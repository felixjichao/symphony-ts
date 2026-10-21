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
import { FileDeliveryStateStorage, withDeliveryAuthority } from './delivery-skill-cli';

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


it('keeps different-PR leases conflicting, selects the exact target, and ignores terminal history', async () => {
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-targets-'));
  const store = new DurableDecisionStore({ storeDir });
  await store.open();
  const service = new DecisionService(store, { clock: () => 1000 });
  const session = await service.createSession(githubDecisionRoot('owner', 'repo', 42));
  const plan = await service.createPlanTask(session.id, { requirements: { title: issue.title, body: issue.description ?? '' } });
  const planClaim = await service.claimTask(plan.id, { owner: 'planner' });
  const planCredentials = { owner: 'planner', token: planClaim.task.lease!.token, generation: planClaim.task.claimGeneration };
  await service.startTask(plan.id, planCredentials);
  await service.submitResult(plan.id, { ...planCredentials, result: { schemaVersion: 1, kind: 'plan', taskId: plan.id,
    sessionId: session.id, revision: plan.revision, createdAtMs: 1000, verdict: 'ready',
    content: { plan: 'plan', acceptanceCriteria: [], risks: [], clarifications: [] } } });
  await service.markPlanPublished(plan.id, { commentId: 1 });
  const target = { repository: 'owner/repo', prNumber: 7, headSha: 'a'.repeat(40) };
  let current = await service.createReviewTask(session.id, { target });
  for (let revision = 2; revision <= 10; revision++) {
    await service.supersedeTask(current.id);
    current = await service.createReviewTask(session.id, { target, forceNewRevision: true });
  }
  expect(current.revision).toBe(10);
  const currentOwner = await service.claimTask(current.id, { owner: 'current-web' });
  let other = await service.createReviewTask(session.id, { target: { ...target, prNumber: 8 } });
  for (let revision = 2; revision <= 11; revision++) {
    await service.supersedeTask(other.id);
    other = await service.createReviewTask(session.id, { target: { ...target, prNumber: 8 }, forceNewRevision: true });
  }
  expect(other.revision).toBe(11); // A numerically higher foreign-PR revision is not newer work for PR #7.
  await expect(service.claimTask(other.id, { owner: 'other-web' })).rejects.toThrow();
  let admissions = 0;
  let observedPr = 7;
  let merged = false;
  const f = await fixture({ now: () => 1000, planningGate: new DecisionPlanningGate(service), canDispatch: () => { admissions++; return false; },
    continuityGitHub: { observeWork: async () => ({ workKey: session.root, issue: { state: 'open', url: issue.url! },
      pullRequest: { number: observedPr, state: merged ? 'merged' : 'open', url: '', headSha: target.headSha, isDraft: false }, ci: { headSha: target.headSha, status: 'success' } }) } });
  try {
    await f.host.start(); f.tick(); await f.host.loop.settled();
    const diagnosis = f.host.workContinuity.observations[0]?.diagnosis;
    expect(diagnosis?.status).toBe('contradictory');
    expect(diagnosis?.next.taskRef).toEqual({ taskId: current.id, revision: 10 });
    expect(admissions).toBe(0);
    expect(service.getTask(current.id)?.lease).toEqual(currentOwner.task.lease);
    expect(service.getTask(other.id)?.status).toBe('pending');
    merged = true;
    expect((await f.host.workContinuity.reconcile())[0]?.diagnosis?.status).toBe('contradictory');
    merged = false;
    await service.supersedeTask(other.id);
    expect((await f.host.workContinuity.reconcile())[0]?.diagnosis?.status).toBe('unknown');
    expect(service.getTask(current.id)?.lease).toEqual(currentOwner.task.lease);
    const credentials = { owner: 'current-web', token: currentOwner.task.lease!.token, generation: currentOwner.task.claimGeneration };
    await service.startTask(current.id, credentials);
    const result = { schemaVersion: 1 as const, kind: 'review' as const, taskId: current.id, sessionId: session.id,
      revision: 9, createdAtMs: 1000, target, verdict: 'approve' as const, findings: [] };
    await expect(service.submitResult(current.id, { ...credentials, result })).rejects.toThrow();
    expect(service.getResult(current.id)).toBeNull();
    await service.submitResult(current.id, { ...credentials, result: { ...result, revision: 10 } });
    expect((await f.host.workContinuity.reconcile())[0]?.diagnosis?.next.description).toContain('delivery:');
    observedPr = 8; // Same SHA on another PR cannot inherit approval.
    expect((await f.host.workContinuity.reconcile())[0]?.diagnosis?.next.description).toContain('review:');
  } finally { await f.cleanup(); await store.close(); await fs.rm(storeDir, { recursive: true, force: true }); }
});

it('reports merged PR tracker wait through poll, ends on terminal state and fails closed offline', async () => {
  const current = { ...issue };
  let offline = false;
  let admissions = 0;
  const f = await fixture({ canDispatch: () => { admissions++; return false; }, continuityGitHub: { observeWork: async () => {
    if (offline) throw new Error('GitHub unavailable');
    return { workKey: githubDecisionRoot('owner', 'repo', 42), issue: { state: 'open', url: issue.url! },
      pullRequest: { number: 7, state: 'merged', url: '', headSha: 'a'.repeat(40), isDraft: false }, ci: null };
  } } }, false, ['open'], current);
  try {
    await f.host.start(); f.tick(); await f.host.loop.settled();
    expect(f.host.workContinuity.observations[0]?.diagnosis?.status).toBe('external_wait');
    expect(f.host.workContinuity.observations[0]?.diagnosis?.next.authority).toEqual({ kind: 'external', system: 'tracker', condition: 'merged_pull_request_waiting_for_tracker_sync' });
    expect(admissions).toBe(0);
    offline = true;
    expect((await f.host.workContinuity.reconcile())[0]?.result).toBe('observation_unavailable');
    offline = false; current.state = 'closed';
    expect((await f.host.workContinuity.reconcile())[0]?.diagnosis?.status).toBe('inactive');
    expect(admissions).toBe(0);
  } finally { await f.cleanup(); }
});

it('resolves a lost reclaim response only after native task readback proves release', async () => {
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-response-'));
  const store = new DurableDecisionStore({ storeDir });
  await store.open();
  let now = 1000;
  const service = new DecisionService(store, { clock: () => now });
  const session = await service.createSession(githubDecisionRoot('owner', 'repo', 42));
  const task = await service.createPlanTask(session.id);
  await service.claimTask(task.id, { owner: 'old-web', ttlMs: 1000 });
  const gate = new DecisionPlanningGate(service);
  const reclaim = gate.reclaimExpiredClaim.bind(gate);
  let commit = false;
  let attempts = 0;
  // Fault injection at the remote authority boundary, preserving the actual native commit.
  gate.reclaimExpiredClaim = async request => { attempts++; if (commit) await reclaim(request); throw new Error('response lost'); };
  const f = await fixture({ planningGate: gate, now: () => now });
  try {
    now = 2000;
    expect((await f.host.workContinuity.reconcile())[0]?.result).toBe('unverified');
    now = 100000;
    expect((await f.host.workContinuity.reconcile())[0]?.result).toBe('unverified');
    expect(attempts).toBe(1);
    expect(service.getTask(task.id)?.status).toBe('claimed');
    // An independent native authority resolves the old action, then a new claim is a new target.
    await reclaim({ taskId: task.id, revision: task.revision, claimGeneration: service.getTask(task.id)!.claimGeneration,
      bindingGeneration: 0, leaseExpiresAtMs: 2000 });
    const next = await service.claimTask(task.id, { owner: 'new-web', ttlMs: 1000 });
    now = next.task.lease!.expiresAtMs; commit = true;
    await f.host.workContinuity.reconcile();
    expect(attempts).toBe(2);
    expect(service.getTask(task.id)?.status).toBe('pending');
    await f.host.workContinuity.reconcile();
    expect(attempts).toBe(2);
  } finally { await f.cleanup(); await store.close(); await fs.rm(storeDir, { recursive: true, force: true }); }
});


it('keeps a file-backed uncertain handoff suppressed until native completion evidence', async () => {
  let admissions = 0;
  let retry: (() => void) | undefined;
  const f = await fixture({ canDispatch: () => { admissions++; return false; },
    retryScheduler: { schedule: (_delay, cb) => { retry = cb; return cb; }, cancel() {} } });
  const workspace = path.join(f.dir, 'workspaces', 'GH-42');
  const storage = new FileDeliveryStateStorage(path.join(workspace, '.symphony', 'delivery-state.json'));
  storage.writeState({ repo: 'owner/repo', issueNumber: 42, workspaceKey: 'GH-42', spentRepairs: 0, spentWaitSeconds: 0,
    isPaused: true, pauseReason: 'manual_intervention_required', pendingCompensation: true, lastUpdated: 'first',
    handoff: { handoffId: 'handoff-1', headSha: 'a'.repeat(40), reason: 'manual_intervention_required', details: 'paused',
      repo: 'owner/repo', issueNumber: 42, headBranch: 'symphony/GH-42', prNumber: 7, prUrl: '',
      spentRepairs: 0, maxRepairs: 1, spentWaitSeconds: 0, readyLabel: 'ready' } });
  try {
    // Another authority holds the real filesystem lock. No GitHub/Codex command can run.
    await withDeliveryAuthority(workspace, async () => {
      expect((await f.host.workContinuity.reconcile())[0]?.result).toBe('unverified');
      storage.writeState({ ...storage.readState()!, lastUpdated: 'unrelated-change' });
      const pending = (await f.host.workContinuity.reconcile())[0]!;
      expect(pending.result).toBe('unverified');
      expect(pending.diagnosis?.next.action).toBe('require_human');
      expect(storage.readState()?.pendingCompensation).toBe(true);
      const snapshot = storage.readState()!;
      await fs.unlink(path.join(workspace, '.symphony', 'delivery-state.json'));
      expect((await f.host.workContinuity.reconcile())[0]?.result).toBe('unverified');
      storage.writeState(snapshot);
      storage.writeState({ ...storage.readState()!, isPaused: false });
      await f.host.start(); f.tick(); await f.host.loop.settled();
      f.host.authority.scheduleRetry({ issueId: issue.id, identifier: issue.identifier, issueUrl: issue.url,
        attempt: 1, kind: 'continuation', reason: 'continuation', error: null });
      retry!(); await new Promise(resolve => setImmediate(resolve));
      expect(admissions).toBe(0);
      expect(f.host.state.running.size).toBe(0);
      storage.writeState({ ...storage.readState()!, isPaused: true, pendingCompensation: false });
      expect((await f.host.workContinuity.reconcile())[0]?.diagnosis?.status).toBe('blocked');
      expect(storage.readState()?.isPaused).toBe(true);
    });
  } finally { await f.cleanup(); }
});


it('does not treat a bound pending Decision adapter as executor liveness or external wait', async () => {
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-binding-'));
  const store = new DurableDecisionStore({ storeDir });
  await store.open();
  const service = new DecisionService(store, { clock: () => 1000 });
  const session = await service.createSession(githubDecisionRoot('owner', 'repo', 42));
  const task = await service.createPlanTask(session.id);
  await service.rebindSession(session.id, { adapter: 'chatgpt-web', externalSessionRef: 'bound-session', resumeUri: null, expectedGeneration: 0 });
  const f = await fixture({ now: () => 1000, planningGate: new DecisionPlanningGate(service) });
  try {
    const result = (await f.host.workContinuity.reconcile())[0]!;
    expect(result.diagnosis?.status).toBe('stranded');
    expect(result.diagnosis?.owner).toBeNull();
    expect(service.getTask(task.id)?.status).toBe('pending');
  } finally { await f.cleanup(); await store.close(); await fs.rm(storeDir, { recursive: true, force: true }); }
});


it.each(['pending', 'expired', 'valid', 'expired-blocked', 'valid-blocked'] as const)(
  'preserves merged tracker wait and native lease protection with a single %s review', async state => {
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-merged-review-'));
    const store = new DurableDecisionStore({ storeDir });
    await store.open();
    let now = 1000;
    const service = new DecisionService(store, { clock: () => now });
    const session = await service.createSession(githubDecisionRoot('owner', 'repo', 42));
    const plan = await service.createPlanTask(session.id, { requirements: { title: issue.title, body: issue.description ?? '' } });
    const planClaim = await service.claimTask(plan.id, { owner: 'planner' });
    const credentials = { owner: 'planner', token: planClaim.task.lease!.token, generation: planClaim.task.claimGeneration };
    await service.startTask(plan.id, credentials);
    await service.submitResult(plan.id, { ...credentials, result: { schemaVersion: 1, kind: 'plan', taskId: plan.id,
      sessionId: session.id, revision: plan.revision, createdAtMs: now, verdict: 'ready',
      content: { plan: 'plan', acceptanceCriteria: [], risks: [], clarifications: [] } } });
    await service.markPlanPublished(plan.id, { commentId: 1 });
    const target = { repository: 'owner/repo', prNumber: 7, headSha: 'a'.repeat(40) };
    const review = await service.createReviewTask(session.id, { target });
    if (state !== 'pending') await service.claimTask(review.id, { owner: 'reviewer', ttlMs: 1000 });
    if (state.startsWith('expired')) now = 2000;
    const before = service.getTask(review.id);
    let admissions = 0;
    let retry: (() => void) | undefined;
    const f = await fixture({ now: () => now, planningGate: new DecisionPlanningGate(service),
      canDispatch: () => { admissions++; return false; },
      retryScheduler: { schedule: (_delay, cb) => { retry = cb; return cb; }, cancel() {} },
      continuityGitHub: { observeWork: async () => ({ workKey: session.root, issue: { state: 'open', url: issue.url! },
        pullRequest: { number: 7, state: 'merged', url: '', headSha: target.headSha, isDraft: false }, ci: null }) } });
    try {
      if (state.endsWith('blocked')) new FileDeliveryStateStorage(path.join(f.dir, 'workspaces', 'GH-42', '.symphony', 'delivery-state.json')).writeState({
        repo: 'owner/repo', issueNumber: 42, workspaceKey: 'GH-42', spentRepairs: 0, spentWaitSeconds: 0,
        isPaused: true, pauseReason: 'manual_intervention_required', pendingCompensation: false, lastUpdated: 'now' });
      await f.host.start(); f.tick(); await f.host.loop.settled();
      for (let round = 0; round < 2; round++) {
        const result = (await f.host.workContinuity.reconcile())[0]!;
        expect(result.diagnosis?.status).toBe(state.endsWith('blocked') ? 'blocked' : 'external_wait');
        expect(result.diagnosis?.recovery).toBe('none');
        expect(result.result).toBe('unchanged');
        if (!state.endsWith('blocked')) expect(result.diagnosis?.next.authority).toEqual({
          kind: 'external', system: 'tracker', condition: 'merged_pull_request_waiting_for_tracker_sync' });
        expect(service.getTask(review.id)).toEqual(before);
      }
      f.host.authority.scheduleRetry({ issueId: issue.id, identifier: issue.identifier, issueUrl: issue.url,
        attempt: 1, kind: 'continuation', reason: 'continuation', error: null });
      retry!(); await new Promise(resolve => setImmediate(resolve));
      expect(admissions).toBe(0);
      expect(f.host.state.running.size).toBe(0);
      expect(service.getTask(review.id)).toEqual(before);
    } finally { await f.cleanup(); await store.close(); await fs.rm(storeDir, { recursive: true, force: true }); }
  });
