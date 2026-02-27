# 🥩 Biazzi Empório da Carne — Sistema de Pedidos

Sistema web para gestão de reservas, pagamentos e estatísticas de vendas.

**Stack:** Node.js 20 · Express · PostgreSQL  
**Hospedagem:** Render.com (gratuito)  
**URL:** https://biazzi-emporio.onrender.com

---

## 📱 Funcionalidades

- **Nova Reserva** — cadastro de clientes com itens, quantidades, preços e forma de pagamento
- **Reservas** — pedidos pendentes aguardando retirada e pagamento
- **Histórico** — pedidos pagos e cancelados, agrupados por data (mais recente primeiro)
- **Estatísticas** — receita, kg de carne, unidades de frango por período ou dia específico
- **WhatsApp** — resumo automático todo domingo às 20h via CallMeBot

---

## 🚀 Deploy no Render (passo a passo)

### 1. Subir o código no GitHub

```bash
cd churrascoapp
git init
git add .
git commit -m "Biazzi Empório da Carne v1.0"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/biazzi-emporio.git
git push -u origin main
```

### 2. Criar o banco PostgreSQL

1. Acesse [render.com](https://render.com) → **New → PostgreSQL**
2. **Name:** `biazzi-db` · **Plan:** Free
3. Clique em **Create Database**

### 3. Criar o Web Service

1. **New → Web Service** → conecte o repositório GitHub
2. O Render detecta o `render.yaml` automaticamente
3. Clique em **Create Web Service**

### 4. Variáveis de ambiente

No painel do serviço → aba **Environment**, adicione:

| Key | Value |
|-----|-------|
| `DATABASE_URL` | connection string do banco criado no passo 2 |
| `TZ` | `America/Sao_Paulo` |
| `WHATSAPP_PHONE` | número com DDI, ex: `5541999998888` |
| `CALLMEBOT_APIKEY` | chave recebida pelo CallMeBot |

### 5. Pronto

Após o deploy, o app estará em:
```
https://biazzi-emporio.onrender.com
```

> ⚠️ **Plano gratuito:** o app "dorme" após 15 min sem uso e leva ~30s para acordar na primeira abertura. Como o uso é aos domingos, isso não impacta a operação.

---

## 📲 Ativar WhatsApp (CallMeBot)

1. Adicione o contato **+34 644 44 79 30** na agenda
2. Envie a mensagem: `I allow callmebot to send me messages`
3. Você receberá sua `apikey` em alguns segundos
4. Cole a chave na variável `CALLMEBOT_APIKEY` no Render

O resumo é enviado automaticamente **todo domingo às 20h**.  
Envio manual disponível na aba **Estatísticas → 📲 Resumo por WhatsApp**.

---

## 💻 Rodar localmente

> Requer Node.js v20 e PostgreSQL instalados.

```bash
# Instalar dependências
npm install

# Configurar variáveis (copie o modelo)
cp .env.example .env
# Edite o .env com sua DATABASE_URL local

# Iniciar
npm start

# Acesse
http://localhost:3000
```

---

## 🔄 Atualizar após melhorias

```bash
git add .
git commit -m "descrição da melhoria"
git push
```

O Render detecta o push e faz o redeploy automaticamente.

---

## 📁 Estrutura do projeto

```
churrascoapp/
├── server.js           ← API REST + agendador WhatsApp
├── package.json
├── render.yaml         ← Configuração do Render (web + banco)
├── Procfile
├── .gitignore
├── .env.example        ← Modelo de variáveis de ambiente
├── README.md
└── public/
    └── index.html      ← Frontend responsivo (mobile/tablet/desktop)
```

---

## 🔌 Endpoints da API

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/orders` | Listar pedidos |
| POST | `/api/orders` | Criar pedido |
| PUT | `/api/orders/:id` | Editar / mudar status |
| DELETE | `/api/orders/:id` | Remover pedido |
| GET | `/api/history` | Histórico |
| GET | `/api/stats` | Estatísticas |
| POST | `/api/whatsapp/send-summary` | Enviar resumo agora |
| GET | `/api/whatsapp/preview` | Prévia do resumo |
