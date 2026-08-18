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

// Configuração do cliente Mercado Pago
const client = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

// Instância do módulo Payment (necessário para buscar/criar pagamentos)
const payment = new Payment(client);

// Inicialização segura do Firebase Admin
try {
  let serviceAccount;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
  } else {
    serviceAccount = require('./serviceAccountKey.json');
  }

  if (!getApps().length) {
    initializeApp({
      credential: cert(serviceAccount),
      databaseURL: "https://turnmodz-app-default-rtdb.firebaseio.com"
    });
  }
} catch (error) {
  console.error("Aviso: Firebase Admin não foi inicializado nesta instância.", error.message);
}

const db = getApps().length ? getDatabase() : null;

/* =========================================================
   ROTA: VERIFICAR STATUS DO PAGAMENTO (Corrigida)
   ========================================================= */
app.get('/check_payment_status/:id', async (req, res) => {
  // Garante os cabeçalhos CORS mesmo em exceções
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const { id } = req.params;

    if (!id || id === "undefined" || id === "null") {
      return res.status(400).json({ error: "ID de pagamento inválido." });
    }

    // Consulta do pagamento utilizando a instância 'payment' instanciada no topo
    const paymentData = await payment.get({ id: String(id) });

    if (!paymentData) {
      return res.status(404).json({ error: "Pagamento não encontrado." });
    }

    return res.json({
      status: paymentData.status,
      status_detail: paymentData.status_detail
    });
  } catch (error) {
    console.error("Erro ao checar status do pagamento:", error?.message || error);
    return res.status(500).json({ 
      error: "Erro ao consultar Mercado Pago", 
      details: error?.message || String(error) 
    });
  }
});

// Suas outras rotas (create_preference, process_payment, webhook, etc.) continuam abaixo...
