// index.js (corrected)
import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs-extra';
import path from 'path';
import QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import express from 'express';
import http from 'http';
import { Server as IOServer } from 'socket.io';

import { Telegraf } from 'telegraf';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from '@whiskeysockets/baileys';

// safe fetch: use global fetch if present, otherwise try node-fetch
let fetchFn = globalThis.fetch;
if (typeof fetchFn !== 'function') {
  try {
    const nf = await import('node-fetch');
    fetchFn = nf.default;
  } catch (e) {
    fetchFn = null;
  }
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const bot = TELEGRAM_TOKEN ? new Telegraf(TELEGRAM_TOKEN) : null;

const app = express();
const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: '*' } });
app.get('/health', (req, res) => res.status(200).send('OK'));

const SESSIONS_BASE = path.resolve('./sessions');
await fs.ensureDir(SESSIONS_BASE);

const OWNER_NAME = "Adam_D'H7";
const OWNER_NUMBER = '50935492574';
const BOT_NAME = "Adam_D'H7";

const IMAGE_URLS = [
  "https://res.cloudinary.com/dckwrqrur/image/upload/v1757896255/tf-stream-url/IMG-20250824-WA0969_mj3ydr.jpg",
  "https://res.cloudinary.com/dckwrqrur/image/upload/v1757896321/tf-stream-url/13362d64459b2b250982b79433f899d8_0_dk8ach.jpg",
  "https://res.cloudinary.com/dckwrqrur/image/upload/v1757902902/tf-stream-url/IMG-20250831-WA0167_nrhik0.jpg"
];

const logger = pino({ level: 'silent' });
const sessions = {};
const telegramSessionMap = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function streamToBuffer(stream) {
  const parts = [];
  for await (const chunk of stream) parts.push(chunk);
  return Buffer.concat(parts);
}
function nextAuthFolder() {
  const items = fs.readdirSync(SESSIONS_BASE).filter(n => n.startsWith('auth_info') || n.startsWith('auth_'));
  const nums = items.map(n => {
    const m = n.match(/(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  });
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `auth_info${next}`;
}
async function fetchImageBuffer() {
  if (!fetchFn) return null;
  try {
    const url = IMAGE_URLS[Math.floor(Math.random() * IMAGE_URLS.length)];
    const res = await fetchFn(url);
    if (!res || !res.ok) throw new Error('fetch failed ' + (res?.status || 'no-status'));
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (e) {
    return null;
  }
}

const COMMAND_ALIASES = {
  menu: ['d','menu','menou','help','aide'],
  signale: ['signale','report','signal','denoncer'],
  owner: ['owner','proprietaire','proprio'],
  qr: ['qr','qrcode'],
  img: ['img','image','photo'],
  voir: ['voir','vv','we','wè','view','see'],
  lien: ['lien','link','invite'],
  nolien: ['nolien','nolink','no-link'],
  nolien2: ['nolien2','nolien_2','nolienall'],
  play: ['play','jwe'],
  tg: ['tg','tagall','tag'],
  tm: ['tm','hidetag','hidetags'],
  dh7: ['dh7',"d'h7",'invisible','ghost'],
  kick: ['kick','remove','expulser'],
  add: ['add','ajoute','invite'],
  promote: ['promote','promouvoir'],
  demote: ['demote','delmote','retrograder'],
  kickall: ['kickall','kick_all','cleanall'],
  ban: ['ban','interdire','block'],
  public: ['public','piblik'],
  prive: ['prive','private'],
  bienvenue: ['bienvenue','welcome'],
  mycode: ['mycode','code'],
  parrain: ['parrain','ref','referral'],
  stats: ['stats','mystats']
};
function findCommandAlias(token) {
  if (!token) return null;
  const t = token.toString().toLowerCase();
  for (const [cmd, arr] of Object.entries(COMMAND_ALIASES)) {
    if (arr.includes(t)) return cmd;
  }
  return null;
}
function parseCommandFromText(text) {
  if (!text) return { cmd: null, args: [] };
  const txt = text.trim();
  const withoutPrefix = txt.replace(/^([./!])+/, '');
  const parts = withoutPrefix.split(/\s+/).filter(Boolean);
  if (!parts.length) return { cmd: null, args: [] };
  const token = parts[0].toLowerCase();
  const alias = findCommandAlias(token) || token;
  const args = parts.slice(1);
  return { cmd: alias, args };
}

const LINK_REGEX = /(https?:\/\/\S+|www\.\S+|\bchat.whatsapp.com\/\S+|\bwa.me\/\S+|\bt.me\/\S+|\byoutu.be\/\S+|\byoutube.com\/\S+|\btelegram.me\/\S+|\bdiscord(?:app)?\.com\/invite\/\S+|\bdiscord.gg\/\S+|\bbit.ly\/\S+)/i;

function getDownloadContentFn(sock) {
  if (!sock) return null;
  if (typeof sock.downloadContentFromMessage === 'function') return sock.downloadContentFromMessage.bind(sock);
  if (typeof sock.downloadMedia === 'function') return sock.downloadMedia.bind(sock);
  return null;
}

let referral;
try {
  const maybe = await import('./referral').catch(()=>null);
  referral = maybe?.default || maybe || null;
} catch (e) {
  referral = null;
}
if (!referral) {
  referral = {
    init: async () => {},
    getOrCreateUser: async (jid, opts) => ({ jid, name: opts?.name || null }),
    generateCodeFor: async (jid, preferred) => `${preferred||'AUTO'}_${Math.random().toString(36).slice(2,8).toUpperCase()}`,
    useCode: async () => ({ ok: false, reason: 'NO_REFERRAL_MODULE' }),
    getStats: async () => null
  };
}
await (referral.init?.()).catch(()=>{});

function buildMenuText(pushName) {
  return `*○ Menu*\n\n  *${pushName}*\n────────────────────────────\n🚶🏻‍♂️ 𝐔𝐬𝐞𝐫: "${pushName}"\n🥀 𝐎𝐰𝐧𝐞𝐫: *${OWNER_NAME}*\n\n────────────────────────────\n📂 𝐂𝐨𝐦𝐦𝐚𝐧𝐝𝐞𝐬:\n────────────────────────────\n\n🔱 *Général*\n*● Menu*\n*● Ban*\n*○ Owner*\n*○ Signale*\n*● Qr [texte]*\n\n🔱 *Groupe*\n*○ Lien*\n*● Tagall*\n*○ Hidetag*\n*● Kick*\n*○ Add*\n*● Promote*\n*○ Demote*\n*● Kickall*\n*○ Ferme*\n*● Ouvert*\n*○ Bienvenue [off]*\n\n🔱 *Modération*\n*● Nolien*\n*○ Nolien2*\n*● Kickall*\n*○ Kick*\n*● Add*\n*○ Promote*\n*● Delmote*\n\n  *${OWNER_NAME}*\n────────────────────────────\n> *D'H7 | Tergene*`;
}

async function startBaileysForSession({ sessionId=null, folderName=null, telegramChatId=null, botName=BOT_NAME, sid=null }={}) {
  if (!sessionId) sessionId = uuidv4();
  if (!folderName) folderName = nextAuthFolder();
  const dir = path.join(SESSIONS_BASE, folderName);
  await fs.ensureDir(dir);

  let state, saveCreds;
  try {
    const auth = await useMultiFileAuthState(dir);
    state = auth.state;
    saveCreds = auth.saveCreds;
  } catch (err) {
    console.error(`[${sessionId}] useMultiFileAuthState failed`, err);
    throw err;
  }

  let version;
  try { const v = await fetchLatestBaileysVersion(); if (v && v.version) version = v.version; } catch(e){ version = undefined; }

  const sock = makeWASocket({ version, auth: state, logger, printQRInTerminal: false });

  const sessionObj = {
    sessionId,
    folderName,
    dir,
    sock,
    saveCreds,
    restarting: false,
    bienvenueEnabled: {},
    noLienMode: {},
    invisibleMode: {},
    sessionOwnerNumber: null,
    botName,
    sid,
    telegramChatId
  };
  sessions[sessionId] = sessionObj;

  sock.ev.on('creds.update', saveCreds);

  async function quickSendWithImage(jid, content, opts={}) {
    try {
      const text = (typeof content === 'string') ? content : (content.text || '');
      const mentions = content.mentions;
      const quoted = content.quoted;
      try {
        const buf = await fetchImageBuffer();
        if (buf) {
          const msg = { image: buf, caption: text };
          if (mentions) msg.mentions = mentions;
          if (quoted) msg.quoted = quoted;
          return await sock.sendMessage(jid, msg);
        }
      } catch(e){}
      try {
        const url = IMAGE_URLS[Math.floor(Math.random()*IMAGE_URLS.length)];
        const msg = { image: { url }, caption: text };
        if (mentions) msg.mentions = mentions;
        if (quoted) msg.quoted = quoted;
        return await sock.sendMessage(jid, msg);
      } catch(e){}
      const msg = { text };
      if (mentions) msg.mentions = mentions;
      if (quoted) msg.quoted = quoted;
      return await sock.sendMessage(jid, msg);
    } catch(e) {
      console.warn('quickSendWithImage failed', e);
    }
  }

  sock.ev.on('connection.update', async (update) => {
    try {
      const { connection, qr, lastDisconnect } = update;
      if (qr && telegramChatId && bot) {
        try {
          const dataUrl = await QRCode.toDataURL(qr);
          const base64 = dataUrl.split(',')[1];
          const buffer = Buffer.from(base64, 'base64');
          const caption = `Scan QR pou sesyon ${sid || sessionId}\nBot: ${botName}`;
          await bot.telegram.sendPhoto(telegramChatId, { source: buffer }, { caption });
        } catch (e) {
          console.warn('Cannot send QR to Telegram chat', e);
        }
      }

      if (connection === 'open') {
        console.log(`[${sid || sessionId}] connected`);
        if (telegramChatId && bot) {
          await bot.telegram.sendMessage(telegramChatId, `WhatsApp konekte pou sesyon ${sid || sessionId} — ${botName}`);
        }
        sessionObj.restarting = false;
        try { fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ connectedAt: Date.now(), phone: sessionObj.sessionOwnerNumber || null }, null, 2)); } catch(e){}
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error || {}).output?.statusCode || null;
        console.log(`[${sid || sessionId}] connection closed, code=${code}`);
        if (telegramChatId && bot) {
          await bot.telegram.sendMessage(telegramChatId, `WhatsApp sesyon ${sid || sessionId} dekonekte: ${code}`);
        }

        if (code === DisconnectReason.loggedOut) {
          try { sock.end(); } catch(e){}
          delete sessions[sessionId];
          return;
        }

        if (code === DisconnectReason.restartRequired || code === 515) {
          sessionObj.restarting = true;
          try { sock.end(); } catch(e){}
          delete sessions[sessionId];
          setTimeout(() => {
            startBaileysForSession({ sessionId: uuidv4(), folderName: folderName, telegramChatId, botName, sid })
              .then(() => {
                if (telegramChatId && bot) bot.telegram.sendMessage(telegramChatId, `Session ${sid || sessionId} relanse otomatikman.`);
              })
              .catch(err => {
                console.error(`[${sid || sessionId}] auto-restart failed`, err);
                if (telegramChatId && bot) bot.telegram.sendMessage(telegramChatId, `Echec redémarrage otomatik: ${String(err)}`);
              });
          }, 2000);
          return;
        }

        try { sock.end(); } catch(e){}
        delete sessions[sessionId];
        setTimeout(() => {
          startBaileysForSession({ sessionId: uuidv4(), folderName: folderName, telegramChatId, botName, sid })
            .then(() => { if (telegramChatId && bot) bot.telegram.sendMessage(telegramChatId, `Tentative reconnexion pou ${sid || sessionId}`); })
            .catch(err => { console.error(`[${sid || sessionId}] reconnect failed`, err); if (telegramChatId && bot) bot.telegram.sendMessage(telegramChatId, `Echec reconnexion: ${String(err)}`); });
        }, 5000);
      }
    } catch (e) { console.error('connection.update handler error', e); }
  });

  sock.ev.on('messages.upsert', async (up) => {
    try {
      const messages = up.messages || [];
      if (!messages.length) return;
      const msg = messages[0];
      if (!msg || !msg.message) return;
      if (msg.key && msg.key.remoteJid === 'status@broadcast') return;

      const jid = msg.key.remoteJid;
      const isGroup = jid && jid.endsWith && jid.endsWith('@g.us');

      const m = msg.message;
      let raw = '';
      if (m.conversation) raw = m.conversation;
      else if (m.extendedTextMessage?.text) raw = m.extendedTextMessage.text;
      else if (m.imageMessage?.caption) raw = m.imageMessage.caption;
      else if (m.videoMessage?.caption) raw = m.videoMessage.caption;
      else if (m.documentMessage?.caption) raw = m.documentMessage.caption;
      else raw = '';

      const textRaw = (raw || '').toString().trim();
      const { cmd, args } = parseCommandFromText(textRaw);

      const senderId = (msg.key && msg.key.participant) ? msg.key.participant : msg.key.remoteJid;
      const senderNumber = (senderId && senderId.includes('@')) ? senderId.split('@')[0] : senderId;
      const pushName = msg.pushName || 'Utilisateur';
      const sessionOwnerNumber = sessionObj.sessionOwnerNumber || OWNER_NUMBER;
      const isOwner = (senderNumber === OWNER_NUMBER) || (senderNumber === sessionOwnerNumber);

      async function isGroupAdminFn(jidCheck, participantId) {
        try {
          const meta = await sock.groupMetadata(jidCheck);
          const p = meta.participants.find(x => x.id === participantId);
          return !!(p && (p.admin || p.admin === 'superadmin'));
        } catch (e) { return false; }
      }

      async function quickReply(jidTo, t, opts={}) {
        try {
          const mentions = opts.mentions;
          const quoted = opts.quoted;
          if (opts.useImage) {
            const buf = await fetchImageBuffer();
            if (buf) {
              const msgObj = { image: buf, caption: t };
              if (mentions) msgObj.mentions = mentions;
              if (quoted) msgObj.quoted = quoted;
              return sock.sendMessage(jidTo, msgObj);
            }
          }
          const msgObj = { text: t };
          if (mentions) msgObj.mentions = mentions;
          if (quoted) msgObj.quoted = quoted;
          return sock.sendMessage(jidTo, msgObj);
        } catch (e) {
          console.warn('quickReply failed', e);
        }
      }

      // nolien link deletion (same logic as before)
      try {
        const containsLink = (() => {
          try {
            const textParts = [];
            if (m.conversation) textParts.push(m.conversation);
            if (m.extendedTextMessage?.text) textParts.push(m.extendedTextMessage.text);
            if (m.imageMessage?.caption) textParts.push(m.imageMessage.caption);
            const aggregated = textParts.join(' ');
            return LINK_REGEX.test(aggregated) || LINK_REGEX.test(JSON.stringify(m || {}));
          } catch (e) { return false; }
        })();

        if (isGroup && containsLink) {
          const mode = sessionObj.noLienMode[jid] || 'off';
          if (!(msg.key && msg.key.fromMe)) {
            const isImageWithCaptionLink = !!(m.imageMessage && m.imageMessage.caption && LINK_REGEX.test(m.imageMessage.caption));
            if (!isImageWithCaptionLink) {
              if (mode === 'exceptAdmins') {
                const admin = await isGroupAdminFn(jid, senderId);
                if (!admin && !isOwner) {
                  try { await sock.sendMessage(jid, { delete: msg.key }); } catch (e) { console.warn('delete failed', e); }
                  return;
                }
              } else if (mode === 'all') {
                try { await sock.sendMessage(jid, { delete: msg.key }); } catch (e) { console.warn('delete failed', e); }
                return;
              }
            }
          }
        }
      } catch (e) {}

      if (!cmd) return;

      console.log(`[${sid || sessionId}] MESSAGE reçu from=${jid} sender=${senderId} cmd=${cmd} args=${args.join(' ')}`);

      const downloadContent = getDownloadContentFn(sock);

      switch (cmd) {
        case 'menu':
          await quickSendWithImage(jid, { text: buildMenuText(pushName) });
          break;

        case 'qr':
          if (!args.length) return quickReply(jid, `${BOT_NAME}\nUsage: .qr [texte]`);
          try {
            const q = args.join(' ');
            const buf = await QRCode.toBuffer(q);
            await sock.sendMessage(jid, { image: buf, caption: `${BOT_NAME}\n${q}` });
          } catch (e) { await quickReply(jid, `${BOT_NAME}\nImpossible de générer le QR.`); }
          break;

        case 'img':
          try {
            const buf = await fetchImageBuffer();
            if (buf) await sock.sendMessage(jid, { image: buf, caption: `${BOT_NAME}\nVoici l'image.` });
            else await quickReply(jid, `${BOT_NAME}\nImage non disponible.`);
          } catch (e) { await quickReply(jid, `${BOT_NAME}\nErreur image.`); }
          break;

        case 'lien':
          if (!isGroup) return quickReply(jid, 'Commande réservée aux groupes.');
          try {
            const meta = await sock.groupMetadata(jid);
            const code = meta.inviteCode || meta.id || null;
            if (code) {
              const link = `https://chat.whatsapp.com/${code}`;
              await sock.sendMessage(jid, { text: link });
            } else {
              await sock.sendMessage(jid, { text: 'https://chat.whatsapp.com/' });
            }
          } catch (e) { await quickReply(jid, 'Impossible de récupérer le lien du groupe.'); }
          break;

        case 'tg':
        case 'tagall':
          if (!isGroup) return quickReply(jid, `${BOT_NAME}\nTagall réservé aux groupes.`);
          try {
            const meta = await sock.groupMetadata(jid);
            const ids = meta.participants.map(p => p.id);
            const list = ids.map(id => `@${id.split('@')[0]}`).join(' ');
            await sock.sendMessage(jid, { text: `${BOT_NAME}\n${list}`, mentions: ids });
          } catch (e) { await quickReply(jid, `${BOT_NAME}\nImpossible de tagall.`); }
          break;

        case 'kick':
          if (!isGroup) return quickReply(jid, `${BOT_NAME}\nKick réservé aux groupes.`);
          {
            const ctx = m.extendedTextMessage?.contextInfo || {};
            let targets = [];
            if (ctx.mentionedJid && ctx.mentionedJid.length) targets = ctx.mentionedJid;
            else if (ctx.participant) targets = [ctx.participant];
            else if (args.length) targets = args.map(a => `${a.replace(/[^0-9]/g,'')}@s.whatsapp.net`);
            if (!targets.length) return quickReply(jid, `${BOT_NAME}\nRépondez ou tag l'utilisateur : kick @user`);
            for (const t of targets) {
              try { await sock.groupParticipantsUpdate(jid, [t], 'remove'); await sleep(200); } catch (e) { console.warn('kick fail', e); }
            }
          }
          break;

        case 'add':
          if (!isGroup) return quickReply(jid, `${BOT_NAME}\nAdd réservé aux groupes.`);
          {
            const ctx = m.extendedTextMessage?.contextInfo || {};
            const idsToAdd = [];
            if (args.length) idsToAdd.push(...args.map(a => `${a.replace(/[^0-9]/g,'')}@s.whatsapp.net`));
            if (ctx.mentionedJid && ctx.mentionedJid.length) idsToAdd.push(...ctx.mentionedJid);
            if (!idsToAdd.length) return quickReply(jid, `${BOT_NAME}\nFormat: add 509XXXXXXXX`);
            for (const t of idsToAdd) {
              try { await sock.groupParticipantsUpdate(jid, [t], 'add'); await sleep(800); } catch (e) { console.warn('add fail', e); }
            }
          }
          break;

        case 'promote':
        case 'demote':
        case 'delmote':
          if (!isGroup) return quickReply(jid, `${BOT_NAME}\nCommande réservée aux groupes.`);
          {
            const action = (cmd === 'promote') ? 'promote' : 'demote';
            const ctx = m.extendedTextMessage?.contextInfo || {};
            let targets = ctx.mentionedJid || (ctx.participant ? [ctx.participant] : []);
            if (!targets.length && args.length) targets = args.map(a => `${a.replace(/[^0-9]/g,'')}@s.whatsapp.net`);
            if (!targets.length) return quickReply(jid, `${BOT_NAME}\nRépondre ou tag : ${action} @user`);
            for (const t of targets) {
              try { await sock.groupParticipantsUpdate(jid, [t], action); await sleep(500); } catch (e) { console.warn(`${action} fail`, e); }
            }
          }
          break;

        case 'nolien':
          if (!isGroup) return quickReply(jid, 'Commande réservée aux groupes.');
          {
            const sender = senderId;
            const admin = await isGroupAdminFn(jid, sender);
            if (!admin && !isOwner) return quickReply(jid, "Seuls l'admin ou le propriétaire peuvent activer.");
            sessionObj.noLienMode[jid] = (args[0] && args[0].toLowerCase()==='off') ? 'off' : 'exceptAdmins';
            await quickReply(jid, `Mode nolien: ${sessionObj.noLienMode[jid]}`);
          }
          break;

        case 'nolien2':
          if (!isGroup) return quickReply(jid, 'Commande réservée aux groupes.');
          {
            const sender = senderId;
            const admin = await isGroupAdminFn(jid, sender);
            if (!admin && !isOwner) return quickReply(jid, "Seuls l'admin ou le propriétaire peuvent activer.");
            sessionObj.noLienMode[jid] = (args[0] && args[0].toLowerCase()==='off') ? 'off' : 'all';
            await quickReply(jid, `Mode nolien2: ${sessionObj.noLienMode[jid]}`);
          }
          break;

        case 'voir':
          try {
            const ctx = m.extendedTextMessage?.contextInfo || {};
            const quoted = ctx?.quotedMessage;
            if (!quoted) return quickReply(jid, 'Réponds à une image/vidéo/voice pour utiliser la commande (voir).');
            const type = Object.keys(quoted)[0];
            if (!type) return quickReply(jid, 'Contenu non reconnu.');

            if (!downloadContent) {
              const warnMsg = `Session ${sid || sessionId}: téléchargement média indisponible (downloadContent missing).`;
              console.warn(warnMsg);
              if (sessionObj.telegramChatId && bot) {
                try { await bot.telegram.sendMessage(sessionObj.telegramChatId, `Notice: ${warnMsg}`); } catch(e){}
              }
              return;
            }

            if (type === 'imageMessage') {
              const stream = await downloadContent(quoted.imageMessage, 'image');
              const buffer = await streamToBuffer(stream);
              await sock.sendMessage(jid, { image: buffer, caption: `> ${BOT_NAME}` }, { quoted: msg });
            } else if (type === 'videoMessage') {
              const stream = await downloadContent(quoted.videoMessage, 'video');
              const buffer = await streamToBuffer(stream);
              await sock.sendMessage(jid, { video: buffer, caption: `> ${BOT_NAME}`, gifPlayback: quoted.videoMessage?.gifPlayback || false }, { quoted: msg });
            } else if (type === 'audioMessage' || type === 'pttMessage') {
              const att = quoted.audioMessage || quoted.pttMessage || quoted[type];
              const stream = await downloadContent(att, 'audio');
              const buffer = await streamToBuffer(stream);
              await sock.sendMessage(jid, { audio: buffer, ptt: !!att.ptt }, { quoted: msg });
            } else if (type === 'documentMessage') {
              const doc = quoted.documentMessage;
              try {
                const stream = await downloadContent(doc, 'document');
                const buffer = await streamToBuffer(stream);
                const filename = doc.fileName || 'file';
                await sock.sendMessage(jid, { document: buffer, fileName: filename, caption: '🔁 Voir — document' }, { quoted: msg });
              } catch (e) {
                await quickReply(jid, 'Impossible de renvoyer le document.', { quoted: msg });
              }
            } else {
              await quickReply(jid, 'Type de média non pris en charge. Seuls: image, vidéo, voice, document sont pris en charge.', { quoted: msg });
            }
          } catch (err) {
            console.error('Erreur commande voir:', err);
            await quickReply(jid, 'Erreur commande `voir`.');
          }
          break;

        case 'signale':
          if (!args[0]) return quickReply(jid, 'Usage: .signale 22997000000');
          try {
            const numeroRaw = args[0].replace(/[^0-9]/g,'');
            const numero = `${numeroRaw}@s.whatsapp.net`;
            if (typeof sock.report === 'function') {
              for (let i=0;i<100;i++) {
                await sock.report(numero, 'spam', msg.key).catch(()=>{});
                await new Promise(r=>setTimeout(r,200));
              }
              await quickReply(jid, `Le numéro ${args[0]} a été signalé 100 fois.`);
            } else {
              await quickReply(jid, 'Fonction report non disponible sur cette version.');
            }
          } catch (e) { await quickReply(jid, 'Erreur signale.'); }
          break;

        case 'owner':
          try {
            const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${OWNER_NAME}\nTEL;type=CELL;type=VOICE;waid=${OWNER_NUMBER}:+${OWNER_NUMBER}\nEND:VCARD`;
            await sock.sendMessage(jid, { contacts: { displayName: OWNER_NAME, contacts: [{ vcard }] } });
          } catch (e) { console.error('owner err', e); }
          break;

        case 'dh7':
          if (!isGroup) { await quickReply(jid, `${BOT_NAME}\nMode invisible réservé aux groupes.`); break; }
          if (sessionObj.invisibleMode[jid]) {
            clearInterval(sessionObj.invisibleMode[jid]);
            delete sessionObj.invisibleMode[jid];
            await quickReply(jid, `${BOT_NAME}\nMode invisible désactivé.`);
            break;
          }
          sessionObj.invisibleMode[jid] = setInterval(() => {
            fetchImageBuffer().then(buf => {
              if (buf) sock.sendMessage(jid, { image: buf, caption: 'ㅤ   ' }).catch(()=>{});
            }).catch(()=>{});
          }, 1000);
          await quickReply(jid, `${BOT_NAME}\nMode invisible activé : envoi d'images en boucle.`);
          break;

        default:
          break;
      }

    } catch (err) {
      console.error('erreur dans messages.upsert', err);
    }
  });

  sock.ev.on('group-participants.update', async (update) => {
    try {
      const action = update.action || update.type || null;
      if (action !== 'add') return;
      const gid = update.id || update.jid || update.groupId;
      if (!gid) return;
      if (!sessionObj.bienvenueEnabled[gid]) return;
      const meta = await sock.groupMetadata(gid);
      const groupName = meta.subject || '';
      for (const p of (update.participants || [])) {
        const userJid = typeof p === 'string' ? p : p?.id;
        if (!userJid) continue;
        const txt = `Bienvenue @${userJid.split('@')[0]} dans ${groupName}`;
        await quickSendWithImage(gid, { text: txt, mentions: [userJid] });
      }
    } catch (e) { console.error('erreur bienvenue', e); }
  });

  return sessionObj;
}

// Telegram commands (only if bot is defined)
if (bot) {
  bot.command('connect', async (ctx) => {
    try {
      const chatId = ctx.chat.id;
      const text = (ctx.message.text || '').trim();
      const after = text.replace(/^\/connect\s*/i, '').trim();
      let botName = null;
      if (after) {
        const qMatch = after.match(/^(".*?"|'.*?')\s*$/);
        if (qMatch) botName = qMatch[1].replace(/^["']|["']$/g,'');
        else botName = after.split(/\s+/).join(' ');
      }
      const sid = `S${Math.random().toString(36).slice(2,8).toUpperCase()}`;
      await ctx.reply(`K ap kreye sesyon ${sid} pou ${botName || BOT_NAME}...`);
      const folderName = nextAuthFolder();
      const sessionId = uuidv4();
      const dir = path.join(SESSIONS_BASE, folderName);
      await fs.ensureDir(dir);
      const meta = { sessionId, folderName, botName: botName || BOT_NAME, createdAt: Date.now(), telegramChatId: chatId, sid };
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
      await startBaileysForSession({ sessionId, folderName, telegramChatId: chatId, botName: botName || BOT_NAME, sid });
      telegramSessionMap.set(`${chatId}_${sid}`, { sessionId, folderName, sid, telegramChatId: chatId });
      return ctx.reply(`Sesyon kreyé (${sid}). W ap resevwa QR sou Telegram pou eskane si sesyon pa otantifye.`);
    } catch (e) {
      console.error('connect cmd err', e);
      return ctx.reply(`Erè: ${String(e)}`);
    }
  });

  bot.command('stop', async (ctx) => {
    try {
      const chatId = ctx.chat.id;
      const parts = (ctx.message.text || '').split(/\s+/).slice(1);
      if (!parts[0]) return ctx.reply('Usage: /stop <sid>  (ex: /stop SABC12)');
      const sid = parts[0];
      const key = `${chatId}_${sid}`;
      const map = telegramSessionMap.get(key);
      if (!map) return ctx.reply('Pa gen sesyon konsa k ap kouri.');
      const sessionId = map.sessionId;
      const sess = sessions[sessionId];
      if (sess && sess.sock) {
        try { await sess.sock.logout(); } catch(e){}
        try { await sess.sock.end(); } catch(e){}
      }
      telegramSessionMap.delete(key);
      try { fs.rmSync(path.join(SESSIONS_BASE, map.folderName), { recursive: true, force: true }); } catch(e){}
      return ctx.reply(`Sesyon ${sid} sispann.`);
    } catch (e) {
      console.error('stop cmd err', e);
      return ctx.reply(`Erè pandan stop: ${String(e)}`);
    }
  });

  bot.command('list', async (ctx) => {
    try {
      const chatId = ctx.chat.id;
      const keys = [];
      for (const k of telegramSessionMap.keys()) if (k.startsWith(`${chatId}_`)) keys.push(k.split('_')[1]);
      if (!keys.length) return ctx.reply('Ou pa gen okenn sesyon kouri.');
      return ctx.reply(`Sesyon kouri pou ou: ${keys.join(', ')}`);
    } catch (e) { console.error('list err', e); return ctx.reply('Erè list.'); }
  });

  bot.launch().then(()=>console.log('Telegram bot started')).catch(e=>console.error('telegram start err', e));
} else {
  console.warn('Telegram token not set — Telegram commands disabled.');
}

io.on('connection', (socket) => {
  console.log('web client connected', socket.id);
  socket.on('list_sessions', () => {
    const arr = Object.keys(sessions).map(k => ({ sessionId: k, folder: sessions[k].folderName, botName: sessions[k].botName }));
    socket.emit('sessions_list', arr);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>console.log(`Server started on http://localhost:${PORT}`));

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down...');
  try { if (bot) await bot.stop('SIGINT'); } catch(e){}
  for (const s of Object.values(sessions)) {
    try { s.sock.logout(); } catch(e){}
    try { s.sock.end(); } catch(e){}
  }
  process.exit(0);
});
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  try { if (bot) await bot.stop('SIGTERM'); } catch(e){}
  for (const s of Object.values(sessions)) {
    try { s.sock.logout(); } catch(e){}
    try { s.sock.end(); } catch(e){}
  }
  process.exit(0);
});

console.log('index.js loaded. Use /connect in Telegram to create sessions (no sid required).');
