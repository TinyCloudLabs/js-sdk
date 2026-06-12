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

Environment:

- `TC_TEST_SERVER`: node URL, default `http://localhost:9000`
- `TC_BENCH_ITERATIONS`: measured iterations, default `10`
- `TC_BENCH_WARMUP`: warmup iterations excluded from summaries, default `2`
- `TC_BENCH_OUTPUT_DIR`: output directory, default `benchmarks/results`
- `TC_BENCH_RUN_ID`: run id, default timestamp
- `TC_BENCH_DUCKDB=true`: force DuckDB benchmarks if the node does not advertise
  features

Outputs:

- `<runId>.jsonl`: raw manual and SDK telemetry span samples
- `<runId>.summary.json`: per-run aggregate summary
- `summary.csv`: cumulative per-run span summaries for plotting over time

The CSV has one row per `(runId, span, source)` with `meanMs`, `p50Ms`, `p95Ms`,
`p99Ms`, and `maxMs`. Use `source=manual` for end-to-end benchmark timings and
`source=telemetry` for spans emitted by SDK internals.
