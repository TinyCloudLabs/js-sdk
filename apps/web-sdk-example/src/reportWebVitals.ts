import type { Metric } from 'web-vitals';

// web-vitals v5 renamed the reporting API: `ReportHandler` became `Metric`, the
// `getX` helpers became `onX`, and FID was dropped in favour of INP. The old
// v2-era imports left this file uncompilable, which blocked the whole
// web-sdk-example build -- and therefore every Playwright e2e run.
const reportWebVitals = (onPerfEntry?: (metric: Metric) => void) => {
  if (onPerfEntry && onPerfEntry instanceof Function) {
    import('web-vitals').then(({ onCLS, onINP, onFCP, onLCP, onTTFB }) => {
      onCLS(onPerfEntry);
      onINP(onPerfEntry);
      onFCP(onPerfEntry);
      onLCP(onPerfEntry);
      onTTFB(onPerfEntry);
    });
  }
};

export default reportWebVitals;
