# Basket Observability

## 1. Context — Where the Basket Sits in the Checkout Flow

The basket (shopping cart) is the starting state for every order. By the time the customer clicks "Confirm Order", the cart already exists — the basket service is not called to *create* anything during checkout, only to *validate* and ultimately *destroy* it as items are transferred to the new order.

The full call chain from HTTP entry to basket destruction is:

```
HTTP POST /checkout/confirm                                [auto span — AspNetCore instrumentation]
  └─ CheckoutController.ConfirmOrder()
       ├─ ShoppingCartService.GetShoppingCartAsync()       ← cart read: validates cart is non-empty
       └─ OrderProcessingService.PlaceOrderAsync()         [span: nop.order.place]
            ├─ PreparePlaceOrderDetailsAsync()
            │    └─ ShoppingCartService.GetShoppingCartAsync()  ← cart read: validation + totals
            └─ MoveShoppingCartItemsToOrderItemsAsync()
                 ├─ (foreach cart item)
                 │    ├─ EntityRepository.DeleteAsync(ShoppingCartItem)  [span: db.delete ShoppingCartItem]
                 │    └─ EventPublisher.PublishAsync(ShoppingCartItemMovedToOrderItemEvent) [span: event ...]
                 └─ ShoppingCartService.ClearShoppingCartAsync()
                      ├─ EntityRepository.DeleteAsync(ShoppingCartItem) [span: db.delete ShoppingCartItem]
                      └─ EventPublisher.PublishAsync(ClearShoppingCartEvent) [span: event ClearShoppingCartEvent]
```

**Key observation:** all basket *write* operations happen inside the `nop.order.place` span, so they are fully visible in the distributed trace. Only the basket *reads* (validation queries) are not covered by a custom span — but these are fast SELECT queries with no side effects, discussed in [Section 4](#4-why-no-explicit-basket-span).

---

## 2. What is Visible in the Trace Without Any Code Changes

No instrumentation was added to `ShoppingCartService`. The basket operations that appear in the trace come from two pre-existing instruments:

### `db.delete ShoppingCartItem` — via EntityRepository

`DeleteShoppingCartItemAsync` calls `_sciRepository.DeleteAsync(shoppingCartItem)`, where `_sciRepository` is `EntityRepository<ShoppingCartItem>`. The `EntityRepository.DeleteAsync` method is already instrumented:

```csharp
// EntityRepository.cs — already instrumented
using var span = NopActivitySource.Source.StartActivity(
    $"db.delete {typeof(TEntity).Name}", ActivityKind.Client);
span?.SetTag("db.operation", "DELETE");
span?.SetTag("db.entity_type", typeof(TEntity).Name);
```

This span fires **once per cart item** during `MoveShoppingCartItemsToOrderItemsAsync` (item-by-item deletion) and again during `ClearShoppingCartAsync` (final cleanup). For a 3-item order, the trace will contain 3+ `db.delete ShoppingCartItem` spans, all nested under `nop.order.place`.

### `event ClearShoppingCartEvent` and `event ShoppingCartItemMovedToOrderItemEvent` — via EventPublisher

`EventPublisher.PublishAsync` is also already instrumented. When `ClearShoppingCartAsync` finishes, it publishes `ClearShoppingCartEvent`, which emits a span. Similarly, `MoveShoppingCartItemsToOrderItemsAsync` publishes `ShoppingCartItemMovedToOrderItemEvent` once per item.

These event spans confirm that the basket was successfully cleared — they are the **completion signal** of the basket lifecycle within the order flow.

---

## 3. What is NOT Visible (and Why That is Acceptable)

### Cart reads — `GetShoppingCartAsync`

`GetShoppingCartAsync` is called twice before the `nop.order.place` span starts:

1. In `CheckoutController.ConfirmOrder()` — guards against empty cart
2. In `PreparePlaceOrderDetailsAsync()` — re-reads cart for total calculation and validation

These are pure read operations (SELECT queries). They do not appear in the trace as custom spans. They are visible at the HTTP span level (the entire request is within the auto-instrumented `POST /checkout/confirm` span), but without granularity.

**Why this is acceptable:** these reads are validation gates. If either fails, the request is rejected before any business operation begins — there is nothing to observe from an order-flow perspective. The duration of a cart SELECT query is sub-millisecond under normal conditions and does not warrant individual instrumentation.

---

## 4. Why No Explicit Basket Span Was Added

The assignment guideline states:

> *"Keep these changes as close to the infrastructure boundary as possible — not in business logic. If you find yourself modifying a service class significantly, step back and find a better instrumentation point."*

Adding a basket span would require one of two approaches, both undesirable:

**Option A — Instrument `ShoppingCartService`**

`GetShoppingCartAsync` is a large method that queries the repository, filters by store and cart type, and validates items. Wrapping it in a span would mean modifying business logic in `ShoppingCartService`, a class not otherwise touched by this project.

**Option B — Instrument `CheckoutController`**

Adding a span in `ConfirmOrder` before calling `PlaceOrderAsync` would instrument the presentation layer. The assignment hint points specifically to `Nop.Services` and `Nop.Core` as the right instrumentation targets.

**The actual cost of not doing this:** zero. The basket's write operations (`db.delete ShoppingCartItem`, `event ClearShoppingCartEvent`) are already in the trace. The only thing missing is the duration of two SELECT queries that are fast, read-only, and causally unrelated to the order outcome. An on-call engineer troubleshooting a slow checkout has no need for these spans.

---

## 5. Modified Files

No files were modified for basket observability. The basket is visible in the trace through instrumentation already added to two other components:

| Component | File | Span emitted |
|---|---|---|
| `EntityRepository<ShoppingCartItem>` | `src/Libraries/Nop.Data/EntityRepository.cs` | `db.delete ShoppingCartItem` |
| `EventPublisher` | `src/Libraries/Nop.Services/Events/EventPublisher.cs` | `event ClearShoppingCartEvent`, `event ShoppingCartItemMovedToOrderItemEvent` |

---

## 6. Span Reference

### `db.delete ShoppingCartItem`

Emitted by the pre-existing `EntityRepository` instrumentation.

| Tag | Value |
|---|---|
| `db.operation` | `"DELETE"` |
| `db.entity_type` | `"ShoppingCartItem"` |

**Multiplicity:** fires once per cart item during `MoveShoppingCartItemsToOrderItemsAsync`, then once more during `ClearShoppingCartAsync` for any remaining items. A 3-item order generates at least 3 of these spans inside `nop.order.place`.

### `event ClearShoppingCartEvent`

Emitted by the pre-existing `EventPublisher` instrumentation. Signals that the cart has been fully emptied for this customer/store combination. Presence of this span in a trace is confirmation that the basket was successfully destroyed after order placement.

### `event ShoppingCartItemMovedToOrderItemEvent`

Emitted once per cart item after it is converted to an `OrderItem`. Presence of N of these spans confirms N items were successfully transferred.

---

## 7. Use Cases and How to Verify

### Case A — Standard checkout (N items)

**Setup:** add 2 or more products to the cart, complete checkout.

**Expected in Jaeger:** within the `nop.order.place` trace, find:
- N × `db.delete ShoppingCartItem` spans
- N × `event ShoppingCartItemMovedToOrderItemEvent` spans
- 1 × `event ClearShoppingCartEvent` span

The presence of all these spans confirms the basket was fully processed and cleared.

---

### Case B — Failed checkout (payment failure)

**Setup:** use a payment method configured to fail.

**Expected in Jaeger:** `nop.order.place` is marked `Error`. Look for `db.delete ShoppingCartItem` spans — **they should NOT appear**, because `MoveShoppingCartItemsToOrderItemsAsync` is only called after a successful payment. The basket is preserved on payment failure so the customer can retry.

**Operational significance:** if `db.delete ShoppingCartItem` spans appear in a failed order trace, it would indicate the cart is being cleared before the payment is confirmed — a data integrity bug.

---

### Case C — Empty cart guard

**Setup:** attempt to POST directly to `/checkout/confirm` with an empty cart.

**Expected in Jaeger:** the HTTP span for `POST /checkout/confirm` exists and completes quickly with a redirect response. No `nop.order.place` span exists — the guard in `ConfirmOrder` redirects before `PlaceOrderAsync` is called. No basket operations appear at all.

---

## 8. Out of Scope

- **`ShoppingCartService.AddToCartAsync`** — adding items to the cart is a separate user action that occurs before the checkout flow. It is not part of the "customer places an order" instrumentation scope.
- **Cart read duration** — `GetShoppingCartAsync` SELECT queries are not instrumented. They are fast, read-only, and their duration does not affect order success or failure.
- **Wishlist operations** — `ShoppingCartType.Wishlist` is a separate path with no overlap with the checkout flow.
- **Guest cart merging** — when a guest logs in, their anonymous cart may be merged with a registered customer cart. This happens before checkout and is out of scope.

---

## 9. Verification Checklist

1. Start the stack and the app.
2. Add at least 2 products to the cart and complete a checkout.
3. In **Jaeger** (`http://localhost:16686`): open the trace for `nop.order.place`. Verify:
   - At least one `db.delete ShoppingCartItem` span is present inside the trace.
   - At least one `event ShoppingCartItemMovedToOrderItemEvent` span is present.
   - One `event ClearShoppingCartEvent` span is present at the end of the basket lifecycle.
   - All basket spans appear nested under `nop.order.place` (same trace context).
4. Repeat with a payment failure. Verify that `db.delete ShoppingCartItem` does **not** appear — confirming the cart is preserved on failure.
