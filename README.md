# AS — Individual Project

| | |
|---|---|
| **Cadeira** | Arquitetura de Software |
| **Aluno** | Duarte Rainho dos Santos |
| **Número Mecanográfico** | 113304 |
| **Assignment** | Assignment 1 |
| **Data de entrega** | 2026-03-24 |

---

## Sobre o projecto

Este projecto consiste na instrumentação de observabilidade de uma aplicação e-commerce open-source, **nopCommerce**, utilizando **OpenTelemetry**.

O objectivo é adicionar traces, métricas e logs distribuídos ao fluxo de checkout, tornando o sistema observável através de uma stack de ferramentas standard: **OTel Collector**, **Jaeger**, **Prometheus** e **Grafana**.

---

## Documentação

| Documento | Descrição |
|---|---|
| [Como correr](docs/Running.md) | Guia passo a passo para arrancar o projecto |
| [Arquitectura](./docs/Architecture-Analysis/Architecture.md) | Camadas, regras de dependência e comunicação |
| [IEventPublisher](./docs/Architecture-Analysis/IEventPublisher.md) | Sistema de eventos in-process do nopCommerce |
| [Observabilidade — Fácil vs Difícil](./docs/Architecture-Analysis/Observability-Easy-vs-Hard.md) | Onde a instrumentação é natural e onde é problemática |
| [Mudanças Estruturais](./docs/Architecture-Analysis/Structural-Changes.md) | O que falta instrumentar e se vale a pena mudar |
