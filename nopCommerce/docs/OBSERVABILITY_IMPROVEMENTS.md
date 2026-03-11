# Plano de Melhorias à Observabilidade — Checkout Flow

## Índice

1. [Estado Actual vs. Assignment](#1-estado-actual-vs-assignment)
2. [O que Falta e Porquê Importa](#2-o-que-falta-e-porquê-importa)
3. [Melhoria 1 — Inventory: span + métrica em AdjustInventoryAsync](#3-melhoria-1--inventory-span--métrica-em-adjustinventoryasync)
4. [Melhoria 2 — Basket: span em PrepareAndValidateShoppingCartAsync](#4-melhoria-2--basket-span-em-prepareandvalidateshoppingcartasync)
5. [Melhoria 3 — Notifications: span em SendNotificationsAndSaveNotesAsync](#5-melhoria-3--notifications-span-em-sendnotificationsandsavenotesasync)
6. [Ficheiros a Modificar / Adicionar](#6-ficheiros-a-modificar--adicionar)
7. [Cenário Operacional Completo](#7-cenário-operacional-completo)

---

## 1. Estado Actual vs. Assignment

O assignment define o flow "Customer places an order" como envolvendo quatro serviços:

```
Basket · Order · Payment · Inventory
```

A instrumentação actual cobre:

| Serviço | Cobertura | Span / Métrica |
|---|---|---|
| **Order** | ✅ Completo | `nop.order.place` (span) + `nop.checkout.duration` (histograma) |
| **Payment** | ✅ Completo | `nop.payment.process` (span) + `nop.payment.result` (counter) |
| **Inventory** | ⚠️ Parcial | Apenas `db.update Product` genérico do EntityRepository — sem contexto de negócio |
| **Basket** | ⚠️ Parcial | Apenas `db.delete ShoppingCartItem` genérico — sem visibilidade na validação |

O waterfall de traces actual é:

```
HTTP POST /checkout/confirm                     (auto — ASP.NET Core)
  └── nop.order.place                           (manual — OrderProcessingService)
        ├── nop.payment.process                 (manual — PaymentService)
        ├── db.insert Order                     (auto — EntityRepository)
        ├── db.insert OrderItem (×N)            (auto — EntityRepository)
        ├── db.update Product (×N)              (auto — EntityRepository)  ← opaco
        ├── db.delete ShoppingCartItem (×N)     (auto — EntityRepository)  ← opaco
        └── event OrderPlacedEvent              (auto — EventPublisher)
```

Os spans `db.update Product` e `db.delete ShoppingCartItem` existem, mas são **opacos**: não dizem se o update foi por ajuste de stock, se houve notificação de low-stock, nem quantos items tinha o carrinho. Da perspectiva de um operador, é impossível distinguir entre "a ordem foi lenta porque o inventário tem lógica de multi-warehouse" e "foi lenta porque o email de notificação falhou".

---

## 2. O que Falta e Porquê Importa

### 2.1 Inventory — AdjustInventoryAsync (ProductService.cs:1700)

**O que faz:** Para cada item da ordem, decrementa o stock do produto. Tem três caminhos diferentes:
- `ManageStock` simples: atualiza `StockQuantity` directamente
- `ManageStock` com múltiplos armazéns: reserva inventário por warehouse
- `ManageStockByAttributes`: actualiza o stock por combinação de atributos

Adicionalmente, depois de cada ajuste, verifica se o stock desceu abaixo do limiar de notificação (`NotifyAdminForQuantityBelow`) e, se sim, **envia emails ao store owner e ao vendor** usando `IWorkflowMessageService` — com recurso ao Service Locator (`EngineContext.Current.Resolve`).

**Porquê a ausência é um problema:** Sem instrumentação aqui, um operador que veja o `nop.order.place` a demorar 2 segundos não consegue saber se o bottleneck está:
- No ajuste de stock simples (devia ser <10ms)
- Na lógica de multi-warehouse (pode envolver queries complexas)
- No envio de emails de low-stock (I/O externo, pode ser lento)
- Numa recursão de bundled products que não termina

Um counter `nop.inventory.adjustment{low_stock_notified=true}` a disparar às 3h da manhã diz imediatamente ao operador: "estamos a esgotar produtos, alguém deve verificar o stock antes de abrirmos amanhã". Isso **não** é informação disponível em nenhuma outra métrica hoje.

### 2.2 Basket — PrepareAndValidateShoppingCartAndCheckoutAttributesAsync (OrderProcessingService.cs:485)

**O que faz:** Chamada dentro de `PreparePlaceOrderDetailsAsync` antes de qualquer pagamento. Carrega o carrinho do cliente, executa `GetShoppingCartWarningsAsync` (validação global), e depois `GetShoppingCartItemWarningsAsync` para cada item individualmente. Se qualquer validação falhar, lança `NopException` que aborta o flow inteiro.

**Porquê a ausência é um problema:** Toda a validação do carrinho ocorre num bloco sem span. Se um cliente tenta fazer checkout com um produto que entretanto esgotou (race condition comum em flash sales), o flow falha durante a validação — mas o span `nop.order.place` marca erro sem identificar que foi a validação do carrinho que falhou, e não o pagamento. Num post-mortem, é impossível distinguir "o pagamento falhou" de "o carrinho era inválido antes sequer de tentar pagar".

Adicionalmente, o número de items no carrinho (`basket.item_count`) é um tag operacionalmente útil: ordens com 30 itens têm uma assinatura de latência diferente de ordens com 1 item, e sem esse tag não é possível correlacionar.

### 2.3 Notifications — SendNotificationsAndSaveNotesAsync (OrderProcessingService.cs:820–853)

**O que faz:** Chamada no final de `PlaceOrderAsync` após a persistência da ordem (linha 1599). Envia emails para:
1. Store owner (sempre)
2. Cliente (sempre, com possível PDF do invoice gerado em disco)
3. Vendors envolvidos na ordem (um email por vendor)
4. Affiliate (se aplicável)

A geração do PDF (`_pdfService.SaveOrderPdfToDiskAsync`) é uma operação de I/O pesada que ocorre sincronamente dentro do flow de checkout quando `_orderSettings.AttachPdfInvoiceToOrderPlacedEmail` está activo.

**Porquê a ausência é um problema:** Hoje, o tempo de notificações está absorvido no span `nop.order.place` sem ser distinguível. Se o servidor de email estiver lento ou o serviço de PDF estiver a consumir demasiados recursos, o p95 do checkout vai subir, mas o Jaeger waterfall não mostrará onde. Esta é a diferença entre "o checkout é lento" e "o checkout é lento porque geramos PDFs em disco para cada ordem".

---

## 3. Melhoria 1 — Inventory: span + métrica em AdjustInventoryAsync

### 3.1 Ficheiro a modificar

```
src/Libraries/Nop.Services/Catalog/ProductService.cs
```

### 3.2 Nova métrica a adicionar (NopMeter.cs)

**Ficheiro:** `src/Libraries/Nop.Core/Observability/NopMeter.cs`

Adicionar logo a seguir ao `CheckoutDuration`:

```csharp
// Counts inventory adjustments during order placement, tagged by inventory method and low-stock outcome.
// Justification: a spike in low_stock_notified=true at 3am tells an operator that products are
// running out — actionable signal before the store opens next morning.
public static readonly Counter<long> InventoryAdjustment =
    _meter.CreateCounter<long>(
        name: "nop.inventory.adjustment",
        unit: "{adjustment}",
        description: "Number of inventory adjustments by method and low-stock notification outcome.");
```

**Tags que o counter vai carregar:**
- `inventory.method` — `ManageStock`, `ManageStockByAttributes`, ou `DontManageStock`
- `inventory.low_stock_notified` — `true` ou `false`

### 3.3 Alteração ao ProductService.cs

**Adicionar o using em cima do ficheiro** (se ainda não existir):
```csharp
using Nop.Core.Observability;
using System.Diagnostics;
```

**Substituição do método `AdjustInventoryAsync` (linha 1700):**

O método começa em linha 1700 e termina em linha 1796. A alteração é **cirúrgica**: adiciona um span no início e o registo da métrica no fim. **Nada da lógica existente é alterado.**

```csharp
public virtual async Task AdjustInventoryAsync(Product product, int quantityToChange, string attributesXml = "", string message = "")
{
    ArgumentNullException.ThrowIfNull(product);

    if (quantityToChange == 0)
        return;

    // ── NOVA INSTRUMENTAÇÃO ────────────────────────────────────────────────
    var lowStockNotified = false;
    using var span = NopActivitySource.Source.StartActivity("nop.inventory.adjust", ActivityKind.Internal);
    span?.SetTag("product.id", product.Id);
    span?.SetTag("inventory.quantity_change", quantityToChange);
    span?.SetTag("inventory.method", product.ManageInventoryMethod.ToString());
    // ──────────────────────────────────────────────────────────────────────

    if (product.ManageInventoryMethod == ManageInventoryMethod.ManageStock)
    {
        //update stock quantity
        if (product.UseMultipleWarehouses)
        {
            //use multiple warehouses
            if (quantityToChange < 0)
                await ReserveInventoryAsync(product, quantityToChange);
            else
                await UnblockReservedInventoryAsync(product, quantityToChange);
        }
        else
        {
            //do not use multiple warehouses
            //simple inventory management
            product.StockQuantity += quantityToChange;
            await UpdateProductAsync(product);

            //quantity change history
            await AddStockQuantityHistoryEntryAsync(product, quantityToChange, product.StockQuantity, product.WarehouseId, message);
        }

        var totalStock = await GetTotalStockQuantityAsync(product);

        await ApplyLowStockActivityAsync(product, totalStock);

        //send email notification
        if (quantityToChange < 0 && totalStock < product.NotifyAdminForQuantityBelow)
        {
            // ── NOVA INSTRUMENTAÇÃO ────────────────────────────────────────
            lowStockNotified = true;
            // ──────────────────────────────────────────────────────────────

            //do not inject IWorkflowMessageService via constructor because it'll cause circular references
            var workflowMessageService = EngineContext.Current.Resolve<IWorkflowMessageService>();
            await workflowMessageService.SendQuantityBelowStoreOwnerNotificationAsync(product, _localizationSettings.DefaultAdminLanguageId);

            if (product.VendorId != 0)
            {
                var vendor = await _vendorService.GetVendorByIdAsync(product.VendorId);
                await workflowMessageService.SendQuantityBelowVendorNotificationAsync(product, vendor, _localizationSettings.DefaultAdminLanguageId);
            }
        }
    }

    if (product.ManageInventoryMethod == ManageInventoryMethod.ManageStockByAttributes)
    {
        var combination = await _productAttributeParser.FindProductAttributeCombinationAsync(product, attributesXml);
        if (combination != null)
        {
            combination.StockQuantity += quantityToChange;
            await _productAttributeService.UpdateProductAttributeCombinationAsync(combination);

            //quantity change history
            await AddStockQuantityHistoryEntryAsync(product, quantityToChange, combination.StockQuantity, message: message, combinationId: combination.Id);

            if (product.AllowAddingOnlyExistingAttributeCombinations)
            {
                var totalStockByAllCombinations = await (await _productAttributeService.GetAllProductAttributeCombinationsAsync(product.Id))
                    .ToAsyncEnumerable()
                    .SumAsync(c => c.StockQuantity);

                await ApplyLowStockActivityAsync(product, totalStockByAllCombinations);
            }

            //send email notification
            if (quantityToChange < 0 && combination.StockQuantity < combination.NotifyAdminForQuantityBelow)
            {
                // ── NOVA INSTRUMENTAÇÃO ────────────────────────────────────
                lowStockNotified = true;
                // ──────────────────────────────────────────────────────────

                //do not inject IWorkflowMessageService via constructor because it'll cause circular references
                var workflowMessageService = EngineContext.Current.Resolve<IWorkflowMessageService>();
                await workflowMessageService.SendQuantityBelowStoreOwnerNotificationAsync(combination, _localizationSettings.DefaultAdminLanguageId);

                if (product.VendorId != 0)
                {
                    var vendor = await _vendorService.GetVendorByIdAsync(product.VendorId);
                    await workflowMessageService.SendQuantityBelowVendorNotificationAsync(combination, vendor, _localizationSettings.DefaultAdminLanguageId);
                }
            }
        }
    }

    //bundled products
    var attributeValues = await _productAttributeParser.ParseProductAttributeValuesAsync(attributesXml);
    foreach (var attributeValue in attributeValues)
    {
        if (attributeValue.AttributeValueType != AttributeValueType.AssociatedToProduct)
            continue;

        //associated product (bundle)
        var associatedProduct = await GetProductByIdAsync(attributeValue.AssociatedProductId);
        if (associatedProduct != null)
            await AdjustInventoryAsync(associatedProduct, quantityToChange * attributeValue.Quantity, message);
    }

    // ── NOVA INSTRUMENTAÇÃO ────────────────────────────────────────────────
    span?.SetTag("inventory.low_stock_notified", lowStockNotified.ToString().ToLower());
    NopMeter.InventoryAdjustment.Add(1,
        new KeyValuePair<string, object>("inventory.method", product.ManageInventoryMethod.ToString()),
        new KeyValuePair<string, object>("inventory.low_stock_notified", lowStockNotified.ToString().ToLower()));
    // ──────────────────────────────────────────────────────────────────────
}
```

**Nota sobre bundled products:** O método é recursivo para produtos em bundle (linha 1794 chama `AdjustInventoryAsync` recursivamente). Cada produto associado vai gerar o seu próprio span filho, o que é o comportamento correcto — o Jaeger vai mostrar uma árvore aninhada de ajustes de stock para bundles.

### 3.4 O que este span acrescenta ao waterfall

Antes:
```
nop.order.place (800ms total)
  └── db.update Product     ← opaco, sem contexto
```

Depois:
```
nop.order.place (800ms total)
  ├── nop.inventory.adjust [product.id=42, method=ManageStock, qty=-1, low_stock=false] (12ms)
  │     └── db.update Product
  └── nop.inventory.adjust [product.id=7, method=ManageStock, qty=-1, low_stock=true] (340ms)
        ├── db.update Product
        └── (email de low-stock enviado — aqui está os 328ms extra)
```

---

## 4. Melhoria 2 — Basket: span em PrepareAndValidateShoppingCartAsync

### 4.1 Ficheiro a modificar

```
src/Libraries/Nop.Services/Orders/OrderProcessingService.cs
```

### 4.2 Alteração

**Adicionar o using** (se ainda não existir — provavelmente já existe dado que o ficheiro já tem ActivitySource):
```csharp
using Nop.Core.Observability;
using System.Diagnostics;
```

**Modificar o método `PrepareAndValidateShoppingCartAndCheckoutAttributesAsync` (começa em linha 485):**

```csharp
protected virtual async Task PrepareAndValidateShoppingCartAndCheckoutAttributesAsync(
    PlaceOrderContainer details,
    ProcessPaymentRequest processPaymentRequest,
    Currency currentCurrency)
{
    // ── NOVA INSTRUMENTAÇÃO ────────────────────────────────────────────────
    using var span = NopActivitySource.Source.StartActivity("nop.basket.validate", ActivityKind.Internal);
    // ──────────────────────────────────────────────────────────────────────

    //checkout attributes
    details.CheckoutAttributesXml = await _genericAttributeService.GetAttributeAsync<string>(
        details.Customer, NopCustomerDefaults.CheckoutAttributes, processPaymentRequest.StoreId);
    details.CheckoutAttributeDescription = await _checkoutAttributeFormatter.FormatAttributesAsync(
        details.CheckoutAttributesXml, details.Customer);

    //load shopping cart
    details.Cart = await _shoppingCartService.GetShoppingCartAsync(
        details.Customer, ShoppingCartType.ShoppingCart, processPaymentRequest.StoreId);

    // ── NOVA INSTRUMENTAÇÃO ────────────────────────────────────────────────
    span?.SetTag("basket.item_count", details.Cart.Count);
    // ──────────────────────────────────────────────────────────────────────

    if (!details.Cart.Any())
    {
        // ── NOVA INSTRUMENTAÇÃO ──────────────────────────────────────────
        span?.SetStatus(ActivityStatusCode.Error, "Cart is empty");
        // ────────────────────────────────────────────────────────────────
        throw new NopException("Cart is empty");
    }

    //validate the entire shopping cart
    var warnings = await _shoppingCartService.GetShoppingCartWarningsAsync(
        details.Cart, details.CheckoutAttributesXml, true);
    if (warnings.Any())
    {
        // ── NOVA INSTRUMENTAÇÃO ──────────────────────────────────────────
        span?.SetStatus(ActivityStatusCode.Error, "Cart validation failed");
        span?.SetTag("basket.validation_error", warnings.First());
        // ────────────────────────────────────────────────────────────────
        throw new NopException(warnings.Aggregate(string.Empty, (current, next) => $"{current}{next};"));
    }

    //validate individual cart items
    foreach (var sci in details.Cart)
    {
        var product = await _productService.GetProductByIdAsync(sci.ProductId);

        var sciWarnings = await _shoppingCartService.GetShoppingCartItemWarningsAsync(
            details.Customer, sci.ShoppingCartType, product, processPaymentRequest.StoreId,
            sci.AttributesXml, sci.CustomerEnteredPrice, sci.RentalStartDateUtc,
            sci.RentalEndDateUtc, sci.Quantity, false, sci.Id);

        if (sciWarnings.Any())
        {
            // ── NOVA INSTRUMENTAÇÃO ──────────────────────────────────────
            span?.SetStatus(ActivityStatusCode.Error, "Cart item validation failed");
            span?.SetTag("basket.invalid_product_id", sci.ProductId);
            // ────────────────────────────────────────────────────────────
            throw new NopException(sciWarnings.Aggregate(string.Empty, (current, next) => $"{current}{next};"));
        }
    }

    // O resto do método continua inalterado...
}
```

**Tags que este span emite:**

| Tag | Valor exemplo | Significado |
|---|---|---|
| `basket.item_count` | `3` | Quantos items tinha o carrinho |
| `basket.validation_error` | `"Product X is out of stock"` | Primeira mensagem de erro (apenas em falha) |
| `basket.invalid_product_id` | `42` | ID do produto que causou falha (apenas em falha) |
| `ActivityStatusCode.Error` | — | Span vermelho no Jaeger quando o carrinho é inválido |

### 4.3 O que este span acrescenta ao waterfall

Antes (quando o carrinho é inválido):
```
nop.order.place [ERROR: "Product X is out of stock"] (45ms)
  ← impossível saber que falhou na validação do carrinho
```

Depois:
```
nop.order.place [ERROR] (45ms)
  └── nop.basket.validate [ERROR: "Cart item validation failed", invalid_product_id=42] (42ms)
        ← imediatamente claro: o problema foi o carrinho, não o pagamento
```

Antes (quando o carrinho é válido, numa ordem normal):
```
nop.order.place (800ms)
  ← tempo de validação invisível
```

Depois:
```
nop.order.place (800ms)
  ├── nop.basket.validate [item_count=5] (38ms)   ← validação do carrinho isolada
  ├── nop.payment.process (120ms)
  └── db.insert Order (15ms)
```

---

## 5. Melhoria 3 — Notifications: span em SendNotificationsAndSaveNotesAsync

### 5.1 Ficheiro a modificar

```
src/Libraries/Nop.Services/Orders/OrderProcessingService.cs
```

### 5.2 Alteração

O método `SendNotificationsAndSaveNotesAsync` existe como `protected virtual async Task` e começa nas imediações da linha 815 (a assinatura). A alteração adiciona um span que envolve todo o corpo do método.

```csharp
protected virtual async Task SendNotificationsAndSaveNotesAsync(Order order)
{
    // ── NOVA INSTRUMENTAÇÃO ────────────────────────────────────────────────
    using var span = NopActivitySource.Source.StartActivity("nop.order.notifications", ActivityKind.Internal);
    span?.SetTag("order.id", order.Id);
    span?.SetTag("notification.pdf_invoice", _orderSettings.AttachPdfInvoiceToOrderPlacedEmail.ToString().ToLower());
    // ──────────────────────────────────────────────────────────────────────

    //notes, messages
    await AddOrderNoteAsync(order, _workContext.OriginalCustomerIfImpersonated != null
        ? $"Order placed by a store owner ('{_workContext.OriginalCustomerIfImpersonated.Email}'. ID = {_workContext.OriginalCustomerIfImpersonated.Id}) impersonating the customer."
        : "Order placed");

    //send email notifications
    var orderPlacedStoreOwnerNotificationQueuedEmailIds = await _workflowMessageService
        .SendOrderPlacedStoreOwnerNotificationAsync(order, _localizationSettings.DefaultAdminLanguageId);
    if (orderPlacedStoreOwnerNotificationQueuedEmailIds.Any())
        await AddOrderNoteAsync(order, $"\"Order placed\" email (to store owner) has been queued. Queued email identifiers: {string.Join(", ", orderPlacedStoreOwnerNotificationQueuedEmailIds)}.");

    var orderPlacedAttachmentFilePath = _orderSettings.AttachPdfInvoiceToOrderPlacedEmail
        ? (await _pdfService.SaveOrderPdfToDiskAsync(order))
        : null;
    var orderPlacedAttachmentFileName = _orderSettings.AttachPdfInvoiceToOrderPlacedEmail
        ? (string.Format(await _localizationService.GetResourceAsync("PDFInvoice.FileName"), order.CustomOrderNumber) + ".pdf")
        : null;

    var orderPlacedCustomerNotificationQueuedEmailIds = await _workflowMessageService
        .SendOrderPlacedCustomerNotificationAsync(order, order.CustomerLanguageId,
            orderPlacedAttachmentFilePath, orderPlacedAttachmentFileName);
    if (orderPlacedCustomerNotificationQueuedEmailIds.Any())
        await AddOrderNoteAsync(order, $"\"Order placed\" email (to customer) has been queued. Queued email identifiers: {string.Join(", ", orderPlacedCustomerNotificationQueuedEmailIds)}.");

    var vendors = await GetVendorsInOrderAsync(order);

    // ── NOVA INSTRUMENTAÇÃO ────────────────────────────────────────────────
    span?.SetTag("notification.vendor_count", vendors.Count);
    // ──────────────────────────────────────────────────────────────────────

    foreach (var vendor in vendors)
    {
        var orderPlacedVendorNotificationQueuedEmailIds = await _workflowMessageService
            .SendOrderPlacedVendorNotificationAsync(order, vendor, _localizationSettings.DefaultAdminLanguageId);
        if (orderPlacedVendorNotificationQueuedEmailIds.Any())
            await AddOrderNoteAsync(order, $"\"Order placed\" email (to vendor) has been queued. Queued email identifiers: {string.Join(", ", orderPlacedVendorNotificationQueuedEmailIds)}.");
    }

    if (order.AffiliateId == 0)
        return;

    var orderPlacedAffiliateNotificationQueuedEmailIds = await _workflowMessageService
        .SendOrderPlacedAffiliateNotificationAsync(order, _localizationSettings.DefaultAdminLanguageId);
    if (orderPlacedAffiliateNotificationQueuedEmailIds.Any())
        await AddOrderNoteAsync(order, $"\"Order placed\" email (to affiliate) has been queued. Queued email identifiers: {string.Join(", ", orderPlacedAffiliateNotificationQueuedEmailIds)}.");
}
```

**Tags que este span emite:**

| Tag | Valor exemplo | Significado |
|---|---|---|
| `order.id` | `1042` | Permite correlacionar com o span pai |
| `notification.pdf_invoice` | `false` | Se gerou PDF em disco |
| `notification.vendor_count` | `2` | Quantos emails de vendor foram enviados |

**Porquê `pdf_invoice` como tag:** Quando `AttachPdfInvoiceToOrderPlacedEmail=true`, `SaveOrderPdfToDiskAsync` corre sincronamente. Um span lento com `notification.pdf_invoice=true` vs. `false` é a diferença entre "o email é lento" e "a geração de PDF está a matar a latência". Sem este tag, os dois casos são indistinguíveis.

---

## 6. Ficheiros a Modificar / Adicionar

### Resumo completo

| Operação | Ficheiro | Alteração |
|---|---|---|
| **MODIFICAR** | `src/Libraries/Nop.Core/Observability/NopMeter.cs` | Adicionar `InventoryAdjustment` Counter |
| **MODIFICAR** | `src/Libraries/Nop.Services/Catalog/ProductService.cs` | Adicionar span + métrica em `AdjustInventoryAsync` |
| **MODIFICAR** | `src/Libraries/Nop.Services/Orders/OrderProcessingService.cs` | Adicionar span em `PrepareAndValidateShoppingCartAndCheckoutAttributesAsync` e em `SendNotificationsAndSaveNotesAsync` |
| **MODIFICAR** | `observability/grafana/provisioning/dashboards/nopcommerce-checkout.json` | Adicionar painéis para `nop.inventory.adjustment` |

Nenhum ficheiro novo é necessário. Nenhum ficheiro é removido.

### Não modificar

- `ObservabilityStartup.cs` — o `MeterProvider` já subscreve `NopActivitySource.ServiceName`, que é o mesmo `Meter` que `NopMeter` usa. A nova métrica é descoberta automaticamente.
- `EntityRepository.cs` — os spans de DB que já existem continuam a funcionar como spans-filho dentro dos novos spans de inventory e basket.
- `EventPublisher.cs` — sem alterações.

### Painéis Grafana a adicionar

No dashboard `nopcommerce-checkout.json`, adicionar à Row "Business Metrics":

**Painel: Inventory Adjustments by Method (timeseries)**
```promql
sum by(inventory_method) (rate(nopcommerce_nop_inventory_adjustment_total[5m]))
```
*Justificação: mostra qual o método de inventário mais usado e se há uma mudança de padrão.*

**Painel: Low-Stock Alerts Triggered (stat)**
```promql
sum(increase(nopcommerce_nop_inventory_adjustment_total{inventory_low_stock_notified="true"}[$__range])) or vector(0)
```
*Justificação: número de vezes que um produto atingiu o limiar de low-stock durante a janela visível. Fundo vermelho quando > 0.*

---

## 7. Cenário Operacional Completo

### Contexto

É a Black Friday. A loja abre o sale às 10:00. O operador tem o Grafana aberto.

### 10:47:23 — Pipeline a degradar

O p95 do `Checkout Duration — p50/p95/p99` começa a subir de 150ms para 1.4s ao longo de 3 minutos. O `Payment Rate — Success vs Failure` mantém-se positivo (pagamentos a completar), por isso não é um erro de pagamento.

**Sem as melhorias**, a análise pára aqui: "o checkout está lento, mas não sei porquê".

**Com as melhorias**, o operador abre o Jaeger e filtra por `nop.order.place` com duração > 1s. O waterfall de uma ordem lenta mostra:

```
nop.order.place (1.412s)
  ├── nop.basket.validate [item_count=1] (8ms)          ← OK, rápido
  ├── nop.payment.process [method=Payments.CheckMoneyOrder] (22ms)  ← OK
  ├── nop.inventory.adjust [product.id=15, method=ManageStock, low_stock=true] (1.320s) ← !!
  │     ├── db.update Product (12ms)
  │     └── (sendmail low-stock: 1.308s)                 ← aqui está o problema
  └── nop.order.notifications [vendor_count=0, pdf_invoice=false] (50ms) ← OK
```

**Diagnóstico em <2 minutos:** O produto 15 atingiu o limiar de low-stock, e o `IWorkflowMessageService.SendQuantityBelowStoreOwnerNotificationAsync` está a demorar 1.3 segundos por ordem. Com 50 ordens/minuto, isso está a criar backpressure em todo o checkout.

### 10:49:00 — Confirmação com métricas

O operador olha para o painel "Low-Stock Alerts Triggered" no Grafana:

```
Low-Stock Alerts Triggered: 47
```

Em 2 minutos, 47 ordens do produto 15 dispararam a notificação. O produto está a esgotar stock rapidamente. O operador tem agora duas acções possíveis:
1. Aumentar `NotifyAdminForQuantityBelow` para um limiar maior (já notificado, desactivar temporariamente)
2. Contactar o servidor de email para perceber a latência

### 10:51:00 — Race condition de carrinho

Entretanto, o painel de 5xx Error Rate continua a zero, mas surgem spans `nop.basket.validate` vermelhos no Jaeger:

```
nop.basket.validate [ERROR: "Cart item validation failed", invalid_product_id=15] (12ms)
```

Clientes que tinham o produto 15 no carrinho antes do esgotamento estão a tentar fazer checkout. O span `basket.validation_error` com `invalid_product_id=15` confirma que é o mesmo produto. O operador pode filtrar no Jaeger por `basket.invalid_product_id=15` e ver exactamente quantos clientes foram afectados.

**Sem o span de basket**, estes erros apareceriam como falhas do `nop.order.place` com mensagem de erro genérica — indistinguíveis de um erro de pagamento ou de DB.

### 11:00:00 — Resolução

O produto 15 esgotou. As notificações de low-stock pararam. O p95 do checkout voltou a 150ms. O operador tem um registo completo do incidente em Jaeger e Prometheus:

- Quantas ordens foram afectadas pela lentidão (campo `nop.order.place` com duração > 1s)
- Quantos clientes não conseguiram fazer checkout por carrinho inválido (spans `nop.basket.validate` com erro)
- O inventário exacto do produto 15 ao longo do tempo (spans `nop.inventory.adjust` com `quantity_change`)
- Quando foi enviada a primeira e última notificação de low-stock

### O que esta história demonstra

| Pergunta de operador | Resposta com instrumentação actual | Resposta com melhorias |
|---|---|---|
| "Porquê é que o checkout está lento?" | "Não sei" | "É o inventário do produto 15 a enviar emails de low-stock" |
| "Os pagamentos estão a falhar?" | "O span de pagamento está OK" | "Idem, claramente isolado do problema de inventário" |
| "Quantos clientes foram bloqueados?" | "Impossível determinar" | "Contar spans `nop.basket.validate` com erro por `invalid_product_id`" |
| "Quando é que o produto esgotou?" | "Ver logs da aplicação" | "Primeiro span `nop.inventory.adjust{low_stock=true}` do produto 15" |
| "O email é o bottleneck ou o DB?" | "Impossível separar" | "O span de inventário tem 1.3s, o `db.update` filho tem 12ms — é o email" |

---

*Este documento define o trabalho a fazer no commit 9 (antes do load test) para completar a cobertura dos quatro serviços do flow.*
