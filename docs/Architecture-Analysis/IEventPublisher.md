# IEventPublisher — Sistema de Eventos In-Process

---

## O que é

O `IEventPublisher` é o **sistema de eventos in-process** do nopCommerce. Permite que diferentes partes do sistema comuniquem entre si sem que o remetente saiba quem vai receber a mensagem. Em vez de um serviço chamar directamente outro, publica um evento — e todos os componentes registados para esse tipo de evento são notificados automaticamente.

**Não é um message broker.** Tudo acontece in-process, dentro da mesma instância da aplicação, durante o mesmo pedido HTTP.

---

## Interface

Definida em `Nop.Core/Events/IEventPublisher.cs`:

```csharp
public partial interface IEventPublisher
{
    Task PublishAsync<TEvent>(TEvent @event);
}
```

O tipo do evento é completamente livre. Não há classe base obrigatória.

---

## Implementação

A implementação está em `Nop.Services/Events/EventPublisher.cs` e usa o padrão **Service Locator** para descobrir os consumidores em runtime:

```csharp
public virtual async Task PublishAsync<TEvent>(TEvent @event)
{
    var consumers = EngineContext.Current.ResolveAll<IConsumer<TEvent>>().ToList();

    foreach (var consumer in consumers)
    {
        try
        {
            await consumer.HandleEventAsync(@event);

            if (@event is IStopProcessingEvent { StopProcessing: true })
                break;
        }
        catch (Exception exception)
        {
            // log, continua para o próximo handler
        }
    }
}
```

`EngineContext.Current.ResolveAll<IConsumer<TEvent>>()` resolve todos os handlers registados para aquele tipo de evento. Os handlers são executados **sequencialmente**, não em paralelo.

---

## Como se publica um evento

### Eventos de negócio

Em `Nop.Services/Orders/OrderProcessingService.cs`, ao colocar uma encomenda:

```csharp
await _eventPublisher.PublishAsync(new OrderPlacedEvent(order));
await _eventPublisher.PublishAsync(new OrderPaidEvent(order));
await _eventPublisher.PublishAsync(new OrderStatusChangedEvent(order, prevOrderStatus));
await _eventPublisher.PublishAsync(new OrderRefundedEvent(order, amountToRefund));
await _eventPublisher.PublishAsync(new OrderVoidedEvent(order));
```

Em `Nop.Services/Orders/ShoppingCartService.cs`:

```csharp
await _eventPublisher.PublishAsync(new ClearShoppingCartEvent(cart));
await _eventPublisher.PublishAsync(new ShoppingCartItemMovedToOrderItemEvent(sc, orderItem));
```

### Eventos genéricos de entidade

Em `Nop.Core/Events/EventPublisherExtensions.cs` existem extensões que disparam eventos para qualquer `BaseEntity`:

```csharp
await eventPublisher.EntityInsertedAsync(entity);  // → EntityInsertedEvent<T>
await eventPublisher.EntityUpdatedAsync(entity);   // → EntityUpdatedEvent<T>
await eventPublisher.EntityDeletedAsync(entity);   // → EntityDeletedEvent<T>
```

Estes são chamados automaticamente pelo `EntityRepository` após cada operação de escrita, pelo que qualquer entidade inserida, alterada ou apagada gera automaticamente um evento de domínio.

---

## Como se consome um evento

Qualquer classe pode implementar `IConsumer<T>`. O `ITypeFinder` descobre-a automaticamente no startup e regista-a no DI. Exemplo — invalidação de cache quando a password de um `Customer` muda (`Nop.Services/Customers/Caching/CustomerCacheEventConsumer.cs`):

```csharp
public partial class CustomerCacheEventConsumer
    : CacheEventConsumer<Customer>, IConsumer<CustomerPasswordChangedEvent>
{
    public virtual async Task HandleEventAsync(CustomerPasswordChangedEvent eventMessage)
    {
        await RemoveAsync(
            NopCustomerServicesDefaults.CustomerPasswordLifetimeCacheKey,
            eventMessage.Password.CustomerId);
    }
}
```

Uma classe pode implementar múltiplos `IConsumer<T>`, um por tipo de evento a que quer reagir.

---

## Estrutura de um evento de domínio

Os eventos são POCOs simples. Exemplo — `Nop.Core/Domain/Orders/OrderPlacedEvent.cs`:

```csharp
public partial class OrderPlacedEvent
{
    public OrderPlacedEvent(Order order)
    {
        Order = order;
    }

    public Order Order { get; }
}
```

Sem herança, sem atributos, sem serialização. Apenas dados.

---

## Resumo do padrão

| Aspecto | Detalhe |
|---|---|
| Descoberta de handlers | `ITypeFinder` no startup; `ResolveAll<IConsumer<T>>()` em runtime |
| Execução | Sequencial, in-process, mesmo pedido HTTP |
| Erro num handler | Capturado e logado; os restantes handlers continuam |
| Paragem antecipada | `IStopProcessingEvent.StopProcessing = true` |
| Uso principal | Invalidação de cache, notificações, reacção de plugins a mudanças de domínio |
| Limitação | Service Locator impede Decorator via DI — ver [Observability-Easy-vs-Hard.md](./Observability-Easy-vs-Hard.md) |
