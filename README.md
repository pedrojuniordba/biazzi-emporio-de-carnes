# 🥩 Biazzi Empório da Carne — Sistema de Gestão

Sistema web completo para gestão de reservas, estoque, pagamentos, estatísticas e reservas online dos clientes.

**Stack:** Node.js 20 · Express · PostgreSQL  
**Hospedagem:** Render.com  
**URL Admin:** https://biazzi-emporio.onrender.com  
**URL Reservas (pública):** https://biazzi-emporio.onrender.com/reserva

---

## 📱 Funcionalidades

### Painel Administrativo (acesso com senha)
- **Nova Reserva** — cadastro pelo atendente com nome, telefone, itens, quantidades, preços e forma de pagamento
- **Reservas** — pedidos pendentes aguardando retirada e pagamento
- **Histórico** — pedidos pagos e cancelados, agrupados por data com receita diária
- **Estatísticas** — receita, kg de carne, unidades de frango por período ou dia específico com gráfico mensal
- **Estoque** — controle por data de venda, abate automático a cada reserva, devolução em cancelamentos
- **WhatsApp** — resumo automático todo domingo às 20h via CallMeBot + envio manual

### Página Pública de Reservas `/reserva`
- Acesso sem login — link direto para clientes finais
- Exibe datas disponíveis com estoque cadastrado
- Fluxo em 3 passos: data → produtos → dados pessoais
- Abate automático do estoque ao confirmar
- Notificação WhatsApp para o dono a cada nova reserva
- Preview social (og-image) para Instagram e WhatsApp

---

## 🔐 Acesso e Segurança

- Login por senha única configurada via variável de ambiente
- Token de sessão salvo no navegador
- Todas as rotas administrativas protegidas por autenticação
- Página `/reserva` é pública — sem acesso a dados internos
- Rate limit nas rotas de login e reservas públicas

---

## 🚀 Deploy no Render

### 1. Subir o código no GitHub

```bash
cd churrascoapp
git init && git add .
git commit -m "Biazzi Empório da Carne v2.0"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/biazzi-emporio.git
git push -u origin main
```

### 2. Criar banco PostgreSQL
Render.com → New → PostgreSQL → Name: `biazzi-db` → Free → Create

### 3. Criar Web Service
New → Web Service → conecte o repositório → o `render.yaml` é detectado automaticamente

### 4. Variáveis de ambiente

| Key | Value | Obrigatório |
|-----|-------|-------------|
| `DATABASE_URL` | connection string do banco | ✅ |
| `TZ` | `America/Sao_Paulo` | ✅ |
| `APP_PASSWORD` | senha do painel admin | ✅ |
| `WHATSAPP_PHONE` | número com DDI ex: `5541999998888` | ⚠️ opcional |
| `CALLMEBOT_APIKEY` | chave recebida pelo CallMeBot | ⚠️ opcional |

> ⚠️ Plano gratuito: app dorme após 15min sem uso (~30s para acordar). Não impacta o uso aos domingos.

---

## 📦 Gestão de Estoque

Controlado por data de venda. O dono define as quantidades antes de cada domingo. O sistema abate automaticamente a cada reserva e devolve em cancelamentos.

Itens: 🥩 Carne (kg) · 🥩 Costela (kg) · 🍗 Frango Assado (unidades)

Para ativar reservas de uma data: cadastrar estoque via botão **⚙ Definir estoque** no cabeçalho do painel.

---

## 📲 Ativar WhatsApp (CallMeBot)

1. Salve o contato **+34 644 95 4275**
2. Envie: `I allow callmebot to send me messages`
3. Receba sua `apikey` e configure no Render

Resumo automático todo domingo às 20h. Envio manual na aba Estatísticas.

---

## 🔗 Página Pública de Reservas

```
https://biazzi-emporio.onrender.com/reserva
```

Compartilhar na bio do Instagram, stories, grupos de WhatsApp e status.

---

## 📁 Estrutura

```
churrascoapp/
├── server.js           ← API REST + agendador + rotas públicas
├── package.json
├── render.yaml
├── Procfile
├── .env.example
├── README.md
└── public/
    ├── index.html      ← Painel admin responsivo
    ├── reserva.html    ← Página pública de reservas
    ├── logo.jpg        ← Logo Biazzi
    └── og-image.jpg    ← Preview para redes sociais
```

---

## 🔌 Endpoints

### Protegidos (x-auth-token)
| Método | Rota | Descrição |
|--------|------|-----------|
| GET/POST | `/api/orders` | Listar / criar pedidos |
| PUT/DELETE | `/api/orders/:id` | Editar / remover |
| GET | `/api/history` | Histórico |
| GET | `/api/stats` | Estatísticas |
| GET/POST | `/api/stock/:date` | Estoque |
| POST | `/api/whatsapp/send-summary` | Enviar resumo |

### Públicos
| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/public/available-dates` | Datas disponíveis |
| GET | `/api/public/stock/:date` | Estoque público |
| POST | `/api/public/reserva` | Registrar reserva |
| GET | `/reserva` | Página de reservas |
