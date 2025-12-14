/**
 * index.js — Sistema de cards + painel (embed + botões + modals) + claim automático
 * Atualizado: painel simplificado e resposta "Meus Cards" em embed ephemeral com last-claim legível.
 *
 * Dependências:
 *   npm i discord.js sqlite3 axios dotenv
 *
 * Respeita seu .env atual (DISCORD_TOKEN, CLIENT_ID, API_BASE, DB_PATH, CLAIM_INTERVAL_MS, TAX_PERCENT, RECEIVER_CARD, etc)
 */

require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, Events,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits, EmbedBuilder
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');

///// Configs /////
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const CLIENT_ID = process.env.CLIENT_ID || '1447414138254004236';
const API_BASE_RAW = process.env.API_BASE || 'https://bank.foxsrv.net/';
const DB_PATH = process.env.DB_PATH || './cards.db';
const CLAIM_INTERVAL_MS = Number(process.env.CLAIM_INTERVAL_MS || 10 * 60 * 1000); // 10 min
const CLAIM_QUEUE_DELAY_MS = Number(process.env.CLAIM_QUEUE_DELAY_MS || 200);
const TAX_PERCENT = Number(process.env.TAX_PERCENT ?? 0.10); // 0.10 = 10%
const RECEIVER_CARD = process.env.RECEIVER_CARD || '';

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is required in .env');
  process.exit(1);
}
if (!RECEIVER_CARD) {
  console.warn('RECEIVER_CARD not set in .env — taxas não serão enviadas até configurar RECEIVER_CARD.');
}

///// Helpers /////
function normalizeApiBase(raw) {
  let base = (raw || '').toString().trim();
  base = base.replace(/\/+$/g, '');
  if (!/\/api$/i.test(base)) base += '/api';
  return base;
}
const API_BASE = normalizeApiBase(API_BASE_RAW);
const api = axios.create({ baseURL: API_BASE, timeout: 30_000 });

function extractAxiosError(e) {
  const status = e.response?.status;
  const data = e.response?.data;
  const msg = e.message || (data && (data.error || data.message)) || JSON.stringify(data) || 'Unknown error';
  return { status, msg, data };
}

async function apiCardClaim(cardCode) {
  try {
    const res = await api.post('/card/claim', { cardCode });
    return res.data;
  } catch (e) {
    const err = extractAxiosError(e);
    return { success: false, error: err.msg || 'request_failed', status: err.status, data: err.data };
  }
}
async function apiTransferBetweenCards(fromCard, toCard, amountCoins) {
  try {
    const truncated = Math.floor(Number(amountCoins) * 1e8) / 1e8;
    const res = await api.post('/card/pay', { fromCard, toCard, amount: truncated });
    return res.data;
  } catch (e) {
    const err = extractAxiosError(e);
    return { success: false, error: err.msg || 'request_failed', status: err.status, data: err.data };
  }
}

function msToHuman(ms) {
  if (!ms || ms <= 0) return '0m 0s';
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec}s`;
}

// format last claim timestamp (seconds) into "Xh Ym Zs atrás"
function formatLastClaimAgo(lastClaimTsSeconds) {
  if (!lastClaimTsSeconds || Number(lastClaimTsSeconds) <= 0) return 'never';
  const nowSec = Math.floor(Date.now() / 1000);
  let diff = Math.max(0, nowSec - Number(lastClaimTsSeconds));
  const h = Math.floor(diff / 3600);
  diff -= h * 3600;
  const m = Math.floor(diff / 60);
  const s = diff - m * 60;
  return `${h}h ${m}m ${s}s atrás`;
}

///// Database /////
const db = new sqlite3.Database(DB_PATH);
function runSql(sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); }));
}
function getSql(sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function allSql(sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}

async function initDb() {
  await runSql(`CREATE TABLE IF NOT EXISTS cards (
    card_code TEXT PRIMARY KEY,
    user_id TEXT,
    last_claim_ts INTEGER DEFAULT 0,
    claim_retry INTEGER DEFAULT 0
  )`);
  await runSql(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
}
initDb().catch(e => { console.error('DB init error', e); process.exit(1); });

///// Card functions /////
async function addOrUpdateCard(cardCode, userId) {
  const existing = await getSql(`SELECT * FROM cards WHERE card_code=?`, [cardCode]);
  if (existing) {
    await runSql(`UPDATE cards SET user_id=? WHERE card_code=?`, [userId, cardCode]);
    return { updated: true };
  } else {
    await runSql(`INSERT INTO cards(card_code, user_id) VALUES(?,?)`, [cardCode, userId]);
    return { created: true };
  }
}
async function removeCard(cardCode, userId) {
  const row = await getSql(`SELECT * FROM cards WHERE card_code=?`, [cardCode]);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.user_id !== userId) return { ok: false, reason: 'not_owner' };
  await runSql(`DELETE FROM cards WHERE card_code=?`, [cardCode]);
  return { ok: true };
}
async function listUserCards(userId) {
  return await allSql(`SELECT * FROM cards WHERE user_id=?`, [userId]);
}
async function listAllCards() {
  return await allSql(`SELECT * FROM cards ORDER BY rowid ASC`);
}
async function setLastClaim(cardCode, ts) {
  await runSql(`UPDATE cards SET last_claim_ts=?, claim_retry=0 WHERE card_code=?`, [ts, cardCode]);
}
async function incClaimRetry(cardCode) {
  await runSql(`UPDATE cards SET claim_retry = claim_retry + 1 WHERE card_code=?`, [cardCode]);
}
async function deleteCardFromDb(cardCode) {
  await runSql(`DELETE FROM cards WHERE card_code=?`, [cardCode]);
}
async function saveSetting(key, value) {
  await runSql(`INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [key, value]);
}
async function getSetting(key) {
  const r = await getSql(`SELECT value FROM settings WHERE key=?`, [key]);
  return r?.value ?? null;
}

///// Claim worker (core) /////
// nextClaimTimestamp used internally; we no longer show live countdown in embed
let claimRunning = false;
let nextClaimTimestamp = Date.now() + CLAIM_INTERVAL_MS;

async function runClaimsPass() {
  if (claimRunning) return;
  claimRunning = true;
  try {
    const cards = await listAllCards();
    if (!cards || cards.length === 0) {
      console.log('[claims] no registered cards to process.');
      nextClaimTimestamp = Date.now() + CLAIM_INTERVAL_MS;
      await refreshPanelEmbed().catch(()=>{});
      return;
    }
    console.log(`[claims] processing ${cards.length} cards...`);
    for (const c of cards) {
      try {
        console.log(`[claims] claiming card ${c.card_code} (user ${c.user_id})`);
        const resp = await apiCardClaim(c.card_code);

        if (resp && resp.success) {
          const claimedStr = resp.claimed || resp.amount || resp.value;
          const amountCoins = Number(claimedStr || 0);
          if (isNaN(amountCoins) || amountCoins <= 0) {
            console.log(`[claims] card ${c.card_code} claimed zero — updating last_claim_ts`);
            await setLastClaim(c.card_code, Math.floor(Date.now() / 1000));
          } else {
            console.log(`[claims] card ${c.card_code} claimed ${amountCoins} coins`);
            const tax = (TAX_PERCENT > 0) ? (amountCoins * TAX_PERCENT) : 0;
            const taxRounded = Number(tax.toFixed(8));
            if (taxRounded > 0 && RECEIVER_CARD) {
              console.log(`[claims] sending tax ${taxRounded} from ${c.card_code} -> ${RECEIVER_CARD}`);
              const payResp = await apiTransferBetweenCards(c.card_code, RECEIVER_CARD, taxRounded);
              if (payResp && payResp.success) {
                console.log(`[claims] tax payment successful for card ${c.card_code}`);
              } else {
                console.warn(`[claims] tax payment FAILED for card ${c.card_code}`, payResp?.error || payResp);
              }
            } else {
              if (!RECEIVER_CARD && taxRounded > 0) {
                console.warn('[claims] RECEIVER_CARD not set; skipping tax send');
              } else {
                console.log('[claims] tax is zero or TAX_PERCENT is 0; skipping tax send');
              }
            }
            await setLastClaim(c.card_code, Math.floor(Date.now() / 1000));
          }
        } else {
          const status = resp?.status || (resp && resp.error && resp.error === 'COOLDOWN_ACTIVE' ? 429 : null);
          const errStr = resp?.error || 'claim_failed';
          if (status === 429 || errStr === 'COOLDOWN_ACTIVE') {
            console.log(`[claims] card ${c.card_code} is in cooldown — skipping (no charge).`);
          } else if (status === 404 || errStr === 'CARD_NOT_FOUND' || (String(errStr).toUpperCase().includes('CARD_NOT_FOUND'))) {
            console.log(`[claims] card ${c.card_code} not found on API — deleting from DB.`);
            await deleteCardFromDb(c.card_code);
          } else {
            console.warn(`[claims] claim failed for ${c.card_code}:`, errStr);
            await incClaimRetry(c.card_code);
          }
        }
      } catch (e) {
        console.warn('[claims] unexpected error processing card', c.card_code, e?.message || e);
        await incClaimRetry(c.card_code);
      }
      await new Promise(r => setTimeout(r, CLAIM_QUEUE_DELAY_MS));
    }
    console.log('[claims] pass finished.');
  } catch (e) {
    console.error('[claims] worker fatal error', e?.message || e);
  } finally {
    nextClaimTimestamp = Date.now() + CLAIM_INTERVAL_MS;
    claimRunning = false;
    await refreshPanelEmbed().catch(()=>{});
  }
}

function startClaimScheduler() {
  runClaimsPass().catch(e => console.warn('initial claims run error', e?.message || e));
  setInterval(() => runClaimsPass().catch(e => console.warn('scheduled claims error', e?.message || e)), CLAIM_INTERVAL_MS);
}
startClaimScheduler();

///// Discord client & UI ///// 
const client = new Client({
  intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages ],
  partials: [ Partials.Channel ]
});

async function registerSlashCommands() {
  try {
    const commands = [
      new SlashCommandBuilder().setName('linkcard')
        .setDescription('Link a card to your user (card code)')
        .addStringOption(o => o.setName('card').setDescription('Card code').setRequired(true)),
      new SlashCommandBuilder().setName('unlinkcard')
        .setDescription('Unlink a card you own')
        .addStringOption(o => o.setName('card').setDescription('Card code').setRequired(true)),
      new SlashCommandBuilder().setName('mycards')
        .setDescription('List your linked cards'),
      new SlashCommandBuilder().setName('createpanel')
        .setDescription('Create the cards panel in this channel (admins only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
      new SlashCommandBuilder().setName('forcelaim')
        .setDescription('Force a claims pass now (admin)')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    ].map(c => c.toJSON());

    if (CLIENT_ID) {
      const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('Slash commands registered globally (CLIENT_ID provided).');
    } else {
      console.log('CLIENT_ID not provided — slash commands not registered globally. Use guild registration if needed.');
    }
  } catch (e) {
    console.warn('Failed to register slash commands', e?.message || e);
  }
}

function buildPanelEmbed(totalCards = 0) {
  const embed = new EmbedBuilder()
    .setTitle('Painel — Auto-Claim de Cards')
    .setDescription('Use os botões abaixo para gerenciar seus cards.')
    .addFields(
      { name: 'Auto-Claim a cada', value: msToHuman(CLAIM_INTERVAL_MS), inline: true },
      { name: 'Cards registrados', value: String(totalCards || 0), inline: true }
    )
    .setFooter({ text: 'Painel de registro de cartões - Coin System' })
    .setColor(0x2F3136);
  return embed;
}
function buildPanelButtons() {
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('panel_add').setLabel('Adicionar Card').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('panel_remove').setLabel('Remover Card').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('panel_mycards').setLabel('Meus Cards').setStyle(ButtonStyle.Secondary)
    );
  return [row];
}

async function refreshPanelEmbed() {
  try {
    const channelId = await getSetting('panel_channel');
    const messageId = await getSetting('panel_message');
    if (!channelId || !messageId) return;
    const channel = await client.channels.fetch(channelId).catch(()=>null);
    if (!channel) return;
    const msg = await channel.messages.fetch(messageId).catch(()=>null);
    if (!msg) return;
    const total = (await listAllCards()).length;
    const embed = buildPanelEmbed(total);
    await msg.edit({ embeds: [embed] }).catch(e => console.warn('refreshPanelEmbed edit failed', e?.message || e));
  } catch (e) {
    console.warn('refreshPanelEmbed error', e?.message || e);
  }
}

client.once(Events.ClientReady, async () => {
  console.log('Bot logged in as', client.user.tag);
  await registerSlashCommands().catch(()=>{});
  // refresh panel on start
  refreshPanelEmbed().catch(()=>{});
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      const cmd = interaction.commandName;
      // regular user commands
      if (cmd === 'linkcard') {
        const card = interaction.options.getString('card', true).trim();
        await interaction.deferReply({ ephemeral: true }).catch(()=>{});
        try {
          const res = await addOrUpdateCard(card, interaction.user.id);
          await interaction.editReply({ content: `Card ${card} linked to your user. (${res.created ? 'created' : 'updated'})` });
          await refreshPanelEmbed();
        } catch (e) {
          console.error('linkcard error', e);
          await interaction.editReply({ content: `Error linking card: ${e.message || e}` });
        }
        return;
      }
      if (cmd === 'unlinkcard') {
        const card = interaction.options.getString('card', true).trim();
        await interaction.deferReply({ ephemeral: true }).catch(()=>{});
        try {
          const res = await removeCard(card, interaction.user.id);
          if (res.ok) {
            await interaction.editReply({ content: `Card ${card} unlinked.` });
            await refreshPanelEmbed();
          } else await interaction.editReply({ content: `Cannot unlink card: ${res.reason}` });
        } catch (e) {
          console.error('unlinkcard error', e);
          await interaction.editReply({ content: `Error unlinking card: ${e.message || e}` });
        }
        return;
      }
      if (cmd === 'mycards') {
        await interaction.deferReply({ ephemeral: true }).catch(()=>{});
        try {
          const rows = await listUserCards(interaction.user.id);
          if (!rows || rows.length === 0) {
            await interaction.editReply({ content: 'You have no linked cards.' });
          } else {
            // build embed ephemeral
            const embed = new EmbedBuilder()
              .setTitle(`${interaction.user.username} — Meus Cards`)
              .setColor(0x5865F2)
              .setFooter({ text: 'Painel de registro de cartões - Coin System' });
            rows.forEach(r => {
              embed.addFields({ name: r.card_code, value: `last claim: ${formatLastClaimAgo(r.last_claim_ts)}\nretries: ${r.claim_retry || 0}`, inline: false });
            });
            await interaction.editReply({ embeds: [embed] });
          }
        } catch (e) {
          console.error('mycards error', e);
          await interaction.editReply({ content: `Error listing cards: ${e.message || e}` });
        }
        return;
      }

      // admin commands
      if (cmd === 'createpanel') {
        if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
          await interaction.reply({ content: 'Você precisa de permissão Manage Guild para usar este comando.', ephemeral: true });
          return;
        }
        await interaction.deferReply({ ephemeral: false }).catch(()=>{});
        try {
          const total = (await listAllCards()).length;
          const embed = buildPanelEmbed(total);
          const components = buildPanelButtons();
          const msg = await interaction.channel.send({ embeds: [embed], components });
          await saveSetting('panel_channel', msg.channelId);
          await saveSetting('panel_message', msg.id);
          await interaction.editReply({ content: 'Painel criado com sucesso neste canal.' });
        } catch (e) {
          console.error('createpanel error', e);
          try { await interaction.editReply({ content: `Erro ao criar painel: ${e.message || e}` }); } catch(_) {}
        }
        return;
      }

      if (cmd === 'forcelaim') {
        if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
          await interaction.reply({ content: 'Você precisa de permissão Manage Guild para usar este comando.', ephemeral: true });
          return;
        }
        await interaction.deferReply({ ephemeral: true }).catch(()=>{});
        try {
          await runClaimsPass();
          await interaction.editReply({ content: 'Rodada de claims forçada executada.' });
        } catch (e) {
          console.error('forcelaim error', e);
          await interaction.editReply({ content: `Erro: ${e.message || e}` });
        }
        return;
      }
    }

    // Button interactions
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id === 'panel_add') {
        const modal = new ModalBuilder().setCustomId('modal_add_card').setTitle('Adicionar Card');
        const input = new TextInputBuilder().setCustomId('card_input').setLabel('Código do card').setStyle(TextInputStyle.Short).setPlaceholder('ex: 1f6c293c3951').setRequired(true);
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
        return;
      }
      if (id === 'panel_remove') {
        const modal = new ModalBuilder().setCustomId('modal_remove_card').setTitle('Remover Card');
        const input = new TextInputBuilder().setCustomId('card_input').setLabel('Código do card a remover').setStyle(TextInputStyle.Short).setPlaceholder('ex: 1f6c293c3951').setRequired(true);
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
        return;
      }
      if (id === 'panel_mycards') {
        const rows = await listUserCards(interaction.user.id);
        if (!rows || rows.length === 0) {
          await interaction.reply({ content: 'Você não tem cards vinculados.', ephemeral: true });
        } else {
          const embed = new EmbedBuilder()
            .setTitle(`${interaction.user.username} — Meus Cards`)
            .setColor(0x5865F2)
            .setFooter({ text: 'Painel de registro de cartões - Coin System' });
          rows.forEach(r => {
            embed.addFields({ name: r.card_code, value: `last claim: ${formatLastClaimAgo(r.last_claim_ts)}\nretries: ${r.claim_retry || 0}`, inline: false });
          });
          await interaction.reply({ embeds: [embed], ephemeral: true });
        }
        return;
      }
    }

    // Modal submissions
    if (interaction.isModalSubmit()) {
      const cid = interaction.customId;
      if (cid === 'modal_add_card') {
        const card = interaction.fields.getTextInputValue('card_input').trim();
        await interaction.deferReply({ ephemeral: true }).catch(()=>{});
        try {
          const res = await addOrUpdateCard(card, interaction.user.id);
          await interaction.editReply({ content: `Card ${card} vinculado com sucesso. (${res.created ? 'created' : 'updated'})` });
          await refreshPanelEmbed();
        } catch (e) {
          console.error('modal_add_card error', e);
          await interaction.editReply({ content: `Erro ao vincular card: ${e.message || e}` });
        }
        return;
      }
      if (cid === 'modal_remove_card') {
        const card = interaction.fields.getTextInputValue('card_input').trim();
        await interaction.deferReply({ ephemeral: true }).catch(()=>{});
        try {
          const res = await removeCard(card, interaction.user.id);
          if (res.ok) await interaction.editReply({ content: `Card ${card} removido.` });
          else await interaction.editReply({ content: `Não foi possível remover: ${res.reason}` });
          await refreshPanelEmbed();
        } catch (e) {
          console.error('modal_remove_card error', e);
          await interaction.editReply({ content: `Erro: ${e.message || e}` });
        }
        return;
      }
    }
  } catch (e) {
    console.error('interaction handler general error', e);
    try { if (interaction.deferred || interaction.replied) await interaction.followUp({ content: 'Erro interno', ephemeral: true }); else await interaction.reply({ content: 'Erro interno', ephemeral: true }); } catch(_) {}
  }
});

client.login(DISCORD_TOKEN).catch(e => {
  console.error('Failed to login Discord client', e);
  process.exit(1);
});
