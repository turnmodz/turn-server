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

// SERVIR ARQUIVOS ESTÁTICOS
app.use(express.static(__dirname));

// CONFIGURAÇÃO DO MERCADO PAGO
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || 'APP_USR-3652144727697622-021610-2239fd16cdc3a00a0c23481f270cbf5b-2305736607';
const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

/* =========================================================
   ROTAS DE PÁGINAS DO FRONTEND
   ========================================================= */
app.get('/pedidos', (req, res) => {
  res.sendFile(path.join(__dirname, 'pedidos.html'));
});

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
   2. ROTA DE CHECAGEM DO STATUS DO PAGAMENTO (APENAS AVISA O FRONTEND)
   ========================================================= */
app.get('/check_payment_status/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const payment = new Payment(client);
    const paymentData = await payment.get({ id });

    // Apenas retorna o status para o frontend decidir e salvar no Firebase
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
   3. WEBHOOK MERCADO PAGO (CONFIRMAÇÃO PASSTHROUGH)
   ========================================================= */
app.post('/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;

    if (type === 'payment' || req.query.type === 'payment') {
      const paymentId = data?.id || req.query['data.id'];
      if (paymentId) {
        console.log(`[WEBHOOK] Notificação recebida para o pagamento #${paymentId}`);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Erro ao processar Webhook:", error);
    res.sendStatus(500);
  }
});

/* =========================================================
   ROTA PARA SOLICITAÇÃO DE SAQUE
   ========================================================= */
app.post('/send_pix_payout', async (req, res) => {
  try {
    const { pixKey, amount, description } = req.body;

    if (!pixKey || !amount || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Chave PIX e valor válido são obrigatórios.' });
    }

    return res.json({ 
      success: true, 
      message: "Solicitação recebida com sucesso." 
    });

  } catch (error) {
    console.error("Erro no processamento:", error);
    return res.status(500).json({ error: 'Erro interno ao registrar solicitação de saque.' });
  }
});

/* =========================================================
   INICIALIZAÇÃO DO SERVIDOR
   ========================================================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}. Aguardando pagamentos...`);
});
