# Metrics & Dashboard Walkthrough

This document explains the complete metrics pipeline of the nopCommerce observability stack — from the lines of code that record a metric, through the OTel Collector, into Prometheus, and finally visualised in Grafana. It complements the [traces walkthrough](TRACES_AND_OBSERVABILITY_WALKTHROUGH.md) and covers the two custom business metrics added to the checkout flow.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Custom Business Metrics](#2-custom-business-metrics)
   - 2.1 [NopMeter — the metric factory](#21-nopmeter--the-metric-factory)
   - 2.2 [Counter: `nop.payment.result`](#22-counter-noppaymentresult)
   - 2.3 [Histogram: `nop.checkout.duration`](#23-histogram-nopcheckoutduration)
3. [Where Metrics Are Recorded](#3-where-metrics-are-recorded)
   - 3.1 [PaymentService — recording the counter](#31-paymentservice--recording-the-counter)
   - 3.2 [OrderProcessingService — recording the histogram](#32-orderprocessingservice--recording-the-histogram)
4. [Automatic Metrics (Zero Code)](#4-automatic-metrics-zero-code)
5. [MeterProvider Registration](#5-meterprovider-registration)
6. [OTel Collector: Metrics Pipeline](#6-otel-collector-metrics-pipeline)
7. [Prometheus: Scraping and Querying](#7-prometheus-scraping-and-querying)
   - 7.1 [The pull model](#71-the-pull-model)
   - 7.2 [Metric naming convention](#72-metric-naming-convention)
   - 7.3 [The double-prefix bug (and fix)](#73-the-double-prefix-bug-and-fix)
   - 7.4 [Essential PromQL queries](#74-essential-promql-queries)
8. [Grafana Dashboard](#8-grafana-dashboard)
   - 8.1 [Provisioning (zero-click setup)](#81-provisioning-zero-click-setup)
   - 8.2 [Row 1 — Business Metrics](#82-row-1--business-metrics)
   - 8.3 [Row 2 — HTTP Layer](#83-row-2--http-layer)
   - 8.4 [Row 3 — .NET Runtime Health](#84-row-3--net-runtime-health)
9. [Reading the Live Dashboard](#9-reading-the-live-dashboard)
10. [URLs Reference](#10-urls-reference)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  nopCommerce process (dotnet run)                                   │
│                                                                     │
│  Business code          OTel SDK                                    │
│  ─────────────          ────────                                    │
│  PaymentService    ──►  NopMeter.PaymentResult.Add(1, ...)          │
│  OrderProcessing   ──►  NopMeter.CheckoutDuration.Record(ms, ...)   │
│  ASP.NET Core      ──►  http.server.request.duration (auto)         │
│  .NET runtime      ──►  dotnet.gc, dotnet.thread_pool (auto)        │
│                         │                                           │
│                         │  OTLP gRPC (port 4317)                   │
└─────────────────────────┼───────────────────────────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  OTel Collector                                                     │
│                                                                     │
│  receivers: [otlp]                                                  │
│  processors: [memory_limiter, batch, resourcedetection]             │
│  exporters: [prometheus]  ◄── exposes /metrics on port 8889         │
└─────────────────────────────────────────────────────────────────────┘
                          ▲ scrape (pull, every 15 s)
┌─────────────────────────────────────────────────────────────────────┐
│  Prometheus (port 9090)                                             │
│  Stores time-series data, evaluates PromQL                          │
└─────────────────────────────────────────────────────────────────────┘
                          ▲ query (PromQL over HTTP)
┌─────────────────────────────────────────────────────────────────────┐
│  Grafana (port 3000)                                                │
│  Visualises metrics as dashboards                                   │
└─────────────────────────────────────────────────────────────────────┘
```

Key distinction from traces: metrics use a **pull model**. Prometheus periodically scrapes a `/metrics` endpoint exposed by the OTel Collector — the application never pushes directly to Prometheus. This is why there are two separate steps (app → Collector → Prometheus) instead of one.

---

## 2. Custom Business Metrics

### 2.1 NopMeter — the metric factory

File: `nopCommerce/src/Libraries/Nop.Core/Observability/NopMeter.cs`

```csharp
public static class NopMeter
{
    public const string Name = "NopCommerce.Checkout";

    private static readonly Meter _meter = new(Name, "1.0.0");

    public static readonly Counter<long>   PaymentResult     = _meter.CreateCounter<long>(...);
    public static readonly Histogram<double> CheckoutDuration = _meter.CreateHistogram<double>(...);
}
```

`Meter` is the BCL type (`System.Diagnostics.Metrics`) that acts as a factory for metric instruments. It is placed in `Nop.Core` (not `Nop.Web.Framework`) so that `Nop.Services` can call it without depending on any OTel NuGet package — `System.Diagnostics.Metrics` is part of the .NET runtime itself.

The class is **static** because `Meter` and its instruments must be singletons. Creating a new `Meter` per request would register duplicate instruments and cause SDK errors.

Until `ObservabilityStartup` creates the `MeterProvider` and subscribes to `"NopCommerce.Checkout"`, all `Add()` and `Record()` calls are **no-ops** — the SDK drops them silently. This means the application starts and runs correctly even if the OTel stack is not configured.

### 2.2 Counter: `nop.payment.result`

```csharp
public static readonly Counter<long> PaymentResult =
    _meter.CreateCounter<long>(
        name: "nop.payment.result",
        unit: "payments",
        description: "Number of payment processing attempts, tagged by method and outcome.");
```

**What a Counter measures:** A monotonically increasing integer. Each call to `Add(1, ...)` increments it by one. Counters are reset to 0 only when the process restarts.

**Labels (attributes/dimensions):**

| Label | Values | Purpose |
|---|---|---|
| `payment.method` | `"Payments.CheckMoneyOrder"`, `"Payments.Manual"`, etc. | Identifies which payment plugin processed the payment. Allows comparing success rates across providers. |
| `payment.status` | `"success"` or `"failure"` | The primary SLO dimension. Filter `payment_status="failure"` to build an error-rate alert. |

**What is deliberately excluded:**
- Order amount — would create unbounded cardinality (one label value per unique amount)
- Customer ID — PII
- Card type — PII risk when combined with other attributes

### 2.3 Histogram: `nop.checkout.duration`

```csharp
public static readonly Histogram<double> CheckoutDuration =
    _meter.CreateHistogram<double>(
        name: "nop.checkout.duration",
        unit: "ms",
        description: "End-to-end duration of PlaceOrderAsync, tagged by payment method and outcome.");
```

**What a Histogram measures:** The distribution of values over time. Rather than storing every individual measurement, Prometheus stores the count of measurements that fell into predefined buckets (e.g. how many requests completed in < 100 ms, < 200 ms, < 500 ms, ...). This allows computing percentiles at query time using `histogram_quantile()`.

**Why percentiles matter more than averages:** An average masks tail latency. If 95% of checkouts complete in 200 ms but 5% take 5 seconds due to a payment gateway timeout, the average might show 450 ms — appearing acceptable. The p99 would expose the real problem.

**Labels:**

| Label | Values | Purpose |
|---|---|---|
| `payment.method` | plugin system name | Identifies whether slow checkouts are correlated with a specific payment provider |
| `order.success` | `"true"` or `"false"` | Separates successful checkout latency from failed checkout latency. A failed checkout caught early (validation error) is fast; a failed checkout from a payment gateway timeout is slow |

**Exemplars:** Because `SetExemplarFilter(ExemplarFilterType.TraceBased)` is configured in `ObservabilityStartup`, when `Record()` is called during an active trace, the OTel SDK automatically attaches the current `trace_id` and `span_id` to the data point. In Grafana, this manifests as clickable dots on the histogram panel that open the corresponding trace in Jaeger directly.

---

## 3. Where Metrics Are Recorded

### 3.1 PaymentService — recording the counter

File: `nopCommerce/src/Libraries/Nop.Services/Payments/PaymentService.cs`, line 94

```csharp
var result = await paymentMethod.ProcessPaymentAsync(processPaymentRequest);

NopMeter.PaymentResult.Add(1,
    new KeyValuePair<string, object?>("payment.method", processPaymentRequest.PaymentMethodSystemName),
    new KeyValuePair<string, object?>("payment.status", result.Success ? "success" : "failure"));

return result;
```

This location was chosen because it is the **only place** in the codebase where both the payment method name and the payment result are available simultaneously. Recording it here avoids duplicating the plugin lookup logic or threading extra parameters through the call stack.

**Important edge case:** The method has an early return at line 54 for zero-value orders (`processPaymentRequest.OrderTotal == decimal.Zero`) — these orders are marked as Paid without going through the payment plugin and therefore bypass the metric. This is intentional: free orders are not payment events.

### 3.2 OrderProcessingService — recording the histogram

File: `nopCommerce/src/Libraries/Nop.Services/Orders/OrderProcessingService.cs`, line 1713

```csharp
sw.Stop();
NopMeter.CheckoutDuration.Record(
    sw.Elapsed.TotalMilliseconds,
    new KeyValuePair<string, object?>("payment.method", processPaymentRequest.PaymentMethodSystemName),
    new KeyValuePair<string, object?>("order.success", result.Success ? "true" : "false"));

return result;
```

A `Stopwatch` is started at the entry of `PlaceOrderAsync` and stopped here, just before the result is returned. This measures the **complete end-to-end duration** of placing an order — including payment processing, inventory reservation, email notifications, and database writes — giving a holistic view of checkout latency as experienced by the user.

---

## 4. Automatic Metrics (Zero Code)

`ObservabilityStartup` also registers two automatic instrumentation packages that produce metrics without any application code:

**`AddAspNetCoreInstrumentation()`** — produces:
- `http.server.request.duration` (histogram in seconds): every HTTP request handled by ASP.NET Core. Labels include `http.request.method`, `http.route`, `http.response.status_code`. This is the source of the "HTTP Request Rate by Route" and "HTTP Error Rate (5xx)" panels.

**`AddRuntimeInstrumentation()`** — produces:
- `dotnet.gc.collections.count` (counter): garbage collection events by generation (gen0, gen1, gen2)
- `dotnet.thread_pool.queue.length` (gauge): current number of items waiting in the thread pool queue
- `dotnet.process.memory.usage` (gauge): process working set in bytes

These three are the source of the ".NET Runtime Health" row in the Grafana dashboard.

---

## 5. MeterProvider Registration

File: `nopCommerce/src/Presentation/Nop.Web.Framework/Infrastructure/ObservabilityStartup.cs`

```csharp
services.AddOpenTelemetry()
    .ConfigureResource(resource => resource
        .AddService(serviceName: "nopcommerce", serviceVersion: "5.0.0"))

    .WithMetrics(metrics => metrics
        .AddMeter(NopMeter.Name)               // subscribe to our custom business meter
        .AddAspNetCoreInstrumentation()        // HTTP request metrics
        .AddRuntimeInstrumentation()           // GC, thread pool, memory

        .SetExemplarFilter(ExemplarFilterType.TraceBased)  // link metrics → traces

        .AddOtlpExporter(options => {
            options.Endpoint = new Uri(otlpEndpoint);      // → OTel Collector :4317
        }));
```

The class implements `INopStartup` with `Order = 10`, which means it runs **before** any other nopCommerce service registration (`NopStartup` has `Order = 2000`). This ensures the `MeterProvider` is active before any request arrives and before any startup code that might otherwise produce untracked metrics.

---

## 6. OTel Collector: Metrics Pipeline

File: `observability/otelcol-config.yml`

The metrics pipeline in the Collector is:

```yaml
metrics:
  receivers:  [otlp]
  processors: [memory_limiter, batch, resourcedetection]
  exporters:  [prometheus, debug]
```

Note that the **`transform/sanitize_pii` processor is absent from the metrics pipeline**. PII sanitization is only in the traces pipeline because metric labels are designed from the start to contain no PII (method names and outcome strings only).

The `prometheus` exporter exposes a standard Prometheus scrape endpoint:

```yaml
exporters:
  prometheus:
    endpoint: "0.0.0.0:8889"
```

This means the Collector listens on port 8889 and responds to `GET /metrics` with all current metric values in Prometheus text format. Prometheus then scrapes this endpoint every 15 seconds.

**Important: Metrics staleness.** If no new metric data arrives from nopCommerce for approximately 5 minutes, the Collector marks existing metrics as stale and stops serving them. Prometheus then shows "no data" for those series. This is expected behaviour — perform a new checkout to refresh the data.

---

## 7. Prometheus: Scraping and Querying

### 7.1 The pull model

Unlike traces (where the application pushes to Jaeger), metrics use a **pull model**:

1. The OTel Collector exposes `/metrics` on port 8889
2. Prometheus is configured (`observability/prometheus.yml`) to scrape `otelcol:8889` every 15 seconds
3. Prometheus stores the scraped values as time-series in its TSDB
4. Grafana queries Prometheus using PromQL

This architecture means Prometheus controls the scrape cadence and retains historical data even if the Collector restarts.

### 7.2 Metric naming convention

OTel metric names use dots as separators (`nop.payment.result`). When exported to Prometheus, the OTel SDK and Collector translate these to underscores, following Prometheus naming conventions:

| OTel name | Prometheus name |
|---|---|
| `nop.payment.result` (Counter, unit: `payments`) | `nop_payment_result_payments_total` |
| `nop.checkout.duration` (Histogram, unit: `ms`) | `nop_checkout_duration_milliseconds_bucket` / `_count` / `_sum` |
| `http.server.request.duration` (Histogram, unit: `s`) | `nop_http_server_request_duration_seconds_bucket` |
| `dotnet.process.memory.usage` (Gauge, unit: `By`) | `nop_dotnet_process_memory_working_set_bytes` |

The transformation rules:
- Dots → underscores
- Counter instruments get the `_total` suffix automatically
- Histogram instruments produce three series: `_bucket`, `_count`, `_sum`
- The unit name is appended in its Prometheus canonical form (e.g. `ms` → `milliseconds`, `By` → `bytes`, `s` → `seconds`)

### 7.3 The double-prefix bug (and fix)

During development, querying `nop_payment_result_payments_total` returned no results. The actual metric name was `nop_nop_payment_result_payments_total`.

**Root cause:** The OTel Collector's prometheus exporter had a `namespace: nop` option configured, which prepends `nop_` to every exported metric. But the metric name already started with `nop.` (→ `nop_`), resulting in the double prefix `nop_nop_`.

```yaml
# BEFORE (broken)
exporters:
  prometheus:
    endpoint: "0.0.0.0:8889"
    namespace: nop        # ← this was the culprit

# AFTER (fixed)
exporters:
  prometheus:
    endpoint: "0.0.0.0:8889"
    # namespace removed — the metric names are already prefixed with nop_
```

After removing `namespace: nop` and restarting the Collector, the metrics appeared with their correct names.

**How to diagnose this in the future:** Open `http://localhost:8889/metrics` directly in a browser. This is the raw scrape endpoint — it shows the exact metric names and current values as Prometheus sees them, bypassing both Prometheus and Grafana.

### 7.4 Essential PromQL queries

**Total payment count (cumulative):**
```promql
sum(nop_payment_result_payments_total)
```

**Successful vs failed payments (cumulative):**
```promql
sum(nop_payment_result_payments_total{payment_status="success"})
sum(nop_payment_result_payments_total{payment_status="failure"})
```

**Payment rate per second (last 2 minutes), split by outcome:**
```promql
sum by(payment_status) (rate(nop_payment_result_payments_total[2m]))
```
`rate()` computes the per-second increase of a counter over the given window. Always use `rate()` for counters in dashboards — never display raw counter values in a timeseries graph.

**Checkout duration p95 (last 5 minutes):**
```promql
histogram_quantile(0.95, sum by(le) (rate(nop_checkout_duration_milliseconds_bucket[5m])))
```
`histogram_quantile(φ, ...)` computes the φth quantile from the bucket distribution. The `le` label is the upper bound of each bucket ("less than or equal"). The `sum by(le)` aggregates across all payment methods and order outcomes to get the overall p95.

**HTTP 5xx error rate per second:**
```promql
sum(rate(nop_http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[2m]))
```

---

## 8. Grafana Dashboard

Dashboard file: `observability/grafana/provisioning/dashboards/nopcommerce-checkout.json`

### 8.1 Provisioning (zero-click setup)

Grafana is configured to auto-load dashboards from a directory via two provisioning files:

**`observability/grafana/provisioning/dashboards/dashboards.yml`** — tells Grafana where to scan:
```yaml
apiVersion: 1
providers:
  - name: nopcommerce
    folder: nopCommerce
    type: file
    options:
      path: /etc/grafana/provisioning/dashboards
```

**`nopcommerce-checkout.json`** — the dashboard definition. On startup (or after `docker compose restart grafana`), Grafana reads every `.json` file in that directory and creates or updates the corresponding dashboards. No manual import through the UI is needed.

The Docker volume mount in `docker-compose.observability.yml` maps the local directory into the container:
```
./observability/grafana/provisioning → /etc/grafana/provisioning
```

### 8.2 Row 1 — Business Metrics

This is the primary operational row. It answers the question: "Is checkout working right now?"

| Panel | Type | Query | Purpose |
|---|---|---|---|
| **Total Payments Processed** | Stat (blue) | `sum(nop_payment_result_payments_total)` | Cumulative count since app start. Confirms the payment metric is being recorded. |
| **Successful Payments** | Stat (green) | `sum(nop_payment_result_payments_total{payment_status="success"})` | Baseline health — should equal Total when everything is working. |
| **Failed Payments** | Stat (green → red at ≥ 1) | `sum(nop_payment_result_payments_total{payment_status="failure"}) or vector(0)` | The primary alert signal. `or vector(0)` ensures the panel shows 0 instead of "No data" when there are no failures (because a counter with value 0 is never exported). |
| **Checkout Duration p95** | Stat (green/yellow/red) | `histogram_quantile(0.95, ...)` | 95th percentile latency. Thresholds: green < 500 ms, yellow 500–1000 ms, red > 1 s. |
| **HTTP 5xx Errors** | Stat (green → red at ≥ 1) | `sum(nop_http_server_request_duration_seconds_count{http_response_status_code=~"5.."})` | Total server errors. A non-zero value after error simulation confirms the HTTP instrumentation is working. |
| **Payment Rate — Success vs Failure** | Timeseries | `sum by(payment_status) (rate(...[2m]))` | Rate over time, coloured green (success) and red (failure). The key SLO graph. |
| **Checkout Duration — p50/p95/p99** | Timeseries | `histogram_quantile(0.50/0.95/0.99, ...)` | Latency percentiles over time. A widening gap between p50 and p99 indicates latency spikes affecting a minority of users. |

### 8.3 Row 2 — HTTP Layer

Covers all traffic to the application, not just payment requests.

| Panel | Type | Query | Purpose |
|---|---|---|---|
| **HTTP Request Rate by Route** | Timeseries | `sum by(http_route) (rate(...[2m]))` | Per-route traffic volume. Shows which checkout endpoints (`/checkout/`, `/onepagecheckout/`, `/cart/`) are active. |
| **HTTP Error Rate (5xx)** | Timeseries | `sum(rate(...{http_response_status_code=~"5.."}[2m]))` | Server errors over time. A spike here correlates with infrastructure failures visible as error spans in Jaeger. |

### 8.4 Row 3 — .NET Runtime Health

Covers the internal health of the .NET process. These panels are sourced from `AddRuntimeInstrumentation()` and require no custom code.

| Panel | Type | Query | Purpose |
|---|---|---|---|
| **Memory — Working Set** | Timeseries (blue) | `nop_dotnet_process_memory_working_set_bytes / 1024 / 1024` | Process memory in MB. A continuously growing line without drops indicates a memory leak. |
| **GC Collections per Second** | Timeseries | `sum by(gc_heap_generation) (rate(nop_dotnet_gc_collections_total[2m]))` | GC pressure by generation. Frequent gen2 collections indicate sustained memory pressure. |
| **Thread Pool — Queue Length** | Timeseries (orange) | `nop_dotnet_thread_pool_queue_length_total` | Work items waiting in the thread pool. A rising queue means the app is CPU-bound and cannot keep up with incoming work. |

---

## 9. Reading the Live Dashboard

After performing several checkouts, the dashboard showed the following:

**Business Metrics row:**
- **Total Payments: 3** — three checkouts were performed in this session
- **Successful Payments: 3** — all completed without errors
- **Failed Payments: 0** — shown as green, confirming the `or vector(0)` fallback works
- **Checkout Duration p95: 243 ms** — well within the 500 ms green threshold
- **HTTP 5xx Errors: 1** — the single error from the MySQL stop simulation (see [traces walkthrough](TRACES_AND_OBSERVABILITY_WALKTHROUGH.md#6-error-simulation))

**Payment Rate timeseries:**
- A single spike (green line) appears at the timestamp of the checkouts
- No red line appears because there were no payment failures
- The rate returns to 0 between sessions (no traffic = rate is 0)

**Checkout Duration timeseries:**
- p50, p95, and p99 lines are tightly clustered around 180–240 ms
- A tightly clustered set of percentiles indicates consistent, predictable performance with no tail latency outliers

**HTTP Request Rate by Route:**
- Clearly shows the checkout routes: `/cart/`, `/checkout/`, `/checkout/completed/{orderId:int?}`, `/onepagecheckout/`, and multiple `addproducttocart/` variants
- The high-volume spikes correspond to the browsing and cart-filling phase, not just the final payment step

**HTTP Error Rate (5xx):**
- A near-zero line with a single tiny spike — the MySQL failure event
- The spike is brief, confirming the error was transient (not a sustained outage)

---

## 10. URLs Reference

| Service | URL | Notes |
|---|---|---|
| Grafana | http://localhost:3000 | Login: `admin / admin`. Dashboard under nopCommerce folder. |
| Prometheus | http://localhost:9090 | Use Graph tab to run PromQL queries manually. |
| Collector scrape endpoint | http://localhost:8889/metrics | Raw Prometheus text format. Use to debug metric names and values. |
| Jaeger | http://localhost:16686 | Trace search and waterfall view. |
| nopCommerce | http://localhost:5000 | The application itself. |

**Debugging tip:** If Grafana shows "No data" for a metric, always check `http://localhost:8889/metrics` first. If the metric appears there, the problem is in the PromQL query or the Prometheus datasource. If the metric is absent there, the problem is upstream — either the application is not recording the metric or the OTel Collector is not receiving data from it.
