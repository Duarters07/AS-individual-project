# Mudanças Estruturais para Instrumentação — Vale a Pena?

---

## O que já está feito

Antes de discutir o que falta, vale a pena reconhecer o que já foi implementado. A arquitectura de observabilidade está bem estabelecida:

| Componente | Ficheiro | Estado |
|---|---|---|
| `NopActivitySource` | `Nop.Core/Observability/NopActivitySource.cs` | ✅ Implementado |
| `NopMeter` | `Nop.Core/Observability/NopMeter.cs` | ✅ 7 métricas definidas |
| `ObservabilityStartup` | `Nop.Web.Framework/Infrastructure/ObservabilityStartup.cs` | ✅ Implementado |
| Spans no `EventPublisher` | `Nop.Services/Events/EventPublisher.cs` | ✅ Implementado |
| Spans no `EntityRepository` | `Nop.Data/EntityRepository.cs` | ✅ INSERT / UPDATE / DELETE |
| Spans e métricas no `PaymentService` | `Nop.Services/Payments/PaymentService.cs` | ✅ Implementado |
| Métricas de encomendas | `Nop.Services/Orders/OrderProcessingService.cs` | ✅ Counter + Histogram |
| Métricas de inventário | `Nop.Services/Catalog/ProductService.cs` | ✅ Counter + Histogram |

A decisão de colocar `NopActivitySource` e `NopMeter` em `Nop.Core` (sem dependências NuGet do OTel SDK) é correcta: permite instrumentar serviços e repositórios usando apenas `System.Diagnostics` da BCL, mantendo as dependências pesadas do SDK (`OpenTelemetry.*`) exclusivamente em `Nop.Web.Framework`.

---

## Mudanças possíveis e se valem a pena

### 1. Spans por handler individual

**Problema:** O `EventPublisher` cria um span por evento publicado, mas não há visibilidade sobre qual handler específico demorou ou falhou.

**O que mudar** — em `Nop.Services/Events/EventPublisher.cs`:

```csharp
foreach (var consumer in consumers)
{
    using var handlerSpan = NopActivitySource.Source.StartActivity(
        $"handler {consumer.GetType().Name}", ActivityKind.Internal);

    try
    {
        await consumer.HandleEventAsync(@event);
    }
    catch (Exception ex)
    {
        handlerSpan?.SetStatus(ActivityStatusCode.Error, ex.Message);
        throw;
    }
}
```

**Vale a pena?** Sim. Com dezenas de consumers por evento (invalidação de cache, notificações, plugins), saber qual handler é lento é informação operacional valiosa. A mudança é mínima — um ficheiro, poucas linhas.

---

### 2. Spans nas queries SELECT

**Problema:** Apenas INSERT, UPDATE e DELETE têm spans. As queries de leitura — que são a maioria — são invisíveis.

**O que mudar** — em `Nop.Data/EntityRepository.cs`, envolver `GetByIdAsync` e `GetAllAsync`:

```csharp
public virtual async Task<TEntity> GetByIdAsync(int? id, ...)
{
    using var span = NopActivitySource.Source.StartActivity(
        $"db.query {typeof(TEntity).Name}", ActivityKind.Client);
    span?.SetTag("db.operation", "SELECT");
    span?.SetTag("db.entity_type", typeof(TEntity).Name);

    return await AddDeletedFilter(Table, includeDeleted)
        .FirstOrDefaultAsync(entity => entity.Id == id);
}
```

**Vale a pena?** Depende do contexto. Em desenvolvimento e diagnóstico de performance, sim — especialmente para identificar queries lentas. Em produção com carga elevada, instrumentar cada SELECT pode criar demasiado ruído. A solução intermédia é usar **sampling** no OTel Collector para reduzir o volume sem perder os casos lentos.

---

### 3. Instrumentar cache

**Problema:** As operações de `IStaticCacheManager` e `IShortTermCacheManager` são completamente opacas. Não se sabe a hit rate nem a latência do cache.

**O que mudar** — decorar `IStaticCacheManager`:

```csharp
public class InstrumentedCacheManager : IStaticCacheManager
{
    private readonly IStaticCacheManager _inner;

    public async Task<T> GetAsync<T>(CacheKey key, Func<Task<T>> acquire)
    {
        using var span = NopActivitySource.Source.StartActivity("cache.get", ActivityKind.Internal);
        span?.SetTag("cache.key.prefix", key.Key.Split('_')[0]);  // baixa cardinalidade

        return await _inner.GetAsync(key, acquire);
    }
}
```

Registar via DI: `services.Decorate<IStaticCacheManager, InstrumentedCacheManager>();`

**Vale a pena?** Sim em contextos de diagnóstico de performance. O nopCommerce usa cache extensivamente — sem esta visibilidade, a latência observada nos serviços pode ser enganosa.

---

### 4. Instrumentar plugins

**Problema:** O interior dos plugins de pagamento (e.g., `PayPalCommercePaymentMethod.ProcessPaymentAsync`) não é rastreado. O `PaymentService` captura a fronteira externa, mas chamadas a APIs externas dentro do plugin são invisíveis.

**Opção simples:** o `AddHttpClientInstrumentation()` já captura chamadas HTTP feitas via `HttpClient`. Se o plugin usa `HttpClient` para chamar APIs externas (e a maioria usa), essas chamadas já aparecem nos traces automaticamente.

**Opção avançada:** criar um proxy de decoração registado no DI:

```csharp
public class InstrumentedPaymentMethod : IPaymentMethod
{
    private readonly IPaymentMethod _inner;

    public async Task<ProcessPaymentResult> ProcessPaymentAsync(ProcessPaymentRequest request)
    {
        using var span = NopActivitySource.Source.StartActivity(
            $"plugin.payment {_inner.GetType().Name}", ActivityKind.Internal);

        return await _inner.ProcessPaymentAsync(request);
    }
    // ... restantes métodos da interface ...
}
```

**Vale a pena?** Para a maioria dos cenários, a combinação do `PaymentService` (fronteira externa) + auto-instrumentation HTTP (chamadas a APIs) é suficiente. O Decorator de plugin traria valor apenas em diagnóstico de problemas específicos com um provider. Esforço moderado-alto; retorno baixo na maioria dos casos.

---

### 5. Métricas de erro

**Problema:** Não há métrica sobre a taxa de erros/excepções no sistema.

**O que mudar** — adicionar em `Nop.Core/Observability/NopMeter.cs`:

```csharp
public static readonly Counter<long> ExceptionCount =
    _meter.CreateCounter<long>(
        name: "nop.exceptions",
        unit: "{exception}",
        description: "Number of unhandled exceptions by type and location.");
```

E registar nos catch relevantes:

```csharp
NopMeter.ExceptionCount.Add(1,
    new("exception.type", exception.GetType().Name),
    new("source", "event_publisher"));
```

**Vale a pena?** Sim, com custo baixo. Uma métrica de excepções por tipo e local é útil para alertas e para correlacionar com degradação de outros indicadores.

---

## O que não mudar — e porquê

| ❌ Não fazer | Razão |
|---|---|
| Adicionar spans a cada método de cada serviço | Cria ruído excessivo, degrada performance, não acrescenta insight diagnóstico |
| Registar PII em tags (email, morada, número de cartão) | Risco de segurança e compliance (RGPD) |
| Usar tags de alta cardinalidade (`customer.id`, `order.total`) | Explosão de cardinalidade no Prometheus e Jaeger |
| Adicionar dependências `OpenTelemetry.*` a `Nop.Core` ou `Nop.Services` | Viola as regras de dependência da arquitectura — SDK deve ficar em `Nop.Web.Framework` |
| Forçar instrumentação síncrona em caminhos críticos | Adiciona latência ao caminho de checkout |

---

## Priorização sugerida

| Mudança | Esforço | Impacto | Recomendação |
|---|---|---|---|
| Spans por handler de evento | Baixo | Alto | ✅ Fazer |
| Métricas de erro | Baixo | Médio | ✅ Fazer |
| Spans nas queries SELECT (com sampling) | Médio | Médio | ⚠️ Considerar |
| Instrumentar cache | Médio | Médio | ⚠️ Considerar |
| Decorator de plugins | Alto | Baixo | ❌ Não prioritário |
