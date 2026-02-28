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

    // Records the end-to-end duration of PlaceOrderAsync, tagged by payment method and outcome.
    public static readonly Histogram<double> CheckoutDuration =
        _meter.CreateHistogram<double>(
            name: "nop.checkout.duration",
            unit: "ms",
            description: "End-to-end duration of PlaceOrderAsync in milliseconds.");
}
