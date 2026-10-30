const crypto = require('crypto');
const axios = require('axios');
const env = require('../config/env');
const { verifyToken } = require('../utils/calendarLink');
const { getPrisma } = require('../config/db');
const { processInboundMessage } = require('../conversation/stateMachine');
const { STATES } = require('../conversation/states');
const { logger } = require('../config/logger');

/**
 * "Choose your ride" page, opened from a button in WhatsApp:
 *   - a Pickup field and a Drop field (like Uber), with suggestions that show the distance in km
 *   - "Use my current location" for the pickup, and a Map button to place a pin by tapping the map
 *   - one Confirm button: pickup and drop are saved together and the booking carries on in WhatsApp
 * Google (autocomplete, place details, reverse geocoding) is called only from the server, so no Google key
 * reaches the browser. Map pictures come from OpenStreetMap; the map library is checked with an integrity hash.
 */
const KIND = 'routemap';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Choose your ride | ABHI CABS</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="__CSS_SRI__" crossorigin="">
<style>
:root{--bg:#f3f6f4;--card:#ffffff;--text:#16241d;--muted:#5b6b63;--line:#d9e2dc;--accent:#0f5d4a;--on:#ffffff;--tile:#eef3f0;--danger:#b42318;--green:#1a9e5c;--orange:#f08a24}
@media (prefers-color-scheme: dark){:root{--bg:#101815;--card:#18221e;--text:#e8f0ec;--muted:#9bb0a5;--line:#2b3a33;--accent:#3fbf9b;--on:#07201a;--tile:#202c27;--danger:#ff8a80}}
*{box-sizing:border-box}[hidden]{display:none!important}html,body{margin:0}
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;justify-content:center;padding:10px}
.card{width:100%;max-width:560px;background:var(--card);border-radius:16px;padding:14px;border:1px solid var(--line)}
h1{font-size:18px;margin:0 0 10px;font-weight:600}
.route{display:flex;gap:10px;align-items:stretch}
.dots{display:flex;flex-direction:column;align-items:center;padding:16px 0;gap:4px}
.dots i{width:12px;height:12px;border-radius:50%;display:block}.dots .g{background:var(--green)}.dots .o{background:var(--orange)}
.dots .line{width:2px;flex:1;background:var(--line);border-radius:1px}
.fields{flex:1;display:flex;flex-direction:column;gap:8px}
.fields input{width:100%;height:46px;border-radius:10px;border:2px solid transparent;background:var(--tile);color:var(--text);font-size:16px;padding:0 12px}
.fields input.on{border-color:var(--text);background:var(--card)}
.stoprow{display:flex;gap:6px}.stoprow input{flex:1;min-width:0}.stoprow .x{width:44px;flex:none;border-radius:10px;border:1px solid var(--line);background:var(--tile);color:var(--text);font-size:20px;cursor:pointer}
.tools{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.tools button{height:40px;border-radius:20px;border:1px solid var(--line);background:var(--tile);color:var(--text);font-size:14px;padding:0 14px;cursor:pointer}
#list{list-style:none;margin:6px 0 0;padding:0}
.item{display:flex;gap:12px;align-items:flex-start;width:100%;text-align:left;border:0;border-bottom:1px dashed var(--line);background:transparent;color:var(--text);padding:11px 4px;cursor:pointer;font:inherit}
.item .km{width:44px;flex:none;text-align:center;color:var(--muted);font-size:12px;line-height:1.2}
.item .km b{display:block;font-size:18px;color:var(--text)}
.item .nm b{display:block;font-weight:600;font-size:15px}.item .nm span{display:block;color:var(--muted);font-size:13px;margin-top:2px}
#mapwrap{margin-top:10px}
#map{width:100%;height:46vh;min-height:260px;border-radius:12px;background:var(--tile);border:1px solid var(--line)}
#maphint{color:var(--muted);font-size:13px;margin-top:6px}
.pin{width:24px;height:24px;border:3px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 2px 6px rgba(0,0,0,.4)}
#sum{margin-top:10px;color:var(--muted);font-size:14px;min-height:18px}
.gm{display:inline-block;margin-top:8px;color:var(--accent);font-weight:600;text-decoration:underline}
#hourlyhint{margin:12px 0 0;padding:10px 12px;border-radius:10px;background:var(--tile);color:var(--text);font-size:14px;line-height:1.45}
#ok{width:100%;height:52px;margin-top:8px;border:0;border-radius:12px;background:var(--accent);color:var(--on);font-size:16px;font-weight:600;cursor:pointer}
#ok:disabled{opacity:.45;cursor:default}#msg{font-size:14px;color:var(--muted);min-height:20px;margin-top:8px}.err{color:var(--danger)!important}
.done{text-align:center;padding:24px 6px}.done .big{font-size:46px;color:var(--accent)}.done .row{margin:8px 0;font-size:15px}
.done a{display:inline-block;margin-top:12px;padding:12px 22px;border-radius:12px;background:var(--accent);color:var(--on);font-weight:600;text-decoration:none}
</style></head><body>
<main class="card" id="card" data-wa="__WA__">
<h1 id="title">Choose your ride</h1>
<div class="route">
<div class="dots"><i class="g"></i><i class="line"></i><i class="o" id="odot"></i></div>
<div class="fields" id="fields"><input id="fp" class="on" placeholder="Pickup location" autocomplete="off" aria-label="Pickup location"><input id="fd" placeholder="Where to?" autocomplete="off" aria-label="Drop location"></div>
</div>
<div class="tools"><button type="button" id="gps">Use my current location</button><button type="button" id="mapbtn">Map</button><button type="button" id="addstop">+ Add stop</button></div>
<ul id="list"></ul>
<div id="mapwrap" hidden><div id="map" role="application" aria-label="Map"></div><div id="maphint">Tap the map, or drag the pin, to set this place.</div></div>
<div id="msg" role="status"></div>
<div id="sum"></div>
<a id="gmap" class="gm" href="#" target="_blank" rel="noopener" hidden>View route in Google Maps</a>
<p id="hourlyhint" hidden>This is for an hourly rental: one pickup, no drop. For a trip from one place to another (for example Hebbal to Rajajinagar), go back to WhatsApp and choose One Way.</p>
<button type="button" id="ok" disabled>Confirm pickup and drop</button>
</main>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="__JS_SRI__" crossorigin=""></script>
<script src="/route-map/app.js"></script>
</body></html>`
  .replace('__CSS_SRI__', 'sha384-sHL9NAb7lN7rfvG5lfHpm643Xkcjzp4jFvuavGOndn6pjVqS6ny56CAt3nsEVT4H').replace('__JS_SRI__', 'sha384-cxOPjt7s7Iz04uaHJceBmS+qpjv2JkIHNVcuOrM+YHwZOmJGBXI00mdUXEq65HTH');

const APP_JS = `(function(){
var token=location.pathname.split('/').pop();
var info;try{var b=token.split('.')[0].replace(/-/g,'+').replace(/_/g,'/');info=JSON.parse(decodeURIComponent(escape(atob(b))));}catch(e){info=null;}
function $(id){return document.getElementById(id);}
if(!info){$('card').innerHTML='<p>This link is not valid. Go back to WhatsApp and tap the button again.</p>';return;}
var hourly=!!(info.x&&info.x.hourly);
if(hourly){$('hourlyhint').hidden=false;$('fd').style.display='none';$('odot').style.display='none';$('addstop').style.display='none';$('title').textContent='Choose your pickup';$('ok').textContent='Confirm pickup';$('fp').placeholder='Pickup location';}
var st=(self.crypto&&crypto.randomUUID)?crypto.randomUUID():String(Date.now())+Math.random().toString(16).slice(2);
var sel={pickup:null,drop:null,stop1:null,stop2:null},active='pickup',gps=null,map=null,marker=null,mapOpen=false,seq=0,timer=null,busy=false;
var inputs={pickup:$('fp'),drop:$('fd')};
var STOPS=['stop1','stop2'];
function say(t,err){$('msg').textContent=t||'';$('msg').className=err?'err':'';}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function api(path,opts){return fetch(path,opts).then(function(r){return r.json().then(function(j){return {s:r.status,j:j};});});}
function hav(a,b){var R=6371,r=Math.PI/180,dl=(b.lat-a.lat)*r,dn=(b.lng-a.lng)*r,h=Math.sin(dl/2)*Math.sin(dl/2)+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin(dn/2)*Math.sin(dn/2);return R*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h));}
function chain(){var c=[sel.pickup];STOPS.forEach(function(k){if(inputs[k])c.push(sel[k]);});c.push(sel.drop);return c;}
function prevOf(k){
if(k==='pickup')return null;
var order=['pickup'].concat(STOPS.filter(function(x){return inputs[x];})).concat(['drop']);
var i=order.indexOf(k);
for(var j=i-1;j>=0;j--){if(sel[order[j]])return sel[order[j]];}
return null;}
function origin(){
var pv=prevOf(active);if(pv)return pv;
if(gps)return gps;
if(sel.pickup)return sel.pickup;
var c=info.c;return c&&c.latitude!=null?{lat:c.latitude,lng:c.longitude}:null;}
function refresh(){
var pend=Object.keys(sel).some(function(k){return sel[k]&&sel[k].pending;});
var stopsOk=STOPS.every(function(k){return !inputs[k]||sel[k];});
var ready=sel.pickup&&(hourly||sel.drop)&&stopsOk&&!pend;
$('ok').disabled=!ready;
var pts=chain();
var gm=$('gmap');
if(info&&info.x&&info.x.gm&&!hourly&&pts.length>=2&&pts.every(function(x){return x&&!x.pending;})){
var ll=function(x){return x.lat+','+x.lng;};
var mid=pts.slice(1,-1).map(ll).join('%7C');
gm.href='https://www.google.com/maps/dir/?api=1&origin='+ll(pts[0])+'&destination='+ll(pts[pts.length-1])+(mid?'&waypoints='+mid:'')+'&travelmode=driving';
gm.hidden=false;}else{gm.hidden=true;}
if(pts.every(function(x){return x;})&&pts.length>=2&&!pend){var tot=0;for(var q=0;q<pts.length-1;q++){tot+=hav(pts[q],pts[q+1]);}$('sum').textContent='About '+(Math.round(tot*10)/10)+' km in a straight line. The fare uses the road distance.';}else{$('sum').textContent='';}}
function setActive(k){active=k;Object.keys(inputs).forEach(function(n){inputs[n].className=n===k?'on':'';});$('list').innerHTML='';if(mapOpen&&marker&&sel[k]){moveMarker(sel[k].lat,sel[k].lng,16);}}
function ensureMap(){
if(map||typeof L==='undefined')return;
map=L.map('map');
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
var c=origin();if(c){map.setView([c.lat,c.lng],13);}else{map.setView([20.5937,78.9629],5);}
map.on('click',function(e){fromPoint(active,e.latlng.lat,e.latlng.lng);});}
function moveMarker(lat,lng,zoom){
if(!map)return;
var color=active==='drop'?'#f08a24':(active==='pickup'?'#1a9e5c':'#6b7280');
if(!marker){marker=L.marker([lat,lng],{draggable:true,icon:L.divIcon({className:'',html:'<div class="pin" style="background:'+color+'"></div>',iconSize:[24,24],iconAnchor:[12,24]})}).addTo(map);
marker.on('dragend',function(){var p=marker.getLatLng();fromPoint(active,p.lat,p.lng);});}
else{marker.setLatLng([lat,lng]);marker.setIcon(L.divIcon({className:'',html:'<div class="pin" style="background:'+color+'"></div>',iconSize:[24,24],iconAnchor:[12,24]}));}
map.setView([lat,lng],zoom||16);}
function fromPoint(k,lat,lng){
var my=++seq;
sel[k]={mode:'point',lat:lat,lng:lng,address:'Finding the address...',pending:true};
inputs[k].value='Finding the address...';moveMarker(lat,lng,map?map.getZoom():16);refresh();
api('/route-map/reverse?token='+encodeURIComponent(token)+'&lat='+lat+'&lng='+lng).then(function(x){
if(my!==seq)return;
if(x.s===410){say('This link has expired. Tap the button again in WhatsApp.',true);return;}
var a=(x.j&&x.j.ok&&x.j.address)?x.j.address:'Pinned location ('+lat.toFixed(5)+', '+lng.toFixed(5)+')';
sel[k]={mode:'point',lat:lat,lng:lng,address:a};inputs[k].value=a;refresh();})
.catch(function(){if(my===seq){var a='Pinned location ('+lat.toFixed(5)+', '+lng.toFixed(5)+')';sel[k]={mode:'point',lat:lat,lng:lng,address:a};inputs[k].value=a;refresh();}});}
function useGps(){
if(!navigator.geolocation){say('This browser cannot share your location. Search for a place instead.',true);return;}
say('Getting your location...');
var done=false;
// After 5 seconds, say it can be typed instead, so nobody is left staring at the spinner.
var slow=setTimeout(function(){if(!done)say('Still looking for your location... you can also type your pickup place.');},5000);
function ok(pos){
if(done)return;done=true;clearTimeout(slow);
say('');gps={lat:pos.coords.latitude,lng:pos.coords.longitude};
active='pickup';setActive('pickup');
if(mapOpen){ensureMap();}
fromPoint('pickup',gps.lat,gps.lng);
// A quick fix from Wi-Fi and mobile masts can be a few hundred metres out: say so, and the Map button fixes it.
if(pos.coords.accuracy>1500){say('Your location is approximate. Tap Map to move the pin to the exact place.');}
if(!hourly){setTimeout(function(){inputs.drop.focus();},50);}}
function fail(err){
if(done)return;done=true;clearTimeout(slow);
say(err.code===1?'Location access was blocked. Allow it in your browser settings, or type your pickup place.':(err.code===2?'Your location is not available right now. Type your pickup place.':'Could not get your location in time. Try again, or type your pickup place.'),true);}
// 1) The fast way first: Wi-Fi and mobile masts, and a reading up to 10 minutes old is fine. This answers in a second or two and
//    still works indoors and with the phone in battery saving mode.
navigator.geolocation.getCurrentPosition(ok,function(e1){
if(done)return;
if(e1.code===1){fail(e1);return;} // blocked by the person: asking again will not help
// 2) The precise way (satellites), a little longer.
navigator.geolocation.getCurrentPosition(ok,fail,{enableHighAccuracy:true,timeout:20000,maximumAge:0});
},{enableHighAccuracy:false,timeout:8000,maximumAge:600000});}
function renderList(items){
$('list').innerHTML='';
items.forEach(function(it){
var li=document.createElement('li'),bt=document.createElement('button');
bt.type='button';bt.className='item';
var km=it.km!=null?'<b>'+(it.km>=10?Math.round(it.km):it.km)+'</b>km':'';
bt.innerHTML='<div class="km">'+km+'</div><div class="nm"><b>'+esc(it.main)+'</b>'+(it.secondary?'<span>'+esc(it.secondary)+'</span>':'')+'</div>';
bt.addEventListener('click',function(){choose(it);});li.appendChild(bt);$('list').appendChild(li);});}
function search(){
var k=active,v=inputs[k].value.trim(),my=++seq;
if(v.length<2){$('list').innerHTML='';say('');return;}
var o=origin(),oq=o?'&olat='+o.lat+'&olng='+o.lng:'';
say('Searching...');
api('/route-map/suggest?token='+encodeURIComponent(token)+'&q='+encodeURIComponent(v)+'&st='+encodeURIComponent(st)+oq).then(function(x){
if(my!==seq)return;
if(x.s===410){say('This link has expired. Tap the button again in WhatsApp.',true);return;}
if(!x.j||!x.j.ok){$('list').innerHTML='';say('Search is not available right now. Use the Map button to place the pin.',true);return;}
if(!x.j.suggestions.length){$('list').innerHTML='';say('No places found. Try another spelling or a nearby landmark.');return;}
say('');renderList(x.j.suggestions);}).catch(function(){if(my===seq){say('No connection. Please try again.',true);}});}
function choose(it){
var k=active;$('list').innerHTML='';seq++;say('Loading the place...');
api('/route-map/place?token='+encodeURIComponent(token)+'&id='+encodeURIComponent(it.id)+'&st='+encodeURIComponent(st)).then(function(x){
if(!x.j||!x.j.ok){say('Could not load that place. Please pick another.',true);return;}
say('');sel[k]={mode:'place',placeId:it.id,lat:x.j.lat,lng:x.j.lng,address:x.j.name};inputs[k].value=it.main;
if(mapOpen){ensureMap();moveMarker(x.j.lat,x.j.lng,16);}
refresh();
if(!hourly){var order=['pickup'].concat(STOPS.filter(function(x){return inputs[x];})).concat(['drop']);var nx=order.slice(order.indexOf(k)+1).filter(function(z){return !sel[z];})[0];if(nx){setActive(nx);inputs[nx].focus();}}}).catch(function(){say('No connection. Please try again.',true);});}
function wire(k){
inputs[k].addEventListener('focus',function(){setActive(k);});
inputs[k].addEventListener('input',function(){sel[k]=null;refresh();clearTimeout(timer);timer=setTimeout(search,250);});}
function addStop(){
var k=STOPS.filter(function(x){return !inputs[x];})[0];
if(!k){say('You can add up to 2 stops.');return;}
var row=document.createElement('div');row.className='stoprow';row.id='row_'+k;
var inp=document.createElement('input');inp.id='f_'+k;inp.placeholder=k==='stop1'?'Stop 1':'Stop 2';inp.autocomplete='off';inp.setAttribute('aria-label',inp.placeholder);
var x=document.createElement('button');x.type='button';x.className='x';x.textContent='\u00d7';x.setAttribute('aria-label','Remove '+inp.placeholder);
row.appendChild(inp);row.appendChild(x);$('fields').insertBefore(row,$('fd'));
inputs[k]=inp;sel[k]=null;wire(k);
x.addEventListener('click',function(){delete inputs[k];sel[k]=null;row.remove();setActive('drop');refresh();});
inp.focus();refresh();}
$('addstop').addEventListener('click',addStop);
inputs.pickup.addEventListener('focus',function(){setActive('pickup');});
inputs.drop.addEventListener('focus',function(){setActive('drop');});
['pickup','drop'].forEach(function(k){inputs[k].addEventListener('input',function(){sel[k]=null;refresh();clearTimeout(timer);timer=setTimeout(search,250);});});
$('gps').addEventListener('click',useGps);
$('mapbtn').addEventListener('click',function(){
mapOpen=!mapOpen;$('mapwrap').hidden=!mapOpen;$('list').innerHTML='';
if(mapOpen){
if(typeof L==='undefined'){say('The map could not load. You can still search for a place.',true);mapOpen=false;$('mapwrap').hidden=true;return;}
ensureMap();setTimeout(function(){map.invalidateSize();},50);
var s=sel[active];if(s){moveMarker(s.lat,s.lng,16);}}});
function spec(s){return s.mode==='place'?{placeId:s.placeId}:{lat:s.lat,lng:s.lng};}
$('ok').addEventListener('click',function(){
if(busy||$('ok').disabled)return;busy=true;$('ok').disabled=true;say('Saving...');
var body={token:token,st:st,pickup:spec(sel.pickup),drop:hourly?null:spec(sel.drop),stops:hourly?[]:STOPS.filter(function(k){return inputs[k];}).map(function(k){return spec(sel[k]);})};
api('/route-map/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(x){
if(x.j&&x.j.ok){var card=$('card'),wa=card.getAttribute('data-wa')||'';
card.innerHTML='<div class="done"><div class="big">&#10003;</div><h1>'+(hourly?'Pickup saved':'Pickup and drop saved')+'</h1><div class="row"><b>Pickup:</b> '+esc(x.j.pickup||'')+'</div>'+(x.j.stops||[]).map(function(a,i){return '<div class="row"><b>Stop '+(i+1)+':</b> '+esc(a)+'</div>';}).join('')+(x.j.drop?'<div class="row"><b>Drop:</b> '+esc(x.j.drop)+'</div>':'')+'<p>Your booking is moving on in WhatsApp.</p>'+(wa?'<a href="'+wa+'">Back to WhatsApp</a>':'<p>You can close this page.</p>')+'</div>';return;}
busy=false;$('ok').disabled=false;
say(x.s===409?'This step is already done. Go back to WhatsApp.':(x.s===410?'This link has expired. Tap the button again in WhatsApp.':'Could not save that. Please try again.'),true);})
.catch(function(){busy=false;$('ok').disabled=false;say('No connection. Please try again.',true);});});
if(info&&info.x&&info.x.pk&&!hourly){var pk=info.x.pk;sel.pickup={mode:'point',lat:pk.lat,lng:pk.lng,address:pk.address};inputs.pickup.value=pk.address;setActive('drop');refresh();inputs.drop.focus();}else{inputs.pickup.focus();}
if(info&&info.x&&info.x.q){var qk=(info.x.qk==='drop'&&inputs.drop&&!hourly)?'drop':'pickup';inputs[qk].value=String(info.x.q);setActive(qk);inputs[qk].dispatchEvent(new Event('input'));}
})();`;

const okInfo = (info) => info && info.kind === KIND;
const okSession = (v) => typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v);
const okId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(v);
const validPoint = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

function parseNear(value) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value || '');
  return m ? { latitude: Number(m[1]), longitude: Number(m[2]) } : null;
}

function msgPage(title, text) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui,sans-serif;text-align:center;padding:40px"><h2>${title}</h2><p>${text}</p></body>`;
}

// The page loads the map library from unpkg and map pictures from OpenStreetMap, so it gets its own, still strict, policy.
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
    return res.status(410).type('html').send(msgPage('This link has expired', 'Go back to WhatsApp and tap the button again.'));
  }
  const digits = String(env.MSG91_INTEGRATED_NUMBER || '').replace(/\D/g, '');
  res.set('Content-Security-Policy', PAGE_CSP);
  return res.type('html').send(PAGE.replace('__WA__', digits ? `https://wa.me/${digits}` : ''));
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
    logger.warn({ err: err.message }, '[routeMap] reverse geocoding failed');
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
  return { name: full, lat: data.location.latitude, lng: data.location.longitude };
}

/** GET /route-map/suggest?token=&q=&st=&olat=&olng=  — suggestions while typing, each with its distance (km) from the origin. */
async function suggest(req, res) {
  res.set('Cache-Control', 'no-store');
  const info = verifyToken(String(req.query.token || ''));
  if (!okInfo(info)) return res.status(410).json({ ok: false, error: 'expired' });
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q.length < 2) return res.json({ ok: true, suggestions: [] });
  if (!env.GOOGLE_MAPS_API_KEY) return res.status(503).json({ ok: false, error: 'not_configured' });

  const body = { input: q, includedRegionCodes: ['in'], languageCode: 'en' };
  if (okSession(req.query.st)) body.sessionToken = req.query.st;
  const olat = Number(req.query.olat);
  const olng = Number(req.query.olng);
  const origin = validPoint(olat, olng) && req.query.olat !== undefined ? { latitude: olat, longitude: olng } : null;
  if (origin) body.origin = origin;
  const center = origin || info.near || parseNear(env.PLACE_SEARCH_NEAR);
  if (center) body.locationBias = { circle: { center: { latitude: Number(center.latitude), longitude: Number(center.longitude) }, radius: 50000 } };
  try {
    const { data } = await axios.post('https://places.googleapis.com/v1/places:autocomplete', body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.distanceMeters',
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
        km: p.distanceMeters != null ? Math.round(p.distanceMeters / 100) / 10 : null,
      }));
    return res.json({ ok: true, suggestions });
  } catch (err) {
    logger.warn({ status: err.response?.status, err: err.response?.data?.error?.message || err.message }, '[routeMap] autocomplete failed (is "Places API (New)" enabled for the key?)');
    return res.status(502).json({ ok: false, error: 'search_failed' });
  }
}

/** GET /route-map/place?token=&id=&st=  — where a suggestion is. */
async function place(req, res) {
  res.set('Cache-Control', 'no-store');
  if (!okInfo(verifyToken(String(req.query.token || '')))) return res.status(410).json({ ok: false, error: 'expired' });
  if (!okId(req.query.id)) return res.status(400).json({ ok: false, error: 'bad_place' });
  try {
    const d = await details(req.query.id, req.query.st);
    return res.json({ ok: true, name: d.name, lat: d.lat, lng: d.lng });
  } catch (err) {
    logger.warn({ status: err.response?.status, err: err.response?.data?.error?.message || err.message }, '[routeMap] details failed');
    return res.status(502).json({ ok: false, error: 'details_failed' });
  }
}

/** GET /route-map/reverse?token=&lat=&lng=  — a readable address for a map point or GPS position. */
async function reverseHandler(req, res) {
  res.set('Cache-Control', 'no-store');
  if (!okInfo(verifyToken(String(req.query.token || '')))) return res.status(410).json({ ok: false, error: 'expired' });
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!validPoint(lat, lng)) return res.status(400).json({ ok: false, error: 'bad_point' });
  return res.json({ ok: true, address: await reverse(lat, lng) });
}

/** Turns { placeId } or { lat, lng } into { address, latitude, longitude }, or throws. */
async function resolveSpec(spec, st) {
  if (spec && spec.placeId !== undefined && spec.placeId !== null && spec.placeId !== '') {
    if (!okId(spec.placeId)) { const e = new Error('bad_place'); e.code = 400; throw e; }
    const d = await details(spec.placeId, st);
    return { address: d.name, latitude: d.lat, longitude: d.lng };
  }
  const lat = Number(spec && spec.lat);
  const lng = Number(spec && spec.lng);
  if (!validPoint(lat, lng)) { const e = new Error('bad_point'); e.code = 400; throw e; }
  return { address: (await reverse(lat, lng)) || `Pinned location (${lat.toFixed(5)}, ${lng.toFixed(5)})`, latitude: lat, longitude: lng };
}

/** POST /route-map/confirm  { token, st, pickup, drop }  — saves pickup and drop together; the booking carries on in WhatsApp. */
async function confirm(req, res) {
  const { token, st, pickup, drop, stops } = req.body || {};
  const info = verifyToken(token);
  if (!okInfo(info)) return res.status(410).json({ ok: false, error: 'expired' });
  const hourly = !!(info.extra && info.extra.hourly);
  if (!pickup || (!hourly && !drop)) return res.status(400).json({ ok: false, error: 'missing_place' });
  const stopSpecs = hourly ? [] : (Array.isArray(stops) ? stops : []);
  if (stopSpecs.length > 2) return res.status(400).json({ ok: false, error: 'too_many_stops' });

  const session = await getPrisma().whatsappSession.findUnique({ where: { whatsappNumber: info.number } });
  if (!session || (session.state !== STATES.BOOKING_PICKUP && session.state !== STATES.BOOKING_DROP)) return res.status(409).json({ ok: false, error: 'not_waiting' });

  let p;
  let d = null;
  let stopList = [];
  try {
    [p, d, ...stopList] = await Promise.all([
      resolveSpec(pickup, st),
      hourly ? Promise.resolve(null) : resolveSpec(drop, st),
      ...stopSpecs.map((x) => resolveSpec(x, st)),
    ]);
  } catch (err) {
    if (err.code === 400) return res.status(400).json({ ok: false, error: err.message });
    logger.warn({ status: err.response?.status, err: err.response?.data?.error?.message || err.message }, '[routeMap] could not resolve a place');
    return res.status(502).json({ ok: false, error: 'details_failed' });
  }

  // The stops travel inside the drop, so they are saved with the booking and used for the fare.
  const dropWithStops = d ? { ...d, ...(stopList.length ? { stops: stopList } : {}) } : null;
  res.json({ ok: true, pickup: p.address, drop: d ? d.address : null, stops: stopList.map((x) => x.address) });
  processInboundMessage(info.number, {
    id: `route-${crypto.randomUUID()}`, from: info.number, timestamp: null, type: 'route', text: null,
    interactiveId: null, interactiveTitle: null, location: null, route: { pickup: p, drop: dropWithStops },
  }).catch((err) => logger.error({ err: err.message }, '[routeMap] could not continue the booking'));
}

module.exports = { KIND, showPage, appJs, suggest, place, reverseHandler, confirm };
