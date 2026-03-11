# Implementação da Observabilidade — Detalhe Técnico Completo

## Índice
1. [Visão Geral](#1-visão-geral)
2. [Ficheiros Criados](#2-ficheiros-criados)
3. [Ficheiros Modificados](#3-ficheiros-modificados)
4. [Decisões de Design](#4-decisões-de-design)
5. [Problemas Encontrados e Resolvidos](#5-problemas-encontrados-e-resolvidos)

---

## 1. Visão Geral

A instrumentação segue o modelo de referência do `opentelemetry-demo` e divide-se em três camadas:

```
nopCommerce (código)
    │  produz spans (ActivitySource) e métricas (Meter)
    │  exporta via OTLP gRPC para:
    ▼
OTel Collector
    │  recebe, sanitiza PII, enriquece com metadados
    │  envia traces para Jaeger e expõe métricas em scrape endpoint
    ▼
Jaeger (traces) + Prometheus (métricas) + Grafana (dashboards)
```

### Princípio de contenção de dependências

Os pacotes NuGet do OpenTelemetry SDK **só existem em `Nop.Web.Framework`**.
As primitivas de instrumentação (`ActivitySource`, `Meter`) são BCL (System.Diagnostics) e ficam em `Nop.Core`, sem NuGet.
Isto mantém `Nop.Core`, `Nop.Data` e `Nop.Services` livres de dependências de observabilidade.

```
Nop.Core      → ActivitySource, Meter (BCL, sem NuGet)
Nop.Data      → usa ActivitySource (referencia Nop.Core)
Nop.Services  → usa ActivitySource + Meter (referencia Nop.Core)
Nop.Web.Framework → OTel SDK NuGet + ObservabilityStartup
```

---

## 2. Ficheiros Criados

### 2.1 `Nop.Core/Observability/NopActivitySource.cs`

**O que é:** Singleton estático que define o `ActivitySource` usado em toda a aplicação para criar spans manualmente.

**Porquê estático:** `ActivitySource` é thread-safe e deve ser criado uma única vez. Se fosse instanciado por pedido, o OTel SDK não conseguiria subscrever correctamente.

**Porquê em Nop.Core:** `Nop.Data` e `Nop.Services` precisam de criar spans mas não podem depender de NuGet packages. `ActivitySource` é BCL, não requer NuGet.

```csharp
public static class NopActivitySource
{
    public const string Name = "NopCommerce.Checkout";
    public const string Version = "1.0.0";
    public static readonly ActivitySource Instance = new(Name, Version);
}
```

O `Name` tem de corresponder exactamente ao que é registado no `ObservabilityStartup` com `.AddSource(NopActivitySource.Name)`. Se houver discrepância, os spans são silenciosamente descartados.

---

### 2.2 `Nop.Core/Observability/NopMeter.cs`

**O que é:** Singleton estático com o `Meter` e os dois instrumentos de métricas de negócio.

**Instrumentos criados:**

| Instrumento | Tipo | Nome Prometheus | Unidade |
|---|---|---|---|
| `PaymentResult` | `Counter<long>` | `nop_payment_result_total` | pagamentos |
| `CheckoutDuration` | `Histogram<double>` | `nop_checkout_duration` | ms |

**Porquê Counter para pagamentos:** Cada pagamento é um evento discreto. Com `rate(nop_payment_result_total[5m])` obtemos pagamentos/segundo. Com filtro `payment_status="failure"` construímos uma taxa de erro.

**Porquê Histogram para duração:** Um histograma regista a distribuição completa (não só a média). Permite calcular p50, p95, p99 de latência — essencial para detectar tail latency que afecta utilizadores reais.

```csharp
public static readonly Counter<long> PaymentResult =
    _meter.CreateCounter<long>("nop.payment.result", "payments", "...");

public static readonly Histogram<double> CheckoutDuration =
    _meter.CreateHistogram<double>("nop.checkout.duration", "ms", "...");
```

---

### 2.3 `Nop.Web.Framework/Infrastructure/ObservabilityStartup.cs`

**O que é:** Implementação de `INopStartup` que regista `TracerProvider` e `MeterProvider` no DI do ASP.NET Core.

**Porquê `INopStartup`:** O nopCommerce auto-descobre todas as implementações de `INopStartup` via `ITypeFinder`. Não é necessário registar manualmente — basta criar o ficheiro.

**Porquê `Order = 10`:** O `NopStartup` principal tem `Order = 2000`. Com `Order = 10` o OTel fica registado antes de qualquer outro serviço, garantindo que o SDK captura actividade mesmo durante o arranque.

**Configuração lida de `appsettings`:**
```json
{
  "Observability": {
    "OtlpEndpoint": "http://localhost:4317"
  }
}
```
Se a chave estiver ausente, usa `http://localhost:4317` como fallback. A app arranca mesmo sem o Collector.

**O que regista:**
- Tracing: `AddSource(NopActivitySource.Name)`, ASP.NET Core auto-instrumentation, HttpClient auto-instrumentation
- Metrics: `AddMeter(NopMeter.Name)`, ASP.NET Core, runtime .NET
- `SetExemplarFilter(ExemplarFilterType.TraceBased)` — liga métricas a traces via Exemplars no Grafana

---

### 2.4 `observability/otelcol-config.yml`

**O que é:** Configuração do OpenTelemetry Collector com pipeline de traces e métricas.

**Receivers:**
```yaml
otlp:
  protocols:
    grpc: { endpoint: 0.0.0.0:4317 }   # nopCommerce envia aqui
    http: { endpoint: 0.0.0.0:4318 }
```

**Processors (por ordem no pipeline):**
1. `memory_limiter` — limita RAM a 512 MB; descarta telemetria em vez de crashar
2. `batch` — agrupa spans em batches de 512 para reduzir round-trips de rede
3. `resourcedetection` — enriquece com `host.name`, `os.type`
4. `transform/sanitize_pii` — remove atributos PII (apenas no pipeline de traces)

**PII Sanitization (segunda linha de defesa):**
```yaml
transform/sanitize_pii:
  trace_statements:
    - context: span
      statements:
        - delete_key(span.attributes, "credit_card.number")
        - delete_key(span.attributes, "credit_card.cvv")
        - delete_key(span.attributes, "customer.email")
        - replace_pattern(span.attributes["url.full"], "token=[^&]*", "token=REDACTED")
```

**Exporters:**
- `otlp_grpc/jaeger` — traces para o Jaeger
- `prometheus` — expõe endpoint de scrape na porta 8889 para o Prometheus puxar
- `debug` — imprime telemetria no stdout do Collector (útil para debug)

---

### 2.5 `docker-compose.observability.yml`

Stack completo com 4 serviços:

| Serviço | Imagem | Porta host |
|---|---|---|
| `otel-collector` | `otel/opentelemetry-collector-contrib:latest` | 4317, 4318, 8889 |
| `jaeger` | `jaegertracing/all-in-one:latest` | 16686 |
| `prometheus` | `prom/prometheus:v3.1.0` | 9090 |
| `grafana` | `grafana/grafana:11.4.0` | 3000 |

---

### 2.6 `observability/prometheus.yml`

Configuração mínima do Prometheus com scrape job para o Collector:

```yaml
scrape_configs:
  - job_name: nopcommerce
    static_configs:
      - targets: ['otel-collector:8889']
```

O Prometheus puxa métricas do Collector a cada 15s (pull model). As métricas chegam ao Collector via OTLP push do nopCommerce.

---

### 2.7 `observability/grafana/provisioning/datasources/datasources.yml`

Provisiona automaticamente dois datasources no Grafana:
- **Prometheus** (uid: `prometheus`) — com Exemplars ligados ao Jaeger
- **Jaeger** (uid: `jaeger`) — para drill-down de traces a partir de gráficos

Os UIDs são referenciados entre si para activar a funcionalidade de Exemplars (clicar num ponto num gráfico abre o trace correspondente no Jaeger).

---

### 2.8 `App_Data/appsettings.Development.json`

Ficheiro de configuração de ambiente de desenvolvimento:
```json
{
  "Observability": {
    "OtlpEndpoint": "http://localhost:4317"
  }
}
```
Carregado automaticamente pelo ASP.NET Core quando `ASPNETCORE_ENVIRONMENT=Development`.

---

## 3. Ficheiros Modificados

### 3.1 `Nop.Web.Framework/Nop.Web.Framework.csproj`

Adicionados 5 NuGet packages OTel, **apenas neste projecto**:

```xml
<PackageReference Include="OpenTelemetry.Extensions.Hosting" Version="1.10.0" />
<PackageReference Include="OpenTelemetry.Instrumentation.AspNetCore" Version="1.11.0" />
<PackageReference Include="OpenTelemetry.Instrumentation.Http" Version="1.11.0" />
<PackageReference Include="OpenTelemetry.Instrumentation.Runtime" Version="1.10.0" />
<PackageReference Include="OpenTelemetry.Exporter.OpenTelemetryProtocol" Version="1.10.0" />
```

---

### 3.2 `Nop.Services/Events/EventPublisher.cs`

**Porquê modificar directamente:** `EventPublisher` usa `EngineContext.Current.ResolveAll<>()` (Service Locator), o que impede o padrão Decorator via DI. Modificar o método directamente é a única opção.

**O que foi adicionado:**
```csharp
using var activity = NopActivitySource.Instance.StartActivity(
    $"event {typeof(TEvent).Name}",
    ActivityKind.Internal);

activity?.SetTag("event.type", typeof(TEvent).Name);
activity?.SetTag("event.consumers_count", consumers.Count);

// em caso de excepção:
activity?.SetStatus(ActivityStatusCode.Error, exception.Message);
activity?.SetTag("exception.type", exception.GetType().Name);
```

`ActivityKind.Internal` — sem hop de rede; é chamada in-process. O span aparece como filho do span HTTP activo no momento, mostrando no Jaeger todo o trabalho disparado por um único pedido HTTP.

O operador `?.` em todas as chamadas garante que o código é um no-op se não houver `TracerProvider` registado (ex: testes unitários).

---

### 3.3 `Nop.Data/EntityRepository.cs`

**Porquê modificar:** linq2db (ORM usado pelo nopCommerce) não tem auto-instrumentação OTel, ao contrário do EF Core. Sem esta modificação, as operações de base de dados são invisíveis nos traces.

**Três operações instrumentadas:**

```csharp
// InsertAsync
using var activity = NopActivitySource.Instance.StartActivity(
    $"db.insert {typeof(TEntity).Name}", ActivityKind.Client);
activity?.SetTag("db.system", "mssql");
activity?.SetTag("db.operation", "INSERT");
activity?.SetTag("db.entity_type", typeof(TEntity).Name);

// UpdateAsync — mesma estrutura com "UPDATE"
// DeleteAsync — mesma estrutura com "DELETE" ou "UPDATE (soft-delete)"
```

`ActivityKind.Client` — convenção OTel semântica para chamadas a datastores.

---

### 3.4 `Nop.Services/Payments/PaymentService.cs`

**O que foi adicionado** (após obter o resultado do pagamento):
```csharp
NopMeter.PaymentResult.Add(1,
    new KeyValuePair<string, object?>("payment.method", processPaymentRequest.PaymentMethodSystemName),
    new KeyValuePair<string, object?>("payment.status", result.Success ? "success" : "failure"));
```

**Porquê aqui:** É o único lugar onde o nome do método de pagamento e o resultado coexistem. Adicionar noutro sítio exigiria passar parâmetros extra pelo stack.

**O que NÃO é registado:** valor do pedido, ID do cliente, tipo de cartão — evita PII e alta cardinalidade.

---

### 3.5 `Nop.Services/Orders/OrderProcessingService.cs`

**O que foi adicionado** em `PlaceOrderAsync`:

```csharp
// início do método
var sw = Stopwatch.StartNew();

// o método original tinha dois return statements — foram unificados num só
PlaceOrderResult result;
if (!_orderSettings.PlaceOrderWithLock)
    result = await placeOrder(details);
else
{
    // código do mutex original, inalterado
}

// antes do único return
sw.Stop();
NopMeter.CheckoutDuration.Record(
    sw.Elapsed.TotalMilliseconds,
    new KeyValuePair<string, object?>("payment.method", processPaymentRequest.PaymentMethodSystemName),
    new KeyValuePair<string, object?>("order.success", result.Success ? "true" : "false"));

return result;
```

**Porquê unificar os dois return:** O método original tinha um early-return no path sem lock e um return normal no path com mutex. Para capturar a duração em ambos os casos com um único ponto de medição, os dois paths foram unificados — o código de negócio não mudou, apenas a estrutura do fluxo de controlo.

---

## 4. Decisões de Design

### ActivitySource e Meter em Nop.Core (BCL, sem NuGet)
Mantém as camadas de negócio livres de dependências de infra. Se o OTel SDK for substituído no futuro, só `Nop.Web.Framework` muda.

### Dois pontos de defesa contra PII
1. **Código** — nunca adicionar atributos com dados sensíveis
2. **Collector** — `transform/sanitize_pii` remove defensivamente campos PII mesmo que alguém se esqueça no código

### Prometheus pull em vez de OTLP push
O Prometheus v3.x removeu o flag `--enable-feature=otlp-write-receiver` (OTLP é built-in mas o endpoint de push retornava 404 neste ambiente Docker). A alternativa com o exporter `prometheus` no Collector expõe um endpoint de scrape que o Prometheus puxa — mais simples, sem dependência de flags experimentais.

---

## 5. Problemas Encontrados e Resolvidos

### P1 — `CS0136`: variável `result` duplicada no `PaymentService.cs`
**Causa:** O método `ProcessPaymentAsync` já tinha um bloco `if (OrderTotal == 0) { var result = ...; return result; }`. Ao adicionar `var result = await paymentMethod.ProcessPaymentAsync(...)` no scope externo, o compilador C# rejeitou — dois `result` no mesmo scope lógico.
**Solução:** Substituir `var result = ...; return result;` por `return new ProcessPaymentResult { ... };` directamente.

### P2 — `NU1603`: versão `1.10.1` do pacote Http não existe
**Causa:** A versão `OpenTelemetry.Instrumentation.Http 1.10.1` não foi publicada no NuGet.
**Solução:** Actualizado para `1.11.0`.

### P3 — Imagem Docker `jaegertracing/all-in-one:1.63` não encontrada
**Causa:** A tag `1.63` não existe no Docker Hub.
**Solução:** Mudado para `latest`.

### P4 — OTel Collector `otel/opentelemetry-collector-contrib:0.116.0` não arrancava
**Causa:** O binário `/otelcol-contrib` na imagem 0.116.0 era incompatível com o kernel/runc desta máquina (exec error).
**Solução:** Mudado para `latest` (0.146.1), que funciona correctamente.

### P5 — Config do Collector rejeitada: `address` inválido
**Causa:** O campo `service.telemetry.metrics.address` foi removido no Collector 0.100+.
**Solução:** Campo removido da secção `service.telemetry`.

### P6 — Aliases deprecated: `otlp/jaeger`, `otlphttp/prometheus`
**Causa:** O Collector 0.100+ renomeou os exporters.
**Solução:** Renomeados para `otlp_grpc/jaeger` e `otlp_http/prometheus`.

### P7 — OTTL paths sem contexto (warnings no Collector)
**Causa:** O Collector 0.100+ exige prefixo de contexto nos paths OTTL (ex: `span.attributes` em vez de só `attributes`).
**Impacto:** Apenas warning — o Collector corrigia automaticamente. Mas foi resolvido na config actual.

### P8 — Prometheus v3.x: OTLP push retorna HTTP 404
**Causa:** O flag `--enable-feature=otlp-write-receiver` foi removido no Prometheus v3 (OTLP é built-in). No entanto, o endpoint de push `/api/v1/otlp/v1/metrics` retornava 404 dentro da rede Docker (funcionava com GET do host, que devolvia 405).
**Solução:** Mudada a estratégia de push para pull — o Collector expõe um endpoint Prometheus em `:8889` e o Prometheus faz scrape. Mais robusto e sem dependência de flags.

### P9 — Detector `docker` no Collector sem acesso ao socket
**Causa:** O `resourcedetection` com detector `docker` tentava aceder a `/var/run/docker.sock`, que não estava montado no container do Collector.
**Solução:** Removido `docker` da lista de detectors (`[env, system]` é suficiente).

### P10 — `aspnet-runtime-9.0` não instalado
**Causa:** O `dotnet-sdk-9.0` foi instalado mas não inclui o runtime ASP.NET Core (`Microsoft.AspNetCore.App`).
**Solução:** Instalar `aspnet-runtime-9.0` separadamente via pacman.
