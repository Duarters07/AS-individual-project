using System.Diagnostics;

namespace Nop.Core.Observability;

public static class NopActivitySource
{

    public const string ServiceName = "nopcommerce";
    // The singleton ActivitySource instance - to be shared — creating one per call would break trace correlation.
    public static readonly ActivitySource Source = new(ServiceName);
}
