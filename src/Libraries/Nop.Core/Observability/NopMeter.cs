using System.Diagnostics.Metrics;

namespace Nop.Core.Observability;

public static class NopMeter
{
    private static readonly Meter _meter = new(NopActivitySource.ServiceName);

    // Counts payment processing attempts, tagged by payment method and outcome.
    public static readonly Counter<long> PaymentResult =
        _meter.CreateCounter<long>(
            name: "nop.payment.result",
            unit: "{attempt}",
            description: "Number of payment processing attempts by method and outcome.");

    // Counts order placement attempts, tagged by payment method and outcome.
    // Explicit counter for "orders per minute" and "order failure rate" panels — more readable
    // than deriving order counts from the checkout duration histogram's _count series.
    public static readonly Counter<long> OrderPlaced =
        _meter.CreateCounter<long>(
            name: "nop.order.placed",
            unit: "{order}",
            description: "Number of order placement attempts by payment method and outcome.");

    // Records the end-to-end duration of PlaceOrderAsync, tagged by payment method and outcome.
    public static readonly Histogram<double> CheckoutDuration =
        _meter.CreateHistogram<double>(
            name: "nop.checkout.duration",
            unit: "ms",
            description: "End-to-end duration of PlaceOrderAsync in milliseconds.");

    // Counts inventory adjustments, tagged by adjustment method and low-stock notification outcome.
    public static readonly Counter<long> InventoryAdjustment =
        _meter.CreateCounter<long>(
            name: "nop.inventory.adjustment",
            unit: "{adjustment}",
            description: "Number of inventory adjustments by method and low-stock notification outcome.");

    // Records the stock quantity remaining after each inventory adjustment.
    // Allows tracking the distribution of remaining stock across all products sold.
    public static readonly Histogram<long> StockRemaining =
        _meter.CreateHistogram<long>(
            name: "nop.inventory.stock_remaining",
            unit: "{unit}",
            description: "Stock quantity remaining after each inventory adjustment, by inventory method.");

    // Counts the number of times a product stock reached zero after an inventory adjustment.
    // Unlike low_stock_notified (fires before the last unit), this fires at the exact moment
    // the product can no longer be sold — enabling immediate catalogue management.
    public static readonly Counter<long> StockOut =
        _meter.CreateCounter<long>(
            name: "nop.inventory.stockout",
            unit: "{event}",
            description: "Number of times a product stock reached zero after an inventory adjustment.");
}
