# Product

## Register

product

## Users

TinyCloud engineers benchmarking Node SDK and tinycloud-node changes on local development machines. They need to understand which request or SDK stage changed, compare commits, and decide whether an optimization improved latency without losing the underlying environment and sample context.

## Product Purpose

Turn repeatable Node SDK benchmark runs into a trustworthy local performance history. Success means an engineer can run the benchmark before and after a change, inspect request and operation percentiles, identify regressions or improvements, and trace every comparison back to exact client, server, runtime, and machine revisions.

## Brand Personality

Precise, technical, calm. The interface should feel dependable and focused, with enough TinyCloud identity to be recognizable without competing with the measurements.

## Anti-references

Avoid flashy SaaS dashboards, decorative data visualizations, marketing-style hero metrics, excessive cards, hidden axes, and color-only status communication. Do not imply statistical certainty that the sample configuration does not support.

## Design Principles

- Keep comparisons honest: always expose revisions, environment, sample count, and percentile.
- Make the slow path obvious: lead with operation and request-stage differences.
- Preserve local ownership: the benchmark history remains on the engineer's machine by default.
- Optimize for repeated use: one command records a run and refreshes the dashboard.
- Prefer readable evidence over decoration.

## Accessibility & Inclusion

Target WCAG 2.2 AA. Support keyboard navigation, visible focus, reduced motion, high-contrast text, and chart series that remain distinguishable without relying on color alone.
