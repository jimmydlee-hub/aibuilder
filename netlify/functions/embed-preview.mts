import type { Context } from '@netlify/functions'

// Fetches a visitor's EXISTING website server-side and injects the AI search
// bar + "Ask the agent" chat widget into it, then returns the combined HTML.
//
// This runs server-side on purpose: most real sites send X-Frame-Options /
// CSP frame-ancestors headers that forbid being shown in an <iframe>. By
// fetching the page here and re-serving it from our own origin (with those
// framing headers stripped), the builder can display the result in an iframe
// so the user sees exactly what the AI features look like on their own site.

const esc = (s: string) =>
  (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Block obvious SSRF targets (loopback, link-local, private ranges, cloud
// metadata). This is a best-effort guard for a demo tool, not a substitute
// for a hardened egress proxy.
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true
  if (h === '0.0.0.0' || h === '::1' || h === '169.254.169.254') return true
  if (/^127\./.test(h)) return true
  if (/^10\./.test(h)) return true
  if (/^192\.168\./.test(h)) return true
  if (/^169\.254\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h)) return true // unique local IPv6
  if (h.startsWith('fe80:')) return true // link-local IPv6
  return false
}

function errorPage(message: string): Response {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>body{margin:0;font-family:-apple-system,Segoe UI,Inter,Arial,sans-serif;background:#f7f9fc;color:#0f1622;display:grid;place-items:center;min-height:100vh}
.card{max-width:440px;text-align:center;background:#fff;border:1px solid #e6ebf2;border-radius:18px;padding:34px;box-shadow:0 10px 40px rgba(20,40,80,.08)}
.card h2{margin:0 0 8px;font-size:20px}.card p{color:#64748b;font-size:14px;line-height:1.6;margin:0}</style></head>
<body><div class="card"><h2>Couldn't load that site</h2><p>${esc(message)}</p></div></body></html>`
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

export default async (req: Request, _context: Context) => {
  const params = new URL(req.url).searchParams
  let target = (params.get('url') || '').trim()
  if (!target) return errorPage('No website address was provided.')
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target

  let targetUrl: URL
  try {
    targetUrl = new URL(target)
  } catch {
    return errorPage('That web address doesn’t look valid. Try something like example.com.')
  }
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return errorPage('Only http and https addresses are supported.')
  }
  if (isBlockedHost(targetUrl.hostname)) {
    return errorPage('That address can’t be loaded for security reasons.')
  }

  // Absolute URL to our own Claude function so the injected widget keeps
  // working even though we add a <base> tag pointing at the visitor's site.
  const claudeUrl = new URL('/.netlify/functions/claude', req.url).toString()

  // Agent / theme config carried over from the builder so the preview matches
  // what the user configured.
  const cfg = {
    name: (params.get('name') || 'Aria').slice(0, 60),
    emoji: (params.get('emoji') || '🤖').slice(0, 8),
    greeting: (params.get('greeting') || 'Hi! I’m here to help. Ask me anything.').slice(0, 400),
    system: (params.get('system') || '').slice(0, 8000),
    accent: (params.get('accent') || '#3aa0ff').slice(0, 32),
    accent2: (params.get('accent2') || '#6ee7ff').slice(0, 32),
    placeholder: (params.get('placeholder') || 'Ask anything…').slice(0, 120),
  }

  let html: string
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12000)
    const resp = await fetch(targetUrl.toString(), {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })
    clearTimeout(timer)
    const ctype = resp.headers.get('content-type') || ''
    if (!ctype.includes('html')) {
      return errorPage('That address didn’t return a web page we can preview.')
    }
    html = await resp.text()
  } catch (err: any) {
    if (err?.name === 'AbortError') return errorPage('That site took too long to respond.')
    return errorPage('We couldn’t reach that site. Double-check the address and that it’s publicly available.')
  }

  // Make relative assets/links resolve against the real site.
  const baseTag = `<base href="${esc(targetUrl.toString())}">`
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`)
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}</head>`)
  } else {
    html = baseTag + html
  }

  const widget = buildWidget(cfg, claudeUrl)
  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, widget + '</body>')
  } else {
    html += widget
  }

  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Allow this re-served page to be framed by the builder.
      'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': "frame-ancestors 'self'",
    },
  })
}

// Self-contained overlay (prefixed `nlai-` classes + inline style block) so it
// renders identically regardless of the host site's own CSS. This is also the
// exact same pair of features the builder offers: a floating AI ask bar and an
// "Ask the agent" chat widget.
function buildWidget(
  cfg: { name: string; emoji: string; greeting: string; system: string; accent: string; accent2: string; placeholder: string },
  claudeUrl: string,
): string {
  const j = (v: string) => JSON.stringify(v)
  return `
<style>
.nlai-root{--nlai-a:${esc(cfg.accent)};--nlai-b:${esc(cfg.accent2)};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Arial,sans-serif}
.nlai-bar{position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483000;width:min(560px,92vw);display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #e6ebf2;border-radius:16px;padding:7px 7px 7px 14px;box-shadow:0 16px 50px rgba(20,40,80,.18)}
.nlai-bar .ic{font-size:18px}
.nlai-bar input{flex:1;border:none;outline:none;font-size:15px;background:transparent;padding:8px 0;color:#0f1622}
.nlai-bar button{background:linear-gradient(135deg,var(--nlai-a),var(--nlai-b));color:#04121f;border:none;border-radius:11px;padding:10px 16px;font-weight:800;font-size:14px;cursor:pointer}
.nlai-ans{position:fixed;left:50%;top:74px;transform:translateX(-50%);z-index:2147483000;width:min(560px,92vw);background:#fff;border:1px solid #e6ebf2;border-radius:14px;padding:14px 16px;box-shadow:0 16px 50px rgba(20,40,80,.18);font-size:14px;line-height:1.55;color:#0f1622;display:none;max-height:50vh;overflow:auto}
.nlai-ans.show{display:block}
.nlai-ans .rh{font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:7px;display:flex;align-items:center;gap:8px}
.nlai-ans .bg{color:var(--nlai-a);border:1px solid color-mix(in srgb,var(--nlai-a) 35%,transparent);border-radius:6px;padding:1px 7px;font-weight:700}
.nlai-ans .x{margin-left:auto;background:none;border:none;font-size:17px;color:#94a3b8;cursor:pointer;line-height:1}
.nlai-fab{position:fixed;right:20px;bottom:20px;z-index:2147483000;background:linear-gradient(135deg,var(--nlai-a),var(--nlai-b));color:#04121f;border:none;border-radius:999px;padding:13px 18px;font-weight:800;font-size:14px;cursor:pointer;box-shadow:0 12px 36px color-mix(in srgb,var(--nlai-a) 45%,transparent);display:flex;gap:8px;align-items:center}
.nlai-panel{position:fixed;right:20px;bottom:78px;z-index:2147483000;width:340px;max-width:calc(100vw - 40px);height:460px;max-height:70vh;background:#fff;border:1px solid #e6ebf2;border-radius:18px;box-shadow:0 24px 70px rgba(10,30,60,.28);display:none;flex-direction:column;overflow:hidden}
.nlai-panel.show{display:flex}
.nlai-head{padding:13px 15px;border-bottom:1px solid #e6ebf2;display:flex;align-items:center;gap:10px}
.nlai-head .av{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--nlai-a),var(--nlai-b));display:grid;place-items:center;font-size:17px}
.nlai-head b{font-size:14px;color:#0f1622}.nlai-head .on{font-size:11.5px;color:#16a34a}
.nlai-head .x{margin-left:auto;background:none;border:none;font-size:20px;color:#94a3b8;cursor:pointer}
.nlai-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:9px;background:#f7f9fc}
.nlai-msg{max-width:82%;padding:9px 12px;border-radius:13px;font-size:13.5px;line-height:1.5}
.nlai-msg.bot{background:#fff;border:1px solid #e6ebf2;align-self:flex-start;border-bottom-left-radius:4px;color:#0f1622}
.nlai-msg.me{background:#0f1622;color:#fff;align-self:flex-end;border-bottom-right-radius:4px}
.nlai-credit{text-align:center;font-size:11px;color:#64748b;padding:6px;border-top:1px solid #e6ebf2;background:#f7f9fc}
.nlai-credit b{color:#0f1622}
.nlai-input{display:flex;gap:7px;padding:11px;border-top:1px solid #e6ebf2}
.nlai-input input{flex:1;border:1px solid #e6ebf2;border-radius:10px;padding:9px 11px;font-size:13.5px;outline:none;color:#0f1622}
.nlai-input button{background:var(--nlai-a);color:#04121f;border:none;border-radius:10px;padding:0 15px;font-weight:800;cursor:pointer}
</style>
<div class="nlai-root">
  <div class="nlai-bar">
    <span class="ic">✨</span>
    <input id="nlaiSearch" placeholder="${esc(cfg.placeholder)}">
    <button onclick="nlaiSearch()">Search</button>
  </div>
  <div class="nlai-ans" id="nlaiAns"><div class="rh">✨ AI answer <span class="bg">Powered by Claude</span><button class="x" onclick="document.getElementById('nlaiAns').classList.remove('show')">×</button></div><div id="nlaiAnsBody"></div></div>
  <button class="nlai-fab" onclick="nlaiToggle()">💬 Ask ${esc(cfg.name)}</button>
  <div class="nlai-panel" id="nlaiPanel">
    <div class="nlai-head"><div class="av">${esc(cfg.emoji)}</div><div><b>${esc(cfg.name)}</b><div class="on">● online</div></div><button class="x" onclick="nlaiToggle()">×</button></div>
    <div class="nlai-msgs" id="nlaiMsgs"></div>
    <div class="nlai-credit">✨ Powered by <b>Claude</b></div>
    <div class="nlai-input"><input id="nlaiInput" placeholder="Type a message…" onkeydown="if(event.key==='Enter')nlaiSend()"><button onclick="nlaiSend()">→</button></div>
  </div>
</div>
<script>
(function(){
  var CLAUDE=${j(claudeUrl)}, SYS=${j(cfg.system)}, GREET=${j(cfg.greeting)};
  function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function id(x){return document.getElementById(x);}
  id('nlaiMsgs').innerHTML='<div class="nlai-msg bot">'+esc(GREET)+'</div>';
  async function callAI(p){
    try{
      var r=await fetch(CLAUDE,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:p,system:SYS})});
      if(!r.ok) throw 0;
      var d=await r.json();
      return esc(d.answer||'').replace(/\\n/g,'<br>');
    }catch(e){ return 'The assistant is unavailable right now — please try again in a moment.'; }
  }
  window.nlaiSearch=async function(){
    var s=id('nlaiSearch'), q=(s.value||'').trim(); if(!q) return;
    var box=id('nlaiAns'); box.classList.add('show'); id('nlaiAnsBody').innerHTML='<span style="opacity:.6">✨ thinking…</span>';
    id('nlaiAnsBody').innerHTML=await callAI(q);
  };
  id('nlaiSearch').addEventListener('keydown',function(e){ if(e.key==='Enter') window.nlaiSearch(); });
  window.nlaiToggle=function(){ id('nlaiPanel').classList.toggle('show'); };
  window.nlaiSend=async function(){
    var i=id('nlaiInput'), t=(i.value||'').trim(); if(!t) return;
    var m=id('nlaiMsgs');
    m.insertAdjacentHTML('beforeend','<div class="nlai-msg me">'+esc(t)+'</div>'); i.value='';
    m.insertAdjacentHTML('beforeend','<div class="nlai-msg bot" id="nlaiTyping">…</div>'); m.scrollTop=m.scrollHeight;
    var r=await callAI(t); var typ=id('nlaiTyping'); if(typ) typ.remove();
    m.insertAdjacentHTML('beforeend','<div class="nlai-msg bot">'+r+'</div>'); m.scrollTop=m.scrollHeight;
  };
})();
<\/script>`
}
