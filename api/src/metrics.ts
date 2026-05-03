import { Counter, Registry, collectDefaultMetrics } from "prom-client";

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry, prefix: "qlkho_api_" });

export const webhookAcceptedCounter = new Counter({
  name: "qlkho_api_webhook_accepted_total",
  help: "Total accepted nhanh webhook events",
  labelNames: ["event_type"],
  registers: [metricsRegistry]
});

export const webhookRejectedCounter = new Counter({
  name: "qlkho_api_webhook_rejected_total",
  help: "Total rejected nhanh webhook events",
  labelNames: ["reason"],
  registers: [metricsRegistry]
});

export const syncEnqueuedCounter = new Counter({
  name: "qlkho_api_sync_enqueued_total",
  help: "Total sync jobs enqueued",
  labelNames: ["event_type"],
  registers: [metricsRegistry]
});
