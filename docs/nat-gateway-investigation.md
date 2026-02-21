# NAT Gateway Traffic Investigation

**Data:** Jan 8 - Feb 20, 2026
**Conta AWS:** 611816806956
**NAT Gateway:** nat-0feb44d9fc97ab816 (ENI: eni-040dde95bd87c4a68)
**NAT Gateway IP:** 10.100.8.123
**VPC:** vpc-01eaf18b9dd0c7dbf

---

## Tráfego Diário (BytesInFromDestination)

| Data (BRT) | GB | Obs |
|---|---|---|
| Jan 08 | 273 | |
| Jan 09 | 355 | |
| Jan 10 | 56 | |
| **Jan 11** | **850** | **SPIKE** |
| Jan 12 | 413 | elevado |
| **Jan 13** | **1,173** | **MEGA SPIKE** |
| Jan 14 | 108 | |
| Jan 15 | 138 | |
| Jan 16 | 63 | |
| Jan 17 | 57 | |
| Jan 18 | 105 | |
| Jan 19 | 156 | |
| Jan 20 | 133 | |
| Jan 21 | 194 | |
| Jan 22 | 103 | |
| Jan 23 | 80 | |
| Jan 24 | 57 | |
| Jan 25 | 188 | |
| Jan 26 | 80 | |
| Jan 27 | 146 | |
| Jan 28 | 158 | |
| Jan 29 | 91 | |
| Jan 30 | 59 | |
| Jan 31 | 51 | |
| Feb 01 | 93 | |
| Feb 02 | 115 | |
| Feb 03 | 70 | |
| Feb 04 | 72 | |
| Feb 05 | 78 | |
| Feb 06 | 79 | |
| Feb 07 | 62 | |
| **Feb 08** | **427** | **SPIKE** |
| **Feb 09** | **513** | **SPIKE** |
| Feb 10 | 175 | |
| Feb 11 | 214 | |
| **Feb 12** | **1,587** | **MEGA SPIKE** |
| Feb 13 | 513 | elevado |
| Feb 14 | 16 | mínimo |
| **Feb 15** | **1,753** | **MEGA SPIKE** |
| Feb 16 | 421 | elevado |
| Feb 17 | 128 | |
| Feb 18 | 143 | |
| Feb 19 | 287 | |

## Padrão Identificado

- **Mega spikes (>800 GB):** Jan 11, Jan 13, Feb 12, Feb 15
- **Spikes médios (400-800 GB):** Jan 12, Feb 08, Feb 09, Feb 13, Feb 16
- **Normal (50-200 GB):** maioria dos dias
- Spikes vêm em **clusters de 2-3 dias** seguidos (Jan 11-13, Feb 08-09, Feb 12-13, Feb 15-16)

## Breakdown do Tráfego (flow logs - tráfego normal)

| Destino | % Inbound | Notas |
|---|---|---|
| MongoDB (157.245.1.66) | 87.6% | kodus-mongodb-prod (DigitalOcean) |
| Google/Gemini APIs | ~2.3% | PromptRunner |
| GitHub | ~3.3% | Git operations |
| Bitbucket | ~2.1% | Git operations |
| Outros | ~4.7% | |

## Características dos Spikes

- **Ratio BytesIn:BytesOut** durante picos: até **87:1** (reads massivos do MongoDB)
- **Packets MTU-saturated** (~1489 bytes/packet): streaming de dados em bulk
- **ActiveConnectionCount** praticamente constante (~700): não são novas conexões, são reads grandes nas conexões existentes
- Projeção em dia normal: ~13 GB/dia

## Hipóteses Descartadas

### 1. `findOneAndUpdate({ new: true })` retornando documentos inteiros
- **Arquivo:** `libs/platformData/infrastructure/adapters/repositories/pullRequests.repository.ts`
- `updateFile()`, `addFileToPullRequest()`, `addSuggestionToFile()` usam `{ new: true }`
- MongoDB tem limite de 16 MB por documento BSON
- Mesmo com 1605 operações: 1605 × 16 MB = ~25 GB (máx)
- **Não explica 1.5 TB**

### 2. KodyLearning Cron
- `findSuggestionsByRuleId()` e `findPullRequestsWithDeliveredSuggestions()` fazem aggregates pesados sem limit
- **Verificação:** cron NÃO rodou nos dias de spike (Feb 13, Feb 16), mas rodou em dia normal (Feb 14 com apenas 15 GB)
- **Descartado completamente**

### 3. Airbyte (kodus-services-v2)
- Verificado: está em **subnet pública** com IP público
- **Não passa pelo NAT Gateway**

## Issues no Código (para correção futura)

### `{ new: true }` desnecessário
- `pullRequests.repository.ts` linhas 924-950 (`updateFile`)
- `pullRequests.repository.ts` linhas 834-860 (`addFileToPullRequest`)
- `pullRequests.repository.ts` linhas 862-890 (`addSuggestionToFile`)
- Retornam o documento inteiro quando o caller não precisa do retorno

### Queries aggregate sem limit
- `findSuggestionsByRuleId()` (linhas 457-530): duas pipelines com `$unwind` duplo, sem limit
- `findPullRequestsWithDeliveredSuggestions()` (linhas 532-602): unwind em files e suggestions sem limit
- `find()` (linha 61-63): find genérico sem limit nem paginação

### Guard de 500 arquivos possivelmente bypassado
- `fetch-changed-files.stage.ts` linha 203: guard usa `filteredFiles` (pós-ignorePaths)
- PR#5608 processou 1605 arquivos em 2 traces paralelos (1155 + 450)

## Infraestrutura de Monitoramento Criada

| Recurso | Identificador |
|---|---|
| Flow Log | `fl-0f2844dcbdae38e39` (no ENI do NAT) |
| Log Group | `/vpc/nat-gateway-flow-logs` (retenção 7 dias) |
| Alarme BytesIn | `NAT-Gateway-High-BytesIn` (>10 GB/hora) |
| Alarme BytesOut | `NAT-Gateway-High-BytesOut` (>10 GB/hora) |
| SNS Topic | `arn:aws:sns:us-east-1:611816806956:kodus-prod-alerts` |
| Notificação | wellington.santana@kodus.io |

## Próximos Passos

1. **Esperar próximo spike** - flow logs + alarmes vão capturar o IP/porta exato gerando o tráfego
2. **Correlacionar spikes com PRs** - cruzar dias de spike com PRs grandes processadas por clientes
3. **Corrigir código** - remover `{ new: true }`, adicionar limits nos aggregates
4. **Investigar bypass do guard de 500 arquivos** - como PR#5608 processou 1605 files
