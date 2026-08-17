const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const path = require('path');

// Suporte para fetch em versões do Node.js anteriores à v18
let fetch = global.fetch;
if (!fetch) {
  fetch = require('node-fetch');
}

const app = express();

// Configuração do CORS
app.use(cors());
app.use(express.json());

// SERVIR ARQUIVOS ESTÁTICOS (HTML, JS, IMAGENS DO PROJETO)
app.use(express.static(__dirname));

// CONFIGURAÇÃO DO MERCADO PAGO E FIREBASE
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || 'APP_USR-3652144727697622-021610-2239fd16cdc3a00a0c23481f270cbf5b-2305736607';
const FIREBASE_RTDB_URL = 'https://turnmodz-app-default-rtdb.firebaseio.com';

const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

/* =========================================================
   ROTAS DE PÁGINAS DO FRONTEND
   ========================================================= */
app.get('/pedidos', (req, res) => {
  res.sendFile(path.join(__dirname, 'pedidos.html'));
});

/* =========================================================
   FUNÇÃO AUXILIAR: SALVAR PEDIDO NO FIREBASE
   ========================================================= */
async function saveApprovedOrderToFirebase(paymentData, cartItems) {
  const customerEmail = paymentData.metadata?.customer_email || paymentData.payer?.email || "cliente@email.com";
  
  const orderData = {
    id: `TM-${Math.floor(1000 + Math.random() * 9000)}`,
    date: new Date().toLocaleDateString('pt-BR'),
    status: 'approved',
    statusText: 'Pagamento Aprovado',
    customerEmail: customerEmail.trim().toLowerCase(),
    paymentMethod: 'PIX',
    total: paymentData.transaction_amount || 0,
    items: cartItems || []
  };

  try {
    const firebaseUrl = FIREBASE_RTDB_URL.endsWith('/') 
      ? `${FIREBASE_RTDB_URL}pedidos.json` 
      : `${FIREBASE_RTDB_URL}/pedidos.json`;

    const response = await fetch(firebaseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(orderData)
    });

    if (response.ok) {
      console.log(`[FIREBASE] Pedido salvo com sucesso para o e-mail: ${orderData.customerEmail}`);
    } else {
      console.error("[FIREBASE ERRO]", await response.text());
    }
  } catch (error) {
    console.error("[FIREBASE FALHA DE CONEXÃO]", error);
  }
}

/* =========================================================
   1. ROTA DE CRIAÇÃO DO PAGAMENTO PIX
   ========================================================= */
app.post('/create_pix_payment', async (req, res) => {
  try {
    const { cart, payer } = req.body;

    if (!cart || cart.length === 0) {
      return res.status(400).json({ error: 'Carrinho vazio' });
    }

    const totalAmount = cart.reduce((sum, item) => sum + (Number(item.preco) * Number(item.qtd)), 0);

    const customerEmail = payer && payer.email ? payer.email : "cliente@email.com";
    const nomeCompleto = (payer && payer.nome ? payer.nome.trim() : "Cliente TurnModz").split(" ");
    const firstName = nomeCompleto[0];
    const lastName = nomeCompleto.length > 1 ? nomeCompleto.slice(1).join(" ") : "Sobrenome";

    const payment = new Payment(client);
    
    const body = {
      transaction_amount: Number(totalAmount.toFixed(2)),
      description: "Compra na Loja TurnModz",
      payment_method_id: 'pix',
      payer: {
        email: customerEmail,
        first_name: firstName,
        last_name: lastName,
        identification: {
          type: 'CPF',
          number: payer && payer.cpf ? payer.cpf.replace(/\D/g, '') : ''
        }
      },
      metadata: {
        cart: cart,
        customer_email: customerEmail
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

/* =========================================================
   ROTA PARA SOLICITAÇÃO DE SAQUE (REGISTRO NO FIREBASE)
   ========================================================= */
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

    const firebaseUrl = FIREBASE_RTDB_URL.endsWith('/') 
      ? `${FIREBASE_RTDB_URL}saques.json` 
      : `${FIREBASE_RTDB_URL}/saques.json`;

    const firebaseResponse = await fetch(firebaseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payoutRequest)
    });

    if (firebaseResponse.ok) {
      console.log(`[SAQUE REGISTRADO] R$ ${amount} para chave ${pixKey}`);
      return res.json({ 
        success: true, 
        message: "Solicitação enviada! Seu resgate será processado em breve." 
      });
    } else {
      const errText = await firebaseResponse.text();
      console.error("[ERRO FIREBASE SAQUES]", errText);
      return res.status(500).json({ error: 'Erro ao salvar no banco de dados. Verifique a URL do Firebase.' });
    }

  } catch (error) {
    console.error("Erro interno no servidor ao processar saque:", error);
    return res.status(500).json({ error: error.message || 'Erro interno ao registrar solicitação de saque.' });
  }
});

/* =========================================================
   2. ROTA DE CHECAGEM DO STATUS DO PAGAMENTO (POLLING)
   ========================================================= */
app.get('/check_payment_status/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const payment = new Payment(client);
    const paymentData = await payment.get({ id });

    if (paymentData.status === 'approved') {
      const cartItems = paymentData.metadata?.cart || [];
      await saveApprovedOrderToFirebase(paymentData, cartItems);
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

/* =========================================================
   3. WEBHOOK MERCADO PAGO (NOTIFICAÇÕES AUTOMÁTICAS)
   ========================================================= */
app.post('/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;

    if (type === 'payment' || req.query.type === 'payment') {
      const paymentId = data?.id || req.query['data.id'];
      if (paymentId) {
        const payment = new Payment(client);
        const paymentData = await payment.get({ id: paymentId });

        if (paymentData.status === 'approved') {
          console.log(`[WEBHOOK] Pagamento #${paymentId} aprovado com sucesso!`);
          const cartItems = paymentData.metadata?.cart || [];
          await saveApprovedOrderToFirebase(paymentData, cartItems);
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Erro ao processar Webhook:", error);
    res.sendStatus(500);
  }
});


// 1. Importação segura dos submódulos do Firebase Admin
const { initializeApp, getApps, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

// 2. Chave do seu Firebase Realtime Database
const serviceAccount = require("./firebase-key.json");

// 3. Inicialização limpa (Verifica se já existe uma app inicializada)
if (getApps().length === 0) {
  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: "https://turnmodz-app-default-rtdb.firebaseio.com" // Confirme se esta é a URL exata do seu banco
  });
}

// 4. Instância do Realtime Database pronta para uso
const db = getDatabase();

// Função auxiliar para formatar e-mail (chave do Firebase)
function sanitizeEmail(email) {
  return email.toLowerCase().replace(/\./g, '_');
}

// Rota de checagem que valida o pagamento e envia o cashback
app.get('/check_payment_status/:id', async (req, res) => {
  const paymentId = req.params.id;

  try {
    // 1. Consulta o status na API do Mercado Pago
    const payment = await mercadopago.payment.get(paymentId);
    const status = payment.body.status;

    if (status === 'approved') {
      const emailCliente = payment.body.payer.email;
      const emailKey = sanitizeEmail(emailCliente);

      // Busca o pedido salvo previamente no Firebase
      const pedidosRef = db.ref('pedidos');
      const snapshot = await pedidosRef.orderByChild('idPedidoMercadoPago').equalTo(Number(paymentId)).once('value');

      if (snapshot.exists()) {
        const pedidoKey = Object.keys(snapshot.val())[0];
        const pedido = snapshot.val()[pedidoKey];

        // Processa o cashback apenas se ainda não tiver sido processado
        if (!pedido.cashbackProcessado) {
          // Calcula o cashback total dos itens do pedido
          const totalCashback = pedido.itens.reduce((acc, item) => {
            return acc + ((item.cashback || 0) * item.qtd);
          }, 0);

          if (totalCashback > 0) {
            // Atualiza saldo do usuário
            const userRef = db.ref(`usuarios/${emailKey}`);
            await userRef.update({
              email: emailCliente,
              saldo: admin.database.ServerValue.increment(totalCashback)
            });

            // Registra a transação no histórico
            const transacoesRef = db.ref('transacoes');
            await transacoesRef.push({
              emailDestino: emailCliente.toLowerCase(),
              valor: totalCashback,
              tipo: 'cashback',
              descricao: `Cashback referente ao pedido #${paymentId}`,
              data: new Date().toISOString()
            });
          }

          // Marca o pedido como concluído e cashback processado
          await pedidosRef.child(pedidoKey).update({
            status: 'approved',
            cashbackProcessado: true
          });
        }
      }
    }

    res.json({ status });
  } catch (error) {
    console.error("Erro ao verificar pagamento:", error);
    res.status(500).json({ error: "Erro interno no servidor" });
  }
});



/* =========================================================
   INICIALIZAÇÃO DO SERVIDOR
   ========================================================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}. Aguardando pagamentos...`);
});
