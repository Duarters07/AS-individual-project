# Observabilidade do Basket

## 1. Contexto 

> Onde o Basket se Situa no Fluxo de Checkout

O basket é o estado inicial de cada encomenda. Quando o cliente clica em "Confirmar Encomenda", o carrinho já existe — o serviço de basket não é chamado para *criar* nada durante o checkout, apenas para *validar* e eventualmente *destruir* os itens ao transferi-los para a nova encomenda. A cadeia de chamadas completa  é:

```
HTTP POST /checkout/confirm                                [auto span — instrumentação AspNetCore]
  └─ CheckoutController.ConfirmOrder()
       ├─ ShoppingCartService.GetShoppingCartAsync()       ← leitura do cart: valida que não está vazio
       └─ OrderProcessingService.PlaceOrderAsync()         [span: nop.order.place]
            ├─ PreparePlaceOrderDetailsAsync()
            │    └─ ShoppingCartService.GetShoppingCartAsync()  ← leitura do cart: validação + totais
            └─ MoveShoppingCartItemsToOrderItemsAsync()
                 ├─ (foreach cart item)
                 │    ├─ EntityRepository.DeleteAsync(ShoppingCartItem)  [span: db.delete ShoppingCartItem]
                 │    └─ EventPublisher.PublishAsync(ShoppingCartItemMovedToOrderItemEvent) [span: event ...]
                 └─ ShoppingCartService.ClearShoppingCartAsync()
                      ├─ EntityRepository.DeleteAsync(ShoppingCartItem) [span: db.delete ShoppingCartItem]
                      └─ EventPublisher.PublishAsync(ClearShoppingCartEvent) [span: event ClearShoppingCartEvent]
```

---

## 2. O Que É Visível no Trace Sem Alterações de Código

Não foi adicionada instrumentação a `ShoppingCartService`. As operações de basket que aparecem no trace provêm de dois instrumentos pré-existentes:

### `db.delete ShoppingCartItem` — via EntityRepository

`DeleteShoppingCartItemAsync` chama `_sciRepository.DeleteAsync(shoppingCartItem)`, onde `_sciRepository` é `EntityRepository<ShoppingCartItem>`. O método `EntityRepository.DeleteAsync` já está instrumentado:

```csharp
// EntityRepository.cs — já instrumentado
using var span = NopActivitySource.Source.StartActivity(
    $"db.delete {typeof(TEntity).Name}", ActivityKind.Client);
span?.SetTag("db.operation", "DELETE");
span?.SetTag("db.entity_type", typeof(TEntity).Name);
```

Este span dispara **uma vez por item do carrinho** durante `MoveShoppingCartItemsToOrderItemsAsync` (eliminação item a item) e novamente durante `ClearShoppingCartAsync` (limpeza final). Para uma encomenda com 3 itens, o trace conterá 3+ spans `db.delete ShoppingCartItem`, todos aninhados sob `nop.order.place`.

### `event ClearShoppingCartEvent` e `event ShoppingCartItemMovedToOrderItemEvent` — via EventPublisher

`EventPublisher.PublishAsync` também já está instrumentado. Quando `ClearShoppingCartAsync` termina, publica `ClearShoppingCartEvent`, que emite um span. Da mesma forma, `MoveShoppingCartItemsToOrderItemsAsync` publica `ShoppingCartItemMovedToOrderItemEvent` uma vez por item.

Estes spans de evento confirmam que o basket foi esvaziado com sucesso — são o **sinal de conclusão** do ciclo de vida do basket dentro do fluxo de encomenda.

---

## 3. O Que NÃO É Visível (e Porquê É Aceitável)

### Leituras do cart — `GetShoppingCartAsync`

`GetShoppingCartAsync` é chamado duas vezes antes do span `nop.order.place` começar:

1. Em `CheckoutController.ConfirmOrder()` — guarda contra carrinho vazio
2. Em `PreparePlaceOrderDetailsAsync()` — relê o carrinho para cálculo de totais e validação

São operações de leitura pura (queries SELECT). Não aparecem no trace como spans personalizados. São visíveis ao nível do span HTTP (o pedido inteiro está dentro do span `POST /checkout/confirm` auto-instrumentado), mas sem granularidade.

**Porquê é aceitável:** estas leituras são portas de validação. Se alguma falhar, o pedido é rejeitado antes de qualquer operação de negócio começar — não há nada a observar do ponto de vista do fluxo de encomenda. A duração de uma query SELECT de carrinho é sub-milissegundo em condições normais e não justifica instrumentação individual.

## 5. Métrica do Basket — `nop.basket.checkout_started`

### A lacuna

O passo do basket e a confirmação da encomenda são pedidos HTTP separados. Nenhuma métrica existente os ligava: o contador de falhas de encomendas só dispara quando o serviço de orders é atingido. Se um utilizador clicar em "Checkout" no basket mas nunca chegar a `PlaceOrderAsync`, é invisível.

### O que foi adicionado

O counter `nop.basket.checkout_started` é registado em `ShoppingCartController.StartCheckout()` — a action que trata o pedido `POST /cart` quando o utilizador clica em "Checkout".

```csharp
// ShoppingCartController.cs — StartCheckout()
if (checkoutAttributeWarnings.Any())
{
    NopMeter.BasketCheckoutStarted.Add(1,
        new KeyValuePair<string, object>("has_warnings", true),
        new KeyValuePair<string, object>("cart_items_count", cart.Count));
    // ... devolver a view com avisos
}

NopMeter.BasketCheckoutStarted.Add(1,
    new KeyValuePair<string, object>("has_warnings", false),
    new KeyValuePair<string, object>("cart_items_count", cart.Count));
// ... redirecionar para o checkout
```

**Tags:** `has_warnings` (bool) distingue falhas de validação (atributo obrigatório não seleccionado) de iniciações com sucesso. `cart_items_count` fornece contexto sobre o tamanho do carrinho.

### Porquê `StartCheckout` e não `ShoppingCartService`

`StartCheckout` é uma action HTTP — fica na fronteira de infra-estrutura entre o utilizador e o pipeline de checkout. A directriz do assignment recomenda manter a instrumentação perto das fronteiras de infra-estrutura em vez de dentro da lógica de negócio. `ShoppingCartService` é lógica de negócio; `StartCheckout` é o ponto de entrada HTTP.

### Justificação operacional

Se `checkout_started` é alto mas `nop.order.placed` é baixo, os utilizadores estão a chegar ao botão de checkout mas não a completar encomendas — seja por falhas de validação no basket (`has_warnings=true`) ou abandono durante o fluxo de checkout multi-passo. Sem esta métrica, essa diferença de conversão é invisível: as métricas HTTP apenas vêem o pedido de página, não o seu resultado no fluxo de negócio.

---

## 6. Ficheiros Modificados

| Componente | Ficheiro | O que foi adicionado |
|---|---|---|
| `NopMeter` | `src/Libraries/Nop.Core/Observability/NopMeter.cs` | Definição do counter `BasketCheckoutStarted` |
| `ShoppingCartController` | `src/Presentation/Nop.Web/Controllers/ShoppingCartController.cs` | Registo da métrica em `StartCheckout` (6 linhas) |

O basket também é visível no trace da encomenda através de instrumentação já adicionada a outros dois componentes:

| Componente | Ficheiro | Span emitido |
|---|---|---|
| `EntityRepository<ShoppingCartItem>` | `src/Libraries/Nop.Data/EntityRepository.cs` | `db.delete ShoppingCartItem` |
| `EventPublisher` | `src/Libraries/Nop.Services/Events/EventPublisher.cs` | `event ClearShoppingCartEvent`, `event ShoppingCartItemMovedToOrderItemEvent` |

---

## 7. Referência de Spans

### `db.delete ShoppingCartItem`

Emitido pela instrumentação pré-existente de `EntityRepository`.

| Tag | Valor |
|---|---|
| `db.operation` | `"DELETE"` |
| `db.entity_type` | `"ShoppingCartItem"` |

**Multiplicidade:** dispara uma vez por item do carrinho durante `MoveShoppingCartItemsToOrderItemsAsync`, depois uma vez mais durante `ClearShoppingCartAsync` para os itens restantes. Uma encomenda com 3 itens gera pelo menos 3 destes spans dentro de `nop.order.place`.

### `event ClearShoppingCartEvent`

Emitido pela instrumentação pré-existente de `EventPublisher`. Sinaliza que o carrinho foi completamente esvaziado para esta combinação cliente/loja. A presença deste span num trace confirma que o basket foi destruído com sucesso após a colocação da encomenda.

### `event ShoppingCartItemMovedToOrderItemEvent`

Emitido uma vez por item do carrinho após ser convertido num `OrderItem`. A presença de N destes spans confirma que N itens foram transferidos com sucesso.

---

## 8. Casos de Uso e Como Verificar

Aplicar este tipo de telemetria no service Basket pode vir a ser útil para:

- Checkout normal (N itens):
  - **Esperado no Jaeger:** dentro do trace `nop.order.place`, encontrar (A presença de todos estes spans confirma que o basket foi totalmente processado e limpo.):
    - N × spans `db.delete ShoppingCartItem`
    - N × spans `event ShoppingCartItemMovedToOrderItemEvent`
    - 1 × span `event ClearShoppingCartEvent`
- Checkout falhado (falha de pagamento):
  - **Esperado no Jaeger:** `nop.order.place` marcado como `Error`. Procurar spans `db.delete ShoppingCartItem` — **não devem aparecer**, porque `MoveShoppingCartItemsToOrderItemsAsync` só é chamado após um pagamento bem-sucedido. O basket é preservado em caso de falha de pagamento para que o cliente possa tentar novamente.
  - **Significado operacional:** se spans `db.delete ShoppingCartItem` aparecerem num trace de encomenda falhada, indica que o carrinho está a ser limpo antes da confirmação do pagamento — um bug de integridade de dados.
- Guarda de carrinho vazio:
  - **Esperado no Jaeger:** o span HTTP para `POST /checkout/confirm` existe e completa rapidamente com uma resposta de redirect. Não existe span `nop.order.place` — o guarda em `ConfirmOrder` redireciona antes de `PlaceOrderAsync` ser chamado. Não aparecem operações de basket.
