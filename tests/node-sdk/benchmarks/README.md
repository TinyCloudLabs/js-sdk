# Node SDK Benchmarks

Run repeatable TinyCloud Node SDK benchmarks and save plot-friendly records.

Start a local node first:

```bash
cd ../tinycloud-node
ROCKET_PORT=9000 TINYCLOUD_TELEMETRY__ENABLED=true cargo run
```

Then run the benchmark from the `js-sdk` repo:

```bash
cd tests/node-sdk
bun run bench:prepare
bun run bench
```

Every successful run remains under `benchmarks/results` and refreshes the
self-contained local dashboard at `benchmarks/results/index.html`. Open that
file directly in a browser; it has no server, build step, external assets, or
network dependency. Use the span and percentile selectors to compare HTTP and
end-to-end SDK latency across runs.

The default suite measures 1 KiB WASM vault encryption/decryption, KV
put/get/list, SQL execute/query, and DuckDB execute/query when the node
advertises DuckDB support. HTTP instrumentation automatically covers every
same-origin node request those operations make.

If summaries were copied into the results directory without running the
benchmark, rebuild the dashboard with:

```bash
bun run bench:dashboard
```

To create a named, reviewable baseline before an optimization:

```bash
TC_BENCH_SERVER_REVISION="$(git -C /path/to/tinycloud-node rev-parse HEAD)" \
  bun run bench:baseline
```

`bench:baseline` uses 5 warmups and 50 measured iterations and writes
`benchmarks/baselines/current.json`. It refuses to replace an existing baseline;
set `TC_BENCH_OVERWRITE_BASELINE=true` only when intentionally moving the
baseline. The `benchmarks/results` directory remains ignored, while named
baselines are trackable in git.

Environment:

- `TC_TEST_SERVER`: node URL, default `http://localhost:9000`
- `TC_BENCH_ITERATIONS`: measured iterations, default `10`
- `TC_BENCH_WARMUP`: warmup iterations excluded from summaries, default `2`
- `TC_BENCH_OUTPUT_DIR`: output directory, default `benchmarks/results`
- `TC_BENCH_DASHBOARD_PATH`: generated HTML path, default
  `<TC_BENCH_OUTPUT_DIR>/index.html`
- `TC_BENCH_BASELINE_DIR`: directory of named baselines included in the
  dashboard, default `benchmarks/baselines`
- `TC_BENCH_RUN_ID`: run id, default timestamp
- `TC_BENCH_LABEL`: short experiment name shown on graphs and in run history
- `TC_BENCH_NOTES`: optional experiment notes retained in the summary manifest
- `TC_BENCH_DUCKDB=true`: force DuckDB benchmarks if the node does not advertise
  features
- `TC_BENCH_BASELINE_PATH`: additionally write the run summary to this stable
  path; refuses to overwrite by default
- `TC_BENCH_OVERWRITE_BASELINE=true`: intentionally replace a named baseline
- `TC_BENCH_LOG_REQUESTS=true`: print every node HTTP response-header timing
- `TC_BENCH_SERVER_REVISION`: node git revision or image digest recorded in the
  run manifest
- `TC_BENCH_CLIENT_REVISION`: SDK revision override; defaults to the current git
  commit

Outputs:

- `<runId>.jsonl`: raw manual, SDK telemetry, and per-request HTTP samples
- `<runId>.summary.json`: per-run aggregate summary
- `summary.csv`: cumulative per-run span summaries for plotting over time
- `index.html`: local trend dashboard with embedded summaries and no external
  runtime dependencies
- `TC_BENCH_BASELINE_PATH`, when set: a stable copy of the versioned run summary

The CSV has one row per `(runId, span, source)` with `meanMs`, `p50Ms`, `p95Ms`,
`p99Ms`, and `maxMs`. Use `source=manual` for end-to-end benchmark timings and
`source=telemetry` for spans emitted by SDK internals.

`source=http` records each node request twice:

- `http.headers`: time until `fetch()` receives the response headers (roughly
  network + server processing + first-byte latency)
- `http.total`: time until the SDK consumes the response body

Each raw HTTP sample includes a request ID, parent benchmark, iteration, method,
normalized path, status, and byte counts when knowable. Authorization contents
are never recorded; only their encoded byte length is retained. Setup and
warmup requests remain in the JSONL for diagnosis but are excluded from
aggregate summaries.

The summary manifest records the server version/features, optional server
revision, SDK revision/branch/dirty state, Bun/Node versions, platform,
architecture, and benchmark configuration so results from different
environments are not silently compared. It also records the CPU model, logical
CPU count, and memory size.

The dashboard deduplicates results and named baselines by run ID, sorts them by
timestamp, and retains:

- a trend graph for every recorded span and percentile
- latest-versus-baseline deltas
- an SDK → client work → HTTP headers → consumed body sequence view
- full run, revision, runtime, and machine history
