# Payment Observability

## 1. Context — Where Payment Lives in the Checkout Flow

The payment step is the single external boundary in the checkout flow: it is the only point where nopCommerce delegates work to a third-party plugin. It runs inside `PlaceOrderAsync` via `GetProcessPaymentResultAsync`, which calls `PaymentService.ProcessPaymentAsync`.

```
HTTP POST /checkout/confirm
  └─ CheckoutController.ConfirmOrder()
       └─ OrderProcessingService.PlaceOrderAsync()      [span: nop.order.place]
            └─ GetProcessPaymentResultAsync()
                 └─ PaymentService.ProcessPaymentAsync() [span: nop.payment.process]
                      └─ IPaymentMethod.ProcessPaymentAsync()   ← plugin boundary
```

`ProcessPaymentAsync` is the **only place** where execution crosses into an external payment plugin. Instrumenting here gives us the exact duration and outcome of the provider call, isolated from DB writes and inventory updates that happen before and after it in `PlaceOrderAsync`.

**Important scope note:** When `processPaymentRequest.OrderTotal == decimal.Zero`, the method returns immediately with `PaymentStatus.Paid` — no span is created and no metric is recorded. This is intentional: free orders (zero-value) do not involve a payment provider and generating a span for them would pollute the payment trace view with noise. See [Section 7](#7-out-of-scope) for more detail.

---

## 2. OpenTelemetry Concepts Used

### Span as child of order span
`nop.payment.process` is started while `Activity.Current` is `nop.order.place`. OTel's `ActivitySource.StartActivity` automatically makes the new span a **child** of the ambient current activity. This means payment spans appear nested under the order span in Jaeger — no explicit parent context passing is needed.

### Counter
`nop.payment.result` is a monotonically increasing counter tagged by `payment.method` and `payment.status`. It answers: *"Is the payment provider rejecting more requests than usual?"* — a question a plain request count cannot answer because it conflates success and failure.

### Error status on two paths
The payment implementation has **two distinct failure paths**:

1. **Exception path** — the plugin throws an unhandled exception (e.g. network timeout). The `catch` block marks the span as `Error` *before* re-throwing, ensuring the trace captures the failure even though the exception propagates up to `PlaceOrderAsync`.

2. **Business failure path** — the plugin returns `Success = false` (e.g. card declined). The span is marked `Error` after the call, with the concatenated error messages as the error description.

Both paths record `payment.status = "failure"` in the metric, so the counter correctly counts all failures regardless of how the plugin signals them.

### Sensitive data exclusion
`ProcessPaymentRequest` carries `CreditCardNumber`, `CreditCardCvv2`, `CreditCardExpireMonth`, `CreditCardExpireYear`, and `CreditCardName`. **None of these appear in span tags.** The instrumentation only records `payment.method` (the plugin system name, e.g. `"Payments.CheckMoneyOrder"`) and `payment.status`. This is a deliberate design decision: payment card data is PCI-DSS sensitive and must never appear in a trace backend.

---

## 3. The Zero-Amount Order Path

```csharp
if (processPaymentRequest.OrderTotal == decimal.Zero)
{
    var result = new ProcessPaymentResult { NewPaymentStatus = PaymentStatus.Paid };
    return result;  // ← span never started, metric never recorded
}
```

This early return exists for guest checkouts where the order total is covered entirely by a gift card, or for products with a zero price. The payment plugin is never called, so there is no external interaction to observe. Recording a span here would:

- Inflate payment success counts (making the `payment.status="success"` rate appear higher than the real provider success rate)
- Create misleading traces that show a payment span with no plugin call

The `nop.order.placed` counter in `OrderProcessingService` still fires for these orders (with `order.success="true"`), so they are visible in dashboard panels that track order volume — just not in the payment-specific panels.

---

## 4. Modified Files

### `src/Libraries/Nop.Core/Observability/NopMeter.cs`

Defines the instrument used by the payment subsystem:

```csharp
// Counts payment processing attempts, tagged by payment method and outcome.
// Tells an operator whether the payment provider is degrading — distinct from
// checkout failure rate, which includes failures for non-payment reasons.
public static readonly Counter<long> PaymentResult =
    _meter.CreateCounter<long>(
        name: "nop.payment.result",
        unit: "{attempt}",
        description: "Number of payment processing attempts by method and outcome.");
```

### `src/Libraries/Nop.Services/Payments/PaymentService.cs` — `ProcessPaymentAsync`

```csharp
public virtual async Task<ProcessPaymentResult> ProcessPaymentAsync(ProcessPaymentRequest processPaymentRequest)
{
    // Zero-value orders bypass payment entirely — no span, no metric
    if (processPaymentRequest.OrderTotal == decimal.Zero)
        return new ProcessPaymentResult { NewPaymentStatus = PaymentStatus.Paid };

    // CreditCardNumber sanitised here (whitespace/dash removal) — not recorded anywhere
    var paymentMethodName = processPaymentRequest.PaymentMethodSystemName;

    using var span = NopActivitySource.Source.StartActivity("nop.payment.process", ActivityKind.Internal);
    span?.SetTag("payment.method", paymentMethodName);

    ProcessPaymentResult paymentResult;
    try
    {
        paymentResult = await paymentMethod.ProcessPaymentAsync(processPaymentRequest);
    }
    catch (Exception ex)
    {
        // Exception path: mark span before re-throwing so the trace captures it
        span?.SetStatus(ActivityStatusCode.Error, ex.Message);
        NopMeter.PaymentResult.Add(1,
            new KeyValuePair<string, object>("payment.method", paymentMethodName),
            new KeyValuePair<string, object>("payment.status", "failure"));
        throw;
    }

    var status = paymentResult.Success ? "success" : "failure";
    span?.SetTag("payment.status", status);
    if (!paymentResult.Success)
        span?.SetStatus(ActivityStatusCode.Error, string.Join("; ", paymentResult.Errors));

    NopMeter.PaymentResult.Add(1,
        new KeyValuePair<string, object>("payment.method", paymentMethodName),
        new KeyValuePair<string, object>("payment.status", status));

    return paymentResult;
}
```

---

## 5. Spans and Metrics Reference

### Span: `nop.payment.process`

| Tag | Type | When set | Example values |
|---|---|---|---|
| `payment.method` | string | start of span | `"Payments.CheckMoneyOrder"`, `"Payments.Manual"` |
| `payment.status` | string | end of span | `"success"` / `"failure"` |

When `payment.status = "failure"`, the span status is set to `Error` with the provider's error messages as the description.

**What is intentionally absent:**
- `payment.order_total` — financial data, PCI-DSS sensitive
- `payment.card_number`, `payment.cvv`, `payment.card_holder` — card data, never emitted
- `payment.customer_id` — PII; customer identity is already in the parent `nop.order.place` span if needed for debugging (via `order.id`)

### Metric: `nop.payment.result`

| Property | Value |
|---|---|
| Prometheus name | `nopcommerce_nop_payment_result_total` |
| Type | Counter |
| Tags | `payment_method`, `payment_status` |

**Operational use:**

| Query | Answers |
|---|---|
| `rate(nopcommerce_nop_payment_result_total[5m])` | Current payment throughput |
| `rate(...{payment_status="failure"}[5m]) / rate(...[5m])` | Real-time payment failure rate |
| `sum by(payment_method) (rate(...{payment_status="failure"}[5m]))` | Which payment method is failing most |

---

## 6. Grafana Dashboard Panels

The following panels in dashboard `1 — Checkout Business KPIs` cover the payment subsystem:

| Panel | Type | What it shows | When actionable |
|---|---|---|---|
| Total Payments | Stat | Cumulative count in selected window | Drops to zero → checkout pipeline broken |
| Successful Payments | Stat | Count with `payment_status="success"` | Sustained decline → provider degrading |
| Failed Payments | Stat | Count with `payment_status="failure"` | Any non-zero → investigate provider |
| Payment Rate — Success vs Failure | Timeseries | `rate(...)` split by `payment_status` | Rising failure rate → payment gateway issue |

The trace panel in the same dashboard (`Recent Order Placement Traces`) shows `nop.payment.process` as a child span. Clicking into a trace shows the payment result and duration relative to the rest of the order flow.

---

## 7. Out of Scope

- **Zero-amount orders** — free orders return `PaymentStatus.Paid` before reaching the plugin. No span is created. This is correct behaviour: there is no payment operation to observe, and including these would corrupt the payment success rate metric.
- **`PostProcessPaymentAsync`** — used only by redirect-based payment gateways (e.g. PayPal). In the primary checkout flow (in-process payment methods like Check/Money Order), this method is a no-op. Adding a span here would only add noise for the common case; it would be worth adding if a redirect gateway were the primary payment method in production.
- **`CancelRecurringPaymentAsync` / `RefundAsync` / `VoidAsync`** — post-order payment lifecycle operations that are outside the "customer places an order" flow scope.
- **Payment plugin duration** — see Section 8.

---

## 8. Recommended Addition: `nop.payment.duration` Histogram

### The gap

`nop.checkout.duration` records the end-to-end latency of `PlaceOrderAsync`, which includes DB writes (Order, OrderItems), inventory adjustments, and event publishing in addition to the payment call. It is **not possible** to isolate payment provider latency from the checkout duration histogram alone.

### Why it matters

Consider a latency spike at 2am: `nop.checkout.duration` p99 doubles to 4 seconds. Without payment duration, the on-call engineer must check each child span individually in Jaeger to determine the root cause. With `nop.payment.duration`:

- If payment p99 spikes and checkout p99 spikes together → payment gateway is slow
- If checkout p99 spikes but payment p99 is flat → look at DB write spans or inventory adjustment

This is exactly the kind of metric the assignment guideline describes: *"This metric would tell an operator that the checkout pipeline is degrading before users start seeing errors."*

### How it would be implemented

```csharp
// In NopMeter.cs — one new instrument
public static readonly Histogram<double> PaymentDuration =
    _meter.CreateHistogram<double>(
        name: "nop.payment.duration",
        unit: "ms",
        description: "Duration of the payment provider call in milliseconds, by method and outcome.");
```

```csharp
// In PaymentService.ProcessPaymentAsync — a Stopwatch around the plugin call
var sw = Stopwatch.StartNew();
try
{
    paymentResult = await paymentMethod.ProcessPaymentAsync(processPaymentRequest);
}
catch (Exception ex) { /* ... existing error handling ... */ }
sw.Stop();

NopMeter.PaymentDuration.Record(sw.Elapsed.TotalMilliseconds,
    new KeyValuePair<string, object>("payment.method", paymentMethodName),
    new KeyValuePair<string, object>("payment.status", status));
```

The change touches **two lines** of existing code (one new `Stopwatch`, one metric record after the existing counter). It does not alter the span, the error handling, or the metric already in place.

### Dashboard panel to add (Dashboard 1)

| Panel | Type | PromQL | Placement |
|---|---|---|---|
| Payment Duration — p50/p95/p99 | Timeseries | `histogram_quantile(0.95, sum by(le) (rate(nopcommerce_nop_payment_duration_milliseconds_bucket[5m])))` | After "Payment Rate" panel |

---

## 9. Use Cases and How to Simulate

### Case A — Successful payment (Check / Money Order)

**Setup:** any product with stock, `Payments.CheckMoneyOrder` as payment method.

**Steps:** complete checkout normally.

**Expected in Jaeger:** span `nop.payment.process` with `payment.method="Payments.CheckMoneyOrder"`, `payment.status="success"`. It appears as a child of `nop.order.place` with a short duration (the plugin immediately returns `PaymentStatus.Pending` without any I/O).

**Expected in Grafana:** `nop.payment.result` counter increments with `payment_status="success"`. "Successful Payments" stat panel increases. "Payment Rate" timeseries shows a brief spike in the success series.

---

### Case B — Payment plugin returns failure

**Setup:** use the `Payments.Manual` plugin (Manual Payment Processor, available in nopCommerce). Configure it to return `Pending` initially. In code, temporarily modify the plugin to return `Success = false` with an error message, or use a custom test plugin.

**Expected in Jaeger:** span `nop.payment.process` marked as `Error`, `payment.status="failure"`. Parent span `nop.order.place` is also `Error` because `GetProcessPaymentResultAsync` returns a failed `ProcessPaymentResult`. No `db.insert Order` span appears (order is not persisted on payment failure).

**Expected in Grafana:** "Failed Payments" stat panel increments (turns red). "Payment Rate" timeseries shows a spike in the failure series.

---

### Case C — Zero-value order (no span)

**Setup:** product with price = 0, or a 100% gift card applied to cover the order total.

**Expected in Jaeger:** `nop.order.place` span exists, but **no `nop.payment.process` child span**. This is correct — look for `db.insert Order` as the first meaningful child.

**Expected in Grafana:** `nop.order.placed` counter increments. `nop.payment.result` counter does **not** change. The "Total Payments" panel stays the same while "Orders Placed" increases — the delta is your free-order volume.

---

### Case D — Payment plugin throws exception

**Setup:** simulate a database or network timeout inside a payment plugin.

**Expected in Jaeger:** `nop.payment.process` span status `Error` with the exception message. The span ends immediately when the exception is caught (before re-throw). Parent `nop.order.place` also fails because `GetProcessPaymentResultAsync` propagates the exception up through `placeOrder`.

**Note:** the exception propagates up through `placeOrder`, which catches it and adds it to `result.Errors`. The outer span in `PlaceOrderAsync` then sets its own `Error` status based on `finalResult.Success`. Both spans end up as `Error` in the trace tree.

---

## 10. Verification Checklist

1. Start the stack: `docker compose -f observability/docker-compose.observability.yml up -d`
2. Start the app: `cd src/Presentation/Nop.Web && dotnet run --urls "http://localhost:5000"`
3. Complete a checkout with `Payments.CheckMoneyOrder`.
4. In **Jaeger** (`http://localhost:16686`): find service `nopcommerce`, operation `nop.payment.process`. Verify:
   - Tags `payment.method` and `payment.status` are present.
   - No credit card data, no `order.total`, no customer email in any tag.
   - Span appears nested under `nop.order.place` (same trace ID).
5. In **Prometheus** (`http://localhost:9090`): query `nopcommerce_nop_payment_result_total` — confirm a series with `payment_status="success"` exists.
6. In **Grafana** (`http://localhost:3000`), dashboard `1 — Checkout Business KPIs`:
   - "Total Payments" and "Successful Payments" stats show non-zero.
   - "Payment Rate — Success vs Failure" timeseries shows a brief spike in the success series.
7. To test Case B: use a plugin that returns `Success = false`. Verify "Failed Payments" stat turns red.
8. To test Case C: checkout with a zero-price product. Verify `nop.payment.process` does **not** appear in the trace.
