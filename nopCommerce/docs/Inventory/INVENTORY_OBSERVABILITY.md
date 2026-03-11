# Inventory Observability

## 1. Context — Where Inventory Lives in the Checkout Flow

The inventory adjustment happens deep inside the order placement pipeline. When a customer completes checkout, the call chain is:

```
HTTP POST /checkout/confirm
  └─ CheckoutController.ConfirmOrder()
       └─ OrderProcessingService.PlaceOrderAsync()          [span: nop.order.place]
            └─ MoveShoppingCartItemsToOrderItemsAsync()
                 └─ ProductService.AdjustInventoryAsync()   [span: nop.inventory.adjust]
```

`AdjustInventoryAsync` is the **service boundary** for inventory: it is the single entry point that decrements stock regardless of which inventory management mode is in use. Instrumenting here gives us one trace span and two metrics that cover all inventory paths without duplicating instrumentation in lower-level helpers.

---

## 2. OpenTelemetry Concepts Used

### Span and parent-child context
A **span** represents a unit of work with a start time, end time, status, and a set of key-value attributes (tags). The span `nop.inventory.adjust` is always a **child** of `nop.order.place`: the OTel SDK propagates the active context through async call chains automatically via `Activity.Current`. In Jaeger you can expand the `nop.order.place` root span to see the inventory child span nested beneath it.

### Counter
A **counter** is a monotonically increasing instrument — it only ever goes up. It is the right choice for counting discrete events ("how many inventory adjustments happened?"). Counters are exported as `_total` suffix in Prometheus (e.g. `nopcommerce_nop_inventory_adjustment_total`).

### Histogram
A **histogram** samples a continuous value (e.g. stock quantity remaining) and buckets the observations so that percentiles (p50, p95, p99) can be computed at query time. This lets us answer "what is the *distribution* of remaining stock across all sold products?" — a question a counter cannot answer.

### Tags / Attributes
Tags are dimensions attached to a span or metric. They allow filtering and aggregation in Prometheus/Grafana without requiring separate metric series per product. For example, `inventory_method="ManageStock"` lets an operator see the adjustment rate for simple-stock products independently of attribute-combination products.

### Error status
When `AdjustInventoryAsync` throws an unhandled exception, the `catch` block calls `span?.SetStatus(ActivityStatusCode.Error, ex.Message)`. This propagates the error up the trace tree so Jaeger marks the root `nop.order.place` span as failed, enabling alert rules on span error rate.

---

## 3. The Three Inventory Management Modes

nopCommerce supports three modes, configured per product in the admin panel under **Catalog → Products → Inventory**:

| Mode | How stock is tracked | When `stockAdjusted` is `true` |
|---|---|---|
| `ManageStock` | Single integer `Product.StockQuantity` (or per-warehouse via `ProductWarehouseInventory`) | Always — stock is always decremented/incremented |
| `ManageStockByAttributes` | Per `ProductAttributeCombination.StockQuantity` (e.g. S/M/L × Blue/Red) | Only when the matching combination is found |
| `DontManageStock` | No stock tracking (digital downloads, gift cards, services) | Never |

---

## 4. Modified Files

### `src/Libraries/Nop.Core/Observability/NopMeter.cs`

Defines three instruments used by the inventory subsystem:

```csharp
// Counts every call to AdjustInventoryAsync, tagged by method, low-stock outcome, and whether stock was actually changed.
public static readonly Counter<long> InventoryAdjustment =
    _meter.CreateCounter<long>("nop.inventory.adjustment", unit: "{adjustment}", ...);

// Samples the stock quantity remaining after each adjustment (only when stock is trackable).
public static readonly Histogram<long> StockRemaining =
    _meter.CreateHistogram<long>("nop.inventory.stock_remaining", unit: "{unit}", ...);

// Fires when stock hits zero — the exact moment a product becomes unavailable for sale.
public static readonly Counter<long> StockOut =
    _meter.CreateCounter<long>("nop.inventory.stockout", unit: "{event}", ...);
```

### `src/Libraries/Nop.Services/Catalog/ProductService.cs` — `AdjustInventoryAsync`

The method tracks a `stockAdjusted` boolean that starts `false` and is set to `true` only in the two paths where stock is actually modified:

```csharp
public virtual async Task AdjustInventoryAsync(Product product, int quantityToChange, ...)
{
    var lowStockNotified = false;
    var stockAdjusted = false;   // tracks whether stock was actually changed
    long? stockAfter = null;

    using var span = NopActivitySource.Source.StartActivity("nop.inventory.adjust", ActivityKind.Internal);
    span?.SetTag("product.id", product.Id);
    span?.SetTag("inventory.quantity_change", quantityToChange);
    span?.SetTag("inventory.method", product.ManageInventoryMethod.ToString());

    try
    {
        if (product.ManageInventoryMethod == ManageInventoryMethod.ManageStock)
        {
            span?.SetTag("inventory.multi_warehouse", product.UseMultipleWarehouses);
            // ... warehouse logic ...
            var totalStock = await GetTotalStockQuantityAsync(product);
            stockAfter = totalStock;
            stockAdjusted = true;   // stock was decremented
            // ... low-stock notification ...
        }

        if (product.ManageInventoryMethod == ManageInventoryMethod.ManageStockByAttributes)
        {
            var combination = await _productAttributeParser.FindProductAttributeCombinationAsync(product, attributesXml);
            span?.SetTag("inventory.combination_found", combination != null);

            if (combination != null)
            {
                combination.StockQuantity += quantityToChange;
                await _productAttributeService.UpdateProductAttributeCombinationAsync(combination);
                stockAfter = combination.StockQuantity;
                stockAdjusted = true;   // combination found — stock was decremented
                // ... low-stock notification ...
            }
            // if combination == null: stockAdjusted remains false
        }

        // DontManageStock: stockAdjusted remains false

        // bundled products (recursive call for associated products)
        // ...

        // emit tags and metrics
        if (stockAfter.HasValue)
            span?.SetTag("inventory.stock_after", stockAfter.Value);
        span?.SetTag("inventory.low_stock_notified", lowStockNotified.ToString().ToLower());
        span?.SetTag("inventory.stock_adjusted", stockAdjusted);

        NopMeter.InventoryAdjustment.Add(1,
            new KeyValuePair<string, object>("inventory.method", product.ManageInventoryMethod.ToString()),
            new KeyValuePair<string, object>("inventory.low_stock_notified", lowStockNotified.ToString().ToLower()),
            new KeyValuePair<string, object>("inventory.stock_adjusted", stockAdjusted.ToString().ToLower()));

        if (stockAfter.HasValue)
        {
            NopMeter.StockRemaining.Record(stockAfter.Value,
                new KeyValuePair<string, object>("inventory.method", product.ManageInventoryMethod.ToString()));

            if (stockAfter.Value <= 0)
                NopMeter.StockOut.Add(1,
                    new KeyValuePair<string, object>("inventory.method", product.ManageInventoryMethod.ToString()));
        }
    }
    catch (Exception ex)
    {
        span?.SetStatus(ActivityStatusCode.Error, ex.Message);
        throw;
    }
}
```

---

## 5. Spans and Metrics Reference

### Span: `nop.inventory.adjust`

| Tag | Type | Values |
|---|---|---|
| `product.id` | int | Product database ID |
| `inventory.method` | string | `ManageStock` / `ManageStockByAttributes` / `DontManageStock` |
| `inventory.quantity_change` | int | Negative for deductions (e.g. `-1`), positive for returns |
| `inventory.stock_after` | long | Stock remaining after adjustment (absent for `DontManageStock` and combination-not-found) |
| `inventory.low_stock_notified` | bool | `true` if admin email was sent |
| `inventory.stock_adjusted` | bool | `true` if stock was actually changed; `false` for `DontManageStock` or missing combination |
| `inventory.multi_warehouse` | bool | `true` if product uses multi-warehouse (only when `ManageStock`) |
| `inventory.combination_found` | bool | Whether the attribute combination matched (only when `ManageStockByAttributes`) |

### Metrics

| Metric | Prometheus name | Type | Tags |
|---|---|---|---|
| `nop.inventory.adjustment` | `nopcommerce_nop_inventory_adjustment_total` | Counter | `inventory_method`, `inventory_low_stock_notified`, `inventory_stock_adjusted` |
| `nop.inventory.stock_remaining` | `nopcommerce_nop_inventory_stock_remaining` | Histogram | `inventory_method` |
| `nop.inventory.stockout` | `nopcommerce_nop_inventory_stockout_total` | Counter | `inventory_method` |

> **Note on `inventory_stock_adjusted` in Prometheus:** the label value is `"true"` or `"false"` (lowercase string). Use `{inventory_stock_adjusted="false"}` to filter adjustments that did not change stock.

---

## 6. Grafana Dashboard Panels

The Grafana dashboard (`nopcommerce-checkout`) contains five inventory-related panels:

| Panel | Type | What it shows |
|---|---|---|
| Inventory Adjustments by Method | Timeseries | Rate of adjustments per second, split by `inventory_method` |
| Low-Stock Alerts Triggered | Stat | Total adjustments that fired a low-stock notification |
| Stock Remaining — p50/p95/p99 | Timeseries | Distribution of remaining stock after each sale |
| Adjustments Without Stock Change | Stat | Total adjustments where `inventory_stock_adjusted=false` |
| Stock-Outs | Stat | Total times stock reached zero |

---

## 7. Use Cases and How to Simulate

### Case A — Normal checkout (ManageStock)

**Setup:** product with `ManageInventoryMethod = ManageStock`, `StockQuantity = 10`.

**Steps:**
1. Add product to cart → checkout → confirm with manual payment method.

**Expected in Jaeger:** span `nop.inventory.adjust` with `inventory.method=ManageStock`, `inventory.stock_adjusted=true`, `inventory.stock_after=9`.

**Expected in Grafana:** `nop.inventory.adjustment` counter increments; `nop.inventory.stock_remaining` histogram records `9`.

---

### Case B — Low-stock trigger

**Setup:** product with `StockQuantity = 1`, `NotifyAdminForQuantityBelow = 2`.

**Steps:** buy the last unit.

**Expected:** `inventory.low_stock_notified=true`; admin receives email.

**Expected in Grafana:** "Low-Stock Alerts Triggered" panel increments.

---

### Case C — ManageStockByAttributes (combination found)

**Setup:** product with attribute combinations (e.g. Size × Colour), combination Blue/M with `StockQuantity = 5`.

**Steps:** add Blue/M variant to cart → checkout.

**Expected:** span with `inventory.combination_found=true`, `inventory.stock_adjusted=true`, `inventory.stock_after=4`.

---

### Case D — ManageStockByAttributes (combination NOT found)

**Setup:** product with attribute combinations but cart item has mismatched attributes (e.g. attributes were deleted after order was placed, or a data integrity issue).

**Expected:** span with `inventory.combination_found=false`, `inventory.stock_adjusted=false`.

**Expected in Grafana:** "Adjustments Without Stock Change" panel increments. A non-zero value here in production signals a product configuration error that requires investigation.

---

### Case E — DontManageStock (digital product)

**Setup:** downloadable product or gift card with `ManageInventoryMethod = DontManageStock`.

**Steps:** purchase the product.

**Expected:** span with `inventory.method=DontManageStock`, `inventory.stock_adjusted=false`. No histogram observation is recorded (there is no stock quantity to track).

**Expected in Grafana:** `nop.inventory.adjustment` counter increments but `nop.inventory.stock_remaining` histogram does not.

---

### Case F — Bundle product (recursion)

**Setup:** product with an attribute value of type `AssociatedToProduct` (bundle component).

**Steps:** purchase the bundle.

**Expected:** two spans `nop.inventory.adjust` — one for the parent product, one for the associated (child) product. The child span is nested under the parent span in Jaeger because `AdjustInventoryAsync` calls itself recursively and `Activity.Current` propagates the trace context.

---

### Case G — Stock-out (last unit)

**Setup:** product with `ManageInventoryMethod = ManageStock`, `StockQuantity = 1`.

**Steps:** buy the only available unit.

**Expected:** span with `inventory.stock_after=0`. If `NotifyAdminForQuantityBelow > 0`, also `inventory.low_stock_notified=true`. `nop.inventory.stockout` counter increments.

**Expected in Grafana:** "Stock-Outs" panel shows 1; product becomes unavailable on the storefront.

**Operational significance:** unlike `low_stock_notified` (which fires *before* the last unit is sold), `stockout` fires at the *exact moment* the product can no longer be sold. An on-call engineer seeing `nop.inventory.stockout` at 2am knows a product just became unavailable and can act immediately (hide from catalogue, activate back-order, contact supplier).

---

## 8. Out of Scope

- **`ReserveInventoryAsync` / `UnblockReservedInventoryAsync`** — these are sub-operations called from within `AdjustInventoryAsync` when multi-warehouse is enabled. Their latency is captured by the parent `nop.inventory.adjust` span. Adding child spans here would add noise without operational value.
- **`ReverseBookedInventoryAsync`** — belongs to the order cancellation flow, which is outside the scope of the instrumented flow ("Customer places an order").
- **`BookReservedInventoryAsync`** — called from the warehouse booking flow, not from `AdjustInventoryAsync`.

---

## 9. Verification Checklist

1. Restart app: `cd src/Presentation/Nop.Web && ASPNETCORE_ENVIRONMENT=Development dotnet run`
2. Complete a checkout with a `ManageStock` product.
3. In **Jaeger** (`http://localhost:16686`): find service `nopcommerce`, operation `nop.order.place`. Expand the trace — `nop.inventory.adjust` should appear as a child span with all tags listed in §5.
4. In **Prometheus** (`http://localhost:9090`): query `nopcommerce_nop_inventory_adjustment_total` — confirm the `inventory_stock_adjusted` label is present with value `"true"`.
5. In **Grafana** (`http://localhost:3000`): open the "nopCommerce — Checkout Observability" dashboard:
   - "Stock Remaining — p50/p95/p99" shows data after the first checkout.
   - "Adjustments Without Stock Change" shows `0` (no misconfigured products).
   - "Stock-Outs" shows `0` (no products depleted yet).
6. To test Case D: create a product with attribute combinations, then remove one combination from the admin while leaving it in a cart. Completing checkout should increment "Adjustments Without Stock Change".
7. To test Case G: set a product stock to `1`, buy it. "Stock-Outs" should increment to `1`.
