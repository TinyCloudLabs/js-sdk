// Private synthetic measurement helpers. Not production instrumentation.
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createDiagnosticRuntime, DiagnosticStore, reviewDiagnostics } from '@tinycloud/operations/diagnostics';

export async function capture(mode, root, source) {
  assert(['off', 'on', 'failed_sink'].includes(mode));
  assert(root.startsWith(process.env.HOME + '/'));
  const store = new DiagnosticStore(root);
  if (mode !== 'off') await store.control('enable', { scope: 'tc-apps' });
  const start = performance.now();
  const runtime = createDiagnosticRuntime({ root, source });
  const binding = await runtime.binding();
  const discovery_ms = performance.now() - start;
  if (mode !== 'off') assert(binding, 'enabled discovery did not produce a binding');
  // Refuse append under a real held root lock, after successful discovery.
  // CLI processes started later also encounter this lock during discovery.
  if (mode === 'failed_sink') await mkdir(join(root, '.writer-lock'), { mode: 0o700 });
  return { runtime, binding, discovery_ms, async finish() {
    const before_drain = runtime.health();
    const started = performance.now();
    const drain = runtime.drainSync();
    const drain_ms = performance.now() - started;
    const after_drain = runtime.health();
    const closeStarted = performance.now();
    await runtime.close();
    const close_ms = performance.now() - closeStarted;
    const after_close = runtime.health();
    if (mode === 'failed_sink') await rm(join(root, '.writer-lock'), { recursive: true });
    const reviewStarted = performance.now();
    const review = await reviewDiagnostics(store, { all: true });
    const time_to_review_ms = performance.now() - reviewStarted;
    const inspection = await store.inspect();
    return {
      discovery_ms, before_drain, drain, drain_ms, after_drain, close_ms, after_close,
      runtime_counter_scope: 'this consumer runtime only; not CLI/wrapper helpers',
      lock: { held: mode === 'failed_sink', lock_wait_ms: null, observed_failure: after_close.failure ?? null },
      queue: { sampled_before_drain_bytes: before_drain.queue_bytes, high_water_bytes: null },
      persisted_events: review.event_count,
      unfinished_observed_invocations: review.invocations.filter(value => value.finish === 'unknown').length,
      incomplete_segments: inspection.health.incomplete,
      metadata_bytes: inspection.usage.partition_bytes - inspection.usage.detail_bytes,
      detail_bytes: inspection.usage.detail_bytes,
      root_bytes: inspection.usage.root_bytes ?? null,
      time_to_review_ms, time_to_review_scope: 'one local review after this runtime closes; excludes transfer and human interpretation',
      coverage: review.coverage,
      wrapper_scheduled_sleep_ms: review.retries.filter(value => value.layer === 'wrapper_child').reduce((sum, value) => sum + value.scheduled_delay_ms, 0),
      observed_run_ids: [...new Set(review.timeline.map(value => value.event.run_id).filter(Boolean))],
      child_process_health: { accepted: null, acknowledged: null, dropped: null, pending: null, reason: 'not exposed by ordinary CLI exit; persisted evidence is not an acceptance counter' },
    };
  }};
}

export async function measure(action) {
  const started = performance.now();
  const cpu = process.cpuUsage();
  const value = await action();
  const usage = process.cpuUsage(cpu);
  return { value, wall_ms: performance.now() - started, cpu_user_us: usage.user, cpu_system_us: usage.system,
    cpu_scope: 'consumer process including its worker threads; excludes isolated diagnostic filesystem child and CLI children',
    process_lifetime_peak_rss_kib: process.resourceUsage().maxRSS };
}
