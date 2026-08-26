const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');

// Importações do Firebase Admin
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getDatabase, ServerValue } = require('firebase-admin/database');

const app = express();

app.use(cors({
  origin: ['https://turnmodz-app.web.app', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.options('*', cors());
app.use(express.json());

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || 'APP_USR-3652144727697622-021610-2239fd16cdc3a00a0c23481f270cbf5b-2305736607';
const FIREBASE_RTDB_URL = 'https://turnmodz-app-default-rtdb.firebaseio.com';

const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

// Função para obter a instância do Firebase sob demanda (Evita travar o Build)
function getDbInstance() {
  if (getApps().length === 0) {
    try {
      if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        initializeApp({
          credential: cert(serviceAccount),
          databaseURL: FIREBASE_RTDB_URL
        });
      }
    } catch (err) {
      console.error('[FIREBASE INIT ERROR]', err.message);
    }
  }
  return getApps().length > 0 ? getDatabase() : null;
}

function sanitizeEmail(email) {
  return email.toLowerCase().replace(/\./g, '_');
}

/* =========================================================
   FUNÇÃO AUXILIAR: SALVAR PEDIDO
   ========================================================= */
async function saveApprovedOrderToFirebase(paymentData, cartItems) {
  const customerEmail = (paymentData.metadata && paymentData.metadata.customer_email) || 
                        (paymentData.payer && paymentData.payer.email) || 
                        'cliente@email.com';
  const paymentId = paymentData.id;

  const orderData = {
    id: `TM-${Math.floor(1000 + Math.random() * 9000)}`,
    idPedidoMercadoPago: paymentId,
    date: new Date().toLocaleDateString('pt-BR'),
    status: 'approved',
    statusText: 'Pagamento Aprovado',
    customerEmail: customerEmail.trim().toLowerCase(),
    paymentMethod: 'PIX',
    total: paymentData.transaction_amount || 0,
    items: cartItems || [],
    cashbackProcessado: false
  };

  try {
    const firebaseUrl = `${FIREBASE_RTDB_URL}/pedidos.json`;

    const response = await fetch(firebaseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderData)
    });

    const db = getDbInstance();
    if (response.ok && db) {
      const emailKey = sanitizeEmail(customerEmail);
      const totalCashback = cartItems.reduce((acc, item) => {
        return acc + ((Number(item.cashback) || 0) * (Number(item.qtd) || 1));
      }, 0);

      if (totalCashback > 0) {
        const userRef = db.ref(`usuarios/${emailKey}`);
        await userRef.update({
          email: customerEmail.toLowerCase(),
          saldo: ServerValue.increment(totalCashback)
        });
      }
    }
  } catch (error) {
    console.error('[FIREBASE FALHA]', error.message);
  }
}

/* =========================================================
   ROTAS
   ========================================================= */
app.get('/check_payment_status/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || id === 'undefined' || id === 'null') {
      return res.status(400).json({ error: 'ID de pagamento inválido.' });
    }

    const payment = new Payment(client);
    const paymentData = await payment.get({ id });

    if (paymentData.status === 'approved') {
      const cartItems = paymentData.metadata?.cart || [];
      await saveApprovedOrderToFirebase(paymentData, cartItems);
    }

    return res.json({
      status: paymentData.status,
      status_detail: paymentData.status_detail
    });
  } catch (error) {
    console.error('Erro ao verificar status do pagamento:', error.message || error);
    return res.status(500).json({ 
      error: 'Erro ao verificar pagamento',
      details: error.message || 'Erro interno'
    });
  }
});

app.post('/create_pix_payment', async (req, res) => {
  try {
    const { cart, payer } = req.body;

    if (!cart || !Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: 'O carrinho está vazio.' });
    }

    const totalAmount = cart.reduce((sum, item) => sum + (Number(item.preco || 0) * Number(item.qtd || 1)), 0);
    if (totalAmount <= 0) {
      return res.status(400).json({ error: 'O valor total deve ser maior que zero.' });
    }

    const customerEmail = payer && payer.email && payer.email.includes('@') 
      ? payer.email.trim() 
      : 'cliente@email.com';
      
    const nomeCompleto = (payer && payer.nome ? payer.nome.trim() : 'Cliente TurnModz').split(' ');

    const payerData = {
      email: customerEmail,
      first_name: nomeCompleto[0] || 'Cliente',
      last_name: nomeCompleto.length > 1 ? nomeCompleto.slice(1).join(' ') : 'Consumidor'
    };

    const payment = new Payment(client);
    const response = await payment.create({
      body: {
        transaction_amount: Number(totalAmount.toFixed(2)),
        description: 'Compra na Loja TurnModz',
        payment_method_id: 'pix',
        payer: payerData,
        metadata: { cart, customer_email: customerEmail }
      }
    });

    const poi = response.point_of_interaction?.transaction_data;
    if (!poi) throw new Error('Retorno inválido do Mercado Pago.');

    return res.json({
      id: response.id,
      qr_code: poi.qr_code,
      qr_code_base64: poi.qr_code_base64,
      ticket_url: poi.ticket_url
    });

  } catch (error) {
    console.error('Erro ao gerar Pix:', error);
    return res.status(500).json({ 
      error: 'Erro ao gerar pagamento via Pix', 
      details: error.message || 'Erro interno no servidor'
    });
  }
});

module.exports = app;

if (require.main === module && !process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
}
