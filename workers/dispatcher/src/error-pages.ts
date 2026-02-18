/**
 * Styled error pages for the dispatcher worker.
 *
 * Renders self-contained HTML error pages with:
 * - Radial grid background animation (ported from RadialGridBackground React component)
 * - Figtree sans-serif body font, system serif italic heading, Geist Mono error code
 * - "Go home" and "Sign in" action buttons
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ErrorPageOptions {
  statusCode: number;
  /** Short uppercase label, e.g. "FORBIDDEN" */
  statusLabel: string;
  /** Main heading, rendered in italic serif */
  title: string;
  /** Longer description in muted text */
  description: string;
  /** Main application URL (e.g. https://camelai.dev) */
  homeUrl: string;
  /** SVG icon markup (24×24 viewBox expected) */
  icon: string;
}

// ---------------------------------------------------------------------------
// Icons (Lucide-style, 24×24 viewBox)
// ---------------------------------------------------------------------------

const ICON_LOCK = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;

const ICON_FILE_X = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m14.5 12.5-5 5"/><path d="m9.5 12.5 5 5"/></svg>`;

const ICON_LOG_IN = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/></svg>`;

const ICON_ALERT_TRIANGLE = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`;

// ---------------------------------------------------------------------------
// Error presets
// ---------------------------------------------------------------------------

export function error403Page(homeUrl: string): ErrorPageOptions {
  return {
    statusCode: 403,
    statusLabel: 'FORBIDDEN',
    title: 'This app is private',
    description:
      "You'll need to be a member of this workspace to view it. If you think you should have access, reach out to the app's owner.",
    homeUrl,
    icon: ICON_LOCK,
  };
}

export function error404Page(homeUrl: string, scriptName?: string): ErrorPageOptions {
  return {
    statusCode: 404,
    statusLabel: 'NOT FOUND',
    title: 'App not found',
    description: scriptName
      ? `The app "${scriptName}" doesn\u2019t exist or may have been removed.`
      : "The app you\u2019re looking for doesn\u2019t exist or may have been removed.",
    homeUrl,
    icon: ICON_FILE_X,
  };
}

export function error401Page(homeUrl: string): ErrorPageOptions {
  return {
    statusCode: 401,
    statusLabel: 'UNAUTHORIZED',
    title: 'Sign in required',
    description: 'You need to sign in to view this private app.',
    homeUrl,
    icon: ICON_LOG_IN,
  };
}

export function error500Page(homeUrl: string): ErrorPageOptions {
  return {
    statusCode: 500,
    statusLabel: 'SERVER ERROR',
    title: 'Something went wrong',
    description: 'We ran into an unexpected error. Please try again later.',
    homeUrl,
    icon: ICON_ALERT_TRIANGLE,
  };
}

export function error503Page(homeUrl: string): ErrorPageOptions {
  return {
    statusCode: 503,
    statusLabel: 'UNAVAILABLE',
    title: 'Temporarily unavailable',
    description: "We\u2019re experiencing issues right now. Please try again in a moment.",
    homeUrl,
    icon: ICON_ALERT_TRIANGLE,
  };
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export function errorResponse(options: ErrorPageOptions): Response {
  return new Response(renderErrorPage(options), {
    status: options.statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// ---------------------------------------------------------------------------
// HTML renderer
// ---------------------------------------------------------------------------

function renderErrorPage(opts: ErrorPageOptions): string {
  const { statusCode, statusLabel, title, description, homeUrl, icon } = opts;
  const signInUrl = `${homeUrl}/login`;

  // Escape HTML entities in dynamic strings
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${statusCode} - ${esc(statusLabel)} | Chiridion</title>
<link rel="icon" href="${esc(homeUrl)}/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Figtree:ital,wght@0,300..900;1,300..900&family=Geist+Mono:wght@100..900&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{
  background:#111113;
  color:#fafafa;
  font-family:'Figtree',ui-sans-serif,system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;
  -moz-osx-font-smoothing:grayscale;
}

/* Canvas background */
#bg-wrap{position:fixed;inset:0;z-index:0;overflow:hidden}
#bg-wrap canvas{display:block}

/* Content overlay */
.page{
  position:relative;z-index:1;
  display:flex;align-items:center;
  min-height:100vh;min-height:100dvh;
  padding:2.5rem;
}
.content{
  display:flex;align-items:center;justify-content:space-between;
  width:100%;max-width:80rem;margin:0 auto;
  gap:2rem;
}

/* Left column */
.info{flex:1 1 auto;max-width:36rem}
.icon-badge{
  width:3.5rem;height:3.5rem;
  display:flex;align-items:center;justify-content:center;
  border-radius:9999px;
  border:1px solid rgba(255,255,255,0.1);
  background:rgba(255,255,255,0.04);
  color:#a1a1aa;
  margin-bottom:1.75rem;
}
.icon-badge svg{width:1.25rem;height:1.25rem}
.status-label{
  font-size:0.75rem;font-weight:500;
  letter-spacing:0.15em;text-transform:uppercase;
  color:#71717a;margin-bottom:0.75rem;
}
.title{
  font-family:ui-serif,Georgia,Cambria,'Times New Roman',Times,serif;
  font-style:italic;font-weight:400;
  font-size:clamp(2rem,5vw,3rem);
  line-height:1.15;color:#fafafa;
  margin-bottom:1rem;
}
.desc{
  font-size:1rem;line-height:1.6;
  color:#a1a1aa;max-width:28rem;
  margin-bottom:2.5rem;
}

/* Buttons */
.actions{display:flex;gap:0.75rem;flex-wrap:wrap}
.btn{
  display:inline-flex;align-items:center;justify-content:center;
  padding:0.625rem 1.5rem;border-radius:0.5rem;
  font-size:0.875rem;font-weight:500;
  text-decoration:none;cursor:pointer;
  transition:background 150ms,border-color 150ms,opacity 150ms;
}
.btn-primary{
  background:#fafafa;color:#111113;border:1px solid #fafafa;
}
.btn-primary:hover{background:#e4e4e7}
.btn-ghost{
  background:transparent;color:#a1a1aa;
  border:1px solid rgba(255,255,255,0.12);
}
.btn-ghost:hover{border-color:rgba(255,255,255,0.25);color:#fafafa}

/* Right column – error code */
.code-col{
  flex:0 0 auto;
  display:flex;align-items:center;justify-content:flex-end;
  user-select:none;pointer-events:none;
}
.error-code{
  font-family:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
  font-weight:600;
  font-size:clamp(8rem,20vw,18rem);
  line-height:1;
  color:rgba(255,255,255,0.08);
  white-space:nowrap;
}

/* Responsive */
@media(max-width:768px){
  .page{padding:2rem 1.5rem}
  .content{flex-direction:column-reverse;align-items:flex-start;gap:0}
  .code-col{justify-content:flex-start;margin-bottom:-1rem}
  .error-code{font-size:6rem;color:rgba(255,255,255,0.06)}
}
</style>
</head>
<body>

<div id="bg-wrap"><canvas id="bg" aria-hidden="true"></canvas></div>

<div class="page">
  <div class="content">
    <div class="info">
      <div class="icon-badge">${icon}</div>
      <div class="status-label">${esc(statusLabel)}</div>
      <h1 class="title">${esc(title)}</h1>
      <p class="desc">${esc(description)}</p>
      <div class="actions">
        <a href="${esc(homeUrl)}/" class="btn btn-primary">Go home</a>
        <a href="${esc(signInUrl)}" class="btn btn-ghost">Sign in</a>
      </div>
    </div>
    <div class="code-col">
      <div class="error-code">${statusCode}</div>
    </div>
  </div>
</div>

<script>
(function(){
var c=document.getElementById('bg'),w=c.parentElement;
var ctx=c.getContext('2d');if(!ctx)return;
var dpr=Math.min(window.devicePixelRatio||1,2);
var sp=28,pts=[],pls=[],W=0,H=0;

function resize(){
  W=w.clientWidth;H=w.clientHeight;
  c.width=Math.floor(W*dpr);c.height=Math.floor(H*dpr);
  c.style.width=W+'px';c.style.height=H+'px';
  pts=[];
  for(var y=-sp;y<=H+sp;y+=sp)
    for(var x=-sp;x<=W+sp;x+=sp)
      pts.push({x:x,y:y});
}

function spawn(){
  if(!W||!H)return;
  pls.push({x:Math.random()*W,y:Math.random()*H,age:0,
    dur:2500+Math.random()*2000,
    mr:Math.min(W,H)*(0.3+Math.random()*0.4)});
}

setTimeout(spawn,100);setTimeout(spawn,900);
setInterval(function(){if(pls.length<3)spawn()},1500);

var lt=0,OP=0.3;
function draw(t){
  var dt=lt?t-lt:16;lt=t;
  if(!W||!H){requestAnimationFrame(draw);return;}
  var dx=Math.sin(t*0.0003)*4,dy=Math.cos(t*0.00025)*4;
  for(var i=pls.length-1;i>=0;i--){pls[i].age+=dt;if(pls[i].age>pls[i].dur)pls.splice(i,1);}
  ctx.clearRect(0,0,c.width,c.height);
  ctx.lineCap='round';
  var col='rgba(250,250,250,1)';
  for(var i=0;i<pts.length;i++){
    var px=pts[i].x+dx,py=pts[i].y+dy;
    var mi=0,ma=0;
    for(var j=0;j<pls.length;j++){
      var p=pls[j],ddx=px-p.x,ddy=py-p.y;
      var d=Math.hypot(ddx,ddy);
      var pr=p.age/p.dur,en=Math.sin(pr*Math.PI);
      var cr=p.mr*en;
      if(d<cr){var f=1-d/cr;var inf=f*f*en;
        if(inf>mi){mi=inf;ma=Math.atan2(ddy,ddx);}
      }
    }
    if(mi<0.05){
      ctx.globalAlpha=0.4*OP;ctx.fillStyle=col;
      ctx.beginPath();ctx.arc(px*dpr,py*dpr,1.25*dpr,0,Math.PI*2);ctx.fill();
      continue;
    }
    var len=6+mi*14,half=len/2;
    var cs=Math.cos(ma),sn=Math.sin(ma);
    ctx.globalAlpha=(0.35+mi*0.5)*OP;
    ctx.lineWidth=(1+mi*1.5)*dpr;ctx.strokeStyle=col;
    ctx.beginPath();
    ctx.moveTo((px-cs*half)*dpr,(py-sn*half)*dpr);
    ctx.lineTo((px+cs*half)*dpr,(py+sn*half)*dpr);
    ctx.stroke();
  }
  ctx.globalAlpha=1;
  requestAnimationFrame(draw);
}

resize();window.addEventListener('resize',resize);
requestAnimationFrame(draw);
})();
</script>

</body>
</html>`;
}
