const crypto = require('crypto');
const axios = require('axios');
const env = require('../config/env');
const { verifyToken } = require('../utils/calendarLink');
const { getPrisma } = require('../config/db');
const { processInboundMessage } = require('../conversation/stateMachine');
const { STATES } = require('../conversation/states');
const { logger } = require('../config/logger');

/**
 * Place map page. Opened from the "Search place" button in WhatsApp, for the PICKUP and for the DROP.
 *  - A search bar with suggestions: the chosen place is shown on the map with a marker.
 *  - "Use my current location" shows the phone's real GPS position with a marker.
 * The customer can also tap or drag the marker to fine-tune it, then taps "Confirm".
 * Confirming saves the place and the booking carries on in WhatsApp. Nothing has to be typed in the chat.
 *
 * Map tiles: OpenStreetMap (https://operations.osmfoundation.org/policies/tiles/ — fine for light use;
 * switch to a paid tile provider for heavy traffic). Google is used only on the server: autocomplete,
 * place details and reverse geocoding, so no Google key is ever sent to the browser.
 */
// A link only works for its own purpose and only while the bot is waiting for that answer.
const KINDS = { pickupmap: STATES.BOOKING_PICKUP, dropmap: STATES.BOOKING_DROP };

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Choose a place | ABHI CABS</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="__CSS_SRI__" crossorigin="">
<style>
:root{--bg:#f3f6f4;--card:#ffffff;--text:#16241d;--muted:#5b6b63;--line:#d9e2dc;--accent:#0f5d4a;--on:#ffffff;--tile:#eef3f0;--danger:#b42318}
@media (prefers-color-scheme: dark){:root{--bg:#101815;--card:#18221e;--text:#e8f0ec;--muted:#9bb0a5;--line:#2b3a33;--accent:#3fbf9b;--on:#07201a;--tile:#202c27;--danger:#ff8a80}}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;justify-content:center;padding:12px}
.card{width:100%;max-width:560px;background:var(--card);border-radius:16px;padding:14px;border:1px solid var(--line)}
h1{font-size:18px;margin:0 0 10px;font-weight:600}
.searchbox{position:relative}
#q{width:100%;height:48px;border-radius:12px;border:1px solid var(--line);background:var(--tile);color:var(--text);font-size:16px;padding:0 14px}
#q:focus{outline:2px solid var(--accent);outline-offset:1px}
#list{list-style:none;margin:6px 0 0;padding:0;position:absolute;left:0;right:0;z-index:1000;background:var(--card);border-radius:12px;box-shadow:0 6px 20px rgba(0,0,0,.18);max-height:260px;overflow:auto}
#list:empty{display:none}
.item{display:block;width:100%;text-align:left;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--text);padding:10px 14px;cursor:pointer;font:inherit}
.item b{display:block;font-weight:600;font-size:15px}.item span{display:block;color:var(--muted);font-size:13px;margin-top:2px}
#map{width:100%;height:50vh;min-height:280px;border-radius:12px;margin-top:10px;background:var(--tile);border:1px solid var(--line)}
#map p{padding:14px;color:var(--muted)}
.pin{width:24px;height:24px;background:#e5594f;border:3px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 2px 6px rgba(0,0,0,.4)}
.row{display:flex;gap:8px;margin-top:10px}
#gps{height:44px;border-radius:12px;border:1px solid var(--line);background:var(--tile);color:var(--text);font-size:15px;padding:0 14px;cursor:pointer;flex:1}
.addr{margin-top:10px;border-top:1px solid var(--line);padding-top:10px}.lbl{color:var(--muted);font-size:13px}#addr{font-size:16px;font-weight:600;min-height:22px;margin-top:2px}
#ok{width:100%;height:52px;margin-top:10px;border:0;border-radius:12px;background:var(--accent);color:var(--on);font-size:16px;font-weight:600;cursor:pointer}
#ok:disabled{opacity:.45;cursor:default}#msg{font-size:14px;color:var(--muted);min-height:20px;margin-top:8px}.err{color:var(--danger)!important}
.done{text-align:center;padding:28px 8px}.done .big{font-size:46px;color:var(--accent)}
</style></head><body>
<main class="card" id="card">
<h1 id="title">Choose your pickup</h1>
<div class="searchbox"><input id="q" type="search" placeholder="Search a place, area, street or landmark" autocomplete="off" aria-label="Search a place"><ul id="list"></ul></div>
<div id="map" role="application" aria-label="Map"></div>
<div class="row"><button type="button" id="gps">Use my current location</button></div>
<div id="msg" role="status"></div>
<div class="addr"><div class="lbl" id="lbl">Pickup location</div><div id="addr">No place selected yet</div></div>
<button type="button" id="ok" disabled>Confirm pickup</button>
</main>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="__JS_SRI__" crossorigin=""></script>
<script src="/place-map/app.js"></script>
</body></html>`
  .replace('__CSS_SRI__', 'sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H').replace('__JS_SRI__', 'sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH');

const APP_JS = `(function(){
var token=location.pathname.split('/').pop();
var params=new URLSearchParams(location.search);
var info;try{var b=token.split('.')[0].replace(/-/g,'+').replace(/_/g,'/');info=JSON.parse(decodeURIComponent(escape(atob(b))));}catch(e){info=null;}
function $(id){return document.getElementById(id);}
if(!info){$('card').innerHTML='<p>This link is not valid. Go back to WhatsApp and tap Search place again.</p>';return;}
var drop=info.k==='dropmap';
var W=drop?'drop':'pickup';
if(drop){$('title').textContent='Choose your drop';$('lbl').textContent='Drop location';$('ok').textContent='Confirm drop';document.title='Choose your drop | ABHI CABS';}
var st=(self.crypto&&crypto.randomUUID)?crypto.randomUUID():String(Date.now())+Math.random().toString(16).slice(2);
var sel=null,map=null,marker=null,seq=0,timer=null,busy=false;
function say(t,err){$('msg').textContent=t||'';$('msg').className=err?'err':'';}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function setSel(s){sel=s;$('addr').textContent=s?s.address:'No place selected yet';$('ok').disabled=!s||!!s.pending;}
function api(path,opts){return fetch(path,opts).then(function(r){return r.json().then(function(j){return {s:r.status,j:j};});});}
function putMarker(lat,lng,zoom){
if(!map)return;
if(!marker){
marker=L.marker([lat,lng],{draggable:true,icon:L.divIcon({className:'',html:'<div class="pin"></div>',iconSize:[24,24],iconAnchor:[12,24]})}).addTo(map);
marker.on('dragend',function(){var p=marker.getLatLng();fromPoint(p.lat,p.lng);});
}else{marker.setLatLng([lat,lng]);}
map.setView([lat,lng],zoom||16);}
function fromPoint(lat,lng){
var my=++seq;
setSel({mode:'point',lat:lat,lng:lng,address:'Finding the address...',pending:true});
api('/place-map/reverse?token='+encodeURIComponent(token)+'&lat='+lat+'&lng='+lng).then(function(x){
if(my!==seq)return;
if(x.s===410){say('This link has expired. Tap Search place again in WhatsApp.',true);return;}
var a=(x.j&&x.j.ok&&x.j.address)?x.j.address:'Pinned location ('+lat.toFixed(5)+', '+lng.toFixed(5)+')';
setSel({mode:'point',lat:lat,lng:lng,address:a});})
.catch(function(){if(my===seq){setSel({mode:'point',lat:lat,lng:lng,address:'Pinned location ('+lat.toFixed(5)+', '+lng.toFixed(5)+')'});}});}
function useGps(){
if(!navigator.geolocation){say('This browser cannot share your location. Search for a place instead.',true);return;}
say('Getting your location...');
navigator.geolocation.getCurrentPosition(function(pos){
say('');var lat=pos.coords.latitude,lng=pos.coords.longitude;
putMarker(lat,lng,17);fromPoint(lat,lng);},
function(err){
var m=err.code===1?'Location access was blocked. Allow it in your browser settings, or search for a place above.'
:(err.code===2?'Your location is not available right now. Search for a place above.'
:'Could not get your location in time. Tap Use my current location to try again, or search above.');
say(m,true);},
{enableHighAccuracy:true,timeout:15000,maximumAge:0});}
// ----- map
if(typeof L!=='undefined'){
map=L.map('map');
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
var c=info.c;if(c&&c.latitude!=null){map.setView([c.latitude,c.longitude],12);}else{map.setView([20.5937,78.9629],5);}
map.on('click',function(e){putMarker(e.latlng.lat,e.latlng.lng,map.getZoom());fromPoint(e.latlng.lat,e.latlng.lng);});
}else{$('map').innerHTML='<p>The map could not load. You can still search for a place above and confirm it.</p>';}
// ----- search
function render(items){
$('list').innerHTML='';
items.forEach(function(it){
var li=document.createElement('li'),bt=document.createElement('button');
bt.type='button';bt.className='item';bt.innerHTML='<b>'+esc(it.main)+'</b>'+(it.secondary?'<span>'+esc(it.secondary)+'</span>':'');
bt.addEventListener('click',function(){choose(it);});li.appendChild(bt);$('list').appendChild(li);});}
function search(){
var v=$('q').value.trim(),my=++seq;
if(v.length<2){$('list').innerHTML='';say('');return;}
say('Searching...');
api('/place-map/suggest?token='+encodeURIComponent(token)+'&q='+encodeURIComponent(v)+'&st='+encodeURIComponent(st)).then(function(x){
if(my!==seq)return;
if(x.s===410){say('This link has expired. Tap Search place again in WhatsApp.',true);return;}
if(!x.j||!x.j.ok){$('list').innerHTML='';say('Search is not available right now. Tap the map to place the marker instead.',true);return;}
if(!x.j.suggestions.length){$('list').innerHTML='';say('No places found. Try another spelling or a nearby landmark.');return;}
say('');render(x.j.suggestions);}).catch(function(){if(my===seq){say('No connection. Please try again.',true);}});}
function choose(it){
$('list').innerHTML='';$('q').value=it.main;say('Loading the place...');seq++;
api('/place-map/place?token='+encodeURIComponent(token)+'&id='+encodeURIComponent(it.id)+'&st='+encodeURIComponent(st)).then(function(x){
if(!x.j||!x.j.ok){say('Could not load that place. Please pick another.',true);return;}
say('');putMarker(x.j.lat,x.j.lng,17);
setSel({mode:'place',placeId:it.id,lat:x.j.lat,lng:x.j.lng,address:x.j.name});}).catch(function(){say('No connection. Please try again.',true);});}
$('q').addEventListener('input',function(){clearTimeout(timer);timer=setTimeout(search,250);});
$('gps').addEventListener('click',useGps);
// ----- confirm
$('ok').addEventListener('click',function(){
if(!sel||busy||sel.pending)return;busy=true;$('ok').disabled=true;say('Saving your '+W+'...');
var body=sel.mode==='place'?{token:token,placeId:sel.placeId,st:st}:{token:token,lat:sel.lat,lng:sel.lng};
api('/place-map/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(x){
if(x.j&&x.j.ok){$('card').innerHTML='<div class="done"><div class="big">&#10003;</div><h1>Pickup saved</h1><p>'+esc(x.j.address||sel.address)+'</p><p>Go back to WhatsApp. We have sent the next step there.</p></div>';return;}
busy=false;$('ok').disabled=false;
say(x.s===409?'This step is already done. Go back to WhatsApp.':(x.s===410?'This link has expired. Tap Search place again in WhatsApp.':'Could not save that '+W+'. Please try again.'),true);})
.catch(function(){busy=false;$('ok').disabled=false;say('No connection. Please try again.',true);});});
if(params.get('mode')==='gps'){useGps();}else{$('q').focus();}
})();`;

const okInfo = (info) => info && Object.prototype.hasOwnProperty.call(KINDS, info.kind);
const okSession = (v) => typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v);
const okId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(v);

function parseNear(value) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value || '');
  return m ? { latitude: Number(m[1]), longitude: Number(m[2]) } : null;
}

function msgPage(title, text) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui,sans-serif;text-align:center;padding:40px"><h2>${title}</h2><p>${text}</p></body>`;
}

// This page loads the map library from unpkg and map pictures from OpenStreetMap, so it gets its own, still strict, policy.
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://unpkg.com",
  "img-src 'self' data: https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://unpkg.com",
  "connect-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function showPage(req, res) {
  res.set('Cache-Control', 'no-store');
  if (!okInfo(verifyToken(req.params.token))) {
    return res.status(410).type('html').send(msgPage('This link has expired', 'Go back to WhatsApp and tap Search place again.'));
  }
  res.set('Content-Security-Policy', PAGE_CSP);
  return res.type('html').send(PAGE);
}

function appJs(req, res) {
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript').send(APP_JS);
}

async function reverse(lat, lng) {
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  try {
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { latlng: `${lat},${lng}`, region: 'in', key },
      timeout: 6000,
    });
    return data?.status === 'OK' ? data?.results?.[0]?.formatted_address || null : null;
  } catch (err) {
    logger.warn({ err: err.message }, '[pickupMap] reverse geocoding failed');
    return null;
  }
}

async function details(placeId, st) {
  const { data } = await axios.get(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    params: { languageCode: 'en', ...(okSession(st) ? { sessionToken: st } : {}) },
    headers: { 'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY, 'X-Goog-FieldMask': 'id,displayName,formattedAddress,location' },
    timeout: 6000,
  });
  if (!data || !data.location) throw new Error('no location');
  const name = data.displayName?.text || data.formattedAddress || 'Selected place';
  const address = data.formattedAddress || name;
  const full = String(address).toLowerCase().includes(String(name).toLowerCase()) ? address : `${name}, ${address}`;
  return { name: full, address, lat: data.location.latitude, lng: data.location.longitude };
}

const validPoint = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/** GET /place-map/suggest?token=&q=&st=  — suggestions while typing (Google Places Autocomplete, New). */
async function suggest(req, res) {
  res.set('Cache-Control', 'no-store');
  const info = verifyToken(String(req.query.token || ''));
  if (!okInfo(info)) return res.status(410).json({ ok: false, error: 'expired' });
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q.length < 2) return res.json({ ok: true, suggestions: [] });
  if (!env.GOOGLE_MAPS_API_KEY) return res.status(503).json({ ok: false, error: 'not_configured' });

  const body = { input: q, includedRegionCodes: ['in'], languageCode: 'en' };
  if (okSession(req.query.st)) body.sessionToken = req.query.st;
  const center = info.near || parseNear(env.PLACE_SEARCH_NEAR);
  if (center) body.locationBias = { circle: { center: { latitude: Number(center.latitude), longitude: Number(center.longitude) }, radius: 50000 } };
  try {
    const { data } = await axios.post('https://places.googleapis.com/v1/places:autocomplete', body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat',
      },
      timeout: 6000,
    });
    const suggestions = (data?.suggestions || [])
      .map((s) => s.placePrediction)
      .filter((p) => p && p.placeId)
      .slice(0, 8)
      .map((p) => ({ id: p.placeId, main: p.structuredFormat?.mainText?.text || p.text?.text || '', secondary: p.structuredFormat?.secondaryText?.text || '' }));
    return res.json({ ok: true, suggestions });
  } catch (err) {
    logger.warn({ status: err.response?.status, err: err.response?.data?.error?.message || err.message }, '[pickupMap] autocomplete failed (is "Places API (New)" enabled for the key?)');
    return res.status(502).json({ ok: false, error: 'search_failed' });
  }
}

/** GET /place-map/place?token=&id=&st=  — where a suggestion is, so the marker can be shown. */
async function place(req, res) {
  res.set('Cache-Control', 'no-store');
  if (!okInfo(verifyToken(String(req.query.token || '')))) return res.status(410).json({ ok: false, error: 'expired' });
  if (!okId(req.query.id)) return res.status(400).json({ ok: false, error: 'bad_place' });
  try {
    const d = await details(req.query.id, req.query.st);
    return res.json({ ok: true, name: d.name, lat: d.lat, lng: d.lng });
  } catch (err) {
    logger.warn({ status: err.response?.status, err: err.response?.data?.error?.message || err.message }, '[pickupMap] details failed');
    return res.status(502).json({ ok: false, error: 'details_failed' });
  }
}

/** GET /place-map/reverse?token=&lat=&lng=  — a readable address for a map point (or GPS position). */
async function reverseHandler(req, res) {
  res.set('Cache-Control', 'no-store');
  if (!okInfo(verifyToken(String(req.query.token || '')))) return res.status(410).json({ ok: false, error: 'expired' });
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!validPoint(lat, lng)) return res.status(400).json({ ok: false, error: 'bad_point' });
  const address = await reverse(lat, lng);
  return res.json({ ok: true, address });
}

/** POST /place-map/confirm  { token, placeId? | lat, lng }  — saves the pickup and carries the booking on in WhatsApp. */
async function confirm(req, res) {
  const { token, placeId, lat, lng, st } = req.body || {};
  const info = verifyToken(token);
  if (!okInfo(info)) return res.status(410).json({ ok: false, error: 'expired' });

  const session = await getPrisma().whatsappSession.findUnique({ where: { whatsappNumber: info.number } });
  if (!session || session.state !== KINDS[info.kind]) return res.status(409).json({ ok: false, error: 'not_waiting' });

  let latitude;
  let longitude;
  let address;
  if (placeId !== undefined && placeId !== null && placeId !== '') {
    if (!okId(placeId)) return res.status(400).json({ ok: false, error: 'bad_place' });
    try {
      const d = await details(placeId, st);
      latitude = d.lat; longitude = d.lng; address = d.name;
    } catch (err) {
      logger.warn({ status: err.response?.status, err: err.response?.data?.error?.message || err.message }, '[pickupMap] details failed');
      return res.status(502).json({ ok: false, error: 'details_failed' });
    }
  } else {
    latitude = Number(lat);
    longitude = Number(lng);
    if (!validPoint(latitude, longitude)) return res.status(400).json({ ok: false, error: 'bad_point' });
    address = (await reverse(latitude, longitude)) || `Pinned location (${latitude.toFixed(5)}, ${longitude.toFixed(5)})`;
  }

  res.json({ ok: true, address });
  processInboundMessage(info.number, {
    id: `pickup-${crypto.randomUUID()}`, from: info.number, timestamp: null, type: 'location', text: null,
    interactiveId: null, interactiveTitle: null,
    location: { latitude, longitude, name: address, address },
  }).catch((err) => logger.error({ err: err.message }, '[pickupMap] could not continue the booking'));
}

module.exports = { KINDS, showPage, appJs, suggest, place, reverseHandler, confirm };
