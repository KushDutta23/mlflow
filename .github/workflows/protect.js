function getSleepLength(iterationCount, numPendingChecks) {
  if (iterationCount <= 5 && numPendingChecks <= 5) {
    // It's likely that this job was triggered with other quick jobs.
    // To minimize the wait time, shorten the polling interval for the first 5 iterations.
    return 5 * 1000; // 5 seconds
  }
  // If the number of pending checks is small, poll more frequently to reduce wait time.
  return (numPendingChecks <= 7 ? 30 : 5 * 60) * 1000;
}
module.exports = async ({ github, context }) => {
  const {
    repo: { owner, repo },
  } = context;
  const { sha } = context.payload.pull_request.head;

  const STATE = {
    pending: "pending",
    success: "success",
    failure: "failure",
  };

  function toStatus(status, conclusion) {
    if (conclusion === "cancelled") return STATE.failure;
    if (status !== "completed") return STATE.pending;
    if (conclusion === "success" || conclusion === "skipped") return STATE.success;
    return STATE.failure;
  }

  async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function logRateLimit() {
    const { data: rateLimit } = await github.rest.rateLimit.get();
    console.log(`Rate limit remaining: ${rateLimit.resources.core.remaining}`);
  }

  function isNewerRun(newRun, existingRun) {
    // Returns true if newRun should replace existingRun
    if (!existingRun) return true;

    // If they are different workflow runs, prefer the one with a higher ID (auto-incrementing)
    if (newRun.id !== existingRun.id) {
      return newRun.id > existingRun.id;
    }

    // Same workflow run: higher run_attempt takes priority (re-runs)
    return newRun.run_attempt > existingRun.run_attempt;
  }

  async function hasFailedJob(runId) {
    for await (const { data: jobs } of github.paginate.iterator(
      github.rest.actions.listJobsForWorkflowRun,
      { owner, repo, run_id: runId },
    )) {
      if (jobs.some((job) => toStatus(job.status, job.conclusion) === STATE.failure)) {
        return true;
      }
    }
    return false;
  }

  async function fetchChecks(ref) {
    // Check runs (e.g., DCO check, but excluding GitHub Actions)
    const checkRuns = (
      await github.paginate(github.rest.checks.listForRef, {
        owner,
        repo,
        ref,
        filter: "latest",
      })
    ).filter(({ app }) => app?.slug !== "github-actions");

    const latestCheckRuns = {};
    for (const run of checkRuns) {
      const { name } = run;
      if (
        !latestCheckRuns[name] ||
        new Date(run.started_at) > new Date(latestCheckRuns[name].started_at)
      ) {
        latestCheckRuns[name] = run;
      }
    }
    const checks = Object.values(latestCheckRuns).map(({ name, status, conclusion }) => ({
      name,
      status: toStatus(status, conclusion),
    }));

    if (checks.some(({ status }) => status === STATE.failure)) {
      return checks;
    }

    // Workflow runs (e.g., GitHub Actions)
    const workflowRuns = (
      await github.paginate(github.rest.actions.listWorkflowRunsForRepo, {
        owner,
        repo,
        head_sha: ref,
      })
    ).filter(
      ({ path, event }) =>
        // Exclude this workflow to avoid self-checking
        path !== ".github/workflows/protect.yml" &&
        // Exclude dynamic workflows (GitHub-managed, e.g., Copilot code review)
        event !== "dynamic",
    );

    // Deduplicate workflow runs by path and event, keeping the latest attempt
    const latestRuns = {};
    for (const run of workflowRuns) {
      const { path, event } = run;
      const key = `${path}-${event}`;
      if (isNewerRun(run, latestRuns[key])) {
        latestRuns[key] = run;
      }
    }

    // Process completed runs first (0 extra API calls each).
    for (const run of Object.values(latestRuns)) {
      if (run.status === "completed") {
        const runName = run.path.replace(".github/workflows/", "");
        checks.push({
          name: `${run.name} (${runName}, attempt ${run.run_attempt})`,
          status: toStatus(run.status, run.conclusion),
        });
      }
    }

    if (checks.some(({ status }) => status === STATE.failure)) {
      return checks;
    }

    // Check in-progress runs for early job failures.
    for (const run of Object.values(latestRuns)) {
      if (run.status === "completed") continue;
      if (await hasFailedJob(run.id)) {
        const runName = run.path.replace(".github/workflows/", "");
        checks.push({
          name: `${run.name} (${runName}, attempt ${run.run_attempt})`,
          status: STATE.failure,
        });
        break;
      }
    }

    return checks;
  }

  const start = new Date();
  let iterationCount = 0;
  const TIMEOUT = 120 * 60 * 1000; // 2 hours
  while (new Date() - start < TIMEOUT) {
    ++iterationCount;
    const checks = await fetchChecks(sha);
    const longest = Math.max(...checks.map(({ name }) => name.length));
    checks.forEach(({ name, status }) => {
      const icon = status === STATE.success ? "✅" : status === STATE.failure ? "❌" : "🕒";
      console.log(`- ${name.padEnd(longest)}: ${icon} ${status}`);
    });

    if (checks.some(({ status }) => status === STATE.failure)) {
      throw new Error(
        "This job ensures that all checks except for this one have passed to prevent accidental auto-merges.",
      );
    }

    if (checks.length > 0 && checks.every(({ status }) => status === STATE.success)) {
      console.log("All checks passed");
      return;
    }

    await logRateLimit();
    const pendingChecks = checks.filter(({ status }) => status === STATE.pending);
    const sleepLength = getSleepLength(iterationCount, pendingChecks.length);
    console.log(
      `Sleeping for ${sleepLength / 1000} seconds (${pendingChecks.length} pending checks)`,
    );
    await sleep(sleepLength);
  }

  throw new Error("Timeout");
};
