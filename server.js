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

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || 'APP_USR-3652144727697622-021610-2239fd16cdc3a00a0c23481f270cbf5b-2305736607';
const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

// Inicialização segura do Firebase Admin com tratamento de quebra de linha da chave
try {
  let serviceAccount;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    
    // Tratamento essencial para a chave privada funcionar na Render
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
  } else {
    serviceAccount = require("./firebase-key.json");
  }

  if (getApps().length === 0) {
    initializeApp({
      credential: cert(serviceAccount),
      databaseURL: "https://turnmodz-app-default-rtdb.firebaseio.com"
    });
  }
} catch (e) {
  console.warn("[FIREBASE ADMIN WARN] Falha ao carregar credenciais do Firebase:", e.message);
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
   PROCESSAR E SALVAR PEDIDO DENTRO DE /users/${userKey}/pedidos
   ========================================================= */
async function processApprovedOrder(paymentData) {
  try {
    const paymentId = String(paymentData.id);
    const payer = paymentData.payer || {};
    const metadata = paymentData.metadata || {};
    
    // Prioriza o userId (UID do Firebase) vindo dos metadados do Mercado Pago
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

    // Cálculo do Cashback
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

/* =========================================================
   SOLICITAÇÃO DE SAQUE DENTRO DE /users/${userKey}/saques
   ========================================================= */
app.post('/send_pix_payout', async (req, res) => {
  try {
    const { pixKey, amount, description, userId } = req.body;
    if (!pixKey || !amount || Number(amount) <= 0 || !userId) {
      return res.status(400).json({ error: 'Chave PIX, valor e usuário são obrigatórios.' });
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
    console.error("Erro ao registrar saque:", error);
    return res.status(500).json({ error: 'Erro interno ao registrar solicitação de saque.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}. Aguardando pagamentos...`);
});
