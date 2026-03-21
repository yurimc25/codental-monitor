# Codental Monitor — Gmail → Upload Automático

Sistema server-side que roda 100% na Vercel (sem extensão de navegador).
Monitora emails não lidos, identifica o paciente pelo nome, verifica duplicatas,
faz upload direto para o Codental e marca o email como lido.

## Como funciona

```
Vercel Cron (a cada 15 min)
  → Gmail API: busca emails NÃO LIDOS com has:attachment e keywords
  → Para cada email:
      → Extrai nome do paciente (assunto / corpo)
      → Busca paciente no Codental por nome
      → Para cada anexo:
          → Verifica se já existe no prontuário (duplicata → pula)
          → Download do anexo via Gmail API
          → Upload via Rails Active Storage para /patients/:id/uploads
      → Marca email como LIDO no Gmail
      → Salva log no MongoDB
  → Dashboard Vercel exibe logs em tempo real
```

## Setup — passo a passo

### 1. Google Cloud Console

1. Acesse https://console.cloud.google.com
2. Crie um projeto
3. APIs e Serviços → Biblioteca → **Gmail API** → Ativar
4. APIs e Serviços → Credenciais → **Criar Credenciais → ID do cliente OAuth 2.0**
   - Tipo: Aplicativo da Web
   - URI de redirecionamento autorizado: `https://SEU-PROJETO.vercel.app/api/gmail/callback`
5. Copie **Client ID** e **Client Secret**

### 2. MongoDB Atlas

1. Crie cluster gratuito em https://mongodb.com
2. Crie banco `codental_monitor`
3. Copie a connection string (formato `mongodb+srv://...`)

### 3. Vercel

```bash
npx vercel login
npx vercel   # na pasta do projeto — anote a URL gerada
```

Adicione todas as variáveis do `.env.example` em **Vercel → Settings → Environment Variables**.

Atualize `GOOGLE_REDIRECT_URI` com a URL real do projeto antes de criar as credenciais OAuth.

### 4. Conectar Gmail

Acesse o dashboard (`https://SEU-PROJETO.vercel.app`) e clique em **"Conectar Gmail"**.
Após autorizar, os tokens são salvos no MongoDB e o monitoramento começa.

### 5. Verificar endpoint de busca do Codental

O sistema tenta automaticamente 4 endpoints diferentes. Para confirmar qual funciona:
1. Abra o Codental no navegador
2. Vá para a listagem de pacientes
3. Abra o DevTools (F12) → Aba Network
4. Digite um nome no campo de busca
5. Observe qual URL é chamada (ex: `/patients.json?q=...`)

Ajuste o array `endpoints` em `lib/codental.js` se necessário.

## Dashboard

| Campo | Descrição |
|---|---|
| ↑ | Arquivos enviados com sucesso |
| ≡ | Duplicatas detectadas e puladas |
| ✕ | Erros no upload |
| Status verde | Email processado, todos os anexos enviados |
| Status âmbar | Duplicata (arquivo já existia no prontuário) |
| Status vermelho | Erro no upload |
| Sem paciente | Nome não encontrado no Codental |

Clique em qualquer linha para ver detalhes completos do email e de cada anexo.

## Extração de nome do paciente

O sistema usa 4 camadas em ordem de confiança:

1. **Padrões explícitos no assunto** (alta): `"Tomografia - João Silva"`, `"Paciente: Ana Lima"`
2. **Padrões explícitos no corpo** (alta): mesmos padrões no texto do email  
3. **Heurística no assunto** (média): sequências de 2+ palavras capitalizadas
4. **Heurística no corpo** (baixa): nas primeiras 8 linhas do email

## Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth Client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth Client Secret |
| `GOOGLE_REDIRECT_URI` | URL de callback OAuth |
| `GMAIL_ACCESS_TOKEN` | Preenchido automaticamente |
| `GMAIL_REFRESH_TOKEN` | Preenchido automaticamente |
| `CODENTAL_BASE_URL` | URL base do Codental |
| `CODENTAL_EMAIL` | Email de login |
| `CODENTAL_PASSWORD` | Senha de login |
| `MONGODB_URI` | Connection string MongoDB |
| `CRON_SECRET` | Usado pelo Vercel para autenticar o cron |
| `API_KEY` | Usado pelo dashboard para disparo manual |
