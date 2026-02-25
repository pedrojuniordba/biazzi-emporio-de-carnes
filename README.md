# 🥩 Biazzi Empório da Carne — Sistema de Pedidos

**Stack:** Node.js 20+ · Express · SQLite (better-sqlite3)  
**Hospedagem:** Render.com (gratuito)

---

## ⚡ Rodar local (desenvolvimento)

> Requer Node.js v20. Use `nvm use 20` se necessário.

```bash
npm install
npm start
# Acesse: http://localhost:3000
```

---

## 🌐 Deploy no Render (gratuito)

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

### 2. Criar o serviço no Render

1. Acesse [render.com](https://render.com) e crie uma conta gratuita
2. Clique em **New → Web Service**
3. Conecte sua conta do GitHub e selecione o repositório
4. O Render detecta o `render.yaml` automaticamente — clique em **Apply**

### 3. Adicionar o disco persistente (banco de dados)

1. No painel do serviço → aba **Disks**
2. Clique em **Add Disk**
3. Preencha:
   - **Name:** `biazzi-data`
   - **Mount Path:** `/data`
   - **Size:** 1 GB
4. Clique em **Save**

### 4. Configurar variáveis de ambiente

No painel do serviço → aba **Environment**, adicione:

| Key | Value |
|-----|-------|
| `DATA_DIR` | `/data` |
| `TZ` | `America/Sao_Paulo` |
| `WHATSAPP_PHONE` | seu número com DDI ex: `5541999998888` |
| `CALLMEBOT_APIKEY` | chave recebida pelo CallMeBot |

### 5. Fazer o deploy

Clique em **Deploy** — em alguns minutos o app estará online com uma URL pública no formato:
```
https://biazzi-emporio.onrender.com
```

Compartilhe essa URL com seu cliente — funciona em qualquer celular, tablet ou computador.

---

## 📲 WhatsApp — Ativar CallMeBot (1 vez só)

1. Adicione o contato **+34 644 44 79 30** na agenda
2. Envie a mensagem: `I allow callmebot to send me messages`
3. Você receberá sua `apikey` em resposta
4. Cole essa chave na variável `CALLMEBOT_APIKEY` no Render

O resumo é enviado automaticamente **todo domingo às 20h**.  
Você também pode enviar manualmente pelo app: aba **Estatísticas → 📲 Resumo por WhatsApp**.

---

## ⚠️ Importante — Free tier do Render

O plano gratuito do Render coloca o app para "dormir" após **15 minutos sem uso**.  
Na primeira abertura após o sono, o app demora ~30 segundos para acordar — isso é normal.

Como o app é usado principalmente aos domingos, isso não é um problema na prática.  
Se quiser que o app fique sempre ativo, o plano pago custa **$7/mês**.

---

## 📁 Estrutura do projeto

```
churrascoapp/
├── server.js           ← API REST + agendador WhatsApp
├── package.json
├── render.yaml         ← Configuração automática do Render
├── Procfile            ← Compatibilidade com outros hosts
├── .gitignore
├── .env.example        ← Modelo de variáveis de ambiente
├── README.md
└── public/
    └── index.html      ← Frontend responsivo
```

---

## 🔌 API REST

| Método | Rota | Ação |
|--------|------|------|
| GET | /api/orders | Listar pedidos |
| POST | /api/orders | Criar pedido |
| PUT | /api/orders/:id | Editar / mudar status |
| DELETE | /api/orders/:id | Remover pedido |
| GET | /api/history | Histórico |
| GET | /api/stats | Estatísticas |
| POST | /api/whatsapp/send-summary | Enviar resumo agora |
| GET | /api/whatsapp/preview | Prévia do resumo |
