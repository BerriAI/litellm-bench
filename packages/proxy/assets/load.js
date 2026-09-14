import execution from "k6/execution";
import http from "k6/http";
import { Counter, Gauge, Trend } from "k6/metrics";
import { matchesJsonChecks, matchesSseResponse, parseSseData } from "./response.js";

export function createTest() {
  const config = JSON.parse(open(__ENV.BENCH_CONFIG));
  const load = config.load;
  const workload = config.workload;
  const request = { ...workload.request, body: open(config.payload_path, "b") };
  const started = new Counter("bench_started");
  const completed = new Counter("bench_completed");
  const successful = new Counter("bench_successful");
  const windowCompleted = new Counter("bench_window_completed");
  const windowSuccessful = new Counter("bench_window_successful");
  const windowFailed = new Counter("bench_window_failed");
  const tailCompleted = new Counter("bench_tail_completed");
  const tailSuccessful = new Counter("bench_tail_successful");
  const tailFailed = new Counter("bench_tail_failed");
  const latency = new Trend("bench_latency", true);
  const ttfb = new Trend("bench_ttfb", true);
  const streamEvents = new Counter("bench_stream_events");
  const elapsed = new Gauge("bench_elapsed");
  const warmupRequests = new Counter("bench_warmup_requests");
  const warmupFailed = new Counter("bench_warmup_failed");
  const stabilityWindowSeconds = load.steady_state?.window_seconds || 1;
  const warmupWindows = Array.from(
    { length: Math.ceil(load.warmup_seconds / stabilityWindowSeconds) },
    (_, index) => new Counter(`bench_warmup_window_${index}`),
  );
  const errors = Object.fromEntries(["transport", "http", "json", "semantic", "stream"].map(
    (name) => [name, new Counter(`bench_${name}_errors`)],
  ));
  const vus = load.mode === "closed" ? load.concurrency : load.preallocated_vus;
  const executor = load.mode === "closed"
    ? { executor: "constant-vus", vus }
    : {
      executor: "constant-arrival-rate",
      rate: config.arrival_rate,
      timeUnit: config.arrival_time_unit,
      preAllocatedVUs: vus,
      maxVUs: load.max_vus,
    };
  const params = {
    headers: request.headers,
    timeout: "120s",
    redirects: 0,
    responseType: "text",
  };
  const url = config.url + request.path;

  function responseError(response) {
    if (response.status === 0) return "transport";
    if (response.status !== workload.response.status) return "http";
    if (workload.response.sse) {
      const contentType = response.headers["Content-Type"] || response.headers["content-type"]
        || "";
      return contentType.toLowerCase().startsWith("text/event-stream")
          && matchesSseResponse(response.body, workload.response.sse)
        ? null
        : "stream";
    }
    if (workload.response.jsonEquals.length === 0) return null;
    try {
      return matchesJsonChecks(response.json(), workload.response.jsonEquals)
        ? null
        : "semantic";
    } catch (_) {
      return "json";
    }
  }

  function executeRequest() {
    const before = Date.now();
    const response = http.request(request.method, url, request.body, params);
    const error = responseError(response);
    return {
      before,
      completedAt: Date.now(),
      error,
      ttfb: response.timings.waiting,
      streamEvents: !error && workload.response.sse ? parseSseData(response.body).length : 0,
    };
  }

  function coefficientOfVariation(values) {
    if (values.length === 0) return null;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    if (mean === 0) return null;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance) / mean;
  }

  return {
    options: {
      scenarios: {
        measure: {
          ...executor,
          duration: `${load.warmup_seconds + load.duration_seconds}s`,
          gracefulStop: "125s",
        },
      },
      setupTimeout: `${load.warmup_seconds + 125}s`,
      summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
      thresholds: {
        bench_warmup_failed: ["count==0"],
      },
    },
    setup() {
      warmupRequests.add(0);
      warmupFailed.add(0);
    },
    run() {
      const phaseStartedAt = Date.now();
      const warmupDeadline = execution.scenario.startTime + load.warmup_seconds * 1000;
      const measurementDeadline = warmupDeadline + load.duration_seconds * 1000;
      if (phaseStartedAt < warmupDeadline) {
        warmupRequests.add(1);
        const observation = executeRequest();
        warmupFailed.add(observation.error ? 1 : 0);
        const window = Math.min(
          warmupWindows.length - 1,
          Math.max(
            0,
            Math.floor(
              (observation.completedAt - execution.scenario.startTime) / 1000
                / stabilityWindowSeconds,
            ),
          ),
        );
        if (
          !observation.error
          && observation.completedAt <= warmupDeadline
          && warmupWindows[window]
        ) warmupWindows[window].add(1);
        return;
      }
      started.add(1);
      const observation = executeRequest();
      const error = observation.error;
      const inWindow = observation.completedAt <= measurementDeadline;
      completed.add(1);
      successful.add(error ? 0 : 1);
      if (error) errors[error].add(1);
      if (inWindow) {
        windowCompleted.add(1);
        windowSuccessful.add(error ? 0 : 1);
        windowFailed.add(error ? 1 : 0);
        if (!error) latency.add(observation.completedAt - observation.before);
        if (!error && workload.response.sse) {
          ttfb.add(observation.ttfb);
          streamEvents.add(observation.streamEvents);
        }
      } else {
        tailCompleted.add(1);
        tailSuccessful.add(error ? 0 : 1);
        tailFailed.add(error ? 1 : 0);
      }
      elapsed.add((observation.completedAt - warmupDeadline) / 1000);
    },
    handleSummary(data) {
      const values = (name) => data.metrics[name]?.values || {};
      const count = (name) => values(name).count || 0;
      const done = count("bench_completed");
      const success = count("bench_successful");
      const measuredDone = count("bench_window_completed");
      const measuredSuccess = count("bench_window_successful");
      const measuredFailed = count("bench_window_failed");
      const tailDone = count("bench_tail_completed");
      const tailSuccess = count("bench_tail_successful");
      const tailErrors = count("bench_tail_failed");
      const seconds = Math.max(load.duration_seconds, values("bench_elapsed").max || 0);
      const warmupWindowRps = warmupWindows.map((_, index) =>
        count(`bench_warmup_window_${index}`) / stabilityWindowSeconds
      );
      const stableValues = load.steady_state
        ? warmupWindowRps.slice(-load.steady_state.windows)
        : [];
      const warmupCv = coefficientOfVariation(stableValues);
      const warmupStable = load.steady_state
        ? stableValues.length === load.steady_state.windows
          && warmupCv !== null
          && warmupCv <= load.steady_state.maximum_cv
        : undefined;
      const result = {
        started: count("bench_started"),
        completed: done,
        successful: success,
        failed: done - success,
        dropped: count("dropped_iterations"),
        interrupted: count("bench_started") - done,
        window_completed: measuredDone,
        window_successful: measuredSuccess,
        window_failed: measuredFailed,
        tail_completed: tailDone,
        tail_successful: tailSuccess,
        tail_failed: tailErrors,
        warmup_requests: count("bench_warmup_requests"),
        warmup_failed: count("bench_warmup_failed"),
        measurement_seconds: load.duration_seconds,
        drain_seconds: seconds - load.duration_seconds,
        elapsed_seconds: seconds,
        completion_rps: measuredSuccess / load.duration_seconds,
        error_rate: measuredDone ? measuredFailed / measuredDone : 0,
        ...(warmupStable === undefined
          ? {}
          : {
            warmup_stable: warmupStable,
            warmup_cv: warmupCv,
            warmup_window_rps: warmupWindowRps,
          }),
        latency: measuredSuccess
          ? {
            samples: measuredSuccess,
            mean_ms: values("bench_latency").avg,
            p50_ms: values("bench_latency").med,
            p95_ms: values("bench_latency")["p(95)"],
            p99_ms: values("bench_latency")["p(99)"],
            max_ms: values("bench_latency").max,
          }
          : null,
        ...(workload.response.sse
          ? {
            ttfb: measuredSuccess
              ? {
                samples: measuredSuccess,
                mean_ms: values("bench_ttfb").avg,
                p50_ms: values("bench_ttfb").med,
                p95_ms: values("bench_ttfb")["p(95)"],
                p99_ms: values("bench_ttfb")["p(99)"],
                max_ms: values("bench_ttfb").max,
              }
              : null,
            stream_events: count("bench_stream_events"),
            event_rps: count("bench_stream_events") / load.duration_seconds,
          }
          : {}),
        errors: Object.fromEntries(
          Object.keys(errors)
            .map((name) => [name, count(`bench_${name}_errors`)])
            .filter(([, value]) => value > 0),
        ),
      };
      return {
        stdout: JSON.stringify(result) + "\n",
        [config.summary_path]: JSON.stringify(data),
      };
    },
  };
}
