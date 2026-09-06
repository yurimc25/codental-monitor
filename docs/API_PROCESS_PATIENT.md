# API — Processar paciente por nome

Endpoint para requisições externas: recebe o nome de uma pessoa, verifica se há
emails no Gmail com anexos mencionando esse nome, identifica o paciente
correspondente no Codental e envia apenas os arquivos ainda não enviados
diretamente para o prontuário dela.

## Endpoint

```
POST /api/process-patient
```

## Autenticação

Use **um** dos dois métodos abaixo:

| Header | Valor |
|---|---|
| `x-api-key` | valor de `API_KEY` (env var) — padrão `Deuse10` |
| `Authorization` | `Bearer <CRON_SECRET>` |

## Body (JSON)

| Campo | Tipo | Obrigatório | Padrão | Descrição |
|---|---|---|---|---|
| `name` | string | sim | — | Nome da pessoa a buscar nos emails |
| `days` | number | não | `365` | Quantos dias retroativos buscar no Gmail |
| `include_read` | boolean | não | `true` | Se `false`, busca só emails não lidos |

## Exemplo de requisição

```bash
curl -X POST https://SEU_DOMINIO/api/process-patient \
  -H "Content-Type: application/json" \
  -H "x-api-key: Deuse10" \
  -d '{"name": "Maria Silva", "days": 180}'
```

## Respostas

### 200 — Sucesso (paciente encontrado, com ou sem emails)

```json
{
  "ok": true,
  "patient_id": "12345",
  "patient_name": "Maria Silva",
  "emails_found": 3,
  "emails_processed": 3,
  "att_uploaded": 2,
  "att_duplicate": 1,
  "att_error": 0,
  "errors": []
}
```

- `att_uploaded`: arquivos novos enviados ao Codental.
- `att_duplicate`: arquivos já existentes (pulados, não reenviados).
- `att_error`: falhas de upload (detalhes ausentes no summary; ver logs).

### 400 — Requisição inválida

```json
{ "ok": false, "error": "Campo \"name\" é obrigatório." }
```

### 401 — Não autorizado

```json
{ "ok": false, "error": "Não autorizado" }
```

### 404 — Paciente não encontrado

Quando não há match com confiança suficiente (score ≥ 0.90) no Codental:

```json
{
  "ok": false,
  "reason": "patient_not_found",
  "message": "Nenhum paciente encontrado com confiança suficiente para \"Maria Silva\".",
  "suggestions": [
    { "id": "555", "name": "Maria Silva Souza", "score": 0.72 }
  ]
}
```

### 500 — Erro interno

```json
{ "ok": false, "error": "mensagem do erro" }
```

## Comportamento

1. Busca o paciente no Codental (base local + fallback via API) pelo nome enviado.
2. Se não achar um match confiável, retorna `404` com sugestões (se houver).
3. Busca no Gmail emails com anexo que mencionem o nome, dentro do período (`days`).
4. Para cada email encontrado, verifica duplicidade (por nome de arquivo e por
   tamanho+extensão) contra o histórico já enviado **daquele paciente**.
5. Envia somente os arquivos únicos diretamente para o prontuário do paciente
   no Codental e marca os emails processados como lidos.
6. Cada email processado gera um registro em `email_logs` (mesma coleção usada
   pelo restante do sistema), com `source: "process_by_name"`.
