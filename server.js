const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

// Evita que o Firebase tente se conectar caso esteja no ambiente de build/compilação
if (getApps().length === 0 && process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({
      credential: cert(serviceAccount),
      databaseURL: 'https://turnmodz-app-default-rtdb.firebaseio.com'
    });
  } catch (err) {
    console.error('[FIREBASE INIT ERROR]', err.message);
  }
}

const app = express();

app.use(cors({
  origin: ['https://turnmodz-app.web.app', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.options(/(.*)/, cors());
app.use(express.json());

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || 'APP_USR-3652144727697622-021610-2239fd16cdc3a00a0c23481f270cbf5b-2305736607';
const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

app.post('/create_pix_payment', async (req, res) => {
  try {
    const { cart, payer } = req.body;
    if (!cart || !Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: 'Carrinho vazio' });
    }

    const totalAmount = cart.reduce((sum, item) => sum + (Number(item.preco || 0) * Number(item.qtd || 1)), 0);
    const customerEmail = payer && payer.email && payer.email.includes('@') ? payer.email.trim() : 'cliente@email.com';
    const nomeCompleto = (payer && payer.nome ? payer.nome.trim() : 'Cliente TurnModz').split(' ');

    const payerData = {
      email: customerEmail,
      first_name: nomeCompleto[0] || 'Cliente',
      last_name: nomeCompleto.length > 1 ? nomeCompleto.slice(1).join(' ') : 'Consumidor'
    };

    const cleanCpf = payer && payer.cpf ? String(payer.cpf).replace(/\D/g, '') : '';
    if (cleanCpf && cleanCpf.length === 11) {
      payerData.identification = { type: 'CPF', number: cleanCpf };
    }

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
    if (!poi) throw new Error('Resposta inválida do Mercado Pago.');

    return res.json({
      id: response.id,
      qr_code: poi.qr_code,
      qr_code_base64: poi.qr_code_base64,
      ticket_url: poi.ticket_url
    });

  } catch (error) {
    console.error('Erro ao gerar Pix:', error);
    return res.status(500).json({ error: 'Erro ao gerar Pix', details: error.message });
  }
});

app.get('/check_payment_status/:id', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { id } = req.params;

    if (!id || id === 'undefined' || id === 'null') {
      return res.status(400).json({ error: 'ID de pagamento inválido.' });
    }

    const paymentData = await payment.get({ id: String(id) });

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



module.exports = app;

if (require.main === module && !process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Servidor local rodando na porta ${PORT}`));
}
