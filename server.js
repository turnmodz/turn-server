const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const path = require('path');

// Suporte para fetch em versões do Node.js anteriores à v18
let fetch = global.fetch;
if (!fetch) {
  fetch = require('node-fetch');
}

// Inicialização segura do Firebase Admin
const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getDatabase, ServerValue } = require("firebase-admin/database");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// CONFIGURAÇÃO DO MERCADO PAGO
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || 'APP_USR-3652144727697622-021610-2239fd16cdc3a00a0c23481f270cbf5b-2305736607';
const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

// INICIALIZAÇÃO DO FIREBASE ADMIN
try {
  const serviceAccount = require("./firebase-key.json");
  if (getApps().length === 0) {
    initializeApp({
      credential: cert(serviceAccount),
      databaseURL: "https://turnmodz-app-default-rtdb.firebaseio.com"
    });
  }
} catch (e) {
  console.warn("[FIREBASE ADMIN WARN] Chave local firebase-key.json não encontrada ou inválida.");
}

const db = getDatabase();

function sanitizeEmail(email) {
  return email ? email.toLowerCase().replace(/\./g, '_') : '';
}

function resolveUserKey(metadata, payer) {
  if (metadata && metadata.user_id) return metadata.user_id;
  const email = (metadata && metadata.customer_email) || (payer && payer.email) || "";
  return sanitizeEmail(email);
}

/* =========================================================
   FUNÇÃO AUXILIAR: PROCESSAR E SALVAR PEDIDO APROVADO
   ========================================================= */
async function processApprovedOrder(paymentData) {
  const paymentId = String(paymentData.id);
  const payer = paymentData.payer || {};
  const metadata = paymentData.metadata || {};
  
  const userKey = resolveUserKey(metadata, payer);
  if (!userKey) {
    console.error(`[FIREBASE] Não foi possível identificar a chave do usuário para o pagamento #${paymentId}`);
    return;
  }

  const pedidoRef = db.ref(`pedidos/${userKey}/${paymentId}`);
  const snapshot = await pedidoRef.once('value');

  // Se o pedido já consta como aprovado, não reprocessa
  if (snapshot.exists() && snapshot.val().status === 'approved') {
    console.log(`[FIREBASE] Pedido #${paymentId} já foi processado anteriormente.`);
    return;
  }

  const customerEmail = metadata.customer_email || payer.email || "cliente@email.com";
  const cartItems = metadata.cart || [];

  const orderData = {
    id: paymentId,
    idPedidoMercadoPago: Number(paymentId),
    data: new Date().toISOString(),
    status: 'approved',
    statusText: 'Pagamento Aprovado',
    clienteEmail: customerEmail.trim().toLowerCase(),
    valorTotal: paymentData.transaction_amount || 0,
    itens: cartItems,
    cashbackProcessado: true
  };

  // Salva no caminho padronizado: pedidos/${userKey}/${paymentId}
  await pedidoRef.update(orderData);
  console.log(`[FIREBASE] Pedido #${paymentId} salvo/atualizado em pedidos/${userKey}/${paymentId}`);

  // Processamento de Cashback (se houver)
  const totalCashback = cartItems.reduce((acc, item) => acc + ((item.cashback || 0) * (item.qtd || 1)), 0);

  if (totalCashback > 0) {
    const userRef = db.ref(`users/${userKey}`);
    
    await userRef.update({
      email: customerEmail,
      saldo: ServerValue.increment(totalCashback),
      cashback: ServerValue.increment(totalCashback)
    });

    const transacoesRef = db.ref('transacoes');
    await transacoesRef.push({
      userId: userKey,
      emailDestino: customerEmail.toLowerCase(),
      valor: totalCashback,
      tipo: 'cashback',
      descricao: `Cashback referente ao pedido #${paymentId}`,
      data: new Date().toISOString()
    });
  }
}

/* =========================================================
   ROTAS
   ========================================================= */
app.get('/pedidos', (req, res) => {
  res.sendFile(path.join(__dirname, 'pedidos.html'));
});

// 1. CRIAÇÃO DO PAGAMENTO PIX
app.post('/create_pix_payment', async (req, res) => {
  try {
    const { cart, payer, userId } = req.body;
    if (!cart || cart.length === 0) return res.status(400).json({ error: 'Carrinho vazio' });

    const totalAmount = cart.reduce((sum, item) => sum + (Number(item.preco) * Number(item.qtd)), 0);
    const customerEmail = payer && payer.email ? payer.email : "cliente@email.com";
    const nomeCompleto = (payer && payer.nome ? payer.nome.trim() : "Cliente TurnModz").split(" ");

    const payment = new Payment(client);
    const body = {
      transaction_amount: Number(totalAmount.toFixed(2)),
      description: "Compra na Loja TurnModz",
      payment_method_id: 'pix',
      payer: {
        email: customerEmail,
        first_name: nomeCompleto[0],
        last_name: nomeCompleto.length > 1 ? nomeCompleto.slice(1).join(" ") : "Sobrenome",
        identification: {
          type: 'CPF',
          number: payer && payer.cpf ? payer.cpf.replace(/\D/g, '') : ''
        }
      },
      metadata: {
        cart: cart,
        customer_email: customerEmail,
        user_id: userId || null
      }
    };

    const response = await payment.create({ body });

    res.json({
      id: response.id,
      qr_code: response.point_of_interaction.transaction_data.qr_code,
      qr_code_base64: response.point_of_interaction.transaction_data.qr_code_base64,
      ticket_url: response.point_of_interaction.transaction_data.ticket_url
    });
  } catch (error) {
    console.error("Erro ao gerar Pix:", error);
    res.status(500).json({ error: 'Erro ao gerar pagamento via Pix' });
  }
});

// 2. CHECAGEM DE STATUS DO PAGAMENTO (Retorna APENAS o status para o front)
app.get('/check_payment_status/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const payment = new Payment(client);
    const paymentData = await payment.get({ id });

    if (paymentData.status === 'approved') {
      await processApprovedOrder(paymentData);
    }

    res.json({
      status: paymentData.status,
      status_detail: paymentData.status_detail
    });
  } catch (error) {
    console.error("Erro ao verificar status do pagamento:", error);
    res.status(500).json({ error: 'Erro ao verificar pagamento' });
  }
});

// 3. WEBHOOK MERCADO PAGO
app.post('/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;

    if (type === 'payment' || req.query.type === 'payment') {
      const paymentId = data?.id || req.query['data.id'];
      if (paymentId) {
        const payment = new Payment(client);
        const paymentData = await payment.get({ id: paymentId });

        if (paymentData.status === 'approved') {
          await processApprovedOrder(paymentData);
        }
      }
    }
    res.sendStatus(200);
  } catch (error) {
    console.error("Erro ao processar Webhook:", error);
    res.sendStatus(500);
  }
});

// 4. SOLICITAÇÃO DE SAQUE
app.post('/send_pix_payout', async (req, res) => {
  try {
    const { pixKey, amount, description } = req.body;
    if (!pixKey || !amount || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Chave PIX e valor válido são obrigatórios.' });
    }

    const payoutRequest = {
      id: `SAQUE-${Math.floor(1000 + Math.random() * 9000)}`,
      pixKey: String(pixKey).trim(),
      amount: Number(amount),
      description: description || "Resgate TurnModz",
      status: "pending_payout",
      createdAt: new Date().toISOString()
    };

    await db.ref('saques').push(payoutRequest);
    return res.json({ success: true, message: "Solicitação enviada com sucesso!" });
  } catch (error) {
    console.error("Erro ao registrar saque:", error);
    return res.status(500).json({ error: 'Erro interno ao registrar solicitação de saque.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}. Aguardando pagamentos...`);
});
