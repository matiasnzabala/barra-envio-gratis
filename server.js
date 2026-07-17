const express = require("express");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- CORS (widget.js y /config se llaman desde el dominio de la tienda) ----
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const {
  TN_CLIENT_ID,
  TN_CLIENT_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  APP_URL, // https://barra.hacecrecertutienda.com
  TRIAL_DIAS = "7",
  MP_PAYMENT_LINK = "",
  PORT = 3000,
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---------------- Helpers cookie firmada (mismo patrón que Ruleta/Aviso Stock) ----------------
function firmar(storeId) {
  const h = crypto.createHmac("sha256", TN_CLIENT_SECRET).update(String(storeId)).digest("hex");
  return `${storeId}.${h}`;
}
function verificarCookie(req, storeId) {
  const val = req.cookies?.tn_session;
  if (!val) return false;
  return val === firmar(storeId);
}

// ---------------- OAuth callback ----------------
app.get("/callback", async (req, res) => {
  try {
    const { code, store_id } = req.query;
    if (!code || !store_id) return res.status(400).send("Falta code o store_id");

    const tokenResp = await fetch("https://www.tiendanegocio.com/apps/authorize/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: TN_CLIENT_ID,
        client_secret: TN_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
      }),
    });
    const tokenData = await tokenResp.json();
    if (!tokenData.access_token) {
      console.error("Error token:", tokenData);
      return res.status(500).send("No se pudo autenticar con Tienda Negocio");
    }

    const storeId = String(tokenData.user_id || store_id);
    const trialEnds = new Date(Date.now() + Number(TRIAL_DIAS) * 24 * 60 * 60 * 1000).toISOString();

    const { data: existente } = await supabase
      .from("barra_tiendas")
      .select("store_id")
      .eq("store_id", storeId)
      .maybeSingle();

    if (!existente) {
      await supabase.from("barra_tiendas").insert({
        store_id: storeId,
        access_token: tokenData.access_token,
        trial_ends_at: trialEnds,
        pago: false,
      });
    } else {
      await supabase.from("barra_tiendas").update({ access_token: tokenData.access_token }).eq("store_id", storeId);
    }

    res.cookie("tn_session", firmar(storeId), {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 1000 * 60 * 60 * 24 * 30,
    });
    res.redirect(`/admin/${storeId}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error interno");
  }
});

// ---------------- Admin (sin storeId: redirige usando cookie, para "Aplicaciones integradas") ----------------
app.get("/admin", (req, res) => {
  const val = req.cookies?.tn_session;
  if (!val) return res.status(401).send("No autenticado. Entrá desde el panel de Tienda Negocio.");
  const storeId = val.split(".")[0];
  res.redirect(`/admin/${storeId}`);
});

app.get("/admin/:storeId", async (req, res) => {
  const { storeId } = req.params;
  if (!verificarCookie(req, storeId)) {
    return res.status(401).send("No autorizado. Entrá desde el panel de Tienda Negocio.");
  }
  const { data: tienda } = await supabase.from("barra_tiendas").select("*").eq("store_id", storeId).maybeSingle();
  if (!tienda) return res.status(404).send("Tienda no encontrada");
  res.send(renderAdminHtml(tienda));
});

// ---------------- Guardar config ----------------
app.post("/api/config/:storeId", async (req, res) => {
  const { storeId } = req.params;
  if (!verificarCookie(req, storeId)) return res.status(401).json({ error: "No autorizado" });

  const { umbral, texto_falta, texto_listo, color_barra, color_fondo, activo } = req.body;
  const { error } = await supabase
    .from("barra_tiendas")
    .update({
      umbral: Number(umbral),
      texto_falta,
      texto_listo,
      color_barra,
      color_fondo,
      activo: !!activo,
    })
    .eq("store_id", storeId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ---------------- Config pública para el widget (con chequeo de trial/pago) ----------------
app.get("/config", async (req, res) => {
  const { store_id } = req.query;
  if (!store_id) return res.status(400).json({ activo: false });

  const { data: tienda } = await supabase.from("barra_tiendas").select("*").eq("store_id", store_id).maybeSingle();
  if (!tienda) return res.json({ activo: false });

  const trialVigente = tienda.trial_ends_at && new Date(tienda.trial_ends_at) > new Date();
  const habilitado = tienda.activo && (tienda.pago || trialVigente);

  if (!habilitado) return res.json({ activo: false });

  res.json({
    activo: true,
    umbral: Number(tienda.umbral || 50000),
    texto_falta: tienda.texto_falta || "¡Te faltan {monto} para tu ENVÍO GRATIS! 🚚",
    texto_listo: tienda.texto_listo || "¡Felicitaciones! Tenés ENVÍO GRATIS 🎉",
    color_barra: tienda.color_barra || "#E8A33D",
    color_fondo: tienda.color_fondo || "#12201B",
  });
});

// ---------------- widget.js ----------------
app.get("/widget.js", (req, res) => {
  res.type("application/javascript");
  res.send(WIDGET_JS(APP_URL));
});

app.get("/", (req, res) => res.send("Barra de Envío Gratis — OK"));

app.listen(PORT, () => console.log(`Barra Envío Gratis escuchando en ${PORT}`));

// ================= HTML admin =================
function renderAdminHtml(t) {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<title>Barra de Envío Gratis</title>
<style>
  :root{--bg:#12201B;--amber:#E8A33D;--coral:#E8632C;--text:#F2EDE4}
  body{background:var(--bg);color:var(--text);font-family:'Public Sans',sans-serif;padding:32px;max-width:560px;margin:0 auto}
  h1{font-family:'Fraunces',serif;font-weight:600}
  label{display:block;margin-top:16px;font-size:14px;opacity:.85}
  input[type=text],input[type=number]{width:100%;padding:10px;border-radius:8px;border:1px solid #3a4a41;background:#1a2a22;color:var(--text);margin-top:4px;box-sizing:border-box}
  input[type=color]{margin-top:4px}
  button{margin-top:24px;background:var(--amber);color:#12201B;border:none;padding:12px 20px;border-radius:8px;font-weight:700;cursor:pointer}
  .toast{display:none;margin-top:12px;color:#7CD992}
</style></head>
<body>
<h1>🚚 Barra de Envío Gratis</h1>
<form id="f">
  <label>Monto para envío gratis ($)
    <input type="number" name="umbral" value="${t.umbral || 50000}">
  </label>
  <label>Texto cuando falta (usá {monto})
    <input type="text" name="texto_falta" value="${(t.texto_falta || "¡Te faltan {monto} para tu ENVÍO GRATIS! 🚚").replace(/"/g,'&quot;')}">
  </label>
  <label>Texto cuando se alcanza
    <input type="text" name="texto_listo" value="${(t.texto_listo || "¡Felicitaciones! Tenés ENVÍO GRATIS 🎉").replace(/"/g,'&quot;')}">
  </label>
  <label>Color barra <input type="color" name="color_barra" value="${t.color_barra || "#E8A33D"}"></label>
  <label>Color fondo <input type="color" name="color_fondo" value="${t.color_fondo || "#12201B"}"></label>
  <label><input type="checkbox" name="activo" ${t.activo !== false ? "checked" : ""} style="width:auto;display:inline"> Activo</label>
  <button type="submit">Guardar</button>
  <div class="toast" id="toast">Guardado ✅</div>
</form>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  body.activo = fd.get('activo') === 'on';
  const r = await fetch('/api/config/${t.store_id}', {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  if (r.ok) { document.getElementById('toast').style.display='block'; setTimeout(()=>document.getElementById('toast').style.display='none',2000); }
});
</script>
</body></html>`;
}

// ================= widget.js (client side, corre en la tienda) =================
function WIDGET_JS(APP_URL) {
  return `(function(){
  var API = "${APP_URL}";
  var storeId = (window.LS && window.LS.store && window.LS.store.id) || window.__TN_STORE_ID__ || document.querySelector('[data-store-id]')?.dataset.storeId;
  if(!storeId){ console.warn('[BarraEnvioGratis] no se encontró store_id'); return; }

  var cfg = null;
  var barEl = null;

  fetch(API + "/config?store_id=" + storeId).then(r=>r.json()).then(function(c){
    if(!c.activo) return;
    cfg = c;
    montarBarra();
    actualizar();
    // Observar cambios en el carrito (agregar/quitar productos actualiza el DOM via AJAX)
    var obs = new MutationObserver(function(){ actualizar(); });
    obs.observe(document.body, {childList:true, subtree:true, characterData:true});
    setInterval(actualizar, 4000); // fallback por si el MutationObserver no detecta el cambio
  }).catch(function(e){ console.warn('[BarraEnvioGratis]', e); });

  function montarBarra(){
    barEl = document.createElement('div');
    barEl.id = 'barra-envio-gratis';
    barEl.style.cssText = 'position:sticky;top:0;z-index:9999;padding:10px 16px;font-family:sans-serif;font-size:14px;text-align:center;background:' + cfg.color_fondo + ';color:#fff;';
    barEl.innerHTML = '<div id="beg-texto" style="margin-bottom:6px;font-weight:600"></div>' +
      '<div style="background:rgba(255,255,255,.2);border-radius:6px;height:8px;overflow:hidden;max-width:420px;margin:0 auto">' +
      '<div id="beg-fill" style="height:100%;width:0%;background:' + cfg.color_barra + ';transition:width .4s ease"></div></div>';
    document.body.prepend(barEl);
  }

  function obtenerTotalCarrito(){
    // Estrategia 1: API JS del tema (si existe)
    try {
      if (window.LS && window.LS.cart && typeof window.LS.cart.total !== 'undefined') {
        return Number(window.LS.cart.total);
      }
    } catch(e){}
    // Estrategia 2: buscar en el DOM un total de carrito conocido
    var selectores = ['[data-cart-total]','.cart-total','.js-cart-total','#CartTotal','.cart__total','[data-total-carrito]'];
    for (var i=0;i<selectores.length;i++){
      var el = document.querySelector(selectores[i]);
      if (el){
        var n = parsearMonto(el.textContent);
        if (n !== null) return n;
      }
    }
    // Estrategia 3: buscar cualquier elemento con la palabra "Total" cerca de un $ (fallback débil)
    var candidatos = Array.from(document.querySelectorAll('body *')).filter(function(el){
      return el.children.length === 0 && /total/i.test(el.textContent) === false && /\\$\\s?[\\d.,]+/.test(el.textContent);
    });
    return null; // sin dato confiable, no mostramos barra en este fallback
  }

  function parsearMonto(txt){
    if(!txt) return null;
    var m = txt.replace(/[^0-9.,]/g,'').replace(/\\./g,'').replace(',', '.');
    var n = parseFloat(m);
    return isNaN(n) ? null : n;
  }

  function actualizar(){
    if(!cfg || !barEl) return;
    var total = obtenerTotalCarrito();
    if (total === null) { barEl.style.display = 'none'; return; }
    barEl.style.display = 'block';
    var pct = Math.min(100, (total / cfg.umbral) * 100);
    var fill = document.getElementById('beg-fill');
    var texto = document.getElementById('beg-texto');
    if (fill) fill.style.width = pct + '%';
    if (texto){
      if (total >= cfg.umbral) {
        texto.textContent = cfg.texto_listo;
      } else {
        var falta = (cfg.umbral - total).toLocaleString('es-AR', {style:'currency', currency:'ARS', maximumFractionDigits:0});
        texto.textContent = cfg.texto_falta.replace('{monto}', falta);
      }
    }
  }
})();`;
}
