/**
 * Robust script.js — dynamic loader + diagnostics
 * - Tries multiple CDNs for tfjs and coco-ssd
 * - Detailed console logging with step IDs
 * - Shows friendly messages in UI and provides Retry button on model load failure
 * - Keeps main detection+TTS logic simple and intact
 *
 * Replace your existing script.js with this and reload page.
 */

const TFJS_CANDIDATES = [
  "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@3.9.0/dist/tf.min.js",
  "https://unpkg.com/@tensorflow/tfjs@3.9.0/dist/tf.min.js"
];
const COCO_CANDIDATES = [
  "https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd",
  "https://unpkg.com/@tensorflow-models/coco-ssd@2.2.2"
];

const canvas = document.getElementById("cameraCanvas");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const sceneTextEl = document.getElementById("sceneText");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const muteBtn = document.getElementById("muteBtn");
const voiceCmdBtn = document.getElementById("voiceCmdBtn");

const langSelect = document.getElementById("langSelect");
const modelSelect = document.getElementById("modelSelect");
const voicePitchEl = document.getElementById("voicePitch");

/* ---------- NEW: Stat elements (Last Message / FPS / Confidence) ---------- */
const lastMsgEl = document.getElementById("lastMsg");
const fpsEl     = document.getElementById("fpsVal");
const confEl    = document.getElementById("confVal");
const modelNameEl = document.getElementById("modelName");

// Safe fallback logs if elements missing
if (!lastMsgEl || !fpsEl || !confEl) {
  console.warn("One or more stat elements not found: lastMsg/fpsVal/confVal. Check HTML IDs.");
}

/* ---------- FPS smoothing helpers ---------- */
let lastFrameTime = performance.now();
let fpsSmoothed = 0.0;
const FPS_ALPHA = 0.12; // smoothing factor (lower = smoother)

/* helper to update UI stat values */
function updateStats({ message = "—", fps = null, confidence = null } = {}) {
  if (lastMsgEl) lastMsgEl.textContent = message;
  if (fpsEl) fpsEl.textContent = fps === null ? "—" : `${Math.round(fps)} fps`;
  if (confEl) confEl.textContent = confidence === null ? "—" : `${Math.round(confidence * 100)}%`;
}

/* Small UI: add Retry button dynamically when model load fails */
let retryBtn = null;
function showRetryModelButton() {
  if (retryBtn) return;
  retryBtn = document.createElement("button");
  retryBtn.textContent = "Retry Model";
  retryBtn.className = "btn";
  retryBtn.style.marginLeft = "10px";
  retryBtn.addEventListener("click", () => {
    retryBtn.disabled = true;
    retryBtn.textContent = "Retrying...";
    loadTfAndModel().then(() => {
      retryBtn.remove();
      retryBtn = null;
    }).catch(() => {
      retryBtn.disabled = false;
      retryBtn.textContent = "Retry Model";
    });
  });
  // attach near status
  statusEl.parentNode.insertBefore(retryBtn, statusEl.nextSibling);
}

/* State */
let model = null;
let tfLoaded = false;
let cocoLoaded = false;
let video = null;
let detecting = false;
let muted = false;
let rafId = null;

/* Throttle & config */
const FRAME_SKIP = 3;
let frameCounter = 0;
const COOLDOWN_MS = 2500;
let lastMessage = "";
let lastMessageTime = 0;
const MIN_SCORE = 0.6;
const DIST_THRESH = { veryClose: 0.08, close: 0.02 };

/* Small scaffolding */
const SCAFFOLD = {
  "en-US": { started: "Started detection.", stopped: "Stopped detection.", seeNone: "I don't see any recognizable objects right now.", onYour: "on your", left: "left", right: "right", center: "center", veryClose: "very close", close: "close", far: "far", help: "Try: start, stop, mute, unmute, scene, summary, help." },
  "hi-IN": { started: "डिटेक्शन शुरू हुआ।", stopped: "डिटेक्शन बंद।", seeNone: "अभी कोई पहचानने योग्य वस्तु नहीं दिख रही।", onYour: "आपके", left: "बाएँ", right: "दाएँ", center: "बीच में", veryClose: "बहुत पास", close: "पास", far: "दूर", help: "कहें: start, stop, mute, unmute, scene, summary, help." },
  "mr-IN": { started: "डिटेक्शन सुरू.", stopped: "डिटेक्शन बंद.", seeNone: "सध्या ओळखण्यासारखी वस्तू दिसत नाही.", onYour: "आपल्या", left: "डावीकडे", right: "उजवीकडे", center: "मध्यभागी", veryClose: "खूप जवळ", close: "जवळ", far: "दूर", help: "कृपया म्हणा: start, stop, mute, unmute, scene, summary, help." }
};

function t(key) { const l = langSelect.value || "en-US"; return (SCAFFOLD[l] && SCAFFOLD[l][key]) || SCAFFOLD["en-US"][key]; }

/* --- Dynamic loader helpers --- */
function loadScriptUrl(url) {
  return new Promise((resolve, reject) => {
    console.log("[loader] adding script", url);
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.onload = () => { console.log(`[loader] loaded ${url}`); resolve(url); };
    s.onerror = (e) => { console.error(`[loader] failed to load ${url}`, e); reject(new Error(`Failed to load ${url}`)); };
    document.head.appendChild(s);
  });
}

/* Try load TFJS from candidates one by one */
async function ensureTfjs() {
  if (tfLoaded) { console.log("[loader] tf already loaded"); return; }
  const errors = [];
  for (const u of TFJS_CANDIDATES) {
    try {
      await loadScriptUrl(u);
      // quick presence test
      if (window.tf) {
        tfLoaded = true;
        console.log("[loader] tf present after loading", u);
        return;
      } else {
        console.warn("[loader] script loaded but window.tf not present for", u);
        errors.push(`No window.tf after loading ${u}`);
      }
    } catch (err) {
      console.warn("[loader] tf attempt failed:", u, err);
      errors.push(err.message || String(err));
    }
  }
  throw new Error("tfjs load failed: " + errors.join(" | "));
}

/* Try load coco-ssd (note: coco-ssd is a module that registers itself when loaded) */
async function ensureCoco() {
  if (cocoLoaded && window.cocoSsd) { console.log("[loader] coco present"); return; }
  const errors = [];
  for (const u of COCO_CANDIDATES) {
    try {
      await loadScriptUrl(u);
      // Wait a tick for the module to register
      await new Promise(r => setTimeout(r, 300));
      if (window.cocoSsd && typeof window.cocoSsd.load === "function") {
        cocoLoaded = true;
        console.log("[loader] coco-ssd present after loading", u);
        return;
      } else {
        console.warn("[loader] script loaded but window.cocoSsd not present for", u);
        errors.push(`No window.cocoSsd after loading ${u}`);
      }
    } catch (err) {
      console.warn("[loader] coco attempt failed:", u, err);
      errors.push(err.message || String(err));
    }
  }
  throw new Error("coco-ssd load failed: " + errors.join(" | "));
}

/* Full load sequence */
async function loadTfAndModel() {
  statusEl.textContent = "Loading tfjs + model (please wait)...";
  console.group("[loader] starting load sequence");
  try {
    await ensureTfjs();
    console.log("[loader] tfjs ready:", !!window.tf);
  } catch (err) {
    console.error("[loader] tfjs error:", err);
    statusEl.textContent = `Failed to load tfjs: ${err.message}. Check console.`;
    showRetryModelButton();
    console.groupEnd();
    throw err;
  }

  try {
    await ensureCoco();
    console.log("[loader] coco-ssd available:", !!window.cocoSsd);
  } catch (err) {
    console.error("[loader] coco-ssd error:", err);
    statusEl.textContent = `Failed to load coco-ssd: ${err.message}. Check console.`;
    showRetryModelButton();
    console.groupEnd();
    throw err;
  }

  // Load the actual model via cocoSsd.load with chosen base
  try {
    const choice = modelSelect.value === "lite" ? { base: "lite_mobilenet_v2" } : { base: "mobilenet_v2" };
    statusEl.textContent = "Downloading model weights (this can take a few seconds)...";
    console.log("[loader] calling cocoSsd.load with", choice);
    model = await window.cocoSsd.load(choice);
    statusEl.textContent = "Model loaded. Click Start.";
    // Update model name UI if available
    if (modelNameEl) modelNameEl.textContent = modelSelect.value;
    console.log("[loader] cocoSsd model loaded:", model);
    console.groupEnd();
    return model;
  } catch (err) {
    console.error("[loader] cocoSsd.load failed:", err);
    statusEl.textContent = `Model load failed: ${err.message}. Check console (network/CORS).`;
    showRetryModelButton();
    console.groupEnd();
    throw err;
  }
}

/* --- Camera setup (same as before but with clear logs) --- */
async function setupCamera() {
  try {
    video = document.createElement("video");
    video.setAttribute("playsinline", "");
    statusEl.textContent = "Requesting camera permission...";
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    video.srcObject = stream;
    await video.play();
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    statusEl.textContent = "Camera ready.";
    console.log("[camera] stream started", stream);
    return video;
  } catch (err) {
    console.error("[camera] getUserMedia failed:", err);
    if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
      statusEl.textContent = "Camera permission denied. Allow camera in site settings, then refresh.";
    } else if (err && (err.name === "NotFoundError" || err.name === "OverconstrainedError")) {
      statusEl.textContent = "No camera found or constraints unsatisfiable. Try connecting a camera.";
    } else {
      statusEl.textContent = `Camera error: ${err.message || err}. See console.`;
    }
    throw err;
  }
}

/* --- Basic detection logic (keeps top-object speak) --- */
function computeGuidance(bbox) {
  const [x,y,w,h] = bbox;
  const cx = x + w/2;
  const cxRatio = cx / canvas.width;
  let dir = "center";
  if (cxRatio < 0.33) dir = "left"; else if (cxRatio > 0.66) dir = "right";
  const frameArea = canvas.width * canvas.height;
  const areaRatio = (w*h) / frameArea;
  let dist = "far";
  if (areaRatio >= DIST_THRESH.veryClose) dist = "veryClose";
  else if (areaRatio >= DIST_THRESH.close) dist = "close";
  return { dir, dist, areaRatio };
}
function drawLabel(text,x,y){
  ctx.font = "16px sans-serif";
  const pad = 6;
  const m = ctx.measureText(text);
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(x-2, y-22, m.width + pad*2, 22);
  ctx.fillStyle = "#9AE6B4";
  ctx.fillText(text, x+pad, y-6);
}
function drawArrow(ctx,x,y,size,dir){
  ctx.beginPath();
  if (dir==="left"){ ctx.moveTo(x+size/2,y-size/2); ctx.lineTo(x-size/2,y); ctx.lineTo(x+size/2,y+size/2); ctx.closePath(); }
  else if (dir==="right"){ ctx.moveTo(x-size/2,y-size/2); ctx.lineTo(x+size/2,y); ctx.lineTo(x-size/2,y+size/2); ctx.closePath(); }
  else { ctx.moveTo(x,y-size/2); ctx.lineTo(x-size/2,y+size/2); ctx.lineTo(x+size/2,y+size/2); ctx.closePath(); }
  ctx.fill();
}
function drawAR(dir,dist){
  const cw = canvas.width, ch = canvas.height, y = ch - 64, size = 36;
  let color = "#10b981"; if (dist==="close") color = "#f59e0b"; if (dist==="veryClose") color = "#ef4444";
  ctx.save(); ctx.globalAlpha = 0.95;
  ctx.fillStyle = (dir==="left") ? color : "rgba(255,255,255,0.12)"; drawArrow(ctx, cw*0.18, y, size, "left");
  ctx.fillStyle = (dir==="center") ? color : "rgba(255,255,255,0.12)"; drawArrow(ctx, cw*0.5, y, size, "up");
  ctx.fillStyle = (dir==="right") ? color : "rgba(255,255,255,0.12)"; drawArrow(ctx, cw*0.82, y, size, "right");
  ctx.restore();
}

/* speak helper */
function speak(text) {
  if (!text || muted) return;
  const now = Date.now();
  if (text === lastMessage && now - lastMessageTime < COOLDOWN_MS) return;
  if (window.speechSynthesis.speaking) window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = langSelect.value || "en-US";
  u.pitch = parseFloat(voicePitchEl.value) || 1;
  window.speechSynthesis.speak(u);
  lastMessage = text;
  lastMessageTime = now;
  statusEl.textContent = `Last: ${text}`;
  // update Last Message UI immediately
  updateStats({ message: text });
}

/* detection loop */
async function detectLoop() {
  if (!detecting) return;
  frameCounter = (frameCounter + 1) % FRAME_SKIP;
  if (frameCounter !== 0) { rafId = requestAnimationFrame(detectLoop); return; }

  try {
    const preds = await model.detect(video);
    // compute FPS instantaneous & smooth it
    const nowTime = performance.now();
    const dt = nowTime - lastFrameTime;
    lastFrameTime = nowTime;
    const instFPS = dt > 0 ? 1000 / dt : 0;
    fpsSmoothed = fpsSmoothed ? (fpsSmoothed * (1 - FPS_ALPHA) + instFPS * FPS_ALPHA) : instFPS;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const good = preds.filter(p => p.score >= MIN_SCORE);
    good.forEach(p => {
      const [x,y,w,h] = p.bbox;
      ctx.strokeStyle = "#34d399";
      ctx.lineWidth = 2;
      ctx.strokeRect(x,y,w,h);
      drawLabel(`${p.class} ${(p.score*100).toFixed(0)}%`, x, y);
    });

    let top = null;
    for (const p of good) {
      const g = computeGuidance(p.bbox);
      if (!top || g.areaRatio > top.areaRatio) {
        top = { p, g };
        top.areaRatio = g.areaRatio;
      }
    }

    if (top) {
      const sentence = (langSelect.value === "en-US")
        ? `${top.p.class} on your ${top.g.dir}, ${top.g.dist === "veryClose" ? "very close" : top.g.dist === "close" ? "close" : "far"}.`
        : `${top.p.class} ${t("onYour")} ${top.g.dir}, ${top.g.dist}.`;

      sceneTextEl.textContent = sentence;
      drawAR(top.g.dir, top.g.dist);

      // update stats: message, smooth FPS, and confidence
      const conf = top.p.score || 0;
      updateStats({ message: sentence, fps: fpsSmoothed, confidence: conf });

      speak(sentence);
    } else {
      sceneTextEl.textContent = t("seeNone");
      updateStats({ message: t("seeNone"), fps: fpsSmoothed, confidence: null });
    }
  } catch (err) {
    console.error("[detection] runtime error:", err);
    statusEl.textContent = `Detection runtime error: ${err.message || err}. See console.`;
    stopDetection();
    return;
  }

  rafId = requestAnimationFrame(detectLoop);
}

/* start/stop */
async function startDetection() {
  if (detecting) return;
  statusEl.textContent = "Starting...";
  try {
    // load model if not present
    if (!model) {
      await loadTfAndModel();
    }
    if (!video) {
      await setupCamera();
    }
    detecting = true;
    statusEl.textContent = "Detecting objects...";
    speak(t("started"));
    detectLoop();
  } catch (err) {
    console.error("[startDetection] failed:", err);
    // user-friendly hints
    if (err && err.name === "NotAllowedError") {
      statusEl.textContent = "Camera permission denied. Allow camera in the site settings (lock icon) and refresh.";
    } else if (err && err.message && err.message.includes("tfjs load failed")) {
      statusEl.textContent = "TensorFlow load failed — check console. Try 'Retry Model'.";
    } else {
      statusEl.textContent = `Start failed: ${err.message || err}. Check console.`;
    }
  }
}
function stopDetection() {
  detecting = false;
  statusEl.textContent = "Stopped.";
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (video && video.srcObject) {
    try { const tracks = video.srcObject.getTracks(); tracks.forEach(t => t.stop()); } catch (e) { console.warn("[stop] stop tracks", e); }
  }
  if (window.speechSynthesis && window.speechSynthesis.speaking) window.speechSynthesis.cancel();
  video = null;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  speak(t("stopped"));
}

/* simple t() wrapper */
function t(key) { const l = langSelect.value || "en-US"; return (SCAFFOLD[l] && SCAFFOLD[l][key]) || SCAFFOLD["en-US"][key]; }

/* button wiring */
startBtn.addEventListener("click", startDetection);
stopBtn.addEventListener("click", stopDetection);
muteBtn.addEventListener("click", () => {
  muted = !muted;
  muteBtn.textContent = muted ? "🔈 Unmute" : "🔇 Mute";
  if (muted && window.speechSynthesis) window.speechSynthesis.cancel();
  if (!muted) speak(t("started"));
});

/* lightweight voice command stub (unchanged) */
voiceCmdBtn.addEventListener("click", async () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  if (!SR) { alert("SpeechRecognition not supported in this browser."); return; }
  if (!window.recognition) {
    const recognition = new SR();
    recognition.lang = langSelect.value || "en-IN";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => { voiceCmdBtn.textContent = "🎧 Listening..."; statusEl.textContent = "Listening..."; };
    recognition.onend = () => { voiceCmdBtn.textContent = "🎙 Voice Cmd"; statusEl.textContent = "Ready"; };
    recognition.onerror = (e) => { console.error("SR error", e); statusEl.textContent = "Voice error"; };
    recognition.onresult = (ev) => {
      const cmd = ev.results[0][0].transcript.trim().toLowerCase();
      statusEl.textContent = `Heard: "${cmd}"`;
      if (/^(start|go|begin)/i.test(cmd)) startDetection();
      else if (/^(stop|pause|halt)/i.test(cmd)) stopDetection();
      else if (/^(scene|describe)/i.test(cmd)) speak("Scene command received.");
      else speak("Command not recognized.");
    };
    window.recognition = recognition;
    try { recognition.start(); } catch (e) { console.warn("recognition start error", e); statusEl.textContent = "Voice start error (console)"; }
    return;
  }
  // toggle existing
  try {
    if (window.recognition) window.recognition.start();
  } catch (e) { console.warn("recognition start error", e); statusEl.textContent = "Voice start error (console)"; }
});

/* Auto-attempt a background load (non-blocking) */
(async function tryPreload() {
  try {
    console.log("[startup] attempting background model load");
    await loadTfAndModel();
    console.log("[startup] background model load ok");
  } catch (err) {
    console.warn("[startup] background model load failed:", err);
    // don't throw: user can click Start which will attempt load again
  }
})();

/* ---------------------------------------------------------
   PERMANENT FIX: Remove unknown floating "+" button
   --------------------------------------------------------- */

window.addEventListener("DOMContentLoaded", () => {
  const nodes = document.querySelectorAll("body *");

  nodes.forEach(el => {
    const txt = (el.innerText || el.textContent || "").trim();

    // get styles safely
    const cs = getComputedStyle(el);
    const pos = cs.position;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const radius = parseFloat(cs.borderRadius) || 0;

    // condition:
    // - element shows only "+"
    // - is small
    // - circular
    // - fixed / absolute positioned (typical floating button)
    if (
      txt === "+" &&
      w > 20 && h > 20 &&
      w < 120 && h < 120 &&
      radius >= Math.min(w, h) / 4 &&
      /fixed|absolute/i.test(pos)
    ) {
      console.warn("Auto-removed floating '+' button:", el);
      el.style.display = "none";
    }
  });
});
