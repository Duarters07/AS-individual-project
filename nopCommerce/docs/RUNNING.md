# Como Correr o Projecto

## Pré-requisitos

| Ferramenta | Versão mínima | Verificar |
|---|---|---|
| .NET SDK | 9.0 | `dotnet --version` |
| ASP.NET Core Runtime | 9.0 | `dotnet --info \| grep AspNetCore` |
| Docker + Docker Compose | qualquer recente | `docker compose version` |

Se algum estiver em falta (Arch Linux):
```bash
sudo pacman -S dotnet-sdk-9.0 aspnet-runtime-9.0
```

---

## Passo 1 — Arrancar a infra de observabilidade

```bash
cd /home/duarte/Documents/UA-MEI-Projects/AS

docker compose -f docker-compose.observability.yml up -d
```

Confirmar que os 4 containers estão `Up`:
```bash
docker compose -f docker-compose.observability.yml ps
```

Deverás ver:
```
NAME                  STATUS
as-otel-collector-1   Up
as-jaeger-1           Up
as-prometheus-1       Up
as-grafana-1          Up
```

---

## Passo 2 — Arrancar o nopCommerce

```bash
cd /home/duarte/Documents/UA-MEI-Projects/AS/nopCommerce/src/Presentation/Nop.Web

dotnet run
```

Aguarda até ver na consola:
```
Now listening on: http://localhost:5000
Application started.
```

---

## Passo 3 — Instalar o nopCommerce (primeira vez)

Abre `http://localhost:5000` no browser. O nopCommerce redireciona para o wizard de instalação em `/install`.

Preenche os campos:
- **Store information**: nome da loja (qualquer)
- **Admin account**: email e password (guarda estes dados)
- **Database**: escolhe **SQLite** (mais simples para dev, sem instalar servidor)
  - Deixa o caminho por defeito

Clica em **Install** e aguarda (pode demorar 1-2 minutos).

Após a instalação a app fica disponível em `http://localhost:5000`.

---

## Passo 4 — Verificar que a observabilidade está activa

Abre os UIs:

| UI | URL | O que ver |
|---|---|---|
| nopCommerce | http://localhost:5000 | Loja |
| Jaeger | http://localhost:16686 | Traces |
| Prometheus | http://localhost:9090 | Métricas |
| Grafana | http://localhost:3000 | Dashboards |

No **Jaeger**, selecciona o serviço `nopcommerce` e clica em **Find Traces** — deverás ver traces dos pedidos HTTP que fizeste.

---

## Parar tudo

```bash
# Parar o nopCommerce
# (Ctrl+C na consola onde está a correr)

# Parar os containers de observabilidade
cd /home/duarte/Documents/UA-MEI-Projects/AS
docker compose -f docker-compose.observability.yml down
```

---

## Compilar sem correr

```bash
cd /home/duarte/Documents/UA-MEI-Projects/AS/nopCommerce/src/Presentation/Nop.Web
dotnet build
```

---

## Variáveis de ambiente úteis

| Variável | Valor | Efeito |
|---|---|---|
| `ASPNETCORE_ENVIRONMENT` | `Development` | Carrega `appsettings.Development.json` (endpoint OTLP configurado) |
| `ASPNETCORE_ENVIRONMENT` | `Production` | Padrão quando se usa `dotnet run` sem mais nada |

Para arrancar em modo Development:
```bash
ASPNETCORE_ENVIRONMENT=Development dotnet run
```

---

## Estrutura de directorias relevante

```
AS/
├── docker-compose.observability.yml   ← stack de observabilidade
├── observability/
│   ├── otelcol-config.yml             ← config do OTel Collector
│   ├── prometheus.yml                 ← config do Prometheus
│   └── grafana/
│       └── provisioning/
│           └── datasources/
│               └── datasources.yml    ← datasources automáticos do Grafana
├── docs/                              ← esta pasta
└── nopCommerce/
    └── src/
        └── Presentation/
            └── Nop.Web/
                └── App_Data/
                    └── appsettings.Development.json  ← endpoint OTLP
```
