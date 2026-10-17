const timers = require('node:timers/promises');

// Commit statuses have one latest state per context. Native Actions checks
// cannot be reopened through the API while their dependencies are retried.
// Keep matrix sizes in sync with testing.yml; missing jobs must not pass a gate.
const matrixSizes = { pytest: 3, 'services-pytest': 1, 'core-tests': 2, 'pre-merge-tests': 2 };
const momenticResultJobs = /^(Merge and triage Momentic results|Triage Momentic failures)$/;
const specs = {
  'Repro CI': {
    'backend-checks': [/^backend-typecheck$/, /^backend-guardrails$/, /^backend-ad-guardrails$/],
  },
  'Repro Tests': {
    pytest: [/^pytest \(shard-/],
    'services-pytest': [/^services-pytest \(/],
    // The merge/check job retains its established required-check name. The
    // combined pattern also selects the failure-only triage job when present.
    'core-tests': [/^Select Momentic tests$/, /^core-tests \(shard-/, /^Merge and triage Momentic results$/, momenticResultJobs],
    'pre-merge-tests': [/^Select Momentic tests$/, /^core-tests \(shard-/, /^Merge and triage Momentic results$/, momenticResultJobs],
  },
};

function latestJobs(jobs) {
  const latest = new Map();
  for (const job of jobs) {
    const prior = latest.get(job.name);
    if (!prior || job.run_attempt > prior.run_attempt ||
        (job.run_attempt === prior.run_attempt && job.id > prior.id)) latest.set(job.name, job);
  }
  return [...latest.values()];
}

function workflowName(run) {
  // GitHub may return run-name as both name and display_title. Recognize only
  // our two workflow names or their complete, validated revision records.
  return Object.keys(specs).find(name => run.name === name ||
    (run.name === run.display_title && Boolean(runNameRevision(run, name))));
}

function summarize(run, jobs) {
  const gates = specs[workflowName(run)];
  if (!gates) return [];
  const latest = latestJobs(jobs);
  return Object.entries(gates).map(([name, patterns]) => {
    const selected = latest.filter(job => patterns.some(pattern => pattern.test(job.name)));
    const detect = latest.find(job => job.name === 'detect-changes');
    let conclusion;
    if (run.status !== 'completed') {
      // Whole-run retries can retain old failed jobs until replacement jobs are
      // scheduled. Never summarize those as final while the attempt is active.
      conclusion = undefined;
    } else if (run.conclusion === 'cancelled') {
      conclusion = 'cancelled';
    } else if (!detect || !['success', 'skipped'].includes(detect.conclusion)) {
      conclusion = 'failure';
    } else if (detect.conclusion === 'skipped' && selected.some(job => job.conclusion !== 'skipped')) {
      conclusion = 'failure';
    } else if (patterns.some(pattern => !selected.some(job => pattern.test(job.name)))) {
      conclusion = 'failure'; // Missing API data or renamed jobs must fail closed.
    } else if (selected.some(job => job.status !== 'completed' || !['success', 'skipped'].includes(job.conclusion))) {
      conclusion = 'failure';
    } else if (matrixSizes[name] && (() => {
      const matrix = selected.filter(job => job.name.includes(' ('));
      return matrix.some(job => job.conclusion !== 'skipped') &&
        (matrix.length !== matrixSizes[name] || matrix.some(job => job.conclusion !== 'success'));
    })()) {
      conclusion = 'failure';
    } else if (selected.every(job => job.conclusion === 'skipped')) {
      conclusion = 'skipped';
    } else if (name === 'backend-checks' && selected.some(job => job.conclusion === 'skipped')) {
      conclusion = 'failure';
    } else {
      // A skipped job may be intentional (e.g. no Momentic tests selected), but
      // must not hide an upstream build/selection failure. Keep the previous
      // selection job name for in-flight runs and retries of older workflows.
      const prerequisites = name === 'pytest' ? ['build', 'pytest-select', 'pytest-timing-snapshot'] :
        ['core-tests', 'pre-merge-tests'].includes(name) ? ['build', 'Build Momentic frontend'] : [];
      conclusion = latest.some(job => prerequisites.includes(job.name) &&
        !['success', 'skipped'].includes(job.conclusion)) ? 'failure' : 'success';
    }
    // Skipped shards following a failed build are not an intentional skip.
    if (conclusion === 'skipped' && detect?.conclusion === 'success') {
      const prerequisites = name === 'pytest' ? ['build', 'pytest-select', 'pytest-timing-snapshot'] :
        ['core-tests', 'pre-merge-tests'].includes(name) ? ['build', 'Build Momentic frontend'] : [];
      if (latest.some(job => prerequisites.includes(job.name) && !['success', 'skipped'].includes(job.conclusion))) conclusion = 'failure';
    }
    return {
      name,
      status: conclusion ? 'completed' : 'in_progress',
      ...(conclusion ? { conclusion } : {}),
    };
  });
}

function chooseRun(runs) {
  const ordered = [...runs].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
  const newest = ordered[0];
  if (newest?.conclusion !== 'cancelled') return newest;
  const survivor = ordered.find(run => run.conclusion !== 'cancelled');
  if (!survivor || !canFollowSurvivor(newest, survivor)) return newest;
  // Graphite's push and API update can emit duplicate synchronize events in
  // different seconds. Concurrency admission need not follow creation order.
  // Keep following the surviving run after it finishes, rather than restoring
  // the cancelled duplicate's error on the survivor's completion event.
  if (survivor.status !== 'completed' || survivor.created_at === newest.created_at ||
      survivor.updated_at >= newest.created_at) return survivor;
  // A cancellation created after validation already finished is not evidence
  // of a duplicate. It still blocks until its own validation is retried.
  return newest;
}

function canFollowSurvivor(a, b) {
  if (a.head_sha !== b.head_sha) return false;
  // The merge-group SHA includes its base. A PR head alone does not.
  if (a.event === 'merge_group' && b.event === 'merge_group') return true;
  const revision = prRevision(a, workflowName(a));
  const survivorRevision = prRevision(b, workflowName(b));
  if (revision) return revision === survivorRevision;
  // A duplicate may be cancelled before any job is created. In that case we
  // cannot reconstruct its original base. Instead require the survivor to
  // validate the PR's CURRENT target, fetched again before each status write.
  // Queued survivors without metadata may keep checks pending, never pass.
  return a.revision_state === 'missing' && Boolean(a.current_revision) &&
    (survivorRevision === a.current_revision ||
      (b.revision_state === 'missing' && b.status !== 'completed'));
}

function prRevision(run, name) {
  return run.revision_state ? run.validation_revision : runNameRevision(run, name);
}

function parseRevision(value, prefix, headSha) {
  if (!value?.startsWith(prefix)) return undefined;
  const revision = value.slice(prefix.length).match(
    /^([1-9]\d*):([a-f0-9]{40}):([1-9]\d*):([^:\s\[\]]+):([a-f0-9]{40})\]$/,
  );
  if (!revision || revision[2] !== headSha) return undefined;
  return revision[0];
}

function runNameRevision(run, name) {
  if (run.event !== 'pull_request') return undefined;
  // Compatibility for runs created before stamps moved into a job step.
  return parseRevision(run.display_title, `${name} [ci-revision-v1:`, run.head_sha);
}

function jobRevision(run, jobs) {
  const metadata = latestJobs(jobs).find(job => job.name === 'ci-revision');
  const steps = metadata?.steps || [];
  const records = steps.filter(step => step.name.startsWith('CI revision '));
  // Cancellation during runner setup can leave setup steps but no record.
  if (!records.length) return { revision_state: 'missing' };
  const revision = records.length === 1 && parseRevision(
    records[0].name, 'CI revision [ci-revision-v1:', run.head_sha,
  );
  // The resolved step name records the event even if cancellation prevents
  // its no-op command from finishing. Malformed/conflicting records block.
  return revision ?
    { revision_state: 'recorded', validation_revision: revision } :
    { revision_state: 'invalid' };
}

function currentRevision(pr, run) {
  if (pr.state !== 'open' || pr.head?.sha !== run.head_sha) return undefined;
  return parseRevision(
    `[ci-revision-v1:${pr.number}:${pr.head.sha}:${pr.base?.repo?.id}:${pr.base?.ref}:${pr.base?.sha}]`,
    '[ci-revision-v1:', run.head_sha,
  );
}

const workflowPaths = {
  'Repro CI': '.github/workflows/checks.yml',
  'Repro Tests': '.github/workflows/testing.yml',
};

function canPublish(run) {
  // Push and manual runs may deliberately skip suites (e.g. pytest_only).
  // They never own the required PR/merge-queue status contexts.
  const name = workflowName(run);
  return Boolean(workflowPaths[name]) &&
    ['pull_request', 'merge_group'].includes(run.event) &&
    workflowPaths[name] === run.path;
}

function selectRuns(event, candidates) {
  const groups = new Map();
  for (const run of candidates) {
    if (!canPublish(run) || run.head_sha !== event.head_sha ||
        run.path !== event.path || run.workflow_id !== event.workflow_id) continue;
    // Replace duplicates only within one validation context. A newer passing
    // PR on another branch/base cannot erase this PR's failed validation.
    const prs = (run.pull_requests || []).map(pr => pr.number).sort((a, b) => a - b);
    const key = JSON.stringify([run.event, run.head_branch, prs]);
    const group = groups.get(key) || [];
    group.push(run);
    groups.set(key, group);
  }
  return [...groups.values()].map(chooseRun).sort((a, b) => a.id - b.id);
}

function statusState(update) {
  return update.status !== 'completed' ? 'pending' :
    ['success', 'skipped'].includes(update.conclusion) ? 'success' :
      update.conclusion === 'cancelled' ? 'error' : 'failure';
}

function combineReports(reports) {
  const priority = { success: 0, pending: 1, error: 2, failure: 3 };
  const gates = new Map();
  for (const { run, jobs } of reports) {
    for (const update of summarize(run, jobs)) {
      const candidate = { ...update, state: statusState(update), run };
      const previous = gates.get(update.name);
      if (!previous || priority[candidate.state] > priority[previous.state]) gates.set(update.name, candidate);
    }
  }
  return [...gates.values()];
}

async function reconcile({ github, context, core }) {
  const event = context.payload.workflow_run;
  if (!canPublish(event)) return;
  const repo = context.repo;
  // Only opted-in producers use step metadata and live-target verification.
  const { data: source } = await github.rest.repos.getContent({
    ...repo, path: event.path, ref: event.head_sha,
  });
  const sourceLines = source.type === 'file' ?
    Buffer.from(source.content, 'base64').toString('utf8').split('\n') : [];
  if (!sourceLines.includes('# ci-aggregate-checks: v1')) return;
  const stepRevisions = sourceLines.includes('# ci-revision-step: v1');
  const recordedRevisions = new Map();
  const withRevisions = async candidates => {
    const currentPRs = new Map(); // Fresh for every pre-publication lookup.
    return Promise.all(candidates.map(async run => {
      if (!stepRevisions || !canPublish(run) || run.event !== 'pull_request' ||
          run.head_sha !== event.head_sha || run.path !== event.path ||
          run.workflow_id !== event.workflow_id || runNameRevision(run, workflowName(run))) return run;
      const key = `${run.id}:${run.run_attempt}`;
      let metadata = recordedRevisions.get(key);
      if (!metadata) {
        const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
          ...repo, run_id: run.id, filter: 'latest', per_page: 100,
        });
        metadata = jobRevision(run, jobs);
        // Resolved step names are immutable across the rest of this attempt.
        if (metadata.revision_state === 'recorded') recordedRevisions.set(key, metadata);
      }
      let current_revision;
      if (metadata.revision_state === 'missing' && run.conclusion === 'cancelled' &&
          run.pull_requests?.length === 1) {
        const number = run.pull_requests[0].number;
        if (!currentPRs.has(number)) currentPRs.set(number,
          github.rest.pulls.get({ ...repo, pull_number: number }).then(({ data }) => data));
        const pr = await currentPRs.get(number);
        if (pr.number === number) current_revision = currentRevision(pr, run);
      }
      return { ...run, ...metadata, current_revision };
    }));
  };
  // Log only selection metadata, never full API responses or request headers.
  const describeRun = run => ({
    id: run.id, name: run.name, workflow_id: run.workflow_id, path: run.path,
    event: run.event, head_sha: run.head_sha, head_branch: run.head_branch,
    status: run.status, conclusion: run.conclusion, run_attempt: run.run_attempt,
    validation_revision: prRevision(run, workflowName(run)),
    revision_state: run.revision_state, current_revision: run.current_revision,
    pull_requests: (run.pull_requests || []).map(pr => pr.number),
  });
  core.info(`Reconciling CI aggregate status: ${JSON.stringify(describeRun(event))}`);
  const listSelected = async () => {
    const retryDelays = [1000, 2000, 4000];
    for (let attempt = 1; ; attempt++) {
      let candidates, error;
      try {
        candidates = await github.paginate(github.rest.actions.listWorkflowRuns, {
          ...repo, workflow_id: event.workflow_id, head_sha: event.head_sha, per_page: 100,
          // Status ownership is SHA + gate: do not filter by event or branch.
        });
      } catch (cause) {
        core.warning(`CI workflow run lookup failed: ${JSON.stringify({
          attempt, status: cause.status, name: cause.name,
          request_id: cause.response?.headers?.['x-github-request-id'],
        })}`);
        // Retry network errors, rate limiting and server errors; other HTTP
        // errors (including authentication failures) need intervention.
        if (cause.status && cause.status !== 429 && cause.status < 500) throw cause;
        error = cause;
      }
      if (candidates) {
        candidates = await withRevisions(candidates);
        const selected = selectRuns(event, candidates);
        core.info(`CI workflow run lookup: ${JSON.stringify({
          attempt, candidates: candidates.map(describeRun), selected_run_ids: selected.map(run => run.id),
        })}`);
        if (selected.length) return selected;
        error = new Error(`No eligible required-check workflow runs found after ${attempt} attempt(s)`);
      }
      const delay = retryDelays[attempt - 1];
      if (delay === undefined) throw error;
      core.warning(`Retrying CI workflow run lookup in ${delay}ms (retry ${attempt}/${retryDelays.length}).`);
      await timers.setTimeout(delay);
    }
  };
  const chosen = await listSelected();
  const reports = [];
  for (const selected of chosen) {
    const { data: run } = await github.rest.actions.getWorkflowRun({ ...repo, run_id: selected.id });
    if (!canPublish(run) || run.head_sha !== event.head_sha) throw new Error('Workflow identity changed');
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      ...repo, run_id: run.id, filter: 'latest', per_page: 100,
    });
    reports.push({ run, jobs });
  }
  for (const update of combineReports(reports)) {
    const latest = await listSelected();
    if (JSON.stringify(latest.map(run => run.id)) !== JSON.stringify(chosen.map(run => run.id))) {
      core.info('Competing runs changed; their next event will reconcile the statuses.');
      return;
    }
    for (const { run } of reports) {
      const { data: current } = await github.rest.actions.getWorkflowRun({ ...repo, run_id: run.id });
      if (current.run_attempt !== run.run_attempt || current.status !== run.status ||
          current.conclusion !== run.conclusion) {
        core.info('Workflow state changed; its next event will reconcile the statuses.');
        return;
      }
    }
    await github.rest.repos.createCommitStatus({
      ...repo, sha: event.head_sha, context: update.name, state: update.state,
      target_url: update.run.html_url,
      description: `${reports.length} validation context(s): ${update.state}`,
    });
  }
}

module.exports = { summarize, chooseRun, reconcile, selectRuns, combineReports };
