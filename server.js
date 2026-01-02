const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const qrcode = require('qrcode-terminal');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

let sock = null;
let qrCodeData = null;
let isConnected = false;
let clientsWS = new Set();

// Rota de status
app.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    connected: isConnected,
    timestamp: new Date().toISOString()
  });
});

// Rota de QR Code
app.get('/qr', (req, res) => {
  res.json({ 
    qr: qrCodeData,
    connected: isConnected
  });
});

// WebSocket para comunicação em tempo real
wss.on('connection', (ws) => {
  console.log('✓ Cliente WebSocket conectado');
  clientsWS.add(ws);
  
  // Enviar status atual
  ws.send(JSON.stringify({
    type: 'status',
    connected: isConnected,
    qr: qrCodeData
  }));
  
  ws.on('close', () => {
    clientsWS.delete(ws);
    console.log('✗ Cliente WebSocket desconectado');
  });
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'send_message') {
        await sendMessage(data.to, data.message, data.attachment);
      } else if (data.type === 'send_bulk') {
        await sendBulkMessages(data.contacts, data.messages, data.delayConfig);
      }
    } catch (error) {
      console.error('Erro ao processar mensagem WebSocket:', error);
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  });
});

// Função para broadcast
function broadcast(data) {
  const message = JSON.stringify(data);
  clientsWS.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Conectar ao WhatsApp
async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
  
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true
  });

  sock.ev.on('creds.update', saveCreds);
  
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log('📱 QR Code gerado!');
      qrCodeData = qr;
      isConnected = false;
      
      // Mostrar QR no terminal
      qrcode.generate(qr, { small: true });
      
      // Enviar QR para clientes WebSocket
      broadcast({ type: 'qr', qr: qr });
    }
    
    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('❌ Conexão fechada. Reconectando:', shouldReconnect);
      
      broadcast({ type: 'status', connected: false });
      
      if (shouldReconnect) {
        setTimeout(() => connectWhatsApp(), 5000);
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp conectado com sucesso!');
      isConnected = true;
      qrCodeData = null;
      
      broadcast({ type: 'status', connected: true });
    }
  });
  
  sock.ev.on('messages.upsert', async ({ messages }) => {
    console.log('📨 Mensagens recebidas:', messages.length);
    broadcast({ type: 'messages', messages });
  });
}

// Enviar mensagem individual
async function sendMessage(to, message, attachment = null) {
  if (!sock || !isConnected) {
    throw new Error('WhatsApp não está conectado');
  }
  
  const jid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;
  
  if (attachment) {
    // Enviar com anexo
    const messageData = { caption: message };
    
    if (attachment.type === 'image') {
      await sock.sendMessage(jid, { image: { url: attachment.url }, caption: message });
    } else if (attachment.type === 'video') {
      await sock.sendMessage(jid, { video: { url: attachment.url }, caption: message });
    } else if (attachment.type === 'document') {
      await sock.sendMessage(jid, { document: { url: attachment.url }, caption: message });
    } else if (attachment.type === 'audio') {
      await sock.sendMessage(jid, { audio: { url: attachment.url } });
    } else if (attachment.type === 'location') {
      await sock.sendMessage(jid, {
        location: {
          degreesLatitude: parseFloat(attachment.latitude),
          degreesLongitude: parseFloat(attachment.longitude)
        }
      });
    }
  } else {
    // Enviar apenas texto
    await sock.sendMessage(jid, { text: message });
  }
  
  console.log(`✓ Mensagem enviada para ${to}`);
  return true;
}

// Enviar mensagens em massa
async function sendBulkMessages(contacts, messages, delayConfig) {
  if (!sock || !isConnected) {
    throw new Error('WhatsApp não está conectado');
  }
  
  const { beforeStart, minInterval, maxInterval, randomExtra, messagesPerHour } = delayConfig;
  
  // Aguardar antes de começar
  console.log(`⏰ Aguardando ${beforeStart}s antes de iniciar...`);
  await sleep(beforeStart * 1000);
  
  let sentCount = 0;
  const startTime = Date.now();
  
  for (const contact of contacts) {
    // Verificar limite por hora
    const elapsedHours = (Date.now() - startTime) / (1000 * 60 * 60);
    if (sentCount >= messagesPerHour * Math.max(1, Math.ceil(elapsedHours))) {
      console.log(`⏸️ Limite de ${messagesPerHour} msgs/hora atingido. Aguardando...`);
      await sleep(60000); // Aguardar 1 minuto
    }
    
    // Selecionar mensagem aleatória
    const randomMessage = messages[Math.floor(Math.random() * messages.length)];
    
    try {
      await sendMessage(contact.phone, randomMessage.text, randomMessage.attachment);
      sentCount++;
      
      broadcast({
        type: 'bulk_progress',
        sent: sentCount,
        total: contacts.length,
        currentContact: contact
      });
      
      // Calcular delay variável
      const baseDelay = minInterval + Math.random() * (maxInterval - minInterval);
      const extraDelay = Math.random() * randomExtra;
      const totalDelay = (baseDelay + extraDelay) * 1000;
      
      console.log(`⏱️ Aguardando ${(totalDelay/1000).toFixed(1)}s até próxima mensagem...`);
      await sleep(totalDelay);
      
    } catch (error) {
      console.error(`❌ Erro ao enviar para ${contact.phone}:`, error);
      broadcast({
        type: 'bulk_error',
        contact: contact,
        error: error.message
      });
    }
  }
  
  console.log(`✅ Envio em massa concluído! ${sentCount}/${contacts.length} mensagens enviadas.`);
  broadcast({
    type: 'bulk_complete',
    sent: sentCount,
    total: contacts.length
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📱 Conectando ao WhatsApp...`);
  connectWhatsApp();
});