# TODO: Correções RabbitMQ — "RabbitMQ is not connected"

## Contexto

O erro `Outbox message permanently failed ... Error: RabbitMQ is not connected` acontece por uma cadeia de problemas:

1. Consumers não fazem ACK a tempo → RabbitMQ server mata o channel (`consumer_timeout = 7200000ms`)
2. A app usa uma única conexão TCP com um único channel default para publishers e consumers
3. Quando o channel morre, a conexão oscila e `amqpConnection.connected` retorna `false`
4. O Outbox Relay tenta publicar nesse momento, falha 3x em ~14s, e marca a mensagem como permanently failed

Nos últimos 3 dias (logs CloudWatch do RabbitMQ prod):
- **13 timeouts** na fila `codeReviewFeedback.syncCodeReviewReactions.queue`
- **1 timeout** na fila `workflow.jobs.webhook.queue`
- Todas as conexões fechadas com: `delivery acknowledgement on channel timed out. Timeout value used: 7200000 ms`

---

## Fix 1 — Separar channels por tipo de consumer (isolamento de falha)

**Problema:** Tudo roda no channel default — publishers e consumers. Quando o RabbitMQ mata o channel de um consumer por timeout, o publisher também é afetado.

**Arquivos:**
- `libs/core/infrastructure/queue/rabbitmq.module.ts`
- `libs/core/workflow/infrastructure/workflow-job-consumer.service.ts`
- `libs/core/infrastructure/queue/messageBroker/consumers/codeReviewFeedback.consumer.ts`

**O que fazer:**

1. No `rabbitmq.module.ts`, adicionar named channels na config do `RabbitMQModule.forRootAsync`:

```typescript
return {
    // ... config existente ...
    prefetchCount: 5, // channel default (usado pelo publisher)
    channels: {
        'channel-webhook': {
            prefetchCount: 20,
            default: false,
        },
        'channel-code-review': {
            prefetchCount: 2, // poucos em paralelo, jobs longos
            default: false,
        },
        'channel-check-implementation': {
            prefetchCount: 5,
            default: false,
        },
        'channel-feedback': {
            prefetchCount: 5,
            default: false,
        },
    },
};
```

2. No `workflow-job-consumer.service.ts`, associar cada `@RabbitSubscribe` ao channel correto via `queueOptions.channel`:
   - `workflow.jobs.webhook.queue` → `channel: 'channel-webhook'`
   - `workflow.jobs.code_review.queue` → `channel: 'channel-code-review'`
   - `workflow.jobs.check_implementation.queue` → `channel: 'channel-check-implementation'`
   - Aplicar nos decorators do exchange principal E do delayed (são 6 decorators no total)

3. No `codeReviewFeedback.consumer.ts`, associar ao channel:
   - `codeReviewFeedback.syncCodeReviewReactions.queue` → `channel: 'channel-feedback'`

**Resultado:** Se o channel de code review morrer por timeout, o publisher e os outros consumers continuam funcionando.

---

## Fix 2 — Race condition: `CODE_REVIEW_PROCESS_TIMEOUT_MS` == `consumer_timeout`

**Problema:** O timeout de code review no app é `2 * 60 * 60 * 1000 = 7200000ms`, que é **exatamente** o mesmo valor do `consumer_timeout` do RabbitMQ server (7200000ms). Se um code review leva 1h59m55s, até o handler retornar e o ACK ser enviado pelo wire, já passou de 2h. O RabbitMQ mata o channel antes do ACK chegar.

**Arquivo:** `libs/core/workflow/infrastructure/job-processor-router.service.ts:20`

**O que fazer:**

```typescript
// Antes
const CODE_REVIEW_PROCESS_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 7200000ms

// Depois — 1h50m, dando 10 min de margem para o ACK chegar ao RabbitMQ
const CODE_REVIEW_PROCESS_TIMEOUT_MS = 110 * 60 * 1000; // 6600000ms
```

**Nota:** O `consumer_timeout` no RabbitMQ server (infra) também será aumentado para 2h30m como safety net (ver Fix 6).

---

## Fix 3 — Fallback ACK nos errorHandlers quando `RabbitMQErrorHandler.instance` é undefined

**Problema:** Todos os `@RabbitSubscribe` usam:
```typescript
errorHandler: (channel, msg, err) =>
    RabbitMQErrorHandler.instance?.handle(channel, msg, err, { ... })
```

O optional chaining `?.` significa que se `RabbitMQErrorHandler.instance` for `undefined` (possível durante inicialização ou race condition no bootstrap), o handler retorna `undefined` → **nenhum ACK acontece** → a mensagem fica unacked até o `consumer_timeout` de 2h → RabbitMQ mata o channel → afeta toda a conexão.

**Arquivos:**
- `libs/core/workflow/infrastructure/workflow-job-consumer.service.ts` (6 decorators)
- `libs/core/infrastructure/queue/messageBroker/consumers/codeReviewFeedback.consumer.ts` (1 decorator)

**O que fazer:** Substituir TODOS os errorHandlers pelo padrão com fallback:

```typescript
errorHandler: (channel, msg, err) => {
    if (RabbitMQErrorHandler.instance) {
        return RabbitMQErrorHandler.instance.handle(channel, msg, err, {
            dlqRoutingKey: 'workflow.job.failed',
        });
    }
    // Fallback: ACK para não deixar mensagem presa por 2h
    channel.ack(msg);
},
```

**Aplicar em:**
- `handleWebhookProcessingJob` — exchange principal + delayed (2 decorators)
- `handleCodeReviewJob` — exchange principal + delayed (2 decorators)
- `handleImplementationCheckJob` — exchange principal + delayed (2 decorators)
- `handleSyncCodeReviewReactions` — 1 decorator

---

## Fix 4 — Outbox Relay: checar conexão antes de queimar tentativas

**Problema:** O método `processOutbox()` faz `claimBatch()` (que incrementa tentativas no banco) e tenta publicar mesmo quando o RabbitMQ está sabidamente desconectado. Com apenas 3 tentativas e backoff de 2s/4s/8s, a janela total é ~14 segundos. O reconnect leva 10s+. As 3 tentativas são queimadas antes da reconexão.

**Arquivos:**
- `libs/core/domain/contracts/message-broker.service.contracts.ts`
- `libs/core/infrastructure/queue/messageBroker/messageBroker.service.ts`
- `libs/core/workflow/infrastructure/outbox-relay.service.ts`

**O que fazer:**

1. Adicionar `isConnected()` na interface `IMessageBrokerService`:

```typescript
// Em message-broker.service.contracts.ts
export interface IMessageBrokerService {
    isConnected(): boolean; // NOVO
    publishMessage(config: BrokerConfig, message: MessagePayload, options?: BrokerPublishOptions): Promise<void>;
    transformMessageToMessageBroker<T = any>(...): MessagePayload<T>;
}
```

2. Implementar no `MessageBrokerService`:

```typescript
// Em messageBroker.service.ts
isConnected(): boolean {
    return !!this.amqpConnection?.connected;
}
```

3. Checar no início de `processOutbox()` no `outbox-relay.service.ts`:

```typescript
async processOutbox(): Promise<number> {
    // Não gastar tentativas se RabbitMQ está desconectado
    if (!this.messageBroker.isConnected()) {
        this.logger.debug({
            message: 'RabbitMQ disconnected, skipping outbox relay cycle',
            context: OutboxRelayService.name,
        });
        return 0; // adaptive polling vai desacelerar naturalmente
    }

    // ... resto do método igual
    const messages = await this.outboxRepository.claimBatch(
        this.BATCH_SIZE,
        this.instanceId,
    );
    // ...
}
```

---

## Fix 5 — Aumentar `WORKFLOW_OUTBOX_MAX_ATTEMPTS` de 3 para 10

**Problema:** 3 tentativas com backoff exponencial (2s, 4s, 8s) = ~14 segundos de janela. Insuficiente para qualquer instabilidade de conexão.

**Tipo:** Config (SSM Parameter ou env var, sem mudança de código)

**O que fazer:** Setar a variável de ambiente:
```
WORKFLOW_OUTBOX_MAX_ATTEMPTS=10
```

Com backoff exponencial (2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 512s, 1024s) e cap de 1h, isso dá ~34 minutos de janela. Combinado com o Fix 4 (que evita queimar tentativas quando desconectado), a robustez é muito maior.

**Onde:** SSM Parameter `/prod/kodus-orchestrator/` ou no task definition do ECS.

---

## Fix 6 — (Infra) Aumentar `consumer_timeout` no RabbitMQ server para 2h30m

**Problema:** Mesmo com o Fix 2 (app timeout de 1h50m), é bom ter margem no server como safety net.

**Arquivo (repo kodus-infra):** `envs/aws/prod/rabbitmq-ec2.tfvars:55`

**O que fazer:**
```hcl
# Antes
rabbitmq_additional_config = "consumer_timeout = 7200000"  # 2h

# Depois
rabbitmq_additional_config = "consumer_timeout = 9000000"  # 2h30m
```

**Nota:** Isso requer apply do Terraform e rolling restart dos nodes do RabbitMQ.

---

## Resumo

| # | Fix | Tipo | Impacto |
|---|-----|------|---------|
| 1 | Separar channels por consumer | Código | Isola falha — channel de code review morrendo não afeta publisher |
| 2 | `CODE_REVIEW_PROCESS_TIMEOUT_MS` 2h → 1h50m | Código | Elimina race condition entre app timeout e consumer_timeout |
| 3 | Fallback ACK nos errorHandlers | Código | Impede mensagens ficarem unacked por 2h quando instance é undefined |
| 4 | Outbox Relay checar conexão antes do claimBatch | Código | Não queima tentativas quando RabbitMQ está sabidamente fora |
| 5 | `WORKFLOW_OUTBOX_MAX_ATTEMPTS` 3 → 10 | Config | Janela de retry de ~14s para ~34min |
| 6 | `consumer_timeout` 2h → 2h30m | Infra | Safety net para o Fix 2 |

## Arquivos afetados (kodus-ai)

- `libs/core/infrastructure/queue/rabbitmq.module.ts` — Fix 1
- `libs/core/workflow/infrastructure/workflow-job-consumer.service.ts` — Fix 1, Fix 3
- `libs/core/infrastructure/queue/messageBroker/consumers/codeReviewFeedback.consumer.ts` — Fix 1, Fix 3
- `libs/core/workflow/infrastructure/job-processor-router.service.ts` — Fix 2
- `libs/core/domain/contracts/message-broker.service.contracts.ts` — Fix 4
- `libs/core/infrastructure/queue/messageBroker/messageBroker.service.ts` — Fix 4
- `libs/core/workflow/infrastructure/outbox-relay.service.ts` — Fix 4

## Arquivos afetados (kodus-infra)

- `envs/aws/prod/rabbitmq-ec2.tfvars` — Fix 6
