global.WebSocket = require('ws');
global.fetch = require('node-fetch');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require('baileys');

const app = express();
const server = http.createServer(app);

// Mode global (public|private)
global.mode = global.mode || 'public';

// Allowed origin
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://adam-d-h7-q8qo.onrender.com';
const io = new Server(server, {
  cors: { origin: [ALLOWED_ORIGIN], methods: ['GET','POST'] },
  pingInterval: 25000,
  pingTimeout: 120000
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.status(200).send('ok'));

// Répertoire des sessions
const SESSIONS_BASE = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_BASE)) fs.mkdirSync(SESSIONS_BASE, { recursive: true });

// CONFIG
const OWNER_NAME = 'Adam_DH7';
const OWNER_NUMBER = '50935492574';
const BOT_NAME = 'Adam_DH7';
const IMAGE_URL = 'https://res.cloudinary.com/dckwrqrur/image/upload/v1756270884/tf-stream-url/77e5009ff1d7c9cd0cbc8a47c6a15caf_0_xokhwz.jpg';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sessions = {};

function nextAuthFolder() {
  const items = fs.readdirSync(SESSIONS_BASE).filter(n => n.startsWith('auth_info'));
  const nums = items.map(n => { const m = n.match(/auth_info(\d+)/); return m ? parseInt(m[1],10) : 0 });
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `auth_info${next}`;
}

async function startBaileysForSession(sessionId, folderName, socket, opts = { attempt: 0 }) {
  if (sessions[sessionId] && sessions[sessionId].sock) return sessions[sessionId];

  const dir = path.join(SESSIONS_BASE, folderName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let state, saveCreds;
  try {
    const auth = await useMultiFileAuthState(dir);
    state = auth.state;
    saveCreds = auth.saveCreds;
  } catch (err) {
    console.error(`[${sessionId}] useMultiFileAuthState failed`, err);
    socket.emit('error', { message: 'Failed to load auth state', detail: String(err) });
    throw err;
  }

  let sessionOwnerNumber = null;
  try {
    const metaPath = path.join(dir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta && meta.phone) sessionOwnerNumber = meta.phone.replace(/\D/g,'');
    }
  } catch (e) { console.warn(`[${sessionId}] impossible de lire meta.json`, e); }

  let version;
  try { const res = await fetchLatestBaileysVersion(); if (res && res.version) version = res.version; } catch (e) { console.warn(`[${sessionId}] fetchLatestBaileysVersion failed`); }

  const logger = pino({ level: 'silent' });
  const sock = makeWASocket({ version, auth: state, logger, printQRInTerminal: false });

  const sessionObj = {
    sock,
    saveCreds,
    folderName,
    dir,
    restarting: false,
    cachedImageBuffer: null,
    invisibleMode: {},
    bienvenueEnabled: {},
    noLienMode: {},
    sessionOwnerNumber,
    botId: null,
  };
  sessions[sessionId] = sessionObj;

  sock.ev.on('creds.update', saveCreds);

  async function fetchImageBuffer() {
    if (sessionObj.cachedImageBuffer) return sessionObj.cachedImageBuffer;
    try {
      const res = await fetch(IMAGE_URL);
      if (!res.ok) throw new Error('fetch status ' + res.status);
      const ab = await res.arrayBuffer();
      sessionObj.cachedImageBuffer = Buffer.from(ab);
      return sessionObj.cachedImageBuffer;
    } catch (e) { return null; }
  }

  async function sendWithImage(jid, content, options = {}) {
    const text = (typeof content === 'string') ? content : (content.text || '');
    const mentions = (typeof content === 'object' && content.mentions) ? content.mentions : undefined;
    const quoted = (typeof content === 'object' && content.quoted) ? content.quoted : undefined;

    if (options.skipImage) return sock.sendMessage(jid, { text, mentions, quoted });

    try {
      const buf = await fetchImageBuffer();
      if (buf) return await sock.sendMessage(jid, { image: buf, caption: text, mentions, quoted });
    } catch(e){}

    try { return await sock.sendMessage(jid, { image: { url: IMAGE_URL }, caption: text, mentions, quoted }); } 
    catch(e){ return await sock.sendMessage(jid, { text, mentions, quoted }); }
  }

  async function quickReply(jid, text, opts = {}) { return sendWithImage(jid, text, opts); }

  function getSenderId(msg) { return (msg.key && msg.key.participant) ? msg.key.participant : msg.key.remoteJid; }
  function getNumberFromJid(jid) { if (!jid) return ''; return jid.split('@')[0]; }
  function getDisplayName(msg) { return msg.pushName || msg.message?.extendedTextMessage?.contextInfo?.participant || 'Utilisateur'; }
  async function isGroupAdminFn(jid, participantId) { try { const meta = await sock.groupMetadata(jid); const p = meta.participants.find(x=>x.id===participantId); return !!(p && (p.admin || p.admin==='superadmin')); } catch(e){ return false; } }

  sock.ev.on('connection.update', async (update) => {
    try {
      const { connection, qr, lastDisconnect } = update;
      if (qr) {
        try { socket.emit('qr', { sessionId, qrDataUrl: await QRCode.toDataURL(qr) }); } 
        catch(e){ socket.emit('qr', { sessionId, qrString: qr }); }
      }

      if (connection==='open') {
        sessionObj.botId = sock.user?.id || sock.user?.jid || null;
        sessionObj.sessionOwnerNumber = sessionObj.sessionOwnerNumber || (sock.user?.id || sock.user?.jid)?.split('@')[0] || sessionObj.sessionOwnerNumber;
        console.log(`[${sessionId}] Connected`);
        socket.emit('connected', { sessionId, folderName });
        try { fs.writeFileSync(path.join(dir,'meta.json'), JSON.stringify({ connectedAt: Date.now() }, null, 2)); } catch(e){}
        sessions[sessionId].restarting = false;
      }

      if (connection==='close') {
        const code = lastDisconnect?.error?.output?.statusCode || null;
        console.log(`[${sessionId}] Connection closed, code=${code}`);
        socket.emit('disconnected', { sessionId, reason: code });
        if (code===DisconnectReason.loggedOut) { sock.end(); delete sessions[sessionId]; return; }
        if (code===DisconnectReason.restartRequired || code===515) {
          sessions[sessionId].restarting = true;
          sock.end(); delete sessions[sessionId];
          setTimeout(()=>startBaileysForSession(sessionId, folderName, socket, { attempt:(opts.attempt||0)+1 }), Math.min(30000, 2000+(opts.attempt||0)*2000));
          return;
        }
        sock.end(); delete sessions[sessionId];
        setTimeout(()=>startBaileysForSession(sessionId, folderName, socket, { attempt:0 }), 5000);
      }

    } catch(err){ console.error('connection.update handler error', err); }
  });

  // messages.upsert handler
  sock.ev.on('messages.upsert', async (up) => {
    try {
      const messages = up.messages || []; if (!messages.length) return;
      const msg = messages[0]; if (!msg || !msg.message) return;

      const jid = msg.key.remoteJid;
      const isGroup = jid.endsWith('@g.us');
      if (msg.key.remoteJid==='status@broadcast') return;

      let textRaw = '';
      const m = msg.message;
      if (m.conversation) textRaw=m.conversation; 
else if (m.extendedTextMessage) textRaw = m.extendedTextMessage.text || '';
else if (m.imageMessage && m.imageMessage.caption) textRaw = m.imageMessage.caption;
else if (m.videoMessage && m.videoMessage.caption) textRaw = m.videoMessage.caption;

const senderId = getSenderId(msg);
  const senderNumber = getNumberFromJid(senderId);
  const senderName = getDisplayName(msg);

  // Exemple simple: auto-reply si mode public
  if (global.mode === 'public') {
    if (textRaw && !msg.key.fromMe) {
      await quickReply(jid, `Hello ${senderName}, your message has been received!\nMode: ${global.mode}`);
    }
  }

  // Exemple: commandes simples
  if (textRaw?.startsWith('.')) {
    const command = textRaw.slice(1).trim().split(' ')[0].toLowerCase();
    const args = textRaw.slice(command.length + 2).trim();

    switch (command) {
      case 'ping':
        await quickReply(jid, `Pong!`);
        break;
      case 'menu':
        await quickReply(jid, `*${BOT_NAME} Menu*\n- .ping\n- .menu\n- .help`);
        break;
      case 'help':
        await quickReply(jid, `Help commands:\n.ping - check bot\n.menu - show menu`);
        break;
      default:
        await quickReply(jid, `Unknown command: ${command}`);
    }
  }

} catch (err) {
  console.error(`[${sessionId}] messages.upsert error:`, err);
}

});

return sessionObj; }

// Socket.IO connection io.on('connection', (socket) => { console.log('Client connected via socket.io');

socket.on('start-session', async ({ sessionId }) => { try { const folderName = nextAuthFolder(); await startBaileysForSession(sessionId, folderName, socket); socket.emit('session-started', { sessionId, folderName }); } catch (e) { console.error('Failed to start session', e); socket.emit('error', { message: 'Failed to start session', detail: String(e) }); } });

socket.on('disconnect', () => { console.log('Client disconnected'); }); });

// Démarrage serveur const PORT = process.env.PORT || 3000; server.listen(PORT, () => console.log(Server running on port ${PORT}));
