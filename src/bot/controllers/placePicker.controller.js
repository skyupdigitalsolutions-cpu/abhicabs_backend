const crypto = require('crypto');
const axios = require('axios');
const env = require('../config/env');
const { verifyToken } = require('../utils/calendarLink');
const { getPrisma } = require('../config/db');
const { processInboundMessage } = require('../conversation/stateMachine');
const { STATES } = require('../conversation/states');
const { logger } = require('../config/logger');

const KINDS = { pickup: STATES.BOOKING_PICKUP, drop: STATES.BOOKING_DROP };

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Search a place | ABHI CABS</title>
<style>
:root{--bg:#f3f6f4;--card:#ffffff;--text:#16241d;--muted:#5b6b63;--line:#d9e2dc;--accent:#0f5d4a;--on:#ffffff;--tile:#eef3f0;--danger:#b42318}
@media (prefers-color-scheme: dark){:root{--bg:#101815;--card:#18221e;--text:#e8f0ec;--muted:#9bb0a5;--line:#2b3a33;--accent:#3fbf9b;--on:#07201a;--tile:#202c27;--danger:#ff8a80}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh;display:flex;justify-content:center;padding:16px}
.card{width:100%;max-width:460px;background:var(--card);border-radius:16px;padding:18px;border:1px solid var(--line);align-self:flex-start}
h1{font-size:18px;margin:0 0 2px;font-weight:600}.sub{color:var(--muted);font-size:14px;margin:0 0 14px}
input{width:100%;height:50px;border-radius:12px;border:1px solid var(--line);background:var(--tile);color:var(--text);font-size:16px;padding:0 14px}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
ul{list-style:none;margin:10px 0 0;padding:0}li{margin:0}
.item{width:100%;text-align:left;border:1px solid var(--line);background:var(--tile);color:var(--text);border-radius:12px;padding:11px 14px;margin-bottom:8px;cursor:pointer;font:inherit}
.item:hover,.item:focus-visible{border-color:var(--accent)}.item b{display:block;font-weight:600;font-size:15px}.item span{display:block;color:var(--muted);font-size:13px;margin-top:2px}
#msg{font-size:14px;color:var(--muted);min-height:20px;margin-top:8px}.err{color:var(--danger)!important}.done{text-align:center;padding:24px 8px}.done .big{font-size:44px;color:var(--accent)}
</style></head><body>
<main class="card" id="card">
<h1 id="title">Search a place</h1><p class="sub">Start typing a place, area, street, landmark or address, then tap a result.</p>
<input id="q" type="search" placeholder="For example Hebbal or Majestic" autocomplete="off" autocapitalize="words" aria-label="Search a place">
<div id="msg" role="status"></div>
<ul id="list"></ul>
</main>
<script src="/place/app.js"></script>
</body></html>`;

const APP_JS = `(function(){
var token=location.pathname.split('/').pop();
var info;try{var b=token.split('.')[0].replace(/-/g,'+').replace(/_/g,'/');info=JSON.parse(decodeURIComponent(escape(atob(b))));}catch(e){info=null;}
var q=document.getElementById('q'),list=document.getElementById('list'),msg=document.getElementById('msg');
if(!info){document.getElementById('card').innerHTML='<p>This link is not valid. Go back to WhatsApp and tap Search place again.</p>';return;}
document.getElementById('title').textContent=info.k==='drop'?'Search your drop place':'Search your pickup place';
var st=(self.crypto&&crypto.randomUUID)?crypto.randomUUID():String(Date.now())+Math.random().toString(16).slice(2);
var timer=null,seq=0,busy=false;
function say(t,err){msg.textContent=t||'';msg.className=err?'err':'';}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function render(items){
list.innerHTML='';
items.forEach(function(it){
var li=document.createElement('li'),bt=document.createElement('button');
bt.type='button';bt.className='item';bt.innerHTML='<b>'+esc(it.main)+'</b>'+(it.secondary?'<span>'+esc(it.secondary)+'</span>':'');
bt.addEventListener('click',function(){choose(it);});li.appendChild(bt);list.appendChild(li);});}
function search(){
var v=q.value.trim();var my=++seq;
if(v.length<2){list.innerHTML='';say('');return;}
say('Searching...');
fetch('/place/suggest?token='+encodeURIComponent(token)+'&q='+encodeURIComponent(v)+'&st='+encodeURIComponent(st))
.then(function(r){return r.json().then(function(j){return {s:r.status,j:j};});})
.then(function(x){
if(my!==seq)return;
if(x.s===410){say('This link has expired. Tap Search place again in WhatsApp.',true);return;}
if(!x.j||!x.j.ok){list.innerHTML='';say('Search is not available right now. Please try again in a moment.',true);return;}
if(!x.j.suggestions.length){list.innerHTML='';say('No places found. Try another spelling or a nearby landmark.');return;}
say('');render(x.j.suggestions);})
.catch(function(){if(my===seq){say('No connection. Please try again.',true);}});}
function choose(it){
if(busy)return;busy=true;say('Saving...');
fetch('/place/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token,placeId:it.id,st:st})})
.then(function(r){return r.json().then(function(j){return {s:r.status,j:j};});})
.then(function(x){
if(x.j&&x.j.ok){document.getElementById('card').innerHTML='<div class="done"><div class="big">&#10003;</div><h1>Place saved</h1><p class="sub">'+esc(x.j.name||it.main)+'</p><p>Go back to WhatsApp. We have sent the next step there.</p></div>';return;}
busy=false;say(x.s===409?'This step is already done. Go back to WhatsApp.':(x.s===410?'This link has expired. Tap Search place again in WhatsApp.':'Could not save that place. Please pick again.'),true);})
.catch(function(){busy=false;say('No connection. Please try again.',true);});}
q.addEventListener('input',function(){clearTimeout(timer);timer=setTimeout(search,250);});
q.focus();
})();`;

function msgPage(title, text) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui,sans-serif;text-align:center;padding:40px"><h2>${title}</h2><p>${text}</p></body>`;
}

const okKind = (info) => info && Object.prototype.hasOwnProperty.call(KINDS, info.kind);
const okSession = (v) => typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v);

function parseNear(value) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value || '');
  return m ? { latitude: Number(m[1]), longitude: Number(m[2]) } : null;
}

function showPage(req, res) {
  res.set('Cache-Control', 'no-store');
  if (!okKind(verifyToken(req.params.token))) {
    return res.status(410).type('html').send(msgPage('This link has expired', 'Go back to WhatsApp and tap Search place again.'));
  }
  return res.type('html').send(PAGE);
}

function appJs(req, res) {
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript').send(APP_JS);
}

/** GET /place/suggest?token=&q=&st=  — suggestions as the customer types (Google Places Autocomplete, New). */
async function suggest(req, res) {
  res.set('Cache-Control', 'no-store');
  const info = verifyToken(String(req.query.token || ''));
  if (!okKind(info)) return res.status(410).json({ ok: false, error: 'expired' });

  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q.length < 2) return res.json({ ok: true, suggestions: [] });
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) return res.status(503).json({ ok: false, error: 'not_configured' });

  const body = { input: q, includedRegionCodes: ['in'], languageCode: 'en' };
  if (okSession(req.query.st)) body.sessionToken = req.query.st;
  const center = info.near || parseNear(env.PLACE_SEARCH_NEAR);
  if (center) body.locationBias = { circle: { center: { latitude: Number(center.latitude), longitude: Number(center.longitude) }, radius: 50000 } };

  try {
    const { data } = await axios.post('https://places.googleapis.com/v1/places:autocomplete', body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat',
      },
      timeout: 6000,
    });
    const suggestions = (data?.suggestions || [])
      .map((s) => s.placePrediction)
      .filter((p) => p && p.placeId)
      .slice(0, 8)
      .map((p) => ({
        id: p.placeId,
        main: p.structuredFormat?.mainText?.text || p.text?.text || '',
        secondary: p.structuredFormat?.secondaryText?.text || '',
      }));
    return res.json({ ok: true, suggestions });
  } catch (err) {
    logger.warn({ status: err.response?.status, err: err.response?.data?.error?.message || err.message }, '[place] autocomplete failed (is "Places API (New)" enabled for the key?)');
    return res.status(502).json({ ok: false, error: 'search_failed' });
  }
}

/** POST /place/select  { token, placeId, st }  — saves the chosen place and carries the booking on in WhatsApp. */
async function select(req, res) {
  const { token, placeId, st } = req.body || {};
  const info = verifyToken(token);
  if (!okKind(info)) return res.status(410).json({ ok: false, error: 'expired' });
  if (typeof placeId !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(placeId)) return res.status(400).json({ ok: false, error: 'bad_place' });

  const session = await getPrisma().whatsappSession.findUnique({ where: { whatsappNumber: info.number } });
  if (!session || session.state !== KINDS[info.kind]) return res.status(409).json({ ok: false, error: 'not_waiting' });

  let place;
  try {
    const { data } = await axios.get(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      params: { languageCode: 'en', ...(okSession(st) ? { sessionToken: st } : {}) },
      headers: { 'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY, 'X-Goog-FieldMask': 'id,displayName,formattedAddress,location' },
      timeout: 6000,
    });
    place = data;
  } catch (err) {
    logger.warn({ status: err.response?.status, err: err.response?.data?.error?.message || err.message }, '[place] details failed');
    return res.status(502).json({ ok: false, error: 'details_failed' });
  }
  if (!place || !place.location) return res.status(502).json({ ok: false, error: 'details_failed' });

  const name = place.displayName?.text || place.formattedAddress || 'Selected place';
  const address = place.formattedAddress || name;
  const full = String(address).toLowerCase().includes(String(name).toLowerCase()) ? address : `${name}, ${address}`;

  res.json({ ok: true, name: full });
  processInboundMessage(info.number, {
    id: `place-${crypto.randomUUID()}`, from: info.number, timestamp: null, type: 'location', text: null,
    interactiveId: null, interactiveTitle: null,
    location: { latitude: place.location.latitude, longitude: place.location.longitude, name: full, address },
  }).catch((err) => logger.error({ err: err.message }, '[place] could not continue the booking'));
}

module.exports = { showPage, appJs, suggest, select };
