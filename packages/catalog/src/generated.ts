import type { BenchmarkCatalog } from "./model.js";

export const benchmarkCatalog = {
  "proxy-chat-completions": {
    "label": "LiteLLM proxy chat-completions sustainable capacity",
    "kind": "proxy",
    "artifact": "proxy",
    "canonicalJob": "base",
    "canonicalRunner": "ubuntu-24.04",
    "metrics": {
      "nonstream.sustainable_rps": {
        "unit": "RPS",
        "better": "higher"
      }
    },
    "definition": {
      "$schema": "../../schemas/current/benchmark.schema.json",
      "id": "proxy-chat-completions",
      "label": "LiteLLM proxy chat-completions sustainable capacity",
      "kind": "proxy",
      "artifact": "proxy",
      "output_metrics": [
        {
          "id": "nonstream.sustainable_rps",
          "unit": "RPS",
          "better": "higher"
        }
      ],
      "protocol": {
        "question": "What fixed arrival rate can one proxy worker sustain while meeting the declared latency, error, and achieved-load SLO?",
        "claim_scope": "One CPU-quota, one-worker non-streaming proxy capacity against a deterministic local validating mock whose fixture explicitly declares zero response delay. Capacity is the highest contiguous offered rate whose independent-trial pass fraction meets the declared rule; it excludes provider inference and streaming.",
        "experimental_unit": "One fresh proxy and mock container for each independently measured rate/round; bypass calibrations use a fresh mock",
        "scenarios": [
          {
            "id": "nonstream-arrival-sweep",
            "label": "Non-streaming fixed-arrival-rate saturation sweep",
            "dimensions": {
              "arrival_rates": [
                25,
                50,
                100,
                150,
                200,
                300,
                450
              ],
              "stream": false
            }
          }
        ],
        "attempts": {
          "count": 7,
          "count_from": "rounds",
          "isolation": "Fresh proxy and mock containers for every rate/round; immutable local image IDs are resolved before container start",
          "order": "Rates are deterministically shuffled within each round from the comparison ID; workflow versions are Fisher–Yates shuffled per dispatch and executed serially",
          "retention": "Retain every rate trial, bypass calibration, exact plan, client summary/log, container log, fixture, configuration, and payload",
          "trials_per_attempt": 8,
          "unit": "independent round"
        },
        "measurements": [
          {
            "id": "slo_pass",
            "label": "Arrival rate meets all sustainable-capacity SLO predicates",
            "unit": "boolean",
            "role": "primary",
            "better": "higher"
          },
          {
            "id": "window_completion_rps",
            "label": "Successful completions timestamped inside the fixed measurement window divided by exactly 30 seconds",
            "unit": "RPS",
            "role": "secondary",
            "better": "higher"
          },
          {
            "id": "p95_latency_ms",
            "label": "p95 latency of successful completions inside the fixed measurement window",
            "unit": "ms",
            "role": "secondary",
            "better": "lower"
          },
          {
            "id": "window_error_rate",
            "label": "Failed completions divided by all completions timestamped inside the fixed measurement window",
            "unit": "ratio",
            "role": "secondary",
            "better": "lower"
          },
          {
            "id": "drain_seconds",
            "label": "Time after the fixed measurement deadline until the final started request completed",
            "unit": "s",
            "role": "diagnostic",
            "better": "lower"
          }
        ],
        "analyses": [
          {
            "id": "nonstream.capacity-knee",
            "label": "Highest contiguous offered rate meeting the required trial pass fraction",
            "measurement": "slo_pass",
            "additional_measurements": [
              "window_completion_rps",
              "p95_latency_ms",
              "window_error_rate",
              "drain_seconds"
            ],
            "aggregation": "contiguous SLO knee with per-round capacities, dispersion, and deterministic 10,000-resample bootstrap 95% CI",
            "report": [
              "rate pass fractions",
              "per-round capacity",
              "standard deviation",
              "median absolute deviation",
              "bootstrap 95% CI"
            ]
          }
        ],
        "validity": {
          "slo": "At least 6 of 7 trials at a rate must have p95 latency <= 100 ms, window error rate 0, no dropped arrivals, >= 98% achieved/offered RPS, and stable warmup; every lower rate must also pass",
          "warmup": "The same fixed-arrival executor and request path run for 30 seconds before measurement; the final three five-second successful-completion windows must have coefficient of variation <= 5%",
          "window": "Only completions timestamped no later than the fixed 30-second deadline enter throughput, errors, and latency; post-deadline completions and drain time are separate diagnostics",
          "translation": "The mock rejects any mismatch in method/path, authorization and content-type headers, non-stream semantics (stream omitted or false), or the exact allowlisted JSON body",
          "headroom": "Each round bypasses the proxy at 1.5x the maximum sweep rate; achieved load and errors must meet the SLO, mock and load-generator CPU must remain below 85%, and mock CFS throttling must stay below 0.1% of wall time; k6 pre-allocates ceil(rate x SLO x 4) VUs (bounded to 16..512) so the open-model executor never starves for VUs below the SLO",
          "retries": "Every round (one trial per swept rate plus its calibration) is an independent unit; if any trial in a round loses measurement integrity or its calibration fails headroom, that whole round is re-run up to 3 attempts with fresh containers, every attempt's artifacts are retained, and trials from different attempts are never mixed",
          "apparatus": "Proxy, mock, and load generator use disjoint CPU sets; the retained upstream fixture is the sole timing source and explicitly declares zero response delay; cgroup quota/cpuset/throttling, utilization, host pressure, image IDs, kernel/topology/governor, runner image, repository identity, and input hashes are retained",
          "fail_closed": "Missing/invalid telemetry, unstable calibration, unbracketed saturation, request-count mismatch, response-semantic mismatch, or any upstream translation failure invalidates the result"
        }
      },
      "jobs": [
        {
          "id": "base",
          "canonical": true,
          "runner": "ubuntu-24.04",
          "config": {
            "rounds": 7,
            "arrival_rates": [
              25,
              50,
              100,
              150,
              200,
              300,
              450
            ],
            "duration_seconds": 30,
            "warmup_seconds": 30,
            "steady_state": {
              "window_seconds": 5,
              "windows": 3,
              "maximum_cv": 0.05
            },
            "slo": {
              "p95_latency_ms": 100,
              "maximum_error_rate": 0,
              "minimum_achievement_ratio": 0.98,
              "required_pass_fraction": 0.8571428571428571
            },
            "retry_attempts": 3,
            "vu_allocation": {
              "slo_multiple": 4,
              "minimum_vus": 16
            },
            "max_vus": 512,
            "calibration_rate_multiplier": 1.5,
            "calibration_headroom": {
              "maximum_cpu_percent": 85,
              "maximum_throttled_fraction": 0.001
            },
            "mock_image": "node:24.8.0-slim@sha256:cadbfafeb6baf87eaaffa40b3640209c4b7fd38cebde65059d15bc39cd636b85",
            "resources": {
              "cpus": 1,
              "memory": "2g",
              "workers": 1,
              "idle_seconds": 5,
              "log_driver": "none",
              "mock_cpus": 1,
              "mock_memory": "1g",
              "cpu_sets": {
                "proxy": "0",
                "mock": "1",
                "load_generator": "2"
              }
            }
          },
          "requirements": {
            "platform": "linux",
            "architecture": "x86_64",
            "tools": [
              "k6"
            ],
            "host": "github-hosted",
            "docker": {
              "architecture": "x86_64",
              "cgroup_version": "2",
              "ports": [
                4020
              ]
            }
          }
        }
      ]
    }
  },
  "proxy-chat-completions-streaming": {
    "label": "LiteLLM proxy streaming chat-completions sustainable capacity",
    "kind": "proxy",
    "artifact": "proxy",
    "canonicalJob": "base",
    "canonicalRunner": "ubuntu-24.04",
    "metrics": {
      "stream.sustainable_rps": {
        "unit": "RPS",
        "better": "higher"
      }
    },
    "definition": {
      "$schema": "../../schemas/current/benchmark.schema.json",
      "id": "proxy-chat-completions-streaming",
      "label": "LiteLLM proxy streaming chat-completions sustainable capacity",
      "kind": "proxy",
      "artifact": "proxy",
      "output_metrics": [
        {
          "id": "stream.sustainable_rps",
          "unit": "RPS",
          "better": "higher"
        }
      ],
      "protocol": {
        "question": "What fixed streaming arrival rate can one proxy worker sustain while meeting the declared TTFB, stream-duration, error, and achieved-load SLO?",
        "claim_scope": "One CPU-quota, one-worker streaming chat-completions proxy capacity against a deterministic local validating SSE mock. Capacity is the highest contiguous offered rate whose independent-trial pass fraction meets the declared rule; it excludes provider inference.",
        "experimental_unit": "One fresh proxy and mock container for each independently measured rate/round; bypass calibrations use a fresh mock",
        "scenarios": [
          {
            "id": "stream-arrival-sweep",
            "label": "Streaming fixed-arrival-rate saturation sweep",
            "dimensions": {
              "arrival_rates": [
                10,
                20,
                30,
                40,
                50,
                60,
                80
              ],
              "stream": true
            }
          }
        ],
        "attempts": {
          "count": 7,
          "count_from": "rounds",
          "isolation": "Fresh proxy and mock containers for every rate/round; immutable local image IDs are resolved before container start",
          "order": "Rates are deterministically shuffled within each round from the comparison ID; workflow versions are Fisher–Yates shuffled per dispatch and executed serially",
          "retention": "Retain every rate trial, bypass calibration, exact plan, client summary/log, container log, SSE fixture, configuration, and payload",
          "trials_per_attempt": 8,
          "unit": "independent round"
        },
        "measurements": [
          {
            "id": "slo_pass",
            "label": "Arrival rate meets all streaming sustainable-capacity SLO predicates",
            "unit": "boolean",
            "role": "primary",
            "better": "higher"
          },
          {
            "id": "window_completion_rps",
            "label": "Successful complete streams timestamped inside the fixed measurement window divided by exactly 30 seconds",
            "unit": "RPS",
            "role": "secondary",
            "better": "higher"
          },
          {
            "id": "window_event_rps",
            "label": "Validated SSE events from successful streams completed inside the measurement window divided by exactly 30 seconds",
            "unit": "events/s",
            "role": "secondary",
            "better": "higher"
          },
          {
            "id": "p95_ttfb_ms",
            "label": "p95 time from request start to the first response byte for successful streams inside the measurement window",
            "unit": "ms",
            "role": "secondary",
            "better": "lower"
          },
          {
            "id": "p95_stream_duration_ms",
            "label": "p95 time from request start through the terminal SSE event for successful streams inside the measurement window",
            "unit": "ms",
            "role": "secondary",
            "better": "lower"
          },
          {
            "id": "window_error_rate",
            "label": "Failed streams divided by all streams completed inside the fixed measurement window",
            "unit": "ratio",
            "role": "secondary",
            "better": "lower"
          },
          {
            "id": "drain_seconds",
            "label": "Time after the fixed measurement deadline until the final started stream completed",
            "unit": "s",
            "role": "diagnostic",
            "better": "lower"
          }
        ],
        "analyses": [
          {
            "id": "stream.capacity-knee",
            "label": "Highest contiguous offered streaming rate meeting the required trial pass fraction",
            "measurement": "slo_pass",
            "additional_measurements": [
              "window_completion_rps",
              "window_event_rps",
              "p95_ttfb_ms",
              "p95_stream_duration_ms",
              "window_error_rate",
              "drain_seconds"
            ],
            "aggregation": "contiguous SLO knee with per-round capacities, dispersion, and deterministic 10,000-resample bootstrap 95% CI",
            "report": [
              "rate pass fractions",
              "per-round capacity",
              "standard deviation",
              "median absolute deviation",
              "bootstrap 95% CI"
            ]
          }
        ],
        "validity": {
          "slo": "At least 6 of 7 trials at a rate must have p95 TTFB <= 100 ms, p95 complete-stream duration <= 200 ms, window error rate 0, no dropped arrivals, >= 98% achieved/offered RPS, and stable warmup; every lower rate must also pass",
          "warmup": "The same fixed-arrival executor, streaming request path, SSE validation, and timing profile run for 30 seconds before measurement; the final three five-second successful-completion windows must have coefficient of variation <= 5%",
          "window": "Only complete streams timestamped no later than the fixed 30-second deadline enter throughput, errors, and latency; post-deadline completions and drain time are separate diagnostics",
          "translation": "The mock rejects any mismatch in method/path, authorization and content-type headers, required stream=true and stream_options.include_usage=true, or the exact allowlisted JSON body; the client validates content-type, all 31 SSE events, every varied content chunk, usage, finish reason, and terminal [DONE]",
          "timing": "The mock waits 10 ms before its first SSE event and 1 ms between subsequent events; TTFB is measured by k6 at the first response byte and complete-stream duration ends after the terminal event",
          "headroom": "Each round bypasses the proxy at 1.5x the maximum sweep rate; achieved load and errors must meet the SLO, mock and load-generator CPU must remain below 85%, and mock CFS throttling must stay below 0.1% of wall time; k6 pre-allocates ceil(rate x SLO x 4) VUs (bounded to 16..512) so the open-model executor never starves for VUs below the SLO",
          "retries": "Every round (one trial per swept rate plus its calibration) is an independent unit; if any trial in a round loses measurement integrity or its calibration fails headroom, that whole round is re-run up to 3 attempts with fresh containers, every attempt's artifacts are retained, and trials from different attempts are never mixed",
          "apparatus": "Proxy, mock, and load generator use disjoint CPU sets; cgroup quota/cpuset/throttling, utilization, host pressure, image IDs, kernel/topology/governor, runner image, repository identity, and input hashes are retained",
          "fail_closed": "Missing/invalid telemetry, missing stream timing/statistics, malformed or semantically incorrect SSE, unstable calibration, unbracketed saturation, request-count mismatch, or any upstream translation failure invalidates the result"
        }
      },
      "jobs": [
        {
          "id": "base",
          "canonical": true,
          "runner": "ubuntu-24.04",
          "config": {
            "rounds": 7,
            "arrival_rates": [
              10,
              20,
              30,
              40,
              50,
              60,
              80
            ],
            "duration_seconds": 30,
            "warmup_seconds": 30,
            "steady_state": {
              "window_seconds": 5,
              "windows": 3,
              "maximum_cv": 0.05
            },
            "slo": {
              "p95_ttfb_ms": 100,
              "p95_stream_duration_ms": 200,
              "maximum_error_rate": 0,
              "minimum_achievement_ratio": 0.98,
              "required_pass_fraction": 0.8571428571428571
            },
            "retry_attempts": 3,
            "vu_allocation": {
              "slo_multiple": 4,
              "minimum_vus": 16
            },
            "max_vus": 512,
            "calibration_rate_multiplier": 1.5,
            "calibration_headroom": {
              "maximum_cpu_percent": 85,
              "maximum_throttled_fraction": 0.001
            },
            "mock_image": "node:24.8.0-slim@sha256:cadbfafeb6baf87eaaffa40b3640209c4b7fd38cebde65059d15bc39cd636b85",
            "resources": {
              "cpus": 1,
              "memory": "2g",
              "workers": 1,
              "idle_seconds": 5,
              "log_driver": "none",
              "mock_cpus": 1,
              "mock_memory": "1g",
              "cpu_sets": {
                "proxy": "0",
                "mock": "1",
                "load_generator": "2"
              }
            }
          },
          "requirements": {
            "platform": "linux",
            "architecture": "x86_64",
            "tools": [
              "k6"
            ],
            "host": "github-hosted",
            "docker": {
              "architecture": "x86_64",
              "cgroup_version": "2",
              "ports": [
                4020
              ]
            }
          }
        }
      ]
    }
  },
  "proxy-ocr": {
    "label": "LiteLLM proxy OCR throughput: Python vs Rust",
    "kind": "proxy",
    "artifact": "proxy",
    "canonicalJob": "base",
    "canonicalRunner": "ubuntu-24.04",
    "metrics": {
      "core_1m.python.rps": {
        "unit": "RPS",
        "better": "higher"
      },
      "core_1m.rust.rps": {
        "unit": "RPS",
        "better": "higher"
      },
      "core_1m.python.latency_p95_ms": {
        "unit": "ms",
        "better": "lower"
      },
      "core_1m.rust.latency_p95_ms": {
        "unit": "ms",
        "better": "lower"
      },
      "core_1m.python.cpu_average_percent": {
        "unit": "%",
        "better": "neutral"
      },
      "core_1m.rust.cpu_average_percent": {
        "unit": "%",
        "better": "neutral"
      },
      "core_1m.python.cpu_ms_per_request": {
        "unit": "ms",
        "better": "lower"
      },
      "core_1m.rust.cpu_ms_per_request": {
        "unit": "ms",
        "better": "lower"
      },
      "core_1m.python.peak_memory_mib": {
        "unit": "MiB",
        "better": "lower"
      },
      "core_1m.rust.peak_memory_mib": {
        "unit": "MiB",
        "better": "lower"
      },
      "core_1m.python.peak_memory_growth_mib": {
        "unit": "MiB",
        "better": "lower"
      },
      "core_1m.rust.peak_memory_growth_mib": {
        "unit": "MiB",
        "better": "lower"
      },
      "core_1m.python.idle_anon_mib": {
        "unit": "MiB",
        "better": "lower"
      },
      "core_1m.rust.idle_anon_mib": {
        "unit": "MiB",
        "better": "lower"
      },
      "core_1m.python.idle_anon_growth_mib": {
        "unit": "MiB",
        "better": "lower"
      },
      "core_1m.rust.idle_anon_growth_mib": {
        "unit": "MiB",
        "better": "lower"
      },
      "core_1m.paired_ratio": {
        "unit": "x",
        "better": "higher"
      },
      "core_8m.python.rps": {
        "unit": "RPS",
        "better": "higher"
      },
      "core_8m.rust.rps": {
        "unit": "RPS",
        "better": "higher"
      },
      "core_8m.python.latency_p95_ms": {
        "unit": "ms",
        "better": "lower"
      },
      "core_8m.rust.latency_p95_ms": {
        "unit": "ms",
        "better": "lower"
      },
      "core_8m.python.cpu_average_percent": {
        "unit": "%",
        "better": "neutral"
      },
      "core_8m.rust.cpu_average_percent": {
        "unit": "%",
        "better": "neutral"
      },
      "core_8m.python.cpu_ms_per_request": {
        "unit": "ms",
        "better": "lower"
      },
      "core_8m.rust.cpu_ms_per_request": {
        "unit": "ms",
        "better": "lower"
      },
      "core_8m.python.peak_memory_mib": {
        "unit": "MiB",
        "better": "lower"
      },
      "core_8m.rust.peak_memory_mib": {
        "unit": "MiB",
        "better": "lower"
      },
      "core_8m.python.peak_memory_growth_mib": {
        "unit": "MiB",
        "better": "lower"
      },
      "core_8m.rust.peak_memory_growth_mib": {
        "unit": "MiB",
        "better": "lower"
      },
      "core_8m.python.idle_anon_mib": {
        "unit": "MiB",
        "better": "lower"
      },
      "core_8m.rust.idle_anon_mib": {
        "unit": "MiB",
        "better": "lower"
      },
      "core_8m.python.idle_anon_growth_mib": {
        "unit": "MiB",
        "better": "lower"
      },
      "core_8m.rust.idle_anon_growth_mib": {
        "unit": "MiB",
        "better": "lower"
      },
      "core_8m.paired_ratio": {
        "unit": "x",
        "better": "higher"
      }
    },
    "definition": {
      "$schema": "../../schemas/current/benchmark.schema.json",
      "id": "proxy-ocr",
      "label": "LiteLLM proxy OCR throughput: Python vs Rust",
      "kind": "proxy",
      "artifact": "proxy",
      "output_metrics": [
        {
          "id": "core_1m.python.rps",
          "unit": "RPS",
          "better": "higher"
        },
        {
          "id": "core_1m.rust.rps",
          "unit": "RPS",
          "better": "higher"
        },
        {
          "id": "core_1m.python.latency_p95_ms",
          "unit": "ms",
          "better": "lower"
        },
        {
          "id": "core_1m.rust.latency_p95_ms",
          "unit": "ms",
          "better": "lower"
        },
        {
          "id": "core_1m.python.cpu_average_percent",
          "unit": "%",
          "better": "neutral"
        },
        {
          "id": "core_1m.rust.cpu_average_percent",
          "unit": "%",
          "better": "neutral"
        },
        {
          "id": "core_1m.python.cpu_ms_per_request",
          "unit": "ms",
          "better": "lower"
        },
        {
          "id": "core_1m.rust.cpu_ms_per_request",
          "unit": "ms",
          "better": "lower"
        },
        {
          "id": "core_1m.python.peak_memory_mib",
          "unit": "MiB",
          "better": "lower"
        },
        {
          "id": "core_1m.rust.peak_memory_mib",
          "unit": "MiB",
          "better": "lower"
        },
        {
          "id": "core_1m.python.peak_memory_growth_mib",
          "unit": "MiB",
          "better": "lower"
        },
        {
          "id": "core_1m.rust.peak_memory_growth_mib",
          "unit": "MiB",
          "better": "lower"
        },
        {
          "id": "core_1m.python.idle_anon_mib",
          "unit": "MiB",
          "better": "lower"
        },
        {
          "id": "core_1m.rust.idle_anon_mib",
          "unit": "MiB",
          "better": "lower"
        },
        {
          "id": "core_1m.python.idle_anon_growth_mib",
          "unit": "MiB",
          "better": "lower"
        },
        {
          "id": "core_1m.rust.idle_anon_growth_mib",
          "unit": "MiB",
          "better": "lower"
        },
        {
          "id": "core_1m.paired_ratio",
          "unit": "x",
          "better": "higher"
        },
        {
          "id": "core_8m.python.rps",
          "unit": "RPS",
          "better": "higher"
        },
        {
          "id": "core_8m.rust.rps",
          "unit": "RPS",
          "better": "higher"
        },
        {
          "id": "core_8m.python.latency_p95_ms",
          "unit": "ms",
          "better": "lower"
        },
        {
          "id": "core_8m.rust.latency_p95_ms",
          "unit": "ms",
          "better": "lower"
        },
        {
          "id": "core_8m.python.cpu_average_percent",
          "unit": "%",
          "better": "neutral"
        },
        {
          "id": "core_8m.rust.cpu_average_percent",
          "unit": "%",
          "better": "neutral"
        },
        {
          "id": "core_8m.python.cpu_ms_per_request",
          "unit": "ms",
          "better": "lower"
        },
        {
          "id": "core_8m.rust.cpu_ms_per_request",
          "unit": "ms",
          "better": "lower"
        },
        {
          "id": "core_8m.python.peak_memory_mib",
          "unit": "MiB",
          "better": "lower"
        },
        {
          "id": "core_8m.rust.peak_memory_mib",
          "unit": "MiB",
          "better": "lower"
        },
        {
          "id": "core_8m.python.peak_memory_growth_mib",
          "unit": "MiB",
          "better": "lower"
        },
        {
          "id": "core_8m.rust.peak_memory_growth_mib",
          "unit": "MiB",
          "better": "lower"
        },
        {
          "id": "core_8m.python.idle_anon_mib",
          "unit": "MiB",
          "better": "lower"
        },
        {
          "id": "core_8m.rust.idle_anon_mib",
          "unit": "MiB",
          "better": "lower"
        },
        {
          "id": "core_8m.python.idle_anon_growth_mib",
          "unit": "MiB",
          "better": "lower"
        },
        {
          "id": "core_8m.rust.idle_anon_growth_mib",
          "unit": "MiB",
          "better": "lower"
        },
        {
          "id": "core_8m.paired_ratio",
          "unit": "x",
          "better": "higher"
        }
      ],
      "protocol": {
        "question": "How does fixed-concurrency closed-loop OCR throughput change when the Rust multipart path replaces the Python path?",
        "claim_scope": "Closed-loop completion throughput at the declared concurrency for one LiteLLM proxy worker on one CPU, a zero-delay local provider, and deterministic byte-for-byte validated PNG uploads. This is not sustainable capacity, end-to-end production latency, or a universal pod-size reduction.",
        "experimental_unit": "One fresh proxy and validating upstream mock measured with the shared k6 2.2.0 runtime for one variant, scenario, and paired round",
        "scenarios": [
          {
            "id": "core_1m",
            "label": "1 MiB, concurrency 32",
            "dimensions": {
              "payload_bytes": 1048576,
              "load_model": "closed-loop",
              "concurrency": 32
            }
          },
          {
            "id": "core_8m",
            "label": "8 MiB, concurrency 8",
            "dimensions": {
              "payload_bytes": 8388608,
              "load_model": "closed-loop",
              "concurrency": 8
            }
          }
        ],
        "attempts": {
          "count": 8,
          "count_from": "rounds",
          "isolation": "Start a fresh proxy container for every trial",
          "order": "Seeded randomized scenario blocks; Python and Rust trials are adjacent within every scenario-round block",
          "pair_by": [
            "scenario",
            "round"
          ],
          "trials_per_attempt": 4,
          "unit": "paired round"
        },
        "measurements": [
          {
            "id": "throughput_rps",
            "label": "Successful requests per second",
            "unit": "RPS",
            "role": "primary",
            "better": "higher"
          },
          {
            "id": "latency_p95_ms",
            "label": "p95 successful response latency (k6 interpolated percentile)",
            "unit": "ms",
            "role": "diagnostic",
            "better": "lower"
          },
          {
            "id": "cpu_average_percent",
            "label": "Average container CPU",
            "unit": "%",
            "role": "diagnostic"
          },
          {
            "id": "cpu_ms_per_request",
            "label": "Proxy CPU time per successful request",
            "unit": "ms",
            "role": "secondary",
            "better": "lower"
          },
          {
            "id": "peak_memory_mib",
            "label": "Peak container memory",
            "unit": "MiB",
            "role": "diagnostic",
            "better": "lower"
          },
          {
            "id": "peak_memory_growth_mib",
            "label": "Peak container memory above the post-warm-up baseline",
            "unit": "MiB",
            "role": "diagnostic",
            "better": "lower"
          },
          {
            "id": "idle_anon_mib",
            "label": "Post-load anonymous memory",
            "unit": "MiB",
            "role": "diagnostic",
            "better": "lower"
          },
          {
            "id": "idle_anon_growth_mib",
            "label": "Post-load anonymous memory above the post-warm-up baseline",
            "unit": "MiB",
            "role": "diagnostic",
            "better": "lower"
          }
        ],
        "analyses": [
          {
            "id": "variant_throughput",
            "label": "Per-variant throughput",
            "measurement": "throughput_rps",
            "group_by": [
              "scenario",
              "variant"
            ],
            "aggregation": "median",
            "report": [
              "value",
              "minimum",
              "maximum",
              "attempt_count"
            ]
          },
          {
            "id": "variant_diagnostics",
            "label": "Per-variant diagnostic summaries",
            "measurement": "latency_p95_ms",
            "additional_measurements": [
              "cpu_average_percent",
              "cpu_ms_per_request",
              "peak_memory_mib",
              "peak_memory_growth_mib",
              "idle_anon_mib",
              "idle_anon_growth_mib"
            ],
            "group_by": [
              "scenario",
              "variant",
              "measurement"
            ],
            "aggregation": "median",
            "report": [
              "value",
              "minimum",
              "maximum",
              "attempt_count"
            ]
          },
          {
            "id": "paired_throughput_ratio",
            "label": "Paired Rust/Python throughput ratio",
            "measurement": "throughput_rps",
            "group_by": [
              "scenario"
            ],
            "pair_by": [
              "scenario",
              "round"
            ],
            "operation": "rust / python",
            "aggregation": "median",
            "report": [
              "all_pairs",
              "value",
              "minimum",
              "maximum",
              "rust_wins",
              "paired_log_ratios",
              "bootstrap_95_percent_ci"
            ]
          }
        ],
        "validity": {
          "trial": "Every response and upstream request must pass semantic validation; client and upstream request counts must agree; no dropped, interrupted, or failed warmup requests; proxy CPU must be at least 90%, mock CPU below 80%, and load-generator CPU below 160%",
          "exclusions": "Keep failed output and its reason, then rerun every scenario and treatment in the entire paired round, up to the configured attempt limit",
          "outliers": "Do not remove statistical outliers",
          "publication": "Publish all valid trials, paired ratios, range, and round wins"
        },
        "variants": [
          {
            "id": "python",
            "label": "Python OCR path",
            "settings": {
              "LITELLM_RUST": "0"
            }
          },
          {
            "id": "rust",
            "label": "Rust OCR path",
            "settings": {
              "LITELLM_RUST": "1"
            }
          }
        ]
      },
      "jobs": [
        {
          "id": "base",
          "canonical": true,
          "runner": "ubuntu-24.04",
          "config": {
            "cpus": 1,
            "proxy_cpu_set": "0",
            "mock_cpu_set": "1",
            "load_generator_cpu_set": "2-3",
            "mock_cpus": 1,
            "memory": "2g",
            "mock_memory": "512m",
            "workers": 1,
            "mock_image": "node:24.8.0-slim@sha256:cadbfafeb6baf87eaaffa40b3640209c4b7fd38cebde65059d15bc39cd636b85",
            "rounds": 8,
            "retry_attempts": 3,
            "order_seed": "proxy-ocr-v1",
            "warmup_seconds": 10,
            "duration_seconds": 30,
            "idle_seconds": 5,
            "log_driver": "none"
          },
          "requirements": {
            "platform": "linux",
            "architecture": "x86_64",
            "tools": [
              "k6"
            ],
            "host": "github-hosted",
            "docker": {
              "architecture": "x86_64",
              "cgroup_version": "2",
              "ports": [
                4020
              ]
            }
          }
        }
      ]
    }
  },
  "sdk-import-footprint": {
    "label": "Fresh-process LiteLLM import footprint",
    "kind": "sdk",
    "artifact": "sdk",
    "canonicalJob": "base",
    "canonicalRunner": "ubuntu-24.04",
    "metrics": {
      "import.peak_rss": {
        "unit": "MiB",
        "better": "lower"
      },
      "import.loaded_modules": {
        "unit": "modules",
        "better": "lower"
      },
      "import.disk_growth": {
        "unit": "MiB",
        "better": "lower"
      }
    },
    "definition": {
      "$schema": "../../schemas/current/benchmark.schema.json",
      "id": "sdk-import-footprint",
      "label": "Fresh-process LiteLLM import footprint",
      "kind": "sdk",
      "artifact": "sdk",
      "output_metrics": [
        {
          "id": "import.peak_rss",
          "unit": "MiB",
          "better": "lower"
        },
        {
          "id": "import.loaded_modules",
          "unit": "modules",
          "better": "lower"
        },
        {
          "id": "import.disk_growth",
          "unit": "MiB",
          "better": "lower"
        }
      ],
      "protocol": {
        "question": "What process-lifetime memory, module, and site-packages growth does importing LiteLLM create?",
        "claim_scope": "First-import net logical-byte growth under site-packages in one clean installation, plus module diagnostics and externally measured process-lifetime peak RSS in a second independent installation. It does not cover caches or temporary files outside site-packages. RSS is platform-specific and should only be compared on matching runners. The import runs with LITELLM_LOCAL_MODEL_COST_MAP=True so the measured process reads the bundled model cost map instead of fetching the live one from GitHub; it therefore excludes the memory and modules that the remote fetch would add.",
        "experimental_unit": "A clean installation, one uninstrumented first import for disk growth, and one separate instrumented import for RSS and modules",
        "scenarios": [
          {
            "id": "root-import",
            "label": "import litellm",
            "dimensions": {
              "statement": "import litellm",
              "isolated_python": true
            }
          }
        ],
        "measurements": [
          {
            "id": "import.peak_rss",
            "label": "Process-lifetime peak resident memory during import",
            "unit": "MiB",
            "role": "primary",
            "better": "lower"
          },
          {
            "id": "import.loaded_modules",
            "label": "Newly loaded modules",
            "unit": "modules",
            "role": "secondary",
            "better": "lower"
          },
          {
            "id": "import.disk_growth",
            "label": "First-import site-packages logical-byte growth",
            "unit": "MiB",
            "role": "secondary",
            "better": "lower"
          }
        ],
        "analyses": [
          {
            "id": "instrumented_import",
            "label": "Instrumented import footprint",
            "measurement": "import.peak_rss",
            "additional_measurements": [
              "import.loaded_modules",
              "import.disk_growth"
            ],
            "scenarios": [
              "root-import"
            ],
            "aggregation": "single observation"
          }
        ],
        "validity": {
          "trial": "The instrumented import must exit successfully",
          "instrumentation": "Disk mutation and diagnostics use independent clean installations. RSS is measured externally around an uninstrumented fresh process; module counting uses a separate instrumented process. Every measured process runs with LITELLM_LOCAL_MODEL_COST_MAP=True so no network request, remote content, or fetch failure can change the observation."
        }
      },
      "jobs": [
        {
          "id": "base",
          "canonical": true,
          "runner": "ubuntu-24.04",
          "config": {
            "profile": "base",
            "workload": {
              "name": "root-import",
              "statement": "import litellm"
            },
            "environment": {
              "LITELLM_LOCAL_MODEL_COST_MAP": "True"
            },
            "measurements": {
              "warmups": 0,
              "samples": 1,
              "timing": false,
              "diagnostics": true,
              "importtime": false,
              "network": false,
              "timeout_seconds": 120
            }
          },
          "requirements": {
            "python": "3.12.10",
            "tools": [
              "uv"
            ]
          }
        }
      ]
    }
  },
  "sdk-import-time": {
    "label": "Fresh-process LiteLLM import time",
    "kind": "sdk",
    "artifact": "sdk",
    "canonicalJob": "base",
    "canonicalRunner": "ubuntu-24.04",
    "metrics": {
      "import.median": {
        "unit": "ms",
        "better": "lower"
      },
      "import.p95": {
        "unit": "ms",
        "better": "lower"
      },
      "import.minimum": {
        "unit": "ms",
        "better": "lower"
      },
      "import.maximum": {
        "unit": "ms",
        "better": "lower"
      },
      "import.first": {
        "unit": "ms",
        "better": "lower"
      }
    },
    "definition": {
      "$schema": "../../schemas/current/benchmark.schema.json",
      "id": "sdk-import-time",
      "label": "Fresh-process LiteLLM import time",
      "kind": "sdk",
      "artifact": "sdk",
      "output_metrics": [
        {
          "id": "import.median",
          "unit": "ms",
          "better": "lower"
        },
        {
          "id": "import.p95",
          "unit": "ms",
          "better": "lower"
        },
        {
          "id": "import.minimum",
          "unit": "ms",
          "better": "lower"
        },
        {
          "id": "import.maximum",
          "unit": "ms",
          "better": "lower"
        },
        {
          "id": "import.first",
          "unit": "ms",
          "better": "lower"
        }
      ],
      "protocol": {
        "question": "How long does importing LiteLLM take in a fresh isolated Python process?",
        "claim_scope": "Wall time for spawning an isolated Python process, importing LiteLLM, and shutting down, on the named runner, Python version, and dependency resolution. Includes interpreter startup; not import-only execution time, application startup, or first API-call latency. The import runs with LITELLM_LOCAL_MODEL_COST_MAP=True, so it excludes the time a live model-cost-map fetch would add.",
        "experimental_unit": "One fresh isolated Python process executing import litellm",
        "scenarios": [
          {
            "id": "root-import",
            "label": "import litellm",
            "dimensions": {
              "statement": "import litellm",
              "isolated_python": true
            }
          }
        ],
        "attempts": {
          "count": 20,
          "count_from": "measurements.samples",
          "retention": "Retain every sample in execution order",
          "unit": "fresh-process sample",
          "warmups": 3
        },
        "measurements": [
          {
            "id": "import_duration_ms",
            "label": "Fresh-process wall time",
            "unit": "ms",
            "role": "primary",
            "better": "lower"
          },
          {
            "id": "first_import_duration_ms",
            "label": "First process in the prepared environment",
            "unit": "ms",
            "role": "secondary",
            "better": "lower"
          }
        ],
        "analyses": [
          {
            "id": "fresh_import_distribution",
            "label": "Fresh-process import distribution",
            "measurement": "import_duration_ms",
            "group_by": [
              "scenario"
            ],
            "aggregation": "median and nearest-rank p95",
            "report": [
              "all_samples",
              "minimum",
              "median",
              "p95",
              "maximum",
              "attempt_count"
            ]
          }
        ],
        "validity": {
          "trial": "The isolated process must exit successfully",
          "outliers": "Do not remove samples",
          "instrumentation": "Timing samples run without RSS, module, network, or importtime instrumentation. Every timed process runs with LITELLM_LOCAL_MODEL_COST_MAP=True so the import reads the bundled model cost map instead of fetching the live one over the network inside the timed region."
        }
      },
      "jobs": [
        {
          "id": "base",
          "canonical": true,
          "runner": "ubuntu-24.04",
          "config": {
            "profile": "base",
            "workload": {
              "name": "root-import",
              "statement": "import litellm"
            },
            "measurements": {
              "warmups": 3,
              "samples": 20,
              "timing": true,
              "diagnostics": false,
              "importtime": false,
              "network": false,
              "timeout_seconds": 120
            },
            "environment": {
              "LITELLM_LOCAL_MODEL_COST_MAP": "True"
            }
          },
          "requirements": {
            "python": "3.12",
            "tools": [
              "uv"
            ]
          }
        }
      ]
    }
  },
  "sdk-package-size": {
    "label": "Clean LiteLLM package size",
    "kind": "sdk",
    "artifact": "sdk",
    "canonicalJob": "base",
    "canonicalRunner": "ubuntu-24.04",
    "metrics": {
      "package.wheel": {
        "unit": "MiB",
        "better": "lower"
      },
      "package.download": {
        "unit": "MiB",
        "better": "lower"
      },
      "package.installed": {
        "unit": "MiB",
        "better": "lower"
      },
      "package.artifacts": {
        "unit": "artifacts",
        "better": "lower"
      }
    },
    "definition": {
      "$schema": "../../schemas/current/benchmark.schema.json",
      "id": "sdk-package-size",
      "label": "Clean LiteLLM package size",
      "kind": "sdk",
      "artifact": "sdk",
      "output_metrics": [
        {
          "id": "package.wheel",
          "unit": "MiB",
          "better": "lower"
        },
        {
          "id": "package.download",
          "unit": "MiB",
          "better": "lower"
        },
        {
          "id": "package.installed",
          "unit": "MiB",
          "better": "lower"
        },
        {
          "id": "package.artifacts",
          "unit": "artifacts",
          "better": "lower"
        }
      ],
      "protocol": {
        "question": "How large are the LiteLLM wheel, resolved wheel-only dependency closure, and files installed from that closure?",
        "claim_scope": "The exact requested LiteLLM version and wheel closure resolved within one campaign on the recorded Python patch and resolver tool versions. Installed logical size covers every regular file and symlink named by installed wheel RECORDs, including scripts and install-scheme data, before first import. Cross-campaign comparisons do not hold dependency versions constant.",
        "experimental_unit": "One isolated, clean, wheel-only resolution and installation",
        "scenarios": [
          {
            "id": "base-install",
            "label": "Base LiteLLM installation",
            "dimensions": {
              "binary_only": true,
              "extras": []
            }
          }
        ],
        "measurements": [
          {
            "id": "package.wheel",
            "label": "LiteLLM wheel",
            "unit": "MiB",
            "role": "primary",
            "better": "lower"
          },
          {
            "id": "package.download",
            "label": "Dependency download closure",
            "unit": "MiB",
            "role": "secondary",
            "better": "lower"
          },
          {
            "id": "package.installed",
            "label": "Installed RECORD footprint before import",
            "unit": "MiB",
            "role": "secondary",
            "better": "lower"
          },
          {
            "id": "package.artifacts",
            "label": "Downloaded artifact count",
            "unit": "artifacts",
            "role": "diagnostic",
            "better": "lower"
          }
        ],
        "analyses": [
          {
            "id": "clean_install_sizes",
            "label": "Clean resolution and installation sizes",
            "measurement": "package.wheel",
            "additional_measurements": [
              "package.download",
              "package.installed",
              "package.artifacts"
            ],
            "scenarios": [
              "base-install"
            ],
            "aggregation": "exact byte counts converted to MiB for display"
          }
        ],
        "validity": {
          "trial": "Resolution and installation must succeed; every resolved artifact must be a wheel; downloaded and pip-report closures must match; every installed distribution must expose a RECORD inventory; and the resolved and installed subject versions must exactly match the requested version",
          "retention": "Retain the pip installation report plus the complete wheel inventory, byte sizes, and SHA-256 hashes. Record the requested Python selector, resolved Python patch, resolver inputs, uv version, and seeded pip version. Treat dependency resolution as campaign-local because indexes are mutable.",
          "allocated_size": "Not published: filesystem allocation units, hard-link accounting, and sparse-file behavior are not portable across supported hosts"
        }
      },
      "jobs": [
        {
          "id": "base",
          "canonical": true,
          "runner": "ubuntu-24.04",
          "config": {
            "profile": "base",
            "workload": {
              "name": "root-import",
              "statement": "import litellm"
            },
            "measurements": {
              "warmups": 0,
              "samples": 1,
              "timing": false,
              "diagnostics": false,
              "importtime": false,
              "network": false,
              "timeout_seconds": 120
            },
            "resolver": {
              "extra_index_urls": [],
              "find_links": [],
              "binary_only": true
            }
          },
          "requirements": {
            "python": "3.12.10",
            "tools": [
              "uv"
            ]
          }
        }
      ]
    }
  }
} as const satisfies BenchmarkCatalog;
