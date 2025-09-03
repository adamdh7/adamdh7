global.WebSocket = require('ws');
global.fetch = require('node-fetch');

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require('baileys');

const app = express();
const server = http.createServer(app);

// default global mode (public|private)
global.mode = global.mode || 'public';

// Allowed origin (si tu déployes)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://adam-d-h7-q8qo.onrender.com';
const io = new Server(server, {
  cors: { origin: [ALLOWED_ORIGIN], methods: ['GET','POST'] },
  pingInterval: 25000,
  pingTimeout: 120000
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.status(200).send('ok'));

// sessions base dir
const SESSIONS_BASE = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_BASE)) fs.mkdirSync(SESSIONS_BASE, { recursive: true });

// CONFIG — modifie si besoin
const OWNER_NAME = 'Adam_DH7';
const OWNER_NUMBER = '50935492574'; // numéro global (fallback)
const BOT_NAME = 'Adam_DH7';

// image par défaut (utilisée pour la plupart des réponses)
const IMAGE_URL = 'https://res.cloudinary.com/dckwrqrur/image/upload/v1756270884/tf-stream-url/77e5009ff1d7c9cd0cbc8a47c6a15caf_0_xokhwz.jpg';

// utils
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function nextAuthFolder() {
  const items = fs.readdirSync(SESSIONS_BASE).filter(n => n.startsWith('auth_info'));
  const nums = items.map(n => {
    const m = n.match(/auth_info(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  });
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `auth_info${next}`;
}

const sessions = {}; // sessions en mémoire

async function startBaileysForSession(sessionId, folderName, socket, opts = { attempt: 0 }) {
  if (sessions[sessionId] && sessions[sessionId].sock) return sessions[sessionId];

  const dir = path.join(SESSIONS_BASE, folderName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // charge auth state
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

  // récupère meta.json (créé par create_session) pour déterminer qui a scanné le QR
  let sessionOwnerNumber = null;
  try {
    const metaPath = path.join(dir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta && meta.phone) {
        sessionOwnerNumber = meta.phone.replace(/\D/g, '');
      }
    }
  } catch (e) {
    console.warn(`[${sessionId}] impossible de lire meta.json`, e);
  }

  // version WA best-effort
  let version = undefined;
  try {
    const res = await fetchLatestBaileysVersion();
    if (res && res.version) version = res.version;
  } catch (err) {
    console.warn(`[${sessionId}] fetchLatestBaileysVersion failed — proceeding without explicit version`);
  }

  const logger = pino({ level: 'silent' });
  const sock = makeWASocket({ version, auth: state, logger, printQRInTerminal: false });

  const sessionObj = {
    sock,
    saveCreds,
    folderName,
    dir,
    restarting: false,
    cachedImageBuffer: null,
    invisibleMode: {},        // map jid -> intervalId (pour dh7)
    bienvenueEnabled: {},     // map jid -> boolean
    noLienMode: {},           // map jid -> 'off' | 'exceptAdmins' | 'all'
    sessionOwnerNumber,       // numéro (string) de la personne qui a crée/la session (scanner)
    botId: null,              // rempli après connexion
  };
  sessions[sessionId] = sessionObj;

  // persist creds
  sock.ev.on('creds.update', saveCreds);

  // helper: cache image buffer
  async function fetchImageBuffer() {
    if (sessionObj.cachedImageBuffer) return sessionObj.cachedImageBuffer;
    try {
      const res = await fetch(IMAGE_URL);
      if (!res.ok) throw new Error('fetch status ' + res.status);
      const ab = await res.arrayBuffer();
      sessionObj.cachedImageBuffer = Buffer.from(ab);
      return sessionObj.cachedImageBuffer;
    } catch (e) {
      return null;
    }
  }

  // helper: envoie texte + image (skipImage = true => texte seul)
  async function sendWithImage(jid, content, options = {}) {
    const text = (typeof content === 'string') ? content : (content.text || '');
    const mentions = (typeof content === 'object' && content.mentions) ? content.mentions : undefined;
    const quoted = (typeof content === 'object' && content.quoted) ? content.quoted : undefined;

    if (options.skipImage) {
      const msg = { text };
      if (mentions) msg.mentions = mentions;
      if (quoted) msg.quoted = quoted;
      return sock.sendMessage(jid, msg);
    }

    try {
      const buf = await fetchImageBuffer();
      if (buf) {
        const msg = { image: buf, caption: text };
        if (mentions) msg.mentions = mentions;
        if (quoted) msg.quoted = quoted;
        return await sock.sendMessage(jid, msg);
      }
    } catch (err) {
      console.warn(`[${sessionId}] image buffer send failed:`, err);
    }

    try {
      const msg = { image: { url: IMAGE_URL }, caption: text };
      if (mentions) msg.mentions = mentions;
      if (quoted) msg.quoted = quoted;
      return await sock.sendMessage(jid, msg);
    } catch (err) {
      console.warn(`[${sessionId}] image url send failed:`, err);
    }

    const msg = { text };
    if (mentions) msg.mentions = mentions;
    if (quoted) msg.quoted = quoted;
    return sock.sendMessage(jid, msg);
  }

  async function quickReply(jid, text, opts = {}) {
    return sendWithImage(jid, text, opts);
  }

  // helpers destinés au traitement de messages
  function getSenderId(msg) {
    return (msg.key && msg.key.participant) ? msg.key.participant : msg.key.remoteJid;
  }
  function getNumberFromJid(jid) {
    if (!jid) return '';
    return jid.split('@')[0];
  }
  function getDisplayName(msg) {
    return msg.pushName || (msg.message && msg.message?.extendedTextMessage?.contextInfo?.participant) || 'Utilisateur';
  }

  async function isGroupAdminFn(jid, participantId) {
    try {
      const meta = await sock.groupMetadata(jid);
      const p = meta.participants.find(x => x.id === participantId);
      return !!(p && (p.admin || p.admin === 'superadmin'));
    } catch (e) {
      return false;
    }
  }

  // --- TRACE: connection.update handler (QR, open, close, restart) ---
  sock.ev.on('connection.update', async (update) => {
    try {
      const { connection, qr, lastDisconnect } = update;
      if (qr) {
        try {
          const dataUrl = await QRCode.toDataURL(qr);
          socket.emit('qr', { sessionId, qrDataUrl: dataUrl });
        } catch (e) {
          socket.emit('qr', { sessionId, qrString: qr });
        }
      }

      if (connection === 'open') {
        // tente remplir botId
        try {
          if (sock.user && (sock.user.id || sock.user.jid)) {
            sessionObj.botId = (sock.user.id || sock.user.jid);
          } else if (sock.user) {
            sessionObj.botId = sock.user;
          }
        } catch (e) { /* ignore */ }

        // --- NOUVEAU : reconnaître automatiquement l'utilisateur qui a scanné le QR comme owner de la session ---
        try {
          const me = sock.user?.id || sock.user?.jid || (sock.user && sock.user[0] && sock.user[0].id);
          if (me) {
            const ownerNum = (typeof me === 'string' && me.includes('@')) ? me.split('@')[0] : String(me);
            sessionObj.sessionOwnerNumber = ownerNum.replace(/\D/g, '');
            console.log(`[${sessionId}] sessionOwnerNumber détecté automatiquement: ${sessionObj.sessionOwnerNumber}`);
          }
        } catch (e) {
          console.warn(`[${sessionId}] impossible de détecter session owner automatiquement`, e);
        }

        console.log(`[${sessionId}] Connected (folder=${folderName})`);
        socket.emit('connected', { sessionId, folderName });
        try { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ connectedAt: Date.now() }, null, 2)); } catch(e){}
        if (sessions[sessionId]) sessions[sessionId].restarting = false;
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error || {}).output?.statusCode || null;
        console.log(`[${sessionId}] Connection closed, code=${code}`);
        socket.emit('disconnected', { sessionId, reason: code });

        if (code === DisconnectReason.loggedOut) {
          try { sock.end(); } catch(e){}
          delete sessions[sessionId];
          return;
        }

        if (code === DisconnectReason.restartRequired || code === 515) {
          console.log(`[${sessionId}] restart required (code ${code}). Attempting re-init.`);
          if (sessions[sessionId]) sessions[sessionId].restarting = true;
          try { sock.end(); } catch(e){}
          delete sessions[sessionId];

          const attempt = (opts && opts.attempt) ? opts.attempt : 0;
          const delay = Math.min(30000, 2000 + attempt * 2000);
          setTimeout(() => {
            startBaileysForSession(sessionId, folderName, socket, { attempt: attempt + 1 })
              .then(() => socket.emit('restarted', { sessionId, folderName }))
              .catch(err => {
                console.error(`[${sessionId}] restart failed`, err);
                socket.emit('error', { message: 'Restart failed', detail: String(err) });
              });
          }, delay);
          return;
        }

        try { sock.end(); } catch(e){}
        delete sessions[sessionId];
        setTimeout(() => {
          startBaileysForSession(sessionId, folderName, socket, { attempt: 0 })
            .then(() => socket.emit('reconnected', { sessionId, folderName }))
            .catch(err => {
              console.error(`[${sessionId}] reconnect failed`, err);
              socket.emit('error', { message: 'Reconnect failed', detail: String(err) });
            });
        }, 5000);
      }
    } catch (err) {
      console.error('connection.update handler error', err);
    }
  });

  // CONSTRUCTION DU MENU
  function buildMenu(pushName) {
    return `🌹  *${BOT_NAME}*🌹
────────────────────────────
🌷 𝐔𝐬𝐞𝐫: "${pushName}"
🥀 𝐎𝐰𝐧𝐞𝐫: *${OWNER_NAME}*

────────────────────────────
📂 𝐂𝐨𝐦𝐦𝐚𝐧𝐝𝐞𝐬:
────────────────────────────

🔱 *Général*
\`\`\`
*●Menu*
*○Owner*
*●Qr [texte]*
\`\`\`

🔱 *Groupe*
\`\`\`
*○Lien*
*●Tagall*
*○Hidetag*
*●Kick*
*○Add*
*●Promote*
*○Demote*
*●Kickall*
*○Ferme*
*●Ouvert*
*○Bienvenue [off]*
\`\`\`

🔱 *Modération*
\`\`\`
*●Nolien*
*○Nolien2*
*●Kickall*
*○Kick*
*●Add*
*○Promote*
*●Delmote*
\`\`\`

👑 *${BOT_NAME}*
────────────────────────────
> *D'H7 | Tergene*`;
  }

  function resolveTargetIds({ jid, m, args }) {
    const ids = [];
    const ctx = m.extendedTextMessage?.contextInfo || {};
    if (ctx.mentionedJid && Array.isArray(ctx.mentionedJid) && ctx.mentionedJid.length) {
      return ctx.mentionedJid;
    }
    if (ctx.participant) ids.push(ctx.participant);
    if (args && args.length) {
      for (const a of args) {
        if (a.includes('@')) { ids.push(a); continue; }
        const cleaned = a.replace(/[^0-9+]/g, '');
        if (!cleaned) continue;
        const noPlus = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
        ids.push(`${noPlus}@s.whatsapp.net`);
      }
    }
    return Array.from(new Set(ids));
  }

  // --- MAIN message handler ---
  sock.ev.on('messages.upsert', async (up) => {
    try {
      const messages = up.messages || [];
      if (!messages.length) return;
      const msg = messages[0];
      if (!msg || !msg.message) return;

      const jid = msg.key.remoteJid;
      const isGroup = jid && jid.endsWith && jid.endsWith('@g.us');

      // ignore status
      if (msg.key && msg.key.remoteJid === 'status@broadcast') return;

      // extraire texte
      let raw = '';
      const m = msg.message;
      if (m.conversation) raw = m.conversation;
      else if (m.extendedTextMessage?.text) raw = m.extendedTextMessage.text;
      else if (m.imageMessage?.caption) raw = m.imageMessage.caption;
      else if (m.videoMessage?.caption) raw = m.videoMessage.caption;
      else if (m.documentMessage?.caption) raw = m.documentMessage.caption;
      else raw = '';

      const textRaw = (raw || '').toString().trim();
      const withoutDot = textRaw.startsWith('.') ? textRaw.slice(1) : textRaw;
      const parts = withoutDot.split(/\s+/).filter(Boolean);
      const cmd = (parts[0] || '').toLowerCase();
      const args = parts.slice(1);
      const argText = args.join(' ').trim();

      // sender info
      const senderId = getSenderId(msg);
      const senderNumber = getNumberFromJid(senderId);
      const pushName = getDisplayName(msg) || 'Utilisateur';

      // owner/session owner detection
      const sessionOwnerNumber = sessionObj.sessionOwnerNumber || OWNER_NUMBER; // scanner QR ou fallback
      const isOwner = (senderNumber === OWNER_NUMBER) || (senderNumber === sessionOwnerNumber);
      const isAdmin = isGroup ? await isGroupAdminFn(jid, senderId) : false;

      // PRIVÉ: si global.mode === 'private', ne répondre qu'au scanner (sessionOwnerNumber) ou OWNER_NUMBER
      if (global.mode === 'private') {
        if (!((senderNumber === sessionOwnerNumber) || (senderNumber === OWNER_NUMBER))) {
          return;
        }
      }

      // enforcement: suppression liens si mode activé (nolien / nolien2)
      try {
        const lc = textRaw.toLowerCase();
        const containsLink = /https?:\/\/|chat\.whatsapp\.com|www\./i.test(lc);
        if (isGroup && containsLink) {
          const mode = sessionObj.noLienMode[jid] || 'off';
          if (mode === 'exceptAdmins') {
            if (!isAdmin && !isOwner) {
              try { await sock.sendMessage(jid, { delete: msg.key }); } catch(e){}
              return;
            }
          } else if (mode === 'all') {
            try { await sock.sendMessage(jid, { delete: msg.key }); } catch(e){}
            return;
          }
        }
      } catch (e) { /* ignore */ }

      // invisible mode behavior (dh7)
      if (isGroup && sessionObj.invisibleMode[jid]) {
        try { await sendWithImage(jid, 'ㅤ   '); } catch (e) {}
        return;
      }

      // DEBUG
      console.log(`[${sessionId}] MSG from=${jid} sender=${senderId} cmd=${cmd} text="${textRaw}"`);

      // --- COMMANDS ---
      switch (cmd) {
        case 'd':
        case 'menu':
          await sendWithImage(jid, buildMenu(pushName));
          break;

        case 'lien':
          if (!isGroup) return await quickReply(jid, 'Seulement pour groupe.');
          try {
            const meta = await sock.groupMetadata(jid);
            const ids = meta.participants.map(p => p.id);
            await fetchImageBuffer().catch(()=>{});
            let code = null;
            try {
              if (typeof sock.groupInviteCode === 'function') code = await sock.groupInviteCode(jid);
            } catch (e) { /* ignore */ }
            if (!code && meta && meta.id) {
              code = meta.inviteCode || null;
            }
            if (code) {
              const link = `https://chat.whatsapp.com/${code}`;
              await sock.sendMessage(jid, { text: link, mentions: ids });
            } else {
              await sock.sendMessage(jid, { text: 'https://chat.whatsapp.com/', mentions: ids });
            }
          } catch (e) {
            console.error('lien error', e);
            await quickReply(jid, 'Impossible de récupérer le lien du groupe.');
          }
          break;

        case 'nolien':
          if (!isGroup) return await quickReply(jid, 'Seulement pour groupe.');
          if (!(isAdmin || isOwner)) return await quickReply(jid, 'Seul admin/owner peut activer.');
          sessionObj.noLienMode[jid] = 'exceptAdmins';
          await quickReply(jid, 'Mode nolien activé: tous les liens seront supprimés SAUF ceux des admins.');
          break;

        case 'nolien2':
          if (!isGroup) return await quickReply(jid, 'Seulement pour groupe.');
          if (!(isAdmin || isOwner)) return await quickReply(jid, 'Seul admin/owner peut activer.');
          sessionObj.noLienMode[jid] = 'all';
          await quickReply(jid, 'Mode nolien2 activé: tous les liens seront supprimés (même admin).');
          break;

        case 'nostat':
          if (textRaw && textRaw.includes('status')) {
            try { await sock.sendMessage(jid, { delete: msg.key }); } catch(e){}
          }
          break;

        case 'ban':
          if (!isGroup) return await quickReply(jid, 'Seul pour groupe.');
          if (!isOwner) return await quickReply(jid, 'Seul owner peut bannir le groupe.');
          try {
            const meta = await sock.groupMetadata(jid);
            const participants = meta.participants.map(p => p.id);
            const botId = sessionObj.botId || (sock.user && (sock.user.id || sock.user.jid)) || null;
            for (const p of participants) {
              if (p === botId) continue;
              try { await sock.groupParticipantsUpdate(jid, [p], 'remove'); await sleep(200); } catch(e){ console.warn('ban remove error', p, e); }
            }
            try { await sock.groupLeave(jid); } catch(e){ console.warn('ban leave error', e); }
          } catch (e) {
            console.error('ban error', e);
            await quickReply(jid, 'Erreur lors du bannissement du groupe.');
          }
          break;

        case 'public':
          global.mode = 'public';
          await quickReply(jid, 'Mode: public (tout le monde peut utiliser les commandes non-admin).');
          break;

        case 'prive':
          if (global.mode === 'private') return await quickReply(jid, 'Le mode est déjà activé en privé.');
          global.mode = 'private';
          global.mode = 'public';
          await quickReply(jid, '✅ Mode: *Privé* activé.');
          break;

        case 'owner':
          try {
            const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${OWNER_NAME}\nTEL;type=CELL;type=VOICE;waid=${OWNER_NUMBER}:+${OWNER_NUMBER}\nEND:VCARD`;
            await sock.sendMessage(jid, { contacts: { displayName: OWNER_NAME, contacts: [{ vcard }] } });
          } catch (e) { console.error('owner card error', e); }
          break;

        case 'play':
          if (!argText) return await quickReply(jid, "Antre le nom de la vidéo. Ex: .play Formidable");
          {
            const title = argText;
            const out = `Video\n${title}`;
            await quickReply(jid, out);
          }
          break;

        case 'tg':
        case 'tagall':
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nTagall se pour groupe seulement.`); break; }
          try {
            const meta = await sock.groupMetadata(jid);
            const ids = meta.participants.map(p => p.id);
            const list = ids.map((id,i) => `${i===0 ? '●' : '○'}@${id.split('@')[0]}`).join('\n');
            const out = `*${BOT_NAME}*\n${list}\n>》》 》》 》 》》D'H7:Tergene`;
            await sendWithImage(jid, { text: out, mentions: ids });
          } catch (e) {
            console.error('tagall error', e);
            await sendWithImage(jid, `${BOT_NAME}\nImpossible de tagall.`);
          }
          break;

        case 'tm':
        case 'hidetag': {
          if (!isGroup) { await sock.sendMessage(jid, { text: `${BOT_NAME}\nTM est pour groupe seulement.` }); break; }

          if (argText) {
            try {
              const meta2 = await sock.groupMetadata(jid);
              const ids2 = meta2.participants.map(p => p.id);
              await sock.sendMessage(jid, { text: argText, mentions: ids2 }); // texte seul
            } catch (e) {
              console.error('tm error', e);
              await sock.sendMessage(jid, { text: `${BOT_NAME}\nErreur tm.` });
            }
            break;
          }

          const ctx = m.extendedTextMessage?.contextInfo || {};
          const quoted = ctx?.quotedMessage;
          if (quoted) {
            let qtext = '';
            if (quoted.conversation) qtext = quoted.conversation;
            else if (quoted.extendedTextMessage?.text) qtext = quoted.extendedTextMessage.text;
            else if (quoted.imageMessage?.caption) qtext = quoted.imageMessage.caption;
            else if (quoted.videoMessage?.caption) qtext = quoted.videoMessage.caption;
            else if (quoted.documentMessage?.caption) qtext = quoted.documentMessage.caption;
            else qtext = '';

            if (!qtext) {
              await sock.sendMessage(jid, { text: `${BOT_NAME}\nImpossible de reproduire le message reply (type non pris en charge).` });
            } else {
              try {
                const meta2 = await sock.groupMetadata(jid);
                const ids2 = meta2.participants.map(p => p.id);
                await sock.sendMessage(jid, { text: qtext, mentions: ids2 });
              } catch (e) {
                console.error('tm reply error', e);
                await sock.sendMessage(jid, { text: `${BOT_NAME}\nErreur tm reply.` });
              }
            }
            break;
          }

          await sock.sendMessage(jid, { text: `${BOT_NAME}\nUtilisation: tm [texte] ou tm (en reply)` });
          break;
        }

        case 'dh7':
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nMode Envizib se pour groupe seulement.`); break; }
          if (sessionObj.invisibleMode[jid]) {
            clearInterval(sessionObj.invisibleMode[jid]);
            delete sessionObj.invisibleMode[jid];
            await sendWithImage(jid, `${BOT_NAME}\nMode envizib desactivé.`);
            break;
          }
          sessionObj.invisibleMode[jid] = setInterval(() => {
            sendWithImage(jid, 'ㅤ   ').catch(()=>{});
          }, 1000);
          await sendWithImage(jid, `${BOT_NAME}\nMode envizib activé: spam d'images.`);
          break;

        case 'del': {
          const ctx = m.extendedTextMessage?.contextInfo;
          if (ctx?.stanzaId) {
            const quoted = {
              remoteJid: jid,
              fromMe: false,
              id: ctx.stanzaId,
              participant: ctx.participant
            };
            try { await sock.sendMessage(jid, { delete: quoted }); } catch(e){ await sendWithImage(jid, `${BOT_NAME}\nImpossible d'effacer.`); }
          } else {
            await sendWithImage(jid, `${BOT_NAME}\nRépondre à un message avec .del pour l'effacer.`);
          }
          break;
        }

        case 'kickall':
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nKickall pour groupe seulement.`); break; }
          try {
            const meta3 = await sock.groupMetadata(jid);
            const admins = meta3.participants.filter(p => p.admin || p.admin === 'superadmin').map(p => p.id);
            const sender = senderId;
            if (!admins.includes(sender) && !isOwner) { await sendWithImage(jid, `${BOT_NAME}\nTu n'es pas admin.`); break; }
            for (const p of meta3.participants) {
              if (!admins.includes(p.id)) {
                try { await sock.groupParticipantsUpdate(jid, [p.id], 'remove'); await sleep(200); } catch(e){ console.warn('kick error', p.id, e); }
              }
            }
            await sock.groupUpdateSubject(jid, BOT_NAME);
          } catch (e) { console.error('kickall error', e); await sendWithImage(jid, `${BOT_NAME}\nErreur kickall.`); }
          break;

        case 'qr':
          if (!argText) { await sendWithImage(jid, `${BOT_NAME}\nUsage: .qr [texte]`); break; }
          try {
            const buf = await QRCode.toBuffer(argText);
            await sock.sendMessage(jid, { image: buf, caption: `${BOT_NAME}\n${argText}` });
          } catch (e) { console.error('qr error', e); await sendWithImage(jid, `${BOT_NAME}\nImpossible générer QR.`); }
          break;

        case 'img':
        case 'image':
          try {
            const buf = await fetchImageBuffer();
            if (buf) await sock.sendMessage(jid, { image: buf, caption: `${BOT_NAME}\nMen imaj la.` });
            else await sendWithImage(jid, `${BOT_NAME}\nMen imaj la.`);
          } catch (e) { console.error('img error', e); await sendWithImage(jid, `${BOT_NAME}\nErreur image.`); }
          break;

        case 'kick': {
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nKick pour groupe seulement.`); break; }
          const senderKick = senderId;
          if (!(await isGroupAdminFn(jid, senderKick)) && !isOwner) { await sendWithImage(jid, `${BOT_NAME}\nTu dois être admin.`); break; }
          const targetsKick = resolveTargetIds({ jid, m, args });
          if (!targetsKick.length) { await sendWithImage(jid, `${BOT_NAME}\nReply ou tag l'utilisateur: kick @user`); break; }
          for (const t of targetsKick) {
            try { await sock.groupParticipantsUpdate(jid, [t], 'remove'); await sleep(500); } catch (e) { console.error('kick error', e); await sendWithImage(jid, `${BOT_NAME}\nImpossible de kick ${t.split('@')[0]}`); }
          }
          break;
        }

        case 'add': {
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nAdd pour groupe seulement.`); break; }
          const senderAdd = senderId;
          if (!(await isGroupAdminFn(jid, senderAdd)) && !isOwner) { await sendWithImage(jid, `${BOT_NAME}\nTu n'es pas admin.`); break; }
          const targetsAdd = resolveTargetIds({ jid, m, args });
          if (!targetsAdd.length) { await sendWithImage(jid, `${BOT_NAME}\nFormat: add 509XXXXXXXX`); break; }
          for (const t of targetsAdd) {
            try { await sock.groupParticipantsUpdate(jid, [t], 'add'); await sleep(800); } catch (e) { console.error('add error', e); await sendWithImage(jid, `${BOT_NAME}\nImpossible ajouter ${t.split('@')[0]}`); }
          }
          break;
        }

        case 'promote': {
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nPromote pour groupe seulement.`); break; }
          const senderProm = senderId;
          if (!(await isGroupAdminFn(jid, senderProm)) && !isOwner) { await sendWithImage(jid, `${BOT_NAME}\nTu n'es pas admin.`); break; }
          const targetsProm = resolveTargetIds({ jid, m, args });
          if (!targetsProm.length) { await sendWithImage(jid, `${BOT_NAME}\nReply ou tag: promote @user`); break; }
          for (const t of targetsProm) {
            try { await sock.groupParticipantsUpdate(jid, [t], 'promote'); await sleep(500); } catch (e) { console.error('promote error', e); await sendWithImage(jid, `${BOT_NAME}\nImpossible promote ${t.split('@')[0]}`); }
          }
          break;
        }

        case 'delmote':
        case 'demote': {
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nDemote pour groupe seulement.`); break; }
          const senderDem = senderId;
          if (!(await isGroupAdminFn(jid, senderDem)) && !isOwner) { await sendWithImage(jid, `${BOT_NAME}\nTu n'es pas admin.`); break; }
          const targetsDem = resolveTargetIds({ jid, m, args });
          if (!targetsDem.length) { await sendWithImage(jid, `${BOT_NAME}\nReply ou tag: demote @user`); break; }
          for (const t of targetsDem) {
            try { await sock.groupParticipantsUpdate(jid, [t], 'demote'); await sleep(500); } catch (e) { console.error('demote error', e); await sendWithImage(jid, `${BOT_NAME}\nImpossible demote ${t.split('@')[0]}`); }
          }
          break;
        }

        case 'ferme': {
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nFerme pour groupe seulement.`); break; }
          const senderFerme = senderId;
          if (!(await isGroupAdminFn(jid, senderFerme)) && !isOwner) { await sendWithImage(jid, `${BOT_NAME}\nTu n'es pas admin.`); break; }
          try { await sock.groupSettingUpdate(jid, 'announcement'); await sendWithImage(jid, `${BOT_NAME}\nGroupe fermé (admins only).`); } catch(e){ console.error('ferme error', e); await sendWithImage(jid, `${BOT_NAME}\nImpossible de fermer.`); }
          break;
        }

        case 'ouvert': {
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nOuvert pour groupe seulement.`); break; }
          const senderOuv = senderId;
          if (!(await isGroupAdminFn(jid, senderOuv)) && !isOwner) { await sendWithImage(jid, `${BOT_NAME}\nTu n'es pas admin.`); break; }
          try { await sock.groupSettingUpdate(jid, 'not_announcement'); await sendWithImage(jid, `${BOT_NAME}\nGroupe ouvert.`); } catch(e){ console.error('ouvert error', e); await sendWithImage(jid, `${BOT_NAME}\nImpossible d'ouvrir.`); }
          break;
        }

        case 'bienvenue': {
          if (!isGroup) { await sendWithImage(jid, `${BOT_NAME}\nBienvenue pour groupe seulement.`); break; }
          if (!(await isGroupAdminFn(jid, senderId)) && !isOwner) { await sendWithImage(jid, `${BOT_NAME}\nTu n'es pas admin.`); break; }
          sessionObj.bienvenueEnabled[jid] = !(argText && argText.toLowerCase() === 'off');
          await sendWithImage(jid, `${BOT_NAME}\nBienvenue: ${sessionObj.bienvenueEnabled[jid] ? 'ON' : 'OFF'}`);
          break;
        }

        default:
          // pas de commande connue => rien faire
          break;
      }

    } catch (err) {
      console.error('messages.upsert handler error', err);
    }
  });

  // bienvenue handler: envoie message si activé
  sock.ev.on('group-participants.update', async (update) => {
    try {
      const gid = update.id || update.jid || update.groupId;
      if (!gid) return;
      if (!sessionObj.bienvenueEnabled[gid]) return;
      const meta = await sock.groupMetadata(gid);
      const groupName = meta.subject || '';
      for (const p of (update.participants || [])) {
        const userJid = typeof p === 'string' ? p : p?.id;
        if (!userJid) continue;
        const txt = `Bienvenue @${userJid.split('@')[0]} dans ${groupName}`;
        await sendWithImage(gid, { text: txt, mentions: [userJid] });
      }
    } catch (e) { console.error('bienvenue error', e); }
  });

  return sessionObj;
}

// socket.io UI handlers
io.on('connection', (socket) => {
  console.log('Web client connected', socket.id);

  socket.on('create_session', async (payload) => {
    try {
      const profile = (payload && payload.profile) ? String(payload.profile) : 'unknown';
      const name = (payload && payload.name) ? String(payload.name) : '';
      const phone = (payload && payload.phone) ? String(payload.phone) : '';

      const folderName = nextAuthFolder();
      const sessionId = uuidv4();

      const dir = path.join(SESSIONS_BASE, folderName);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const meta = { sessionId, folderName, profile, name, phone, createdAt: Date.now() };
      try { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2)); } catch(e){}

      await startBaileysForSession(sessionId, folderName, socket);

      socket.emit('session_created', { sessionId, folderName });
    } catch (err) {
      console.error('create_session error', err);
      socket.emit('error', { message: 'Failed to create session', detail: String(err) });
    }
  });

  socket.on('list_sessions', () => {
    const arr = fs.readdirSync(SESSIONS_BASE).filter(n => n.startsWith('auth_info')).map(n => {
      let meta = {};
      const metaPath = path.join(SESSIONS_BASE, n, 'meta.json');
      if (fs.existsSync(metaPath)) {
        try { meta = JSON.parse(fs.readFileSync(metaPath)); } catch (e) {}
      }
      const inMem = Object.values(sessions).find(s => s.folderName === n);
      return { folder: n, meta, online: !!inMem, lastSeen: meta.connectedAt || null };
    });
    socket.emit('sessions_list', arr);
  });

  socket.on('destroy_session', (payload) => {
    try {
      if (!payload || !payload.folder) return socket.emit('error', { message: 'folder required' });
      const folder = payload.folder;
      const target = Object.entries(sessions).find(([k, v]) => v.folderName === folder);
      if (target) {
        const [sid, val] = target;
        try { val.sock.end(); } catch(e){}
        delete sessions[sid];
      }
      const full = path.join(SESSIONS_BASE, folder);
      if (fs.existsSync(full)) fs.rmSync(full, { recursive: true, force: true });
      socket.emit('session_destroyed', { folder });
    } catch (err) {
      console.error('destroy_session error', err);
      socket.emit('error', { message: 'Failed to destroy session', detail: String(err) });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('Web client disconnected', socket.id, 'reason:', reason);
  });
});

// logs
process.on('uncaughtException', (err) => console.error('uncaughtException', err));
process.on('unhandledRejection', (reason) => console.error('unhandledRejection', reason));

// start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server started on http://localhost:${PORT} (port ${PORT})`));
