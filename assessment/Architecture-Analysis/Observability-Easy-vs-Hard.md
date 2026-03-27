# Observabilidade — Fácil vs Difícil

---

## Contexto

A arquitectura do nopCommerce tem características que tornam alguns pontos de instrumentação naturais e outros estruturalmente problemáticos. Este documento analisa ambos com base no código real do projecto.

A infraestrutura de base já existe: `NopActivitySource` (em `Nop.Core`) expõe um `ActivitySource` da BCL, e `NopMeter` expõe um `Meter` também da BCL — sem dependências do OTel SDK. O SDK (`OpenTelemetry.*`) está isolado em `Nop.Web.Framework`, registado via `ObservabilityStartup`.

---

## Pontos onde é fácil adicionar observabilidade

### EventPublisher — ponto único para todos os eventos de domínio

`EventPublisher.PublishAsync` é um único método genérico que processa **todos** os eventos do sistema. Instrumentar aqui significa visibilidade automática sobre qualquer evento de domínio, sem alterar os serviços individualmente. Já está implementado:

```csharp
// Nop.Services/Events/EventPublisher.cs
using var span = NopActivitySource.Source.StartActivity(
    $"event {typeof(TEvent).Name}", ActivityKind.Internal);
span?.SetTag("event.type", typeof(TEvent).Name);
span?.SetTag("event.consumers_count", consumers.Count);
```

**Porquê é fácil:** ponto de passagem obrigatório para todos os eventos, interface-based, sem ramificações, async.

---

### EntityRepository — ponto único para todas as escritas em base de dados

`EntityRepository<TEntity>` é a única via de acesso à BD para Insert, Update e Delete. Todos os serviços dependem dele via `IRepository<T>`. Já instrumentado para as três operações:

```csharp
// Nop.Data/EntityRepository.cs — InsertAsync, UpdateAsync, DeleteAsync
using var span = NopActivitySource.Source.StartActivity(
    $"db.insert {typeof(TEntity).Name}", ActivityKind.Client);
span?.SetTag("db.operation", "INSERT");
span?.SetTag("db.entity_type", typeof(TEntity).Name);
```

**Porquê é fácil:** genérico, ponto único, todas as entidades passam aqui, três métodos cobrem todas as escritas.

---

### PaymentService — gateway de todos os pagamentos

Independentemente do provider (PayPal, Stripe, etc.), todos os pagamentos passam por `PaymentService.ProcessPaymentAsync`. É o sítio natural para medir latência e taxa de sucesso. Já implementado com span e métricas:

```csharp
// Nop.Services/Payments/PaymentService.cs
using var span = NopActivitySource.Source.StartActivity("nop.payment.process", ActivityKind.Internal);
span?.SetTag("payment.method", paymentMethodName);

NopMeter.PaymentResult.Add(1,
    new("payment.method", paymentMethodName),
    new("payment.status", status));

NopMeter.PaymentDuration.Record(sw.Elapsed.TotalMilliseconds,
    new("payment.method", paymentMethodName),
    new("payment.status", status));
```

**Porquê é fácil:** ponto único, resultado binário (success/failure), plugins isolados atrás da interface `IPaymentMethod`.

---

### ASP.NET Core — instrumentação automática

`AddAspNetCoreInstrumentation()` captura automaticamente todos os pedidos HTTP: método, rota, status code, duração. Zero modificações ao código da aplicação.

**Porquê é fácil:** auto-instrumentation out-of-the-box, providenciada pelo OTel SDK.

---

## Pontos onde é difícil adicionar observabilidade

### Service Locator no EventPublisher bloqueia o padrão Decorator

O `EventPublisher` não usa constructor injection para resolver os handlers — usa `EngineContext.Current.ResolveAll<>()`. Isto impede a aplicação do **padrão Decorator** via DI: não é possível envolver o `IEventPublisher` com uma camada de observabilidade sem modificar a própria classe.

```csharp
// Isto não funciona — o EventPublisher ignora a cadeia de DI para os consumers
// services.Decorate<IEventPublisher, InstrumentedEventPublisher>();

// O que acontece internamente:
var consumers = EngineContext.Current.ResolveAll<IConsumer<TEvent>>().ToList();
```

**Consequência:** qualquer instrumentação tem de ser feita directamente dentro do `EventPublisher` — não por fora.

---

### Queries SELECT não são instrumentadas

O `EntityRepository` instrumenta INSERT, UPDATE e DELETE, mas as queries de leitura (`GetByIdAsync`, `GetAllAsync`) não têm spans. O **linq2db** não expõe hooks equivalentes aos interceptors do Entity Framework Core, pelo que não há forma de capturar queries SELECT sem modificar cada método individualmente ou escrever um wrapper de `IQueryable`.

Num sistema com cache agressivo, muitas leituras são servidas do cache sem tocar na BD — o que torna os spans de SELECT menos prioritários, mas também significa que quando chegam à BD, a latência pode ser surpreendente sem visibilidade.

---

### Handlers individuais não são rastreados

O `EventPublisher` cria um span por evento publicado, mas os handlers individuais (`IConsumer<T>`) não têm spans próprios. Se um handler específico for lento ou falhar de forma silenciosa, não é possível identificá-lo no trace.

```csharp
// O span de evento existe, mas não se sabe qual handler demorou:
foreach (var consumer in consumers)
{
    await consumer.HandleEventAsync(@event);  // sem span próprio
}
```

---

### Plugins são opacos

Os plugins (e.g., `Nop.Plugin.Payments.PayPalCommerce`) implementam `IPaymentMethod` mas a sua lógica interna não é observável. O `PaymentService` captura a fronteira externa — o tempo total do plugin e o resultado — mas o que acontece dentro (chamadas a APIs externas, lógica de autorização, retries) é invisível nos traces.

---

### Operações de cache são invisíveis

As operações de `IStaticCacheManager` e `IShortTermCacheManager` não estão instrumentadas. Cache hits, misses, e tempos de expiração são completamente opacos. Numa aplicação com cache agressivo como o nopCommerce, a latência observada nos serviços não reflecte a latência real sem cache — o que pode levar a diagnósticos incorrectos de performance.

