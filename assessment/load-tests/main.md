# Guia de Execução dos Testes

Este documento descreve todos os passos necessários para correr os três testes k6 sem erros, desde a preparação do ambiente até ao comando de execução de cada teste.

---

## Índice

1. [Configuração única após instalação](#1-configuração-única-após-instalação)
2. [Smoke Test](#2-smoke-test)
3. [Load Test — Checkout](#3-load-test--checkout)

---

## 1. Configuração única após instalação


Após a instalação do nopCommerce, é preciso fazer umas configurações de modo aos testes funcionares:

### 2.1 Desactivar one-page checkout

Por omissão, o nopCommerce usa um checkout de página única (`/onepagecheckout`). Se esta definição estiver activa, todos os testes falham a seguir ao login.

```bash
docker exec nopcommerce_postgres_server psql -U postgres -d nopcommerce -c \
  "UPDATE \"Setting\" SET \"Value\" = 'false' WHERE \"Name\" = 'ordersettings.onepagecheckoutenabled';"
```

### 2.2 Remover intervalo mínimo entre encomendas

Por omissão, o nopCommerce impõe um intervalo de 1 segundo entre encomendas do mesmo utilizador. O load test coloca encomendas em sequência rápida, sem esta alteração, as encomendas são rejeitadas silenciosamente.

```bash
docker exec nopcommerce_postgres_server psql -U postgres -d nopcommerce -c \
  "UPDATE \"Setting\" SET \"Value\" = '0' WHERE \"Name\" = 'ordersettings.minimumorderplacementinterval';"
```

### 2.3 Reiniciar o nopCommerce

**Obrigatório.** O nopCommerce carrega as definições em cache no arranque e não as relê da base de dados enquanto estiver em execução. As alterações acima só ficam activas depois de reiniciar o processo.

```bash
# Parar (Ctrl+C no terminal, ou:)
kill $(pgrep -f "Nop.Web")

# Arrancar novamente
cd nopCommerce/src/Presentation/Nop.Web
ASPNETCORE_ENVIRONMENT=Development dotnet run --urls http://localhost:5000
```

### 2.4 Verificar o produto de teste

Os três testes usam por omissão o produto com ID `36`. Confirma que o produto está configurado correctamente:

```bash
docker exec nopcommerce_postgres_server psql -U postgres -d nopcommerce -c \
  "SELECT \"Id\", \"Name\", \"StockQuantity\", \"DisableBuyButton\", \"ManageInventoryMethodId\", \"LowStockActivityId\"
   FROM \"Product\" WHERE \"Id\" = 36;"
```

O resultado deve mostrar:

| Campo | Valor esperado | Porquê |
|---|---|---|
| `DisableBuyButton` | `f` (false) | Se `true`, o "add to cart" falha com JSON `success: false` |
| `ManageInventoryMethodId` | `1` (ManageStock) | Necessário para os spans de inventário e o stock depletion test |
| `LowStockActivityId` | `0` (Nothing) | Se `1` (DisableBuyButton), o nopCommerce desactiva o produto automaticamente quando o stock desce |

Se `DisableBuyButton = true` ou `LowStockActivityId != 0`, corrigir:

```bash
docker exec nopcommerce_postgres_server psql -U postgres -d nopcommerce -c \
  "UPDATE \"Product\"
   SET \"DisableBuyButton\" = false, \"LowStockActivityId\" = 0, \"MinStockQuantity\" = 2
   WHERE \"Id\" = 36;"
```

> Depois de alterar qualquer produto directamente na base de dados, reiniciar o nopCommerce para limpar o cache de produto.

---

## 3. Smoke Test

**Ficheiro:** `smoke-test.js`
**Duração:** ~2 minutos
**O que faz:** dois cenários sequenciais — checkout completo com 2 itens, seguido de uma tentativa de checkout com carrinho vazio.

### Preparação

**Stock mínimo:** o teste adiciona 2 unidades do produto 36. O stock deve ser ≥ 2.

```bash
docker exec nopcommerce_postgres_server psql -U postgres -d nopcommerce -c \
  "SELECT \"StockQuantity\" FROM \"Product\" WHERE \"Id\" = 36;"
```

Se for inferior a 2:

```bash
docker exec nopcommerce_postgres_server psql -U postgres -d nopcommerce -c \
  "UPDATE \"Product\" SET \"StockQuantity\" = 100, \"DisableBuyButton\" = false WHERE \"Id\" = 36;"
```

**Carrinho limpo:** o segundo cenário (`empty_cart_guard`) testa que o sistema bloqueia um checkout com carrinho vazio. Se o carrinho tiver itens de uma execução anterior, o cenário passa à mesma mas não está a testar o que deve.

O primeiro cenário faz um checkout completo, o que limpa o carrinho automaticamente ao concluir a encomenda. Se o teste anterior falhou a meio e deixou itens no carrinho, limpar manualmente:

```bash
docker exec nopcommerce_postgres_server psql -U postgres -d nopcommerce -c \
  "DELETE FROM \"ShoppingCartItem\" WHERE \"CustomerId\" = 1;"
```

### Comando

```bash
cd load-test

k6 run \
  -e TEST_EMAIL=admin@ua.pt \
  -e TEST_PASSWORD=1234 \
  -e PRODUCT_ID=36 \
  smoke-test.js
```

### Resultado esperado

```
✓ login page loads
✓ login: no error message
✓ login: redirected away
✓ add 2 items: 200
✓ add 2 items: success
✓ cart page: 200
✓ cart: not empty
✓ billing page: 200
✓ confirm page: 200
✓ order placed: completed page
✓ order placed: no payment error
✓ empty cart guard: not on /checkout/confirm
✓ empty cart guard: redirected to /cart or similar

checks.........................: 100.00%
```

O output imprime instruções exactas do que verificar no Jaeger e no Grafana. Seguir essas instruções é parte do teste.

---

## 4. Load Test — Checkout

**Ficheiro:** `checkout-load-test.js`
**Duração:** ~4 minutos e 30 segundos
**O que faz:** simula até 20 utilizadores simultâneos a fazer checkout em loop, com perfil de carga progressivo (ramp-up → baseline → pico → sustentado → ramp-down).

### Preparação

**Stock alto:** com 20 VUs a colocar encomendas em loop durante 4 minutos, o produto pode ser consumido se o stock for baixo. Definir um valor alto antes de correr:

```bash
docker exec nopcommerce_postgres_server psql -U postgres -d nopcommerce -c \
  "UPDATE \"Product\"
   SET \"StockQuantity\" = 9999, \"DisableBuyButton\" = false
   WHERE \"Id\" = 36;"
```

> Reiniciar o nopCommerce depois desta alteração para o cache de produto ser limpo.

**Carrinho limpo:** com vários VUs a partilhar o mesmo utilizador (o comportamento esperado neste teste), o carrinho pode acumular itens de iterações anteriores que falharam a meio do checkout. O teste foi desenhado para lidar com isso, mas começa mais limpo sem resíduos:

```bash
docker exec nopcommerce_postgres_server psql -U postgres -d nopcommerce -c \
  "DELETE FROM \"ShoppingCartItem\" WHERE \"CustomerId\" = 1;"
```

### Comando

```bash
cd load-test

k6 run \
  -e TEST_EMAIL=admin@ua.pt \
  -e TEST_PASSWORD=1234 \
  -e PRODUCT_ID=36 \
  checkout-load-test.js
```

### Resultado esperado

O teste passa se os seguintes thresholds forem cumpridos:

| Threshold | Critério |
|---|---|
| `http_req_failed` | < 5% de erros HTTP |
| `checks` | > 90% dos checks passam |
| `http_req_duration` | p95 < 5 000ms |
| `orders_completed` | ≥ 10 encomendas concluídas |
| `cart_add_success_rate` | > 90% |

É normal que algumas encomendas falhem (utilizadores a partilhar o mesmo carrinho causam conflitos). O que importa é que o sistema não quebra e que os thresholds são cumpridos.

Durante o teste, o Grafana deve mostrar actividade em tempo real nos dashboards **Checkout Business KPIs** e **Inventory Impact**.

---

## Referência rápida

| Teste | Comando | Stock antes | Duração |
|---|---|---|---|
| Smoke | `k6 run -e TEST_EMAIL=admin@ua.pt -e TEST_PASSWORD=1234 smoke-test.js` | ≥ 2 | ~2 min |
| Load | `k6 run -e TEST_EMAIL=admin@ua.pt -e TEST_PASSWORD=1234 checkout-load-test.js` | 9999 | ~4.5 min |
| Stock Depletion | `k6 run -e TEST_EMAIL=admin@ua.pt -e TEST_PASSWORD=1234 -e LOW_STOCK_PRODUCT_ID=36 -e INITIAL_STOCK=5 stock-depletion-test.js` | = 5 | ~30 s |
