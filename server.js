const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const path = require('path');

let fetch = global.fetch;
if (!fetch) {
  fetch = require('node-fetch');
}

const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

const app = express();

// Configuração robusta do CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.static(__dirname));

// Remove o token antigo hardcoded e força a leitura da variável de ambiente da Vercel
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

if (!MP_ACCESS_TOKEN) {
  console.error("[ERRO CRÍTICO] Variável MP_ACCESS_TOKEN não configurada na Vercel!");
}

const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
const payment = new Payment(client);

/* =========================================================
   INICIALIZAÇÃO DO FIREBASE ADMIN (COMPATÍVEL COM SERVERLESS)
   ========================================================= */
let db = null;

try {
  let serviceAccount = null;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
  } else {
    try {
      serviceAccount = require('./firebase-key.json');
    } catch (err) {
      console.warn("[FIREBASE WARN] Arquivo firebase-key.json não encontrado localmente.");
    }
  }

  if (getApps().length === 0 && serviceAccount) {
    initializeApp({
      credential: cert(serviceAccount),
      databaseURL: "https://turnmodz-app-default-rtdb.firebaseio.com"
    });
    db = getDatabase();
    // Força o Firebase a rodar de forma não-bloqueante em Serverless
    if (db && db.engine && db.engine.repo_) {
      db.engine.repo_.start();
    }
    console.log("[FIREBASE] Inicializado com sucesso.");
  } else if (getApps().length > 0) {
    db = getDatabase();
  }
} catch (e) {
  console.warn("[FIREBASE WARN] Falha ao autenticar credenciais Admin:", e.message);
}

function sanitizeEmail(email) {
  return email ? email.toLowerCase().replace(/\./g, '_') : '';
}

function resolveUserKey(metadata, payer) {
  if (metadata && metadata.user_id) return metadata.user_id;
  const email = (metadata && metadata.customer_email) || (payer && payer.email) || "";
  return sanitizeEmail(email);
}

/* =========================================================
   PROCESSAR E SALVAR PEDIDO
   ========================================================= */
async function processApprovedOrder(paymentData) {
  if (!db) {
    console.warn("[FIREBASE WARN] Operação cancelada: Conexão com Firebase não iniciada.");
    return;
  }

  try {
    const paymentId = String(paymentData.id);
    const payer = paymentData.payer || {};
    const metadata = paymentData.metadata || {};
    
    const userKey = metadata.user_id || resolveUserKey(metadata, payer);
    
    if (!userKey) {
      console.error(`[FIREBASE] Não foi possível identificar o userKey para o pagamento #${paymentId}`);
      return;
    }

    const pedidoRef = db.ref(`users/${userKey}/pedidos/${paymentId}`);
    const snapshot = await pedidoRef.once('value');

    if (snapshot.exists() && snapshot.val().status === 'approved') {
      console.log(`[FIREBASE] Pedido #${paymentId} já processado.`);
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

    await pedidoRef.update(orderData);
    console.log(`[FIREBASE] Pedido #${paymentId} salvo/atualizado em users/${userKey}/pedidos/${paymentId}`);

    const totalCashback = cartItems.reduce((acc, item) => acc + ((Number(item.cashback) || 0) * (Number(item.qtd) || 1)), 0);

    if (totalCashback > 0) {
      const userRef = db.ref(`users/${userKey}`);
      await userRef.transaction((currentUserData) => {
        if (!currentUserData) {
          return { email: customerEmail, saldo: totalCashback, cashback: totalCashback };
        }
        return {
          ...currentUserData,
          email: customerEmail,
          saldo: (Number(currentUserData.saldo) || 0) + totalCashback,
          cashback: (Number(currentUserData.cashback) || 0) + totalCashback
        };
      });
    }
  } catch (err) {
    console.error(`[FIREBASE ERROR] Falha ao processar pedido #${paymentData.id}:`, err);
  }
}

app.get('/pedidos', (req, res) => {
  res.sendFile(path.join(__dirname, 'pedidos.html'));
});

/* =========================================================
   GERAR PAGAMENTO VIA PIX
   ========================================================= */
app.post('/create_pix_payment', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { cart, payer, userId } = req.body;
    if (!cart || cart.length === 0) return res.status(400).json({ error: 'Carrinho vazio' });

    const totalAmount = cart.reduce((sum, item) => sum + (Number(item.preco) * Number(item.qtd)), 0);
    const customerEmail = payer && payer.email ? payer.email : "cliente@email.com";
    const nomeCompleto = (payer && payer.nome ? payer.nome.trim() : "Cliente TurnModz").split(" ");

// Tratamento e limpeza do CPF
    const cleanCpf = payer && payer.cpf ? String(payer.cpf).replace(/\D/g, '') : '';

    // Estrutura do payer com fallback de segurança
    const payerData = {
      email: customerEmail || "cliente@email.com",
      first_name: (nomeCompleto && nomeCompleto[0]) ? nomeCompleto[0] : "Cliente",
      last_name: (nomeCompleto && nomeCompleto.length > 1) ? nomeCompleto.slice(1).join(" ") : "Consumidor"
    };

    // O Mercado Pago SÓ deve receber identification se houver um CPF válido de 11 dígitos
    if (cleanCpf && cleanCpf.length === 11) {
      payerData.identification = {
        type: 'CPF',
        number: cleanCpf
      };
    }

    const body = {
      transaction_amount: Number(totalAmount.toFixed(2)),
      description: "Compra na Loja TurnModz",
      payment_method_id: 'pix',
      payer: payerData,
      metadata: {
        cart: cart || [],
        customer_email: customerEmail || "",
        user_id: userId || null
      }
    };

    const response = await payment.create({ body });

    return res.json({
      id: response.id,
      qr_code: response.point_of_interaction.transaction_data.qr_code,
      qr_code_base64: response.point_of_interaction.transaction_data.qr_code_base64,
      ticket_url: response.point_of_interaction.transaction_data.ticket_url
    });
  } catch (error) {
    console.error("Erro ao gerar Pix:", error?.message || error);
    return res.status(500).json({ error: 'Erro ao gerar pagamento via Pix', details: error?.message });
  }
});

/* =========================================================
   VERIFICAR STATUS DO PAGAMENTO (ASYNC EM BACKGROUND)
   ========================================================= */
app.get('/check_payment_status/:id', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { id } = req.params;

    if (!id || id === 'undefined' || id === 'null') {
      return res.status(400).json({ error: 'ID de pagamento inválido.' });
    }

    const paymentData = await payment.get({ id: String(id) });

    // Dispara a gravação no Firebase sem aguardar o await (evita Timeout de 10s da Vercel)
    if (paymentData.status === 'approved') {
      processApprovedOrder(paymentData).catch(err => 
        console.error("Erro em background no Firebase:", err)
      );
    }

    return res.json({
      status: paymentData.status,
      status_detail: paymentData.status_detail
    });
  } catch (error) {
    console.error("Erro ao verificar status do pagamento:", error?.message || error);
    return res.status(500).json({ error: 'Erro ao verificar pagamento', details: error?.message });
  }
});

/* =========================================================
   WEBHOOK MERCADO PAGO
   ========================================================= */
app.post('/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;

    if (type === 'payment' || req.query.type === 'payment') {
      const paymentId = data?.id || req.query['data.id'];
      if (paymentId) {
        const paymentData = await payment.get({ id: String(paymentId) });

        if (paymentData.status === 'approved') {
          processApprovedOrder(paymentData).catch(err => 
            console.error("Erro Webhook Firebase:", err)
          );
        }
      }
    }
    return res.sendStatus(200);
  } catch (error) {
    console.error("Erro ao processar Webhook:", error?.message || error);
    return res.sendStatus(500);
  }
});

/* =========================================================
   SOLICITAÇÃO DE SAQUE
   ========================================================= */
app.post('/send_pix_payout', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { pixKey, amount, description, userId } = req.body;
    if (!pixKey || !amount || Number(amount) <= 0 || !userId) {
      return res.status(400).json({ error: 'Chave PIX, valor e usuário são obrigatórios.' });
    }

    if (!db) {
      return res.status(500).json({ error: 'Banco de dados indisponível no momento.' });
    }

    const payoutRequest = {
      id: `SAQUE-${Math.floor(1000 + Math.random() * 9000)}`,
      pixKey: String(pixKey).trim(),
      amount: Number(amount),
      description: description || "Resgate TurnModz",
      status: "pending_payout",
      createdAt: new Date().toISOString()
    };

    await db.ref(`users/${userId}/saques`).push(payoutRequest);
    return res.json({ success: true, message: "Solicitação enviada com sucesso!" });
  } catch (error) {
    console.error("Erro ao registrar saque:", error?.message || error);
    return res.status(500).json({ error: 'Erro interno ao registrar solicitação de saque.' });
  }
});

// Exporte o app para a Vercel usar como Serverless Function
module.exports = app;

// Só roda o app.listen se estiver rodando localmente
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
  });
}
