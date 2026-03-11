# Order Observability

## 1. Context — Where Order Lives in the Checkout Flow

The order placement is the central operation of the checkout flow. It orchestrates payment, persistence, inventory adjustment, and post-order notifications. The call chain is:

```
HTTP POST /checkout/confirm
  └─ CheckoutController.ConfirmOrder()
       └─ OrderProcessingService.PlaceOrderAsync()      [span: nop.order.place]
            ├─ PreparePlaceOrderDetailsAsync()           [outside span — validation only]
            ├─ GetProcessPaymentResultAsync()
            │    └─ PaymentService.ProcessPaymentAsync() [span: nop.payment.process]
            ├─ SaveOrderDetailsAsync()
            │    └─ EntityRepository.InsertAsync()       [span: db.insert Order]
            ├─ MoveShoppingCartItemsToOrderItemsAsync()
            │    └─ EntityRepository.InsertAsync()       [span: db.insert OrderItem] (x N items)
            │    └─ ProductService.AdjustInventoryAsync() [span: nop.inventory.adjust] (x N items)
            ├─ SaveDiscountUsageHistoryAsync()
            ├─ SaveGiftCardUsageHistoryAsync()
            ├─ SendNotificationsAndSaveNotesAsync()
            └─ EventPublisher.PublishAsync(OrderPlacedEvent) [span: event OrderPlacedEvent]
```

`PlaceOrderAsync` is the **top-level service boundary** for the order flow: it is the single entry point that coordinates all downstream operations. Instrumenting here gives us the full end-to-end duration and outcome of a checkout attempt, with all child operations visible as nested spans in the same trace.

**Important scope note:** `PreparePlaceOrderDetailsAsync` (cart validation, total calculation, coupon verification) runs *before* the span starts. Early failures here — such as an empty cart or an invalid payment method — are not captured by `nop.order.place`. This is an intentional trade-off: those validations are pure business logic, and the instrumentation boundary is kept at the point where actual work begins.

---

## 2. OpenTelemetry Concepts Used

### Span and root context
A **span** represents a unit of work with a start time, end time, status, and a set of key-value attributes (tags). The span `nop.order.place` is the **root business span** of the checkout flow — it is typically a child of the ASP.NET Core HTTP span (`POST /checkout/confirm`) which is created automatically by `AddAspNetCoreInstrumentation`. All downstream spans (payment, DB writes, inventory, events) inherit the trace context via `Activity.Current` and appear as children in Jaeger.

### Counter
A **counter** is a monotonically increasing instrument — it only ever goes up. `nop.order.placed` counts order placement attempts. It is the right instrument for rate queries in Prometheus (`rate(...[1m])`) and for alerting on sudden drops in order volume (a drop to zero means checkout is broken).

### Histogram
A **histogram** samples a continuous value and buckets the observations so that percentiles (p50, p95, p99) can be computed at query time. `nop.checkout.duration` records the end-to-end duration in milliseconds of `PlaceOrderAsync`. This lets us answer "what does a slow checkout look like at p99?" — a question a counter cannot answer.

### Tags / Attributes
Tags are dimensions attached to a span or metric. `payment.method` allows filtering and aggregation per payment plugin without separate metric series. `order.success` lets Grafana separate successful from failed checkouts in the same panel.

### Error status
When `placeOrder` fails (either via exception or via `processPaymentResult.Success == false`), the `catch` block and the post-execution check call `span?.SetStatus(ActivityStatusCode.Error, ...)`. This propagates the error up the trace tree so Jaeger marks the span as failed, enabling alert rules on span error rate.

---

## 3. The Two Execution Paths

nopCommerce supports two modes for order placement, controlled by `_orderSettings.PlaceOrderWithLock`:

| Mode | Description | When used |
|---|---|---|
| `PlaceOrderWithLock = false` | Direct async call to `placeOrder()` | Default — no concurrency protection |
| `PlaceOrderWithLock = true` | Wraps `placeOrder()` in a named `Mutex` per customer, with a cache-based rate limit | When `MinimumOrderPlacementInterval` is configured to prevent duplicate orders |

Both paths are covered by the same span — the mutex wait time is included in `nop.checkout.duration`, which means high lock contention (multiple concurrent checkouts by the same customer) is visible as latency spikes in the histogram.

---

## 4. Modified Files

### `src/Libraries/Nop.Core/Observability/NopMeter.cs`

Defines two instruments used by the order subsystem:

```csharp
// Counts payment processing attempts, tagged by payment method and outcome.
// Used as a proxy for order placement rate before nop.order.placed was added.
public static readonly Counter<long> PaymentResult =
    _meter.CreateCounter<long>("nop.payment.result", unit: "{attempt}", ...);

// Records the end-to-end duration of PlaceOrderAsync, tagged by payment method and outcome.
public static readonly Histogram<double> CheckoutDuration =
    _meter.CreateHistogram<double>("nop.checkout.duration", unit: "ms", ...);

// Counts order placement attempts, tagged by payment method and outcome.
// Explicit counter for direct "orders per minute" and "order failure rate" panels.
public static readonly Counter<long> OrderPlaced =
    _meter.CreateCounter<long>("nop.order.placed", unit: "{order}", ...);
```

### `src/Libraries/Nop.Services/Orders/OrderProcessingService.cs` — `PlaceOrderAsync`

```csharp
public virtual async Task<PlaceOrderResult> PlaceOrderAsync(ProcessPaymentRequest processPaymentRequest)
{
    // ... argument validation and PreparePlaceOrderDetailsAsync() — outside span ...

    var paymentMethodName = processPaymentRequest.PaymentMethodSystemName;
    var sw = Stopwatch.StartNew();

    using var span = NopActivitySource.Source.StartActivity("nop.order.place", ActivityKind.Internal);
    span?.SetTag("payment.method", paymentMethodName);

    PlaceOrderResult finalResult;

    // ... PlaceOrderWithLock logic calls placeOrder(details) ...

    sw.Stop();
    var orderSuccess = finalResult.Success.ToString().ToLower();
    span?.SetTag("order.success", orderSuccess);
    span?.SetTag("order.items_count", details.Cart.Count);
    if (finalResult.PlacedOrder != null)
        span?.SetTag("order.id", finalResult.PlacedOrder.Id);
    if (!finalResult.Success)
        span?.SetStatus(ActivityStatusCode.Error, string.Join("; ", finalResult.Errors));

    NopMeter.CheckoutDuration.Record(sw.Elapsed.TotalMilliseconds,
        new KeyValuePair<string, object>("payment.method", paymentMethodName),
        new KeyValuePair<string, object>("order.success", orderSuccess));

    NopMeter.OrderPlaced.Add(1,
        new KeyValuePair<string, object>("payment.method", paymentMethodName),
        new KeyValuePair<string, object>("order.success", orderSuccess));

    return finalResult;
}
```

---

## 5. Spans and Metrics Reference

### Span: `nop.order.place`

| Tag | Type | When set | Values |
|---|---|---|---|
| `payment.method` | string | start of span | e.g. `"Payments.CheckMoneyOrder"`, `"Payments.Manual"` |
| `order.success` | string | end of span | `"true"` / `"false"` |
| `order.id` | int | end of span (success only) | Order database ID |
| `order.items_count` | int | end of span | Number of line items in the order |

When `order.success = "false"`, the span status is set to `Error` with the concatenated error messages.

### Metrics

| Metric | Prometheus name | Type | Tags |
|---|---|---|---|
| `nop.checkout.duration` | `nopcommerce_nop_checkout_duration` | Histogram | `payment_method`, `order_success` |
| `nop.order.placed` | `nopcommerce_nop_order_placed_total` | Counter | `payment_method`, `order_success` |

> **Note:** `nop.checkout.duration` already exposes a `_count` series in Prometheus which can serve as an order counter (`rate(nopcommerce_nop_checkout_duration_count[1m])`). The explicit `nop.order.placed` counter is added for dashboard readability — a panel titled "Orders per Minute" sourced from a counter named `order_placed` is self-documenting in a way that `checkout_duration_count` is not.

> **Sensitive data note:** `order.total` (the monetary value of the order) is deliberately excluded from span tags. Order totals are financially sensitive data that must not appear in trace backends. An OTel processor could sanitise this at the collector level, but the simpler and safer approach is to never emit it.

---

## 6. Grafana Dashboard Panels

The Grafana dashboard (`nopcommerce-checkout`) contains order-related panels:

| Panel | Type | What it shows | PromQL |
|---|---|---|---|
| Checkout Success Rate | Stat | % of successful order placements | `rate(...{order_success="true"}[5m]) / rate(...[5m])` |
| Checkout Duration — p50/p95/p99 | Timeseries | Latency percentiles of PlaceOrderAsync | `histogram_quantile(0.99, rate(nopcommerce_nop_checkout_duration_bucket[5m]))` |
| Orders Placed per Minute | Timeseries | Order placement rate by outcome | `rate(nopcommerce_nop_order_placed_total[1m])` |
| Order Error Rate | Timeseries | Rate of failed order placements | `rate(...{order_success="false"}[5m])` |

---

## 7. Use Cases and How to Simulate

### Case A — Successful checkout

**Setup:** any product with available stock, `Payments.CheckMoneyOrder` payment method.

**Steps:**
1. Add product to cart → proceed to checkout → confirm order.

**Expected in Jaeger:** span `nop.order.place` with `order.success=true`, `order.id=<N>`. Child spans visible: `nop.payment.process`, `db.insert Order`, `db.insert OrderItem`, `nop.inventory.adjust`, `event OrderPlacedEvent`.

**Expected in Grafana:** `nop.checkout.duration` histogram records a new observation; `nop.order.placed` counter increments with `order_success="true"`.

---

### Case B — Payment failure

**Setup:** configure a payment plugin that returns a failure result (or use a test plugin that rejects the payment).

**Steps:** complete checkout with the failing payment method.

**Expected in Jaeger:** span `nop.order.place` with `order.success=false`, span status `Error`. Child span `nop.payment.process` also marked as `Error`. No `db.insert Order` span (order is not saved on payment failure).

**Expected in Grafana:** `nop.checkout.duration` histogram records the duration with `order_success="false"`; error rate panel increases.

---

### Case C — Duplicate order prevention (PlaceOrderWithLock)

**Setup:** enable `PlaceOrderWithLock` in admin settings and set `MinimumOrderPlacementInterval` to e.g. 30 seconds.

**Steps:** submit the checkout form twice in rapid succession.

**Expected in Jaeger:** first attempt has `order.success=true`. Second attempt within the interval has `order.success=false` with error message "Minimum order placement interval is not reached yet". The mutex wait time is included in the `nop.checkout.duration` histogram for both attempts.

**Operational significance:** a spike in failed orders with this specific error in production indicates users double-clicking the "Place Order" button, which could indicate a slow response prompting impatient retries — the `p99` of `nop.checkout.duration` is the first metric to check.

---

### Case D — Multi-item order

**Setup:** add 3 different products to the cart, complete checkout.

**Expected in Jaeger:** span `nop.order.place` with `order.items_count=3` **[after tag is added]**. Three `db.insert OrderItem` child spans and three `nop.inventory.adjust` child spans visible in the trace.

**Operational significance:** `order.items_count` as a span tag enables queries like "show me all traces where an order had more than 10 items and checkout took over 2 seconds" — useful for diagnosing whether latency scales with order size.

---

### Case E — Checkout exception (unexpected error)

**Setup:** simulate an unhandled exception in `placeOrder` (e.g. database unavailable).

**Expected in Jaeger:** span `nop.order.place` with status `Error` and the exception message in the error description. The exception is also logged via `_logger.ErrorAsync` before the span captures it.

**Note:** the `catch` block inside `placeOrder` adds the error to `result.Errors` but does not rethrow. The span error status is set in the outer method based on `finalResult.Success`. This means the trace correctly reflects the failure without the span propagating an unhandled exception.

---

## 8. Out of Scope

- **`PreparePlaceOrderDetailsAsync`** — cart validation, coupon verification, total calculation. Failures here return before the span is created, so they are not captured. Adding a span here would require wrapping business logic, which violates the surgical instrumentation principle.
- **`CheckOrderStatusAsync` / `ProcessOrderPaidAsync`** — post-placement status transitions called within `placeOrder`. Their latency is captured within the parent `nop.order.place` span. They are part of the happy path and do not warrant separate spans.
- **`PlaceOrderAsync` for recurring orders** — the recurring order path goes through `PrepareRecurringOrderDetailsAsync` instead of `PreparePlaceOrderDetailsAsync`. It follows a different code path and is outside the scope of the primary "customer places an order" flow.
- **`order.total` as a span tag** — financial data, excluded for sensitive data compliance.

---

## 9. Instrumentation Changelog

| What | Where | Why |
|---|---|---|
| Tag `order.items_count` | `OrderProcessingService.PlaceOrderAsync` | Correlate order size with latency |
| Counter `nop.order.placed` | `NopMeter.cs` + `OrderProcessingService.PlaceOrderAsync` | Explicit order rate and failure rate panels in Grafana |

---

## 10. Verification Checklist

1. Restart app: `cd src/Presentation/Nop.Web && ASPNETCORE_ENVIRONMENT=Development dotnet run`
2. Complete a checkout with any available product.
3. In **Jaeger** (`http://localhost:16686`): find service `nopcommerce`, operation `nop.order.place`. Verify:
   - Tags `payment.method`, `order.success`, `order.id` are present.
   - Child spans `nop.payment.process`, `db.insert Order`, `db.insert OrderItem`, `nop.inventory.adjust`, `event OrderPlacedEvent` are visible.
4. In **Prometheus** (`http://localhost:9090`): query `nopcommerce_nop_checkout_duration_count` — confirm it increments after each checkout.
5. In **Grafana** (`http://localhost:3000`): open the "nopCommerce — Checkout Observability" dashboard:
   - "Checkout Duration — p50/p95/p99" shows a data point after the first checkout.
   - "Checkout Success Rate" shows 100% after a successful checkout.
6. To test Case B: use a payment plugin configured to fail, or temporarily return `Success = false` from a test plugin.
7. To test Case C: enable `PlaceOrderWithLock`, set `MinimumOrderPlacementInterval = 60`, submit the form twice. Second attempt should show `order.success=false` in Jaeger.
