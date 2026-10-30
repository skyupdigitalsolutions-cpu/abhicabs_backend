const crypto = require('crypto');
const { verifyToken } = require('../utils/calendarLink');
const { getPrisma } = require('../config/db');
const { processInboundMessage } = require('../conversation/stateMachine');
const { STATES } = require('../conversation/states');
const { logger } = require('../config/logger');
const env = require('../config/env');
const dateParser = require('../conversation/nlu/dateParser');

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Pick a date | ABHI CABS</title>
<style>
:root{--bg:#f3f6f4;--card:#ffffff;--text:#16241d;--muted:#5b6b63;--line:#d9e2dc;--accent:#0f5d4a;--on:#ffffff;--tile:#eef3f0;--danger:#b42318;--ok:#0f5d4a}
@media (prefers-color-scheme: dark){:root{--bg:#101815;--card:#18221e;--text:#e8f0ec;--muted:#9bb0a5;--line:#2b3a33;--accent:#3fbf9b;--on:#07201a;--tile:#202c27;--danger:#ff8a80;--ok:#3fbf9b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh;display:flex;justify-content:center;padding:16px}
.card{width:100%;max-width:420px;background:var(--card);border-radius:16px;padding:18px;border:1px solid var(--line);align-self:flex-start}
h1{font-size:18px;margin:0 0 2px;font-weight:600}.sub{color:var(--muted);font-size:14px;margin:0 0 14px}
.nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.nav button{width:44px;height:44px;border-radius:50%;border:1px solid var(--line);background:var(--tile);color:var(--text);font-size:20px;cursor:pointer}
.nav button:disabled{opacity:.35;cursor:default}.month{font-size:17px;font-weight:600}
.dow,.grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}.dow{color:var(--muted);font-size:13px;text-align:center;margin-bottom:6px}
.grid button{height:46px;border-radius:10px;border:1px solid var(--line);background:var(--tile);color:var(--text);font-size:16px;cursor:pointer}
.grid button:disabled{background:transparent;border-color:transparent;color:var(--muted);opacity:.5;cursor:default}
.grid button.today{border-color:var(--text);font-weight:600}.grid button.sel{background:var(--accent);color:var(--on);border-color:var(--accent);font-weight:600}
.sel-row{border-top:1px solid var(--line);margin-top:14px;padding-top:12px}.lbl{color:var(--muted);font-size:13px}.val{font-size:17px;font-weight:600;min-height:24px}
select{height:46px;border-radius:10px;border:1px solid var(--line);background:var(--tile);color:var(--text);font-size:16px;padding:0 10px;min-width:0;flex:1}.trow{display:flex;gap:8px;margin-top:6px}#nowbtn{height:46px;border-radius:10px;border:1px solid var(--line);background:var(--tile);color:var(--text);font-size:15px;padding:0 14px;cursor:pointer}#nowbtn:disabled{opacity:.4;cursor:default}
#ok{width:100%;height:50px;margin-top:12px;border:0;border-radius:12px;background:var(--accent);color:var(--on);font-size:16px;font-weight:600;cursor:pointer}
#ok:disabled{opacity:.45;cursor:default}#msg{font-size:14px;min-height:20px;margin-top:8px}.err{color:var(--danger)}.done{text-align:center;padding:24px 8px}.done .big{font-size:44px;color:var(--ok)}
</style></head><body>
<main class="card" id="card" data-wa="__WA__">
<h1>Pick date and time</h1><p class="sub" id="now"></p>
<div id="app">
<div class="nav"><button id="prev" aria-label="Previous month">&#8249;</button><div class="month" id="month" aria-live="polite"></div><button id="next" aria-label="Next month">&#8250;</button></div>
<div class="dow"><div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div></div>
<div class="grid" id="grid"></div>
<div class="sel-row"><div class="lbl">Selected date</div><div class="val" id="sel">Tap a date</div></div>
<div class="sel-row" id="timebox"><div class="lbl">Pickup time (India time)</div>
<div class="trow"><select id="hh" aria-label="Hour"></select><select id="mm" aria-label="Minute"></select><select id="ap" aria-label="AM or PM"><option>AM</option><option>PM</option></select><button type="button" id="nowbtn">Now</button></div></div>
<button id="ok" disabled>Confirm date and time</button><div id="msg" role="status"></div>
</div>
</main>
<script src="/calendar/app.js"></script>
</body></html>`;

const APP_JS = `(function(){
var MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
var DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
var token=location.pathname.split('/').pop();
var info;try{var b=token.split('.')[0].replace(/-/g,'+').replace(/_/g,'/');info=JSON.parse(decodeURIComponent(escape(atob(b))));}catch(e){info=null;}
var msg=document.getElementById('msg');
if(!info){document.getElementById('app').innerHTML='<p>This link is not valid. Go back to WhatsApp and tap the date step again.</p>';return;}
function parse(s){var p=s.split('-');return new Date(+p[0],+p[1]-1,+p[2]);}
function iso(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function long(d){return DAYS[d.getDay()]+', '+d.getDate()+' '+MONTHS[d.getMonth()]+' '+d.getFullYear();}
function pad(n){return String(n).padStart(2,'0');}
// India time, whatever the phone's own clock or time zone says
function ist(){var f=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date()),o={};f.forEach(function(p){o[p.type]=p.value;});return {date:o.year+'-'+o.month+'-'+o.day,mins:(+o.hour%24)*60+(+o.minute)};}
var min=parse(info.a),max=parse(info.b);
var y=min.getFullYear(),m=min.getMonth(),sel=null;
var first=y*12+m,last=max.getFullYear()*12+max.getMonth();
var hh=document.getElementById('hh'),mm=document.getElementById('mm'),ap=document.getElementById('ap');
for(var h=1;h<=12;h++){var o=document.createElement('option');o.value=h;o.textContent=h;hh.appendChild(o);}
for(var n=0;n<60;n++){var o2=document.createElement('option');o2.value=n;o2.textContent=pad(n);mm.appendChild(o2);}
function setTime(mins){var h24=Math.floor(mins/60)%24,mi=mins%60;ap.value=h24<12?'AM':'PM';hh.value=h24%12||12;mm.value=mi;}
function chosenMins(){var h=+hh.value%12;if(ap.value==='PM')h+=12;return h*60+(+mm.value);}
function nowText(){var t=ist(),h=Math.floor(t.mins/60),mi=t.mins%60;return 'Now: '+long(parse(t.date))+', '+(h%12||12)+':'+pad(mi)+' '+(h<12?'AM':'PM')+' (IST)';}
function tick(){document.getElementById('now').textContent=nowText();}
tick();setInterval(tick,30000);
setTime(Math.min(ist().mins+5,23*60+59));
var grid=document.getElementById('grid');
function problem(){
if(!sel)return 'Tap a date first.';
var t=ist();
if(sel===t.date&&chosenMins()<=t.mins)return 'That time has already passed. Choose a later time or tap Now.';
return '';}
function refresh(){
document.getElementById('nowbtn').disabled=!(sel&&sel===ist().date);
var p=problem();
document.getElementById('ok').disabled=!!p;
if(sel&&p){msg.className='err';msg.textContent=p;}else{msg.className='';msg.textContent='';}}
function render(){
document.getElementById('month').textContent=MONTHS[m]+' '+y;
document.getElementById('prev').disabled=y*12+m<=first;document.getElementById('next').disabled=y*12+m>=last;
grid.innerHTML='';
var lead=new Date(y,m,1).getDay(),count=new Date(y,m+1,0).getDate();
for(var i=0;i<lead;i++){grid.appendChild(document.createElement('div'));}
var todayIso=ist().date;
for(var d=1;d<=count;d++){
var dt=new Date(y,m,d),k=iso(dt),btn=document.createElement('button');
btn.textContent=d;btn.setAttribute('data-k',k);btn.setAttribute('aria-label',long(dt));
if(dt<min||dt>max){btn.disabled=true;}
if(k===todayIso){btn.className='today';}
if(sel===k){btn.className=(btn.className+' sel').trim();btn.setAttribute('aria-pressed','true');}
grid.appendChild(btn);}
document.getElementById('sel').textContent=sel?long(parse(sel)):'Tap a date';
refresh();}
grid.addEventListener('click',function(e){var b=e.target.closest('button');if(!b||b.disabled)return;sel=b.getAttribute('data-k');render();});
document.getElementById('prev').addEventListener('click',function(){m--;if(m<0){m=11;y--;}render();});
document.getElementById('next').addEventListener('click',function(){m++;if(m>11){m=0;y++;}render();});
[hh,mm,ap].forEach(function(el){el.addEventListener('change',refresh);});
document.getElementById('nowbtn').addEventListener('click',function(){setTime(Math.min(ist().mins+1,23*60+59));refresh();});
document.getElementById('ok').addEventListener('click',function(){
var p=problem();if(p){msg.className='err';msg.textContent=p;return;}
var ok=document.getElementById('ok'),c=chosenMins(),time=pad(Math.floor(c/60))+':'+pad(c%60);
ok.disabled=true;msg.className='';msg.textContent='Saving...';
fetch('/calendar/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token,date:sel,time:time})})
.then(function(r){return r.json().then(function(j){return {s:r.status,j:j};});})
.then(function(x){
if(x.j&&x.j.ok){var card=document.getElementById('card'),wa=card.getAttribute('data-wa')||'';card.innerHTML='<div class="done"><div class="big">&#10003;</div><h1>Date and time saved</h1><p class="sub">'+long(parse(sel))+', '+(Math.floor(c/60)%12||12)+':'+pad(c%60)+' '+(Math.floor(c/60)<12?'AM':'PM')+'</p><p>Your booking is moving on in WhatsApp.</p>'+(wa?'<p><a href="'+wa+'" style="display:inline-block;padding:12px 22px;border-radius:12px;background:var(--accent);color:var(--on);font-weight:600;text-decoration:none">Back to WhatsApp</a></p>':'<p>You can close this page.</p>')+'</div>';return;}
msg.className='err';msg.textContent=x.s===409?'This step is already done. Go back to WhatsApp.':(x.s===410?'This link has expired. Tap the date step again in WhatsApp.':(x.j&&x.j.error==='time_passed'?'That time has already passed. Choose a later time.':'Could not save that. Try again.'));ok.disabled=false;})
.catch(function(){msg.className='err';msg.textContent='No connection. Try again.';ok.disabled=false;});});
render();
})();`;

function msgPage(title, text) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui,sans-serif;text-align:center;padding:40px"><h2>${title}</h2><p>${text}</p></body>`;
}

function showCalendar(req, res) {
  res.set('Cache-Control', 'no-store');
  const info = verifyToken(req.params.token);
  if (!info || info.kind !== 'date') {
    return res.status(410).type('html').send(msgPage('This link has expired', 'Go back to WhatsApp and tap the date step again.'));
  }
  const digits = String(env.MSG91_INTEGRATED_NUMBER || '').replace(/\D/g, '');
  return res.type('html').send(PAGE.replace('__WA__', digits ? `https://wa.me/${digits}` : ''));
}

function appJs(req, res) {
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript').send(APP_JS);
}

/** POST /calendar/select  { token, date: 'YYYY-MM-DD', time?: 'HH:MM' }  — hands the chosen date (and time) to the bot as if it were tapped in WhatsApp. */
async function selectDate(req, res) {
  const { token, date, time } = req.body || {};
  const info = verifyToken(token);
  if (!info || info.kind !== 'date') return res.status(410).json({ ok: false, error: 'expired' });
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < info.min || date > info.max) {
    return res.status(400).json({ ok: false, error: 'bad_date' });
  }

  let hhmm = null;
  if (time !== undefined && time !== null && time !== '') {
    if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return res.status(400).json({ ok: false, error: 'bad_time' });
    // Today's time must still be ahead (India time).
    const now = dateParser.now();
    if (date === now.format('YYYY-MM-DD') && time <= now.format('HH:mm')) return res.status(400).json({ ok: false, error: 'time_passed' });
    hhmm = time.replace(':', '');
  }

  const session = await getPrisma().whatsappSession.findUnique({ where: { whatsappNumber: info.number } });
  const waiting = info.returnTrip ? STATES.BOOKING_RETURN_DATE : STATES.BOOKING_DATE;
  if (!session || session.state !== waiting) return res.status(409).json({ ok: false, error: 'not_waiting' });

  res.json({ ok: true });
  const startedAt = Date.now();
  processInboundMessage(info.number, {
    id: `cal-${crypto.randomUUID()}`, from: info.number, timestamp: null, type: 'flow',
    text: null, interactiveId: `FLOWDATE_${date}${hhmm ? `_${hhmm}` : ''}`, interactiveTitle: date, location: null,
  })
    .then(() => {
      // Timing: from the customer's Confirm to the last reply sent (vehicles list included).
      const ms = Date.now() - startedAt;
      logger.info({ ms }, ms >= 3000 ? '[perf] SLOW booking step after calendar confirm' : '[perf] booking step after calendar confirm');
    })
    .catch((err) => logger.error({ err: err.message }, '[calendar] could not continue the booking'));
}

module.exports = { showCalendar, appJs, selectDate };
