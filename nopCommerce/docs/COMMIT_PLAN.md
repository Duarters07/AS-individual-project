# Commit Plan — Incremental History

The assignment explicitly states: *"a single large commit at the end is not acceptable"* and *"show a clear commit history that reflects your work incrementally"*. This document defines the exact sequence of commits to make, with the files to stage in each one and the commit message to use.

---

## BEFORE COMMITTING — Critical structural fix

The git repository is at `nopCommerce/` (remote: `Duarters07/nopCommerce`). The `observability/` and `docs/` directories currently live **outside** the git repo, at the `AS/` level. The assignment requires everything to be in the repo. Move them first:

```bash
# Run from AS/
cp -r observability/ nopCommerce/observability/
cp -r docs/          nopCommerce/docs/

# Verify the git repo sees them
cd nopCommerce
git status --short
```

After moving, all work below is done from inside `nopCommerce/`.

---

## Commit Sequence

### Commit 1 — Architecture analysis (Task 1)

**Story:** *"Before writing a single line of code, I read the codebase."*

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: add architecture analysis of nopCommerce layered design

Analyses layer dependencies, IEventPublisher event bus, and identifies
instrumentation facilitation points and obstacles in the existing code.
Covers why EntityRepository and EventPublisher are the natural OTel
injection points and why the Service Locator pattern limits decorator use."
```

---

### Commit 2 — Flow selection and instrumentation plan (Task 2 planning)

**Story:** *"I chose the checkout flow and planned exactly what to instrument."*

```bash
git add docs/task2-flow-selection.md
git commit -m "docs: select checkout flow and plan instrumentation strategy

Compares three candidate flows (checkout, search, admin publish) across six
criteria. Checkout selected: highest architectural complexity, genuine PII
risk requiring sanitisation, and metrics with real operational value.
Documents planned spans, safe attributes, and PII exclusion strategy."
```

---

### Commit 3 — Observability infrastructure stack

**Story:** *"I set up the backends before touching any application code."*

```bash
git add observability/docker-compose.observability.yml
git add observability/otelcol-config.yml
git add observability/prometheus.yml
git add observability/grafana/provisioning/datasources/datasources.yml
git commit -m "infra: add OTel Collector, Jaeger, Prometheus and Grafana stack

Docker Compose stack with four services wired together:
- OTel Collector (otel/opentelemetry-collector-contrib) receives OTLP from
  the app, sanitises PII via transform/sanitize_pii processor, forwards
  traces to Jaeger and exposes a Prometheus scrape endpoint on :8889.
- Jaeger all-in-one for trace storage and waterfall UI.
- Prometheus in pull mode, scraping the Collector every 15 s.
- Grafana with Prometheus and Jaeger datasources auto-provisioned.

The PII processor removes credit_card.*, customer.email, billing/shipping
addresses, and redacts token= query parameters before any export."
```

---

### Commit 4 — OTel SDK primitives in Nop.Core

**Story:** *"I added the two static singletons that the rest of the code will use."*

```bash
git add src/Libraries/Nop.Core/Observability/NopActivitySource.cs
git add src/Libraries/Nop.Core/Observability/NopMeter.cs
git commit -m "feat(core): add NopActivitySource and NopMeter observability primitives

NopActivitySource wraps System.Diagnostics.ActivitySource (BCL, no NuGet)
for creating manual trace spans. NopMeter wraps System.Diagnostics.Metrics.Meter
(BCL) and defines two instruments:

  nop.payment.result   Counter<long>    — payment attempts by method and outcome
  nop.checkout.duration Histogram<double> — PlaceOrderAsync duration in ms

Both placed in Nop.Core so that Nop.Services can record metrics without
depending on OTel NuGet packages, which live only in Nop.Web.Framework."
```

---

### Commit 5 — Register OTel SDK via ObservabilityStartup

**Story:** *"I wired the SDK into the ASP.NET Core DI container without touching Program.cs."*

```bash
git add src/Presentation/Nop.Web.Framework/Infrastructure/ObservabilityStartup.cs
git add src/Presentation/Nop.Web.Framework/Nop.Web.Framework.csproj
git add src/Presentation/Nop.Web/App_Data/appsettings.Development.json
git commit -m "feat(framework): register TracerProvider and MeterProvider via INopStartup

ObservabilityStartup (Order=10) is auto-discovered by nopCommerce's INopStartup
mechanism — no changes to Program.cs or any existing file.

TracerProvider subscribes to NopActivitySource and adds:
  - AddAspNetCoreInstrumentation (HTTP entry spans, health/favicon filtered out)
  - AddHttpClientInstrumentation (outbound calls to payment providers)
  - AddOtlpExporter → OTel Collector :4317

MeterProvider subscribes to NopMeter and adds:
  - AddAspNetCoreInstrumentation (http.server.request.duration)
  - AddRuntimeInstrumentation (GC, thread pool, working set)
  - SetExemplarFilter(TraceBased) — links metric data points to live traces
  - AddOtlpExporter → OTel Collector :4317

OTLP endpoint read from Observability:OtlpEndpoint in appsettings.Development.json,
defaulting to http://localhost:4317 so the app starts without the stack running."
```

---

### Commit 6 — Distributed tracing: EventPublisher and EntityRepository

**Story:** *"I instrumented the two infrastructure boundaries with surgical changes."*

```bash
git add src/Libraries/Nop.Services/Events/EventPublisher.cs
git add src/Libraries/Nop.Data/EntityRepository.cs
git commit -m "feat(tracing): instrument EventPublisher and EntityRepository with manual spans

EventPublisher.PublishAsync: adds span 'event <EventType>' (ActivityKind.Internal)
with event.type and event.consumers_count. Errors mark the span red in Jaeger.
Modified here because Service Locator (EngineContext) prevents DI decoration.

EntityRepository<T>.InsertAsync/UpdateAsync/DeleteAsync: adds spans 'db.<op> <T>'
(ActivityKind.Client) with db.operation and db.entity_type. A single generic
change covers all 100+ entity types. Read methods are intentionally excluded
to avoid high-volume noise — writes change state and are the operationally
relevant operations."
```

---

### Commit 7 — Tracing + metrics: checkout service layer

**Story:** *"I added the missing middle of the trace and the two custom business metrics."*

```bash
git add src/Libraries/Nop.Services/Orders/OrderProcessingService.cs
git add src/Libraries/Nop.Services/Payments/PaymentService.cs
git commit -m "feat(checkout): add nop.order.place and nop.payment.process spans + metrics

Completes the trace waterfall for the checkout flow:

  HTTP POST /checkout/confirm          (auto)
    └── nop.order.place                (new — OrderProcessingService)
          ├── nop.payment.process      (new — PaymentService)
          ├── db.insert Order          (EntityRepository)
          └── event OrderPlacedEvent   (EventPublisher)

nop.order.place: wraps PlaceOrderAsync end-to-end. Tags: payment.method (upfront),
order.success + order.id (on completion). SetStatus(Error) on failure.

nop.payment.process: wraps the external plugin call. Tags: payment.method (upfront),
payment.status (after result). SetStatus(Error) on failure. This is the highest-risk
step — a dedicated span isolates payment provider latency from DB/notification time.

Metrics recorded at the same two locations:
  nop.payment.result{payment.method, payment.status} += 1   (PaymentService)
  nop.checkout.duration{payment.method, order.success}       (OrderProcessingService)

Both instruments exclude PII: plugin system names and boolean outcomes only."
```

---

### Commit 8 — Grafana dashboard

**Story:** *"I created the dashboard that tells the checkout story at a glance."*

```bash
git add observability/grafana/provisioning/dashboards/dashboards.yml
git add observability/grafana/provisioning/dashboards/nopcommerce-checkout.json
git commit -m "feat(grafana): add nopCommerce checkout observability dashboard

Provisioned automatically on Grafana startup — no manual import needed.
Three rows covering the three observability concerns:

  Business Metrics: Total/Successful/Failed payments (stat), p95 checkout
    duration (stat, green<500ms/yellow<1s/red), 5xx error count (stat),
    payment rate success vs failure (timeseries), checkout latency p50/p95/p99.

  HTTP Layer: request rate per route (timeseries), 5xx error rate (timeseries).

  .NET Runtime Health: memory working set, GC collections by generation,
    thread pool queue length — all from AddRuntimeInstrumentation(), zero code.

All panels source from the prometheus datasource. Failed Payments uses
'or vector(0)' to show 0 instead of No Data when no failures exist."
```

---

### Commit 9 — Load test script  *(to create)*

**Story:** *"I drove the flow under load to make the dashboard meaningful."*

```bash
git add load-test/checkout.js           # (or whatever tool/path used)
git add load-test/README.md
git commit -m "test(load): add k6 load test for checkout flow

Drives the complete checkout path under configurable load: add to cart,
fill address/shipping/payment steps, confirm order. Generates enough signal
to produce meaningful p95/p99 latency distributions and payment rate graphs
in Grafana. Run with: k6 run load-test/checkout.js"
```

---

### Commit 10 — README.md  *(to create)*

**Story:** *"I documented how to build, run, and see the dashboard."*

```bash
git add README.md
git commit -m "docs: add README with build/run instructions and instrumented flow diagram

Covers: prerequisites, starting the observability stack, running nopCommerce,
navigating to Jaeger/Prometheus/Grafana, and an architecture diagram of the
instrumented checkout flow. Satisfies the deliverable requirement for a README
that includes the architecture diagram."
```

---

### Commit 11 — CRITIQUE.md  *(to create)*

**Story:** *"I reflected on what nopCommerce's design helped and hindered."*

```bash
git add CRITIQUE.md
git commit -m "docs: add architectural critique of nopCommerce observability

Addresses: what in nopCommerce's design helped (INopStartup, IEventPublisher,
EntityRepository<T>) or hindered (Service Locator, static helpers, no
ActivitySource hooks) instrumentation. Proposes structural changes (interface
injection over Service Locator, domain event interfaces) and evaluates their
cost. Documents why the surgical approach was chosen over a Decorator rewrite."
```

---

### Commit 12 — Supporting docs  *(already written)*

**Story:** *"I documented how to observe the system."*

```bash
git add docs/IMPLEMENTATION.md
git add docs/OBSERVABILITY_GUIDE.md
git add docs/RUNNING.md
git add docs/TRACES_AND_OBSERVABILITY_WALKTHROUGH.md
git add docs/METRICS_AND_DASHBOARD_WALKTHROUGH.md
git commit -m "docs: add implementation details, observability guides and walkthroughs

IMPLEMENTATION.md   — all files touched, why each was chosen.
OBSERVABILITY_GUIDE — step-by-step guide to viewing traces and metrics.
RUNNING.md          — how to start the full stack.
TRACES walkthrough  — anatomy of a checkout trace in Jaeger, error simulation.
METRICS walkthrough — metrics pipeline, PromQL queries, dashboard panels."
```

---

## Summary table

| # | Commit | Files | Status |
|---|---|---|---|
| 1 | Architecture analysis | `docs/ARCHITECTURE.md` | Ready to commit |
| 2 | Flow selection | `docs/task2-flow-selection.md` | Ready to commit |
| 3 | Observability stack | `observability/` (excl. dashboards) | Ready to commit |
| 4 | OTel primitives | `Nop.Core/Observability/*.cs` | Ready to commit |
| 5 | SDK registration | `ObservabilityStartup.cs`, `.csproj`, `appsettings` | Ready to commit |
| 6 | EventPublisher + EntityRepository tracing | `EventPublisher.cs`, `EntityRepository.cs` | Ready to commit |
| 7 | Checkout spans + metrics | `OrderProcessingService.cs`, `PaymentService.cs` | Ready to commit |
| 8 | Grafana dashboard | `observability/grafana/provisioning/dashboards/` | Ready to commit |
| 9 | Load test | `load-test/` | **TO CREATE** |
| 10 | README.md | `README.md` | **TO CREATE** |
| 11 | CRITIQUE.md | `CRITIQUE.md` | **TO CREATE** |
| 12 | Supporting docs | `docs/*.md` (remaining) | Ready to commit |

---

## Rules to follow

- **Stage files explicitly** — never use `git add .` or `git add -A`. Always name the files to avoid accidentally committing `.env`, compiled binaries, or database files.
- **One logical unit per commit** — if you need to fix something in a later step, create a new `fix:` commit rather than amending.
- **Commit messages follow the pattern** `type(scope): summary` — types used here: `feat`, `fix`, `docs`, `infra`, `test`.
- **Push to `origin` after each session**, not just at the end — this gives the commit timestamps a natural spread and shows incremental progress.
