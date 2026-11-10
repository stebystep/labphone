/* global SipDocs, LabAudio */
'use strict';

// ---------- tiny DOM helpers (textContent only: SIP data from the network is untrusted) ----------
const $ = (id) => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.setAttribute('style', v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
const pad = (n) => String(n).padStart(2, '0');
const fmtTime = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`; };
const fmtDur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
function toast(text, ms = 3500) {
  const t = $('toast');
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}
const userPart = (uri) => (uri || '').replace(/^sips?:/, '').split(/[;?]/)[0];

// ---------- state ----------
const S = {
  app: null, profiles: [], activeId: null, registration: null, calls: new Map(), history: [], messages: [],
  trace: [], stats: {}, mwi: null, selectedTrace: null, editId: null, dtmfLog: {}, openPad: null, openXfer: null,
};
let ws = null;

function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); else toast('Not connected to the LabPhone engine'); }

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => $('conn').classList.add('up');
  ws.onclose = () => { $('conn').classList.remove('up'); setTimeout(connect, 1500); };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') { LabAudio.play(e.data); return; }
    handle(JSON.parse(e.data));
  };
}

function handle(m) {
  switch (m.type) {
    case 'state':
      S.app = m.app; S.profiles = m.profiles; S.activeId = m.activeId; S.registration = m.registration;
      S.history = m.history; S.messages = m.messages; S.mwi = m.mwi;
      S.calls = new Map(m.calls.map((c) => [c.id, c]));
      if (m.trace) { S.trace = m.trace; renderLadder(true); }
      if (!S.editId || !S.profiles.some((p) => p.id === S.editId)) S.editId = S.activeId;
      renderAll();
      break;
    case 'registration': S.registration = m.registration; renderReg(); renderAccounts(); break;
    case 'call': {
      const prev = S.calls.get(m.call.id);
      if (m.call.state === 'ended') {
        S.calls.delete(m.call.id);
        if (prev && prev.state !== 'ended') toast(`Call ended: ${m.call.endReason || ''}`);
      } else S.calls.set(m.call.id, m.call);
      renderCalls();
      renderIncoming();
      renderDialHint();
      updateTones();
      break;
    }
    case 'incoming': renderIncoming(); updateTones(); if (document.hidden) document.title = '📞 Incoming call – LabPhone'; break;
    case 'trace': addTraceEntry(m.entry); break;
    case 'traceCleared': S.trace = []; S.selectedTrace = null; renderLadder(true); renderInspector(); break;
    case 'stats': S.stats = m.stats; renderMedia(); break;
    case 'dtmf': (S.dtmfLog[m.callId] = S.dtmfLog[m.callId] || []).push(`←${m.digit}`); renderCalls(); break;
    case 'history': S.history = m.history; renderHistory(); break;
    case 'im': S.messages.push(m.message); renderMessages(); if (m.message.dir === 'in') toast(`Message from ${m.message.from}`); break;
    case 'mwi': S.mwi = m.mwi; renderReg(); break;
    case 'saved': S.editId = m.id; toast('Account saved'); break;
    case 'error': toast(`Error: ${m.message}`, 6000); break;
    default: break;
  }
}

function renderAll() {
  renderReg(); renderCalls(); renderIncoming(); renderAccounts(true); renderHistory(); renderMessages(); renderMedia(); renderDialHint();
  $('lane-local').textContent = S.app ? `This phone · SIP ${S.app.sipPort}${S.app.tlsPort ? ` / TLS ${S.app.tlsPort}` : ''}` : 'This phone';
}

const activeProfile = () => S.profiles.find((p) => p.id === S.activeId);

// ---------- top bar ----------
function renderReg() {
  const sel = clear($('account-select'));
  for (const p of S.profiles) sel.append(h('option', { value: p.id, selected: p.id === S.activeId, text: `${p.name} (${p.transport.toUpperCase()})` }));
  const r = S.registration || { state: 'unregistered' };
  const p = activeProfile();
  const box = $('reg');
  box.className = `reg ${r.state}`;
  let text;
  if (!p || !p.domain) text = 'Direct IP mode (no registrar)';
  else if (r.state === 'registered') text = `Registered ${r.aor.replace(/^sips?:/, '')} via ${r.transport.toUpperCase()}${r.connection && r.connection.tls ? ' 🔒' : ''}`;
  else if (r.state === 'registering') text = `Registering… ${r.reason || ''}`;
  else if (r.state === 'failed') text = `Registration failed: ${r.reason}`;
  else text = r.reason ? `Not registered (${r.reason})` : 'Not registered';
  $('reg-text').textContent = text;
  $('reg-text').title = text;
  const btn = $('reg-btn');
  btn.classList.toggle('hidden', !p || !p.domain);
  btn.textContent = r.state === 'registered' ? 'Unregister' : 'Register';
  const mwi = S.mwi;
  $('mwi').classList.toggle('hidden', !(mwi && mwi.waiting));
  if (mwi) $('mwi-count').textContent = mwi.newMessages !== null ? `${mwi.newMessages} new` : '';
}

function renderDialHint() {
  const p = activeProfile();
  if (dtmfCall()) { $('dial-hint').textContent = 'In a call: the keypad and your keyboard digits send DTMF (RFC 4733) to the connected call.'; return; }
  $('dial-hint').textContent = p && p.domain
    ? `Numbers are dialled as sip:<number>@${p.domain} over ${p.transport.toUpperCase()}${p.srtp === 'sdes' ? ' with SRTP' : ''}.`
    : 'Direct IP mode: dial user@ip[:port] or a sip: URI, e.g. sip:bob@192.168.1.20;transport=tls';
}

// ---------- dialer ----------
const KEYS = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];
function buildDialpad() {
  const pad = $('dialpad');
  for (const [k, l] of KEYS) {
    pad.append(h('button', { class: 'key', type: 'button', 'aria-label': k, onclick: () => pressKey(k) }, h('b', { text: k }), h('small', { text: l })));
  }
  // Like a desk phone: during a call, keys (and the keyboard) send DTMF instead of dialling.
  document.addEventListener('keydown', (e) => {
    if (!dtmfCall() || e.ctrlKey || e.metaKey || e.altKey || !/^[0-9*#]$/.test(e.key)) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    e.preventDefault();
    pressKey(e.key);
  });
  $('backspace').onclick = () => { const t = $('target'); t.value = t.value.slice(0, -1); t.focus(); };
  $('call-btn').onclick = dial;
  $('target').addEventListener('keydown', (e) => { if (e.key === 'Enter') dial(); });
}
// The call DTMF goes to: the newest connected call that is not on hold.
function dtmfCall() {
  let best = null;
  for (const c of S.calls.values()) {
    if (c.state === 'active' && !c.localHold && (!best || (c.connectedAt || 0) >= (best.connectedAt || 0))) best = c;
  }
  return best;
}

function sendDigit(c, k) {
  send({ type: 'dtmf', callId: c.id, digit: k });
  (S.dtmfLog[c.id] = S.dtmfLog[c.id] || []).push(`→${k}`);
  renderCalls();
}

function pressKey(k) {
  const c = dtmfCall();
  if (c) {
    sendDigit(c, k);
    if (LabAudio.enabled) LabAudio.keyBeep(k);
    return;
  }
  const t = $('target');
  t.value += k;
  t.focus();
}

function dial() {
  const target = $('target').value.trim();
  if (!target) { $('target').focus(); return; }
  ensureAudioHint();
  send({ type: 'call', target });
}
function ensureAudioHint() { if (!LabAudio.enabled) toast('Tip: click "Enable audio" to use your microphone and speaker.'); }

// ---------- calls ----------
function callIsLive(c) { return c.state === 'active' || c.state === 'early'; }

function renderCalls() {
  const box = clear($('calls'));
  for (const c of S.calls.values()) {
    const name = c.remote.display || userPart(c.remote.uri) || 'Unknown';
    const held = c.localHold || c.remoteHold;
    const card = h('div', { class: `card call-card ${c.state}${held ? ' held' : ''}` });
    const timer = h('span', { class: 'timer', 'data-since': c.connectedAt || '' }, c.connectedAt ? fmtDur(Date.now() - c.connectedAt) : '');
    card.append(h('div', { class: 'call-top' },
      h('div', { class: 'avatar', text: name[0].toUpperCase() }),
      h('div', { class: 'who' }, h('b', { text: name }), h('span', { text: c.remote.uri, title: c.remote.uri })),
      timer));
    let status = c.statusText || c.state;
    if (c.localHold) status = 'On hold';
    if (c.remoteHold) status = c.localHold ? 'On hold (both sides)' : 'Held by remote party';
    card.append(h('div', { class: 'call-status' }, `${c.direction === 'incoming' ? '↙ ' : '↗ '}${status}`));

    const badges = h('div', { class: 'badges' });
    if (c.transport) badges.append(h('span', { class: `badge ${c.transport === 'tls' ? 'secure' : ''}`, text: c.transport === 'tls' ? 'SIP/TLS 🔒' : `SIP/${c.transport.toUpperCase()}` }));
    if (c.codec) badges.append(h('span', { class: 'badge', text: c.codec === 'PCMU' ? 'G.711 µ-law' : 'G.711 A-law' }));
    if (c.srtp) badges.append(h('span', { class: `badge ${c.keysExposed ? 'warn' : 'secure'}`, text: `SRTP ${c.srtp.endsWith('_32') ? '(32-bit tag)' : ''} 🔒`, title: c.srtp }));
    else if (c.codec) badges.append(h('span', { class: 'badge bad', text: 'RTP unencrypted' }));
    if (c.keysExposed) badges.append(h('span', { class: 'badge warn', text: 'SRTP keys sent in clear', title: 'SDES keys travel inside the SDP. Without TLS anyone capturing the signalling can decrypt the media.' }));
    if (c.muted) badges.append(h('span', { class: 'badge warn', text: 'Muted' }));
    if (c.tone) badges.append(h('span', { class: 'badge warn', text: '1 kHz test tone' }));
    card.append(badges);
    if (c.transferStatus) card.append(h('div', { class: 'hint', text: c.transferStatus }));

    const act = h('div', { class: 'call-actions' });
    const b = (label, cls, fn, title) => h('button', { class: `btn small ${cls}`, type: 'button', onclick: fn, title }, label);
    if (c.direction === 'incoming' && c.state === 'ringing') {
      act.append(b('Answer', 'call', () => { ensureAudioHint(); send({ type: 'answer', callId: c.id }); }),
        b('Busy (486)', 'ghost', () => send({ type: 'reject', callId: c.id, status: 486 })),
        b('Decline (603)', 'danger', () => send({ type: 'reject', callId: c.id, status: 603 })));
    } else if (c.state === 'active') {
      act.append(
        b(c.localHold ? 'Resume' : 'Hold', c.localHold ? 'on' : 'ghost', () => send({ type: 'hold', callId: c.id, on: !c.localHold }), 'Sends a re-INVITE with a=sendonly / a=sendrecv'),
        b(c.muted ? 'Unmute' : 'Mute', c.muted ? 'on' : 'ghost', () => send({ type: 'mute', callId: c.id, on: !c.muted })),
        b('Keypad', S.openPad === c.id ? 'on' : 'ghost', () => { S.openPad = S.openPad === c.id ? null : c.id; renderCalls(); }, 'Send DTMF'),
        b('Transfer', S.openXfer === c.id ? 'on' : 'ghost', () => { S.openXfer = S.openXfer === c.id ? null : c.id; renderCalls(); }, 'Blind transfer with REFER'),
        b('Tone', c.tone ? 'on' : 'ghost', () => send({ type: 'tone', callId: c.id, on: !c.tone }), 'Send a 1 kHz test tone instead of the microphone'),
        b('Hang up', 'danger', () => send({ type: 'hangup', callId: c.id })));
    } else {
      act.append(b('Cancel', 'danger', () => send({ type: 'hangup', callId: c.id })));
    }
    card.append(act);

    if (S.openPad === c.id && c.state === 'active') {
      const pad = h('div', { class: 'mini-pad' });
      for (const k of '123456789*0#ABCD') pad.append(h('button', { type: 'button', onclick: () => sendDigit(c, k) }, k));
      card.append(pad);
    }
    if (S.dtmfLog[c.id] && S.dtmfLog[c.id].length) card.append(h('div', { class: 'dtmf-log', text: `DTMF ${S.dtmfLog[c.id].slice(-24).join(' ')}` }));
    if (S.openXfer === c.id && c.state === 'active') {
      const input = h('input', { placeholder: 'Transfer to: 1002 or user@host' });
      const form = h('form', { class: 'inline-form', onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) { send({ type: 'transfer', callId: c.id, target: input.value.trim() }); S.openXfer = null; } } },
        input, h('button', { class: 'btn small', type: 'submit' }, 'Transfer'));
      card.append(form);
      setTimeout(() => input.focus(), 0);
    }
    box.append(card);
  }
}

setInterval(() => {
  for (const t of document.querySelectorAll('.timer[data-since]')) {
    const since = Number(t.dataset.since);
    if (since) t.textContent = fmtDur(Date.now() - since);
  }
}, 1000);

function renderIncoming() {
  const ringing = [...S.calls.values()].find((c) => c.direction === 'incoming' && c.state === 'ringing');
  const box = $('incoming');
  if (!ringing) { box.classList.add('hidden'); document.title = 'LabPhone'; return; }
  const name = ringing.remote.display || userPart(ringing.remote.uri);
  clear(box).append(
    h('h3', { text: `Incoming call · ${(ringing.transport || '').toUpperCase()}${ringing.srtp ? ' · SRTP' : ''}` }),
    h('div', { class: 'who' }, h('b', { text: name }), h('span', { text: ringing.remote.uri })),
    h('div', { class: 'call-actions' },
      h('button', { class: 'btn call', type: 'button', onclick: () => { ensureAudioHint(); send({ type: 'answer', callId: ringing.id }); } }, 'Answer'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => send({ type: 'reject', callId: ringing.id, status: 486 }) }, 'Reject')));
  box.classList.remove('hidden');
}

function updateTones() {
  if (!LabAudio.enabled) return;
  const calls = [...S.calls.values()];
  const ringing = calls.some((c) => c.direction === 'incoming' && c.state === 'ringing');
  const ringback = calls.some((c) => c.direction === 'outgoing' && c.state === 'early' && /Ringing/.test(c.statusText) && !c.earlyMedia);
  const want = ringing ? 'ring' : ringback ? 'back' : null;
  if (want === updateTones.current) return;
  updateTones.current = want;
  LabAudio.stopTone();
  if (want === 'ring') LabAudio.ringtone();
  else if (want === 'back') LabAudio.ringback();
}

// ---------- audio ----------
async function toggleAudio() {
  const btn = $('audio-btn');
  if (LabAudio.enabled) {
    await LabAudio.disable();
    send({ type: 'audio', enabled: false });
    btn.textContent = 'Enable audio';
    btn.classList.remove('on');
    return;
  }
  try {
    await LabAudio.enable({
      send: (buf) => { if (ws && ws.readyState === 1) ws.send(buf); },
      wantSend: () => [...S.calls.values()].some(callIsLive),
      levels: (l) => {
        $('mic-level').style.setProperty('--lvl', `${Math.min(100, Math.round(Math.sqrt(l.mic) * 100))}%`);
        $('spk-level').style.setProperty('--lvl', `${Math.min(100, Math.round(Math.sqrt(l.spk) * 100))}%`);
      },
    });
    send({ type: 'audio', enabled: true });
    btn.textContent = 'Audio on';
    btn.classList.add('on');
    updateTones.current = undefined;
    updateTones();
    fillDevices();
  } catch (e) {
    toast(`Audio could not start: ${e.message}`, 6000);
  }
}

async function fillDevices() {
  try {
    const { inputs, outputs } = await LabAudio.devices();
    const fill = (sel, list) => {
      const cur = sel.value;
      clear(sel).append(h('option', { value: '', text: 'System default' }));
      list.forEach((d, i) => sel.append(h('option', { value: d.deviceId, text: d.label || `Device ${i + 1}`, selected: d.deviceId === cur })));
    };
    fill($('mic-select'), inputs);
    fill($('spk-select'), outputs);
  } catch { /* no permission yet */ }
}

// ---------- SIP ladder ----------
function kindClass(e) {
  if (e.dir === 'note') return '';
  const m = /^SIP\/2\.0 (\d)/.exec(e.raw);
  if (!m) return 'k-req';
  return { 1: 'k-1xx', 2: 'k-2xx', 3: 'k-3xx' }[m[1]] || 'k-err';
}

function traceVisible(e) {
  const filter = $('ladder-filter').value;
  const q = $('ladder-search').value.trim().toLowerCase();
  if (e.dir === 'note') {
    if (!$('ladder-notes').checked || filter) return false;
    return !q || e.text.toLowerCase().includes(q);
  }
  if (filter && e.callId !== filter) return false;
  return !q || e.raw.toLowerCase().includes(q);
}

function traceRow(e) {
  if (e.dir === 'note') {
    return h('div', { class: 'row note' }, h('div', { class: 'time', text: fmtTime(e.time).slice(0, 8) }), h('div', { class: 'lane' }, h('div', { class: 'text', text: `ⓘ ${e.text}` })));
  }
  const row = h('div', { class: `row ${e.dir}${S.selectedTrace === e.id ? ' sel' : ''}`, 'data-id': e.id, onclick: () => selectTrace(e.id) });
  row.append(h('div', { class: 'time', text: fmtTime(e.time) }));
  const lane = h('div', { class: `lane ${kindClass(e)}` });
  lane.append(h('div', { class: 'label' }, shortSummary(e), h('small', { text: `${e.transport.toUpperCase()} ${e.dir === 'out' ? '→' : '←'} ${e.remote}` })));
  lane.append(h('div', { class: 'arrow' }));
  row.append(lane);
  return row;
}

function shortSummary(e) {
  const first = e.raw.split('\r\n')[0];
  const m = /^SIP\/2\.0 (\d+ .*)$/.exec(first);
  if (m) {
    const cseq = /^CSeq:\s*\d+\s+(\S+)/im.exec(e.raw);
    return `${m[1]}${cseq ? ` (${cseq[1]})` : ''}`;
  }
  const [method, uri] = first.split(' ');
  const hasSdp = /\r\nContent-Type:\s*application\/sdp/i.test(e.raw);
  return `${method} ${userPart(uri)}${hasSdp ? ' +SDP' : ''}`;
}

function renderLadder(full) {
  const rows = $('ladder-rows');
  if (full) {
    clear(rows);
    const frag = document.createDocumentFragment();
    for (const e of S.trace) if (traceVisible(e)) frag.append(traceRow(e));
    rows.append(frag);
  }
  $('ladder-empty').classList.toggle('hidden', S.trace.length > 0);
  refreshFilterOptions();
  if ($('ladder-follow').checked) $('ladder').scrollTop = $('ladder').scrollHeight;
}

function addTraceEntry(e) {
  S.trace.push(e);
  if (S.trace.length > 1500) S.trace.splice(0, S.trace.length - 1500);
  if (traceVisible(e)) $('ladder-rows').append(traceRow(e));
  renderLadder(false);
}

function refreshFilterOptions() {
  const sel = $('ladder-filter');
  const seen = new Map();
  for (const e of S.trace) {
    if (!e.callId || seen.has(e.callId)) continue;
    const first = e.raw.split('\r\n')[0];
    const cseq = /^CSeq:\s*\d+\s+(\S+)/im.exec(e.raw);
    seen.set(e.callId, `${cseq ? cseq[1] : first.split(' ')[0]} · ${e.callId.slice(0, 14)}…`);
  }
  if (sel.options.length - 1 === seen.size) return;
  const cur = sel.value;
  clear(sel).append(h('option', { value: '', text: 'All messages' }));
  for (const [id, label] of seen) sel.append(h('option', { value: id, text: label, selected: id === cur }));
}

function selectTrace(id) {
  S.selectedTrace = id;
  for (const r of document.querySelectorAll('#ladder-rows .row.sel')) r.classList.remove('sel');
  const row = document.querySelector(`#ladder-rows .row[data-id="${id}"]`);
  if (row) row.classList.add('sel');
  renderInspector();
}

function renderInspector() {
  const e = S.trace.find((t) => t.id === S.selectedTrace);
  const raw = clear($('raw'));
  if (!e) { $('inspector-head').textContent = 'Select a message'; return; }
  $('inspector-head').textContent = `${e.dir === 'out' ? 'Sent to' : 'Received from'} ${e.remote} over ${e.transport.toUpperCase()} · local ${e.local} · ${fmtTime(e.time)} · ${e.raw.length} bytes`;
  const [head, ...bodyParts] = e.raw.split('\r\n\r\n');
  const body = bodyParts.join('\r\n\r\n');
  const lines = head.split('\r\n');
  lines.forEach((line, i) => {
    let el;
    if (i === 0) el = h('span', { class: 'ln start', text: line });
    else {
      const c = line.indexOf(':');
      el = h('span', { class: 'ln' }, h('span', { class: 'hn', text: line.slice(0, c + 1) }), line.slice(c + 1));
    }
    el.addEventListener('click', () => explainLine(el, i === 0 ? { start: line } : { header: line.slice(0, line.indexOf(':')).trim(), value: line.slice(line.indexOf(':') + 1).trim() }));
    raw.append(el);
  });
  raw.append(h('span', { class: 'ln sep', text: ' ' }));
  if (body) {
    for (const line of body.split(/\r?\n/)) {
      if (!line) continue;
      const el = h('span', { class: 'ln sdp', text: line });
      el.addEventListener('click', () => explainLine(el, { sdp: line }));
      raw.append(el);
    }
  }
  explainLine(raw.firstChild, { start: lines[0] });
}

function explainLine(el, what) {
  for (const s of document.querySelectorAll('#raw .ln.sel')) s.classList.remove('sel');
  if (el) el.classList.add('sel');
  const box = clear($('explain'));
  const add = (title, text, ref) => box.append(h('h4', { text: title }), h('p', { text }), ref ? h('p', { class: 'ref', text: ref }) : null);
  if (what.start) {
    const m = /^SIP\/2\.0 (\d)(\d\d) (.*)$/.exec(what.start);
    if (m) {
      const code = Number(m[1] + m[2]);
      add(`${code} ${m[3]}`, SipDocs.codes[code] || SipDocs.classes[m[1]] || '', 'RFC 3261 §21');
      box.append(h('p', { class: 'muted', text: SipDocs.classes[m[1]] }));
    } else {
      const method = what.start.split(' ')[0];
      const d = SipDocs.methods[method];
      add(method, d ? d[0] : SipDocs.startLine.request, d ? d[1] : '');
      box.append(h('p', { class: 'muted', text: SipDocs.startLine.request }));
    }
    return;
  }
  if (what.header) {
    const d = SipDocs.headers[what.header];
    add(what.header, d ? d[0] : 'Header not described in the built-in guide.', d ? d[1] : '');
    if (what.header === 'Via') {
      const br = /branch=([^;\s]+)/.exec(what.value);
      if (br) box.append(h('p', {}, 'Transaction branch: ', h('code', { text: br[1] })));
    }
    if (what.header === 'CSeq') box.append(h('p', {}, 'Number / method: ', h('code', { text: what.value })));
    return;
  }
  if (what.sdp) {
    const t = what.sdp[0];
    let key = t;
    if (t === 'a') {
      const name = what.sdp.slice(2).split(/[:\s]/)[0];
      key = `a=${name}`;
    }
    const d = SipDocs.sdp[key];
    add(key, d ? d[0] : 'SDP attribute not described in the built-in guide.', d ? d[1] : 'RFC 4566');
    const pt = /^m=audio \d+ \S+ (.*)$/.exec(what.sdp);
    if (pt) box.append(h('p', {}, 'Payload types offered: ', h('code', { text: pt[1] })));
  }
}

function exportTrace() {
  const lines = S.trace.filter(traceVisible).map((e) => (e.dir === 'note'
    ? `[${new Date(e.time).toISOString()}] NOTE ${e.text}\n`
    : `[${new Date(e.time).toISOString()}] ${e.dir === 'out' ? 'SENT to' : 'RECEIVED from'} ${e.remote} (${e.transport.toUpperCase()}) local ${e.local}\n${e.raw}\n${'-'.repeat(72)}\n`));
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `labphone-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.txt` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------- media tab ----------
function renderMedia() {
  const box = clear($('media-calls'));
  const entries = Object.entries(S.stats).filter(([id]) => S.calls.has(id));
  if (!entries.length) { box.append(h('p', { class: 'muted', text: 'RTP statistics appear here during a call.' })); return; }
  for (const [id, s] of entries) {
    const c = S.calls.get(id);
    const kv = h('dl', { class: 'kv' });
    const row = (k, v) => kv.append(h('dt', { text: k }), h('dd', { text: v === null || v === undefined ? '–' : String(v) }));
    row('Codec', `${s.codec} (PT ${s.pt})`);
    row('DTMF', s.dtmfPt !== null ? `RFC 4733, PT ${s.dtmfPt} · sent ${s.dtmfSent} · recv ${s.dtmfReceived}` : 'SIP INFO (no telephone-event)');
    row('Encryption', s.srtp ? `SRTP ${s.srtp}` : 'none (plain RTP)');
    row('Local RTP', `:${s.localPort} (RTCP :${s.localPort + 1})`);
    row('Remote RTP', s.remote);
    row('Direction', s.direction);
    row('SSRC local / remote', `${s.ssrc} / ${s.remoteSsrc || '–'}`);
    row('Packets sent', `${s.sent} (${(s.sentBytes / 1024).toFixed(1)} KiB payload)`);
    row('Packets received', `${s.received} (${(s.receivedBytes / 1024).toFixed(1)} KiB payload)`);
    row('Lost (estimated)', s.lost);
    row('Jitter', `${s.jitterMs} ms`);
    if (s.srtp) row('SRTP auth failures', s.srtpAuthFailures);
    if (s.unknownPt) row('Unknown payload types', s.unknownPt);
    if (s.remoteReport) row('Remote RTCP report', `${s.remoteReport.fractionLost}% lost · ${s.remoteReport.cumulativeLost} total · jitter ${s.remoteReport.jitterMs} ms`);
    row('Last packet', s.lastReceived ? `${((Date.now() - s.lastReceived) / 1000).toFixed(1)} s ago` : 'never');
    const name = c ? (c.remote.display || userPart(c.remote.uri)) : id;
    box.append(h('div', { class: 'card media-card' }, h('h3', {}, name, s.srtp ? h('span', { class: 'badge secure', text: 'SRTP' }) : h('span', { class: 'badge bad', text: 'RTP' })), kv));
  }
}

// ---------- accounts ----------
// Re-render the form only when forced or untouched, so registration refreshes don't wipe edits.
function renderAccounts(force = false) {
  const list = clear($('account-list'));
  for (const p of S.profiles) {
    list.append(h('li', { class: p.id === S.editId ? 'sel' : '', onclick: () => { S.editId = p.id; renderAccounts(true); } },
      h('div', {}, p.name, p.id === S.activeId ? h('span', { class: 'act', text: '  ● active' }) : null),
      h('small', { text: p.domain ? `${p.username}@${p.domain} · ${p.transport.toUpperCase()}${p.srtp === 'sdes' ? ' · SRTP' : ''}` : 'Direct IP calls' })));
  }
  if (!force && S.formDirty && S.formFor === S.editId) return;
  S.formDirty = false;
  S.formFor = S.editId;
  const p = S.editId === 'new' ? null : S.profiles.find((x) => x.id === S.editId);
  renderAccountForm(p);
}

function field(label, input, help) {
  return h('label', {}, label, input, help ? h('span', { class: 'help', text: help }) : null);
}

function renderAccountForm(p) {
  const form = clear($('account-form'));
  const v = p || { name: '', displayName: '', username: '', authUsername: '', domain: '', proxy: '', transport: 'tls', register: true, expires: 300, srtp: 'sdes', codecs: ['PCMU', 'PCMA'], dtmfMode: 'rfc2833', tlsVerify: false, useSips: false, autoAnswer: false, keepaliveSec: 30, tlsCaFile: '', tlsCertFile: '', tlsKeyFile: '' };
  const inp = (name, type = 'text', attrs = {}) => h('input', { name, type, value: v[name] !== undefined ? v[name] : '', ...attrs });
  const isActive = p && p.id === S.activeId;

  if (isActive && S.registration) {
    const r = S.registration;
    if (r.state === 'registered') {
      const tls = r.connection && r.connection.tls;
      form.append(h('div', { class: 'callout ok' },
        `Registered as ${r.aor} · contact ${r.contact} · expires ${r.expires}s${r.server ? ` · server "${r.server}"` : ''}`,
        tls ? h('div', { text: `TLS: ${tls.protocol} ${tls.cipher} · certificate ${tls.subject} · issuer ${tls.issuer} · ${tls.authorized ? 'verified ✔' : `not verified (${tls.authError})`}` }) : null));
    } else if (r.state === 'failed') form.append(h('div', { class: 'callout warn', text: `Registration failed: ${r.reason}` }));
  }

  const transport = h('div', { class: 'radios' }, ...['udp', 'tcp', 'tls'].map((t) => h('label', {}, h('input', { type: 'radio', name: 'transport', value: t, checked: v.transport === t }), t.toUpperCase())));
  const srtpSel = h('select', { name: 'srtp' }, h('option', { value: 'off', text: 'Off – plain RTP (accept SRTP if offered)', selected: v.srtp !== 'sdes' }), h('option', { value: 'sdes', text: 'Mandatory – SDES-SRTP (RTP/SAVP)', selected: v.srtp === 'sdes' }));
  const dtmfSel = h('select', { name: 'dtmfMode' }, h('option', { value: 'rfc2833', text: 'RFC 4733 / 2833 (in RTP)', selected: v.dtmfMode !== 'info' }), h('option', { value: 'info', text: 'SIP INFO', selected: v.dtmfMode === 'info' }));
  const codecs = h('div', { class: 'codec-list' }, ...['PCMU', 'PCMA'].map((c) => h('label', { class: 'toggle' }, h('input', { type: 'checkbox', name: `codec_${c}`, checked: (v.codecs || []).includes(c) }), c === 'PCMU' ? 'G.711 µ-law (PCMU)' : 'G.711 A-law (PCMA)')));
  const cb = (name, label) => h('label', { class: 'toggle' }, h('input', { type: 'checkbox', name, checked: !!v[name] }), label);
  const warn = h('div', { class: 'callout warn hidden', id: 'srtp-warn', text: 'SRTP with SDES puts the media keys inside the SDP. Over UDP/TCP those keys can be read by anyone capturing the signalling — choose TLS to protect them.' });

  form.append(
    h('fieldset', {}, h('legend', { text: 'Account' }), h('div', { class: 'form-grid' },
      field('Account name', inp('name', 'text', { placeholder: 'Lab PBX ext 1001' })),
      field('Display name', inp('displayName', 'text', { placeholder: 'Student 1' })),
      field('Username / extension', inp('username', 'text', { placeholder: '1001' })),
      field('Auth username', inp('authUsername', 'text', { placeholder: 'same as username' }), 'Only if the server uses a different authentication ID'),
      field('Password', h('input', { name: 'password', type: 'password', placeholder: p && p.hasPassword ? '(unchanged)' : '', autocomplete: 'new-password' })),
      field('Domain / registrar', inp('domain', 'text', { placeholder: 'pbx.lab.local or 192.168.1.10' }), 'Leave empty for direct IP-to-IP calls'))),
    h('fieldset', {}, h('legend', { text: 'Server & transport' }), h('div', { class: 'form-grid' },
      field('Outbound proxy (optional)', inp('proxy', 'text', { placeholder: 'host[:port]' }), 'Where requests are physically sent. Empty = domain (DNS SRV lookup if no port)'),
      h('div', { class: 'field' }, 'Transport', transport),
      field('Registration expires (s)', inp('expires', 'number', { min: 30, max: 86400 })),
      field('TCP/TLS keep-alive (s)', inp('keepaliveSec', 'number', { min: 0, max: 600 }), 'CRLF ping (RFC 5626), 0 = off'),
      cb('register', 'Register with the server'),
      cb('useSips', 'Use sips: URIs (end-to-end TLS)'))),
    h('fieldset', {}, h('legend', { text: 'Security' }), warn, h('div', { class: 'form-grid' },
      field('Media encryption', srtpSel),
      cb('tlsVerify', 'Verify server TLS certificate'),
      field('CA certificate file (PEM)', inp('tlsCaFile', 'text', { placeholder: '/etc/ssl/lab-ca.pem' }), 'Trust a private lab CA when verifying'),
      field('Client certificate (PEM)', inp('tlsCertFile', 'text', { placeholder: 'optional' })),
      field('Client key (PEM)', inp('tlsKeyFile', 'text', { placeholder: 'optional' })))),
    h('fieldset', {}, h('legend', { text: 'Media & behaviour' }), h('div', { class: 'form-grid' },
      h('div', { class: 'field' }, 'Codecs (offer order)', codecs),
      field('DTMF method', dtmfSel),
      cb('autoAnswer', 'Auto-answer incoming calls after 1 s'))),
    h('div', { class: 'form-actions' },
      h('button', { class: 'btn', type: 'submit' }, p ? 'Save' : 'Create account'),
      p && !isActive ? h('button', { class: 'btn ghost', type: 'button', onclick: () => send({ type: 'activateProfile', id: p.id }) }, 'Use this account') : null,
      h('div', { class: 'spacer' }),
      p && S.profiles.length > 1 ? h('button', { class: 'btn ghost', type: 'button', onclick: () => { if (confirm(`Delete account "${p.name}"?`)) send({ type: 'deleteProfile', id: p.id }); } }, 'Delete') : null),
  );
  const updateWarn = () => {
    const t = form.querySelector('input[name=transport]:checked');
    warn.classList.toggle('hidden', !(srtpSel.value === 'sdes' && t && t.value !== 'tls'));
  };
  form.onchange = updateWarn;
  form.oninput = () => { S.formDirty = true; };
  updateWarn();
  form.onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const profile = {
      id: p ? p.id : undefined,
      name: f.get('name'), displayName: f.get('displayName'), username: f.get('username'), authUsername: f.get('authUsername'),
      password: f.get('password') || undefined, domain: f.get('domain'), proxy: f.get('proxy'), transport: f.get('transport'),
      expires: Number(f.get('expires')), keepaliveSec: Number(f.get('keepaliveSec')), register: f.has('register'), useSips: f.has('useSips'),
      srtp: f.get('srtp'), tlsVerify: f.has('tlsVerify'), tlsCaFile: f.get('tlsCaFile'), tlsCertFile: f.get('tlsCertFile'), tlsKeyFile: f.get('tlsKeyFile'),
      codecs: ['PCMU', 'PCMA'].filter((c) => f.has(`codec_${c}`)), dtmfMode: f.get('dtmfMode'), autoAnswer: f.has('autoAnswer'),
    };
    send({ type: 'saveProfile', profile, activate: !p });
  };
}

// ---------- history & messages ----------
function renderHistory() {
  const body = clear($('history-rows'));
  if (!S.history.length) { body.append(h('tr', {}, h('td', { colspan: 6, class: 'muted', text: 'No calls yet.' }))); return; }
  for (const c of S.history) {
    const dur = c.connectedAt ? fmtDur(c.end - c.connectedAt) : '–';
    const ok = !!c.connectedAt;
    body.append(h('tr', { title: 'Click to call back', onclick: () => { $('target').value = c.remote.uri; $('target').focus(); } },
      h('td', { text: c.direction === 'incoming' ? (ok ? '↙' : '↙✕') : (ok ? '↗' : '↗✕') }),
      h('td', { class: 'party' }, c.remote.display ? `${c.remote.display} ` : '', userPart(c.remote.uri)),
      h('td', { text: new Date(c.start).toLocaleString() }),
      h('td', { text: dur }),
      h('td', { text: c.reason || '' }),
      h('td', { text: `${(c.transport || '').toUpperCase()}${c.srtp ? ' + SRTP' : ''}` })));
  }
}

function renderMessages() {
  const list = clear($('im-list'));
  if (!S.messages.length) list.append(h('p', { class: 'muted', text: 'SIP MESSAGE (RFC 3428) instant messages appear here.' }));
  for (const m of S.messages) {
    list.append(h('div', { class: `bubble ${m.dir}` }, h('small', { text: `${m.dir === 'in' ? `From ${m.from}` : `To ${m.to}`} · ${new Date(m.at).toLocaleTimeString()}${m.status ? ` · ${m.status}` : ''}` }), m.text));
  }
  list.scrollTop = list.scrollHeight;
}

// ---------- wiring ----------
function init() {
  buildDialpad();
  for (const b of document.querySelectorAll('#tabs button')) {
    b.addEventListener('click', () => {
      for (const x of document.querySelectorAll('#tabs button')) x.classList.toggle('active', x === b);
      for (const t of document.querySelectorAll('.tab-body')) t.classList.toggle('hidden', t.id !== `tab-${b.dataset.tab}`);
      if (b.dataset.tab === 'media') fillDevices();
    });
  }
  $('account-select').onchange = (e) => send({ type: 'activateProfile', id: e.target.value });
  $('reg-btn').onclick = () => send({ type: S.registration && S.registration.state === 'registered' ? 'unregister' : 'register' });
  $('audio-btn').onclick = toggleAudio;
  $('new-account').onclick = () => { S.editId = 'new'; renderAccounts(true); };
  $('ladder-filter').onchange = () => renderLadder(true);
  $('ladder-search').oninput = () => renderLadder(true);
  $('ladder-notes').onchange = () => renderLadder(true);
  $('ladder-clear').onclick = () => send({ type: 'clearTrace' });
  $('ladder-export').onclick = exportTrace;
  $('history-clear').onclick = () => send({ type: 'clearHistory' });
  $('mic-select').onchange = (e) => LabAudio.setMic(e.target.value).catch((err) => toast(err.message));
  $('spk-select').onchange = (e) => LabAudio.setSpeaker(e.target.value).catch((err) => toast(`Speaker selection not supported: ${err.message}`));
  $('im-form').onsubmit = (e) => {
    e.preventDefault();
    send({ type: 'message', target: $('im-to').value.trim(), text: $('im-text').value });
    $('im-text').value = '';
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = 'LabPhone'; });
  connect();
}

init();
