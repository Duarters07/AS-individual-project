# Privacidade e Protecção de Dados Sensíveis

## Contexto

O fluxo "Cliente faz uma encomenda" processa:

- **PII do cliente:** nome, endereço de email, morada de facturação, morada de envio
- **Dados de pagamento:** número de cartão, CVV, data de validade, nome do titular (âmbito PCI-DSS)
- **Dados financeiros:** total da encomenda, preços dos itens, valores de desconto

Se não for configurado cuidadosamente, exportará qualquer valor definido como atributo de span para o Jaeger, labels do Prometheus e logs. Sem controlos deliberados, um único `span.SetTag("customer", customer.Email)` escreveria o email de um cliente em cada trace, persistido no Jaeger e visível para qualquer pessoa com acesso à stack de observabilidade.

---

## Estratégia de Protecção em Duas Camadas

A protecção é implementada em duas camadas independentes. Qualquer camada por si só é suficiente para prevenir fugas; ambas juntas proporcionam defesa em profundidade.

### Camada 1 — Código (Primária)

> A Camada 1 (código) impede que PII entre no pipeline de telemetria na origem. É o controlo primário.

Os atributos de span são definidos explicitamente, e apenas valores seguros e sem PII são incluídos. A regra: **se o valor pode identificar uma pessoa ou constitui dado sensível, é excluído.**

#### **Span `nop.order.place`**
**Arquivo:** `OrderProcessingService.cs`

| Status | Atributo | Descrição / Motivo |
| :--- | :--- | :--- |
| **INCLUÍDO** | `payment.method` | Nome do sistema (ex. "Payments.Manual") — não sensível |
| **INCLUÍDO** | `order.success` | Booleano |
| **INCLUÍDO** | `order.id` | Inteiro interno — não é ligável a PII sem acesso à BD |
| **INCLUÍDO** | `order.items_count` | Contagem inteira |
| **EXCLUÍDO** | `customer.email` | PII |
| **EXCLUÍDO** | `billing.address` | PII |
| **EXCLUÍDO** | `shipping.address` | PII |
| **EXCLUÍDO** | `order.total` | Dados financeiros + label de cardinalidade elevada no Prometheus |


#### **Span `nop.payment.process`**
**Arquivo:** `PaymentService.cs`

| Status | Atributo | Descrição / Motivo |
| :--- | :--- | :--- |
| **INCLUÍDO** | `payment.method` | Nome do sistema |
| **INCLUÍDO** | `payment.status` | "success" ou "failure" |
| **EXCLUÍDO** | `payment.card_number` | PCI-DSS |
| **EXCLUÍDO** | `payment.cvv` | PCI-DSS |
| **EXCLUÍDO** | `payment.card_holder` | PII + PCI-DSS |
| **EXCLUÍDO** | `payment.expiry` | PCI-DSS |
| **EXCLUÍDO** | `customer.id` | PII — ligável ao registo do cliente |
| **EXCLUÍDO** | `order.total` | Dados financeiros |

#### **Span `nop.inventory.adjust`**
**Arquivo:** `ProductService.cs`

| Status | Atributo | Descrição / Motivo |
| :--- | :--- | :--- |
| **INCLUÍDO** | `product.id` | Inteiro interno |
| **INCLUÍDO** | `inventory.method` | Valor de enum (ManageStock / ManageStockByAttributes / DontManageStock) |
| **INCLUÍDO** | `inventory.quantity_change` | Delta inteiro |
| **INCLUÍDO** | `inventory.stock_after` | Inteiro |
| **INCLUÍDO** | `inventory.low_stock_notified` | Booleano |
| **INCLUÍDO** | `inventory.stock_adjusted` | Booleano |
| **INCLUÍDO** | `inventory.multi_warehouse` | Booleano |
| **EXCLUÍDO** | `customer.id` | Não presente neste contexto — por design |

### Camada 2 — Processador do OTel Collector (Salvaguarda)

> A Camada 2 (collector): apanha PII que possa escapar de bibliotecas de terceiros que adicionam atributos inesperados, de bibliotecas de auto-instrumentação que capturam corpos ou cabeçalhos de pedidos, ou de alterações futuras ao código feitas sem consciência da convenção.


O OTel Collector está configurado com um processador `transform/sanitize_pii` que corre em todos os spans **antes** de serem exportados para o Jaeger. Usa correspondência de palavras-chave nos nomes dos atributos para redactar qualquer valor cuja chave contenha um termo sensível.

**Ficheiro de configuração:** `nopCommerce/observability/otelcol-config.yml`

O processador elimina atributos cujas chaves contenham: `card`, `cvv`, `email`, `address`, `phone`, `token`, `password`, `secret`, `username`, `ssn`, `tax_id`, `billing`, `shipping` — independentemente de onde o atributo foi definido (código da aplicação, biblioteca de auto-instrumentação ou SDK de terceiros).

O processador está posicionado no pipeline **antes** do exportador Jaeger:

```
receivers -> memory_limiter -> batch -> resourcedetection -> transform/sanitize_pii -> exportador jaeger
```

Esta ordem garante que nenhum span chega ao Jaeger com um atributo sensível, mesmo que uma alteração futura ao código viole a convenção da Camada 1.
