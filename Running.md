# Como Correr o Projecto

## Pré-requisitos

| Ferramenta | Versão mínima | Verificar |
|---|---|---|
| .NET SDK | 9.0 | `dotnet --version` |
| Docker + Docker Compose | qualquer recente | `docker compose version` |

---

## Passo 1 — Arrancar o PostgreSQL

O nopCommerce usa PostgreSQL como base de dados. Na primeira vez, arranca um container:

```bash
docker run -d \
  --name nopcommerce_postgres_server \
  -e POSTGRES_PASSWORD=nopCommerce_db_password \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=nopcommerce \
  -p 5432:5432 \
  postgres:latest
```

Ativa a extensão `citext` (necessária para o nopCommerce):
```bash
docker exec nopcommerce_postgres_server \
  psql -U postgres -d nopcommerce \
  -c "CREATE EXTENSION IF NOT EXISTS citext;"
```

> Nas vezes seguintes, basta apenas arrancar o container que já existe:
> ```bash
> docker start nopcommerce_postgres_server
> ```

---

## Passo 2 — Arrancar a stack de observabilidade

```bash
cd nopCommerce/observability

docker compose -f docker-compose.observability.yml up -d
```

---

## Passo 3 — Arrancar o nopCommerce

```bash
cd nopCommerce/src/Presentation/Nop.Web

ASPNETCORE_ENVIRONMENT=Development dotnet run
```

> `ASPNETCORE_ENVIRONMENT=Development` é necessário para ativar o endpoint OTLP definido em `App_Data/appsettings.Development.json`, que envia telemetria para o OTel Collector.

---

## Passo 4 — Na primeira instalação

Na primeira execução, o nopCommerce redireciona automaticamente para `http://localhost:5000/install`.

![Wizard de instalação do nopCommerce](./img/inicialConfig.png)

Preenche o formulário da seguinte forma:

**Store information**
| Campo | Valor |
|---|---|
| Admin user email | qualquer email (ex: `admin@admin.com`) |
| Admin user password | password à tua escolha |
| Confirm the password | repetir a password |
| Country | Um qualquer |
| Create sample data | ✅ **Activar** (necessário para os testes de carga — fornece produtos e dados de exemplo) |

**Database information**
| Campo | Valor |
|---|---|
| Database | **PostgreSQL** |
| Enter raw connection string (advanced) | ✔ activar |
| Connection string | `Host=localhost;Database=nopcommerce;Username=postgres;Password=nopCommerce_db_password` |

Clica em **Install** e aguarda (1-2 minutos). O wizard escreve a connection string em `App_Data/appsettings.json` e a app fica disponível em `http://localhost:5000`.

> Nas execuções seguintes, o wizard não aparece — a app arranca diretamente.

---

## Resolução de Problemas

### Erro: "relation already exists" no arranque

O FluentMigrator falha quando o esquema da base de dados já existe mas a tabela `MigrationVersionInfo` não tem os registos correspondentes. Isto acontece quando a base de dados foi parcialmente inicializada.

**Solução — reinstalar de raiz:**

```bash
# 1. Apagar e recriar a base de dados
docker exec nopcommerce_postgres_server \
  psql -U postgres -c "DROP DATABASE IF EXISTS nopcommerce; CREATE DATABASE nopcommerce;"

docker exec nopcommerce_postgres_server \
  psql -U postgres -d nopcommerce -c "CREATE EXTENSION IF NOT EXISTS citext;"

# 2. Limpar a connection string para forçar o wizard de instalação
# Editar App_Data/appsettings.json e colocar ConnectionString a vazio:
#   "ConnectionStrings": { "ConnectionString": "", ... }

# 3. Arrancar o nopCommerce — redireciona automaticamente para /install
ASPNETCORE_ENVIRONMENT=Development dotnet run --urls "http://localhost:5000"
```

Preencher o wizard em `http://localhost:5000/install` com os dados acima. O wizard semeia todos os dados iniciais e repõe a connection string em `appsettings.json`.

> **Porquê acontece:** o nopCommerce determina se está instalado verificando se `ConnectionStrings.ConnectionString` em `appsettings.json` não está vazio. Se a connection string existe mas a base de dados não tem dados, a app tenta carregar configurações e falha. Apagar a base de dados e limpar a connection string repõe o estado inicial correcto.

### Erro: "No store could be loaded" no arranque

Mesmo sintoma que acima — a base de dados tem o esquema mas não tem dados (wizard não foi concluído). Aplicar a mesma solução: apagar a BD, limpar a connection string, correr o wizard.

---

## Passo 5 — Verificar que a observabilidade está activa

| UI | URL | O que ver |
|---|---|---|
| nopCommerce | http://localhost:5000 | Loja |
| Jaeger | http://localhost:16686 | Traces |
| Prometheus | http://localhost:9090 | Métricas |
| Grafana | http://localhost:3000 | Dashboards (user: `admin`, pass: `admin`) |

No **Jaeger**, selecciona o serviço `nopcommerce` e clica em **Find Traces** — deverás ver traces dos pedidos HTTP que fizeste.

---

## Parar tudo

```bash
# Parar o nopCommerce
# (Ctrl+C na consola onde está a correr)

# Parar os containers
docker stop nopcommerce_postgres_server
cd nopCommerce/observability
docker compose -f docker-compose.observability.yml down
```

