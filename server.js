const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');

// Inicialização do Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const db = admin.database();
const app = express();
app.use(express.json());

const MERCADO_PAGO_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;

// Helper para processar pedido aprovado no banco de dados
async function processApprovedOrder(paymentId, userId) {
  try {
    const orderRef = db.ref(`users/${userId}/pedidos/${paymentId}`);
    await orderRef.update({
      status: 'approved',
      statusText: 'Pagamento Aprovado',
      updatedAt: new Date().toISOString()
    });
    console.log(`[Pagamento ${paymentId}] Status atualizado para 'approved' no Firebase.`);
  } catch (error) {
    console.error(`Erro ao atualizar pedido ${paymentId} no Firebase:`, error);
  }
}

// 🟢 Rota para consultar status do pagamento
app.get('/check_payment_status/:id', async (req, res) => {
  const paymentId = req.params.id;
  const userId = req.query.userId; // Recebe o ID/Email sanitizado do usuário

  if (!paymentId) {
    return res.status(400).json({ error: 'ID do pagamento não fornecido' });
  }

  try {
    const response = await axios.get(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: {
        Authorization: `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`
      }
    });

    const { status, status_detail } = response.data;

    // Se estiver aprovado, atualiza o Firebase em tempo real
    if (status === 'approved' && userId) {
      await processApprovedOrder(paymentId, userId);
    }

    return res.json({
      status,
      status_detail
    });
  } catch (error) {
    console.error('Erro ao consultar Mercado Pago:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Erro ao verificar status no servidor' });
  }
});

// 🟢 Rota de Webhook do Mercado Pago (Notificações instantâneas)
app.post('/webhook', async (req, res) => {
  const { type, data } = req.body;

  if (type === 'payment' && data?.id) {
    try {
      const response = await axios.get(`https://api.mercadopago.com/v1/payments/${data.id}`, {
        headers: {
          Authorization: `Bearer ${MERCADO_PAGO_ACCESS_TOKEN}`
        }
      });

      const paymentData = response.data;
      if (paymentData.status === 'approved') {
        const userId = paymentData.external_reference; // Certifique-se de passar o ID do usuário na criação do Pix
        if (userId) {
          await processApprovedOrder(data.id, userId);
        }
      }
    } catch (err) {
      console.error('Erro ao processar Webhook:', err.message);
    }
  }

  return res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
