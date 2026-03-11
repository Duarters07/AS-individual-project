# Melhoria 1 — Inventory: span + métrica em AdjustInventoryAsync

## Índice

1. [Contexto e Motivação](#1-contexto-e-motivação)
2. [O que o Assignment exige](#2-o-que-o-assignment-exige)
3. [O que é um Span e o que é uma Métrica](#3-o-que-é-um-span-e-o-que-é-uma-métrica)
4. [O método AdjustInventoryAsync — o que faz](#4-o-método-adjustinventoryasync--o-que-faz)
5. [Ficheiros alterados](#5-ficheiros-alterados)
6. [O que estamos a medir](#6-o-que-estamos-a-medir)
7. [Como testar](#7-como-testar)
8. [O que ver no Jaeger](#8-o-que-ver-no-jaeger)
9. [O que ver no Grafana](#9-o-que-ver-no-grafana)
10. [Decisão de design: um dashboard unificado](#10-decisão-de-design-um-dashboard-unificado)
11. [Cenário operacional](#11-cenário-operacional)

---

## 1. Contexto e Motivação

O assignment define o flow "Customer places an order" como envolvendo quatro serviços:

```
Basket · Order · Payment · Inventory
```

Antes desta melhoria, a instrumentação cobria:

| Serviço | Estado | O que existia |
|---|---|---|
| Order | ✅ Completo | `nop.order.place` span + `nop.checkout.duration` histograma |
| Payment | ✅ Completo | `nop.payment.process` span + `nop.payment.result` counter |
| Inventory | ⚠️ Parcial | Apenas `db.update Product` genérico e automático |
| Basket | ⚠️ Parcial | Apenas `db.delete ShoppingCartItem` genérico |

O `db.update Product` que existia era automático — criado pelo `EntityRepository` — e dizia apenas "alguém actualizou um produto". Não dizia porquê, qual o método de inventário, se o stock ficou abaixo do limiar, nem quanto tempo demorou a parte de negócio vs. a parte de DB.

**Sem esta melhoria**, um operador que visse o `nop.order.place` a demorar 2 segundos não conseguia saber se o bottleneck estava no ajuste de stock simples, na lógica de multi-warehouse, ou no envio de emails de low-stock.

---

## 2. O que o Assignment exige

O guião define dois critérios chave para justificar instrumentação:

> *"I added this because it was easy" is not a justification. "This metric would tell an operator that the checkout pipeline is degrading **before** users start seeing errors" is.*

> **Metric justification** — Are the chosen metrics operationally useful? **Could an on-call engineer act on them?**

A métrica `nop.inventory.adjustment{inventory_low_stock_notified="true"}` passa neste teste:
- Diz quantas vezes produtos atingiram o limiar de low-stock **durante o checkout**
- Um engenheiro de turno pode agir: verificar o stock, contactar fornecedores, ou desactivar temporariamente as notificações se o servidor de email estiver lento

---

## 3. O que é um Span e o que é uma Métrica

### Span (visível no Jaeger)

Um span é um **cronómetro com contexto** associado a uma operação específica. Cada vez que uma ordem é feita e o stock é ajustado, o Jaeger regista:

```
nop.inventory.adjust
  product.id: 42
  inventory.quantity_change: -1
  inventory.method: ManageStock
  inventory.low_stock_notified: false
  Duração: 12ms
```

O span aparece dentro do span pai `nop.order.place` — o Jaeger mostra a árvore (waterfall) de toda a operação de checkout.

### Métrica/Counter (visível no Prometheus e Grafana)

A métrica não é por ordem — é um **total acumulado ao longo do tempo**. O Prometheus regista:

```
nopcommerce_nop_inventory_adjustment_total{inventory_method="ManageStock", inventory_low_stock_notified="false"} = 5
nopcommerce_nop_inventory_adjustment_total{inventory_method="ManageStock", inventory_low_stock_notified="true"}  = 2
```

Uma linha por cada combinação de tags. O Grafana pode mostrar este valor a crescer em tempo real, com alertas quando `low_stock_notified=true` começa a subir.

**Resumo simples:**

| | O que é | O que diz |
|---|---|---|
| Span (Jaeger) | Cronómetro por operação individual | "Esta ordem demorou X ms a ajustar o stock do produto 42" |
| Métrica (Grafana) | Contador agregado ao longo do tempo | "Nas últimas 2 horas, 47 ajustes dispararam alerta de low-stock" |

---

## 4. O método AdjustInventoryAsync — o que faz

**Ficheiro:** `src/Libraries/Nop.Services/Catalog/ProductService.cs:1702`

Chamado pelo `OrderProcessingService` para cada item da ordem, após o pagamento ser aceite. Recebe um `product` e um `quantityToChange` (negativo, porque estamos a descontar stock).

O método tem três caminhos consoante a configuração do produto:

**Caminho A — ManageStock simples**
```
produto.StockQuantity -= N
→ grava na DB
→ verifica se stock < NotifyAdminForQuantityBelow
→ se sim, envia email ao store owner (e ao vendor, se existir)
```

**Caminho B — ManageStock com múltiplos armazéns**
```
→ ReserveInventoryAsync (query mais complexa, envolve tabela de warehouses)
```

**Caminho C — ManageStockByAttributes**
```
produto tem variantes (ex: t-shirt S/M/L)
→ encontra a combinação de atributos correcta
→ desconta o stock dessa combinação específica
→ mesma lógica de notificação de low-stock
```

**Recursão para bundles**
```
se o produto tem produtos associados (bundle),
chama AdjustInventoryAsync recursivamente para cada um
→ cada produto do bundle gera o seu próprio span filho
```

---

## 5. Ficheiros alterados

### 5.1 `src/Libraries/Nop.Core/Observability/NopMeter.cs`

Adicionado um novo counter logo após o `CheckoutDuration`:

```csharp
// Counts inventory adjustments during order placement, tagged by inventory method and low-stock outcome.
public static readonly Counter<long> InventoryAdjustment =
    _meter.CreateCounter<long>(
        name: "nop.inventory.adjustment",
        unit: "{adjustment}",
        description: "Number of inventory adjustments by method and low-stock notification outcome.");
```

**Porquê aqui e não no ProductService?** O `NopMeter` é a classe central de métricas da aplicação. Centralizar garante que tudo usa o mesmo `Meter("nopcommerce")`, que é o que o `ObservabilityStartup.cs` já subscreve — não foi necessário alterar mais nenhum ficheiro de infraestrutura.

### 5.2 `src/Libraries/Nop.Services/Catalog/ProductService.cs`

Adicionados dois `using` no topo:
```csharp
using Nop.Core.Observability;
using System.Diagnostics;
```

Quatro intervenções cirúrgicas no método `AdjustInventoryAsync`, sem alterar a lógica existente:

**Ponto A — início do método (após o guard de zero)**
```csharp
var lowStockNotified = false;
using var span = NopActivitySource.Source.StartActivity("nop.inventory.adjust", ActivityKind.Internal);
span?.SetTag("product.id", product.Id);
span?.SetTag("inventory.quantity_change", quantityToChange);
span?.SetTag("inventory.method", product.ManageInventoryMethod.ToString());
```

- `lowStockNotified = false` — flag local que será actualizada se o email de low-stock for enviado
- `using var span` — o `using` garante que o span fecha automaticamente quando o método termina (incluindo em caso de excepção)
- `span?.SetTag(...)` — o `?` evita NullReferenceException se não houver listener activo (ex: testes unitários)

**Ponto B — dentro do bloco ManageStock, no `if` de low-stock**
```csharp
lowStockNotified = true;
```

**Ponto C — dentro do bloco ManageStockByAttributes, no `if` de low-stock**
```csharp
lowStockNotified = true;
```

**Ponto D — fim do método, antes do `}`**
```csharp
span?.SetTag("inventory.low_stock_notified", lowStockNotified.ToString().ToLower());
NopMeter.InventoryAdjustment.Add(1,
    new KeyValuePair<string, object>("inventory.method", product.ManageInventoryMethod.ToString()),
    new KeyValuePair<string, object>("inventory.low_stock_notified", lowStockNotified.ToString().ToLower()));
```

A tag `low_stock_notified` é adicionada ao span no fim porque só no fim do método se sabe se houve notificação. O counter é incrementado em 1 com as tags correspondentes.

---

## 6. O que estamos a medir

### Span `nop.inventory.adjust`

| Tag | Exemplo | O que significa |
|---|---|---|
| `product.id` | `42` | Qual o produto cujo stock foi ajustado |
| `inventory.quantity_change` | `-1` | Quantas unidades foram retiradas (negativo = redução) |
| `inventory.method` | `ManageStock` | Como o inventário é gerido para este produto |
| `inventory.low_stock_notified` | `true` | Se foi enviado email de low-stock |

### Counter `nop.inventory.adjustment`

| Tag | Valores possíveis |
|---|---|
| `inventory.method` | `ManageStock`, `ManageStockByAttributes`, `DontManageStock` |
| `inventory.low_stock_notified` | `true`, `false` |

---

## 7. Como testar

### Disparar `low_stock_notified = true`

1. **Admin** → http://localhost:5000/admin → Catalog → Products → edita um produto
2. Separador **Inventory**:
   - `Stock quantity` → `0`
   - `Notify admin for quantity below` → qualquer valor > 0 (ex: `5`)
   - Guardar
3. **Loja** → http://localhost:5000 → adiciona esse produto ao carrinho → checkout completo

O código verifica:
```csharp
if (quantityToChange < 0 && totalStock < product.NotifyAdminForQuantityBelow)
```
Com `totalStock = -1` (0 - 1) e `NotifyAdminForQuantityBelow = 5`, a condição é verdadeira.

---

## 8. O que ver no Jaeger

**URL:** http://localhost:16686

- Service: `nopcommerce`
- Operation: `nop.order.place`
- Clica num trace → expande o waterfall

**Antes desta melhoria:**
```
nop.order.place (800ms)
  └── db.update Product    ← opaco, sem contexto de negócio
```

**Depois:**
```
nop.order.place (800ms)
  └── nop.inventory.adjust [product.id=42, method=ManageStock, qty=-1, low_stock=true] (23ms)
        ├── db.update Product (2ms)
        └── db.insert StockQuantityHistory
```

Quando `low_stock_notified=true` e o servidor de email estiver lento, o span de inventário terá uma duração muito maior, e é imediatamente visível no waterfall que o bottleneck é a notificação de low-stock e não o pagamento ou a DB.

---

## 9. O que ver no Grafana

**URL:** http://localhost:3000 → dashboard **nopCommerce — Checkout Observability**

Dois novos painéis na secção **Business Metrics**:

### Inventory Adjustments by Method (timeseries)
Query: `sum by(inventory_method) (rate(nopcommerce_nop_inventory_adjustment_total[5m]))`

Mostra a taxa de ajustes de inventário por segundo, separada por método. Útil para detectar mudanças de padrão (ex: se de repente há mais `ManageStockByAttributes` do que o normal).

### Low-Stock Alerts Triggered (stat)
Query: `sum(increase(nopcommerce_nop_inventory_adjustment_total{inventory_low_stock_notified="true"}[$__range])) or vector(0)`

Mostra o número total de alertas de low-stock disparados na janela de tempo seleccionada. O fundo fica vermelho quando o valor é > 0.

**Porquê este painel é operacionalmente útil:** Um valor não-zero às 3h da manhã diz ao engenheiro de turno que produtos estão a esgotar durante o checkout — sem precisar de ver um único log. A acção é clara: verificar o stock antes de abrir a loja.

---

## 10. Decisão de design: um dashboard unificado

Ponderou-se separar os painéis por serviço (um dashboard por serviço). A decisão foi manter um dashboard unificado pelas seguintes razões:

1. **O flow é uma única história** — os 4 serviços (Basket, Order, Payment, Inventory) estão em sequência. Um problema no Inventory causa latência no Order. Separar impede ver essa correlação num único ecrã.

2. **O assignment pede que o dashboard "conte uma história"** — alguém que nunca viu o código deve conseguir perceber o sistema. Um dashboard unificado do flow de checkout faz isso; dashboards separados requerem conhecimento prévio de qual serviço consultar.

3. **Escala da aplicação** — são 4 métricas de negócio num monolito. Dashboards separados fazem sentido em sistemas com dezenas de microserviços e equipas independentes por serviço.

Numa equipa real, a abordagem seria dois níveis: este dashboard de flow para visão geral, e dashboards de detalhe por serviço para investigação profunda.

---

## 11. Cenário operacional

É Black Friday. A loja abre às 10:00. O operador tem o Grafana aberto.

**10:47** — O painel "Checkout Duration p95" começa a subir de 150ms para 1.4s. O painel "Payment Rate" mantém-se estável — não é um erro de pagamento.

**Sem esta melhoria:** "O checkout está lento, mas não sei porquê."

**Com esta melhoria:** O painel "Low-Stock Alerts Triggered" mostra **47**. O operador abre o Jaeger, filtra `nop.order.place` com duração > 1s, e vê:

```
nop.order.place (1.412s)
  ├── nop.basket.validate (8ms)          ← OK
  ├── nop.payment.process (22ms)         ← OK
  └── nop.inventory.adjust [product.id=15, low_stock=true] (1.320s)  ← !!
        ├── db.update Product (12ms)
        └── (sendmail low-stock: 1.308s) ← aqui está o problema
```

**Diagnóstico em < 2 minutos:** O produto 15 está a esgotar, e o servidor de email demora 1.3s por notificação. Com 50 ordens/minuto, isso cria backpressure em todo o checkout.

**Sem o span de inventário**, este diagnóstico levaria dezenas de minutos de análise de logs. Com ele, é imediato.
