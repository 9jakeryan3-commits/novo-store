/* Rasterise the brand SVGs to PNG for the OG-card compositor.
   Pillow cannot read SVG and no cairo binding is installed on this box, so the browser that
   already renders the site does it. Transparent ground (omitBackground), 2x device scale, then
   trimmed to the ink so the compositor positions the MARK and not its padding.

   Run it when public/brand/*.svg changes. Output goes to public/brand/raster/ and is committed --
   make-og-cards.py must not depend on a browser being present. */
const http=require('http'),fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const ROOT=path.join(__dirname,'..','public');
const OUT=path.join(ROOT,'brand','raster');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const dl=(p,ms,l)=>Promise.race([p,new Promise((_,x)=>setTimeout(()=>x(new Error('timeout '+l)),ms))]);

// what the cards actually need, at the size they need it
const WANT=[
  ['brand/mark/novo-mark-cyan.svg',   'mark-cyan.png',   512],
  ['brand/mark/novo-mark-violet.svg', 'mark-violet.png', 512],
  ['brand/mark/novo-mark-green.svg',  'mark-green.png',  512],
  ['brand/mark/novo-mark-white.svg',  'mark-white.png',  512],
  ['brand/mark/novo-mark-ink.svg',    'mark-ink.png',    512],
  ['brand/signature/novo-signature-medium-white.svg', 'signature-medium-white.png', 900],
  ['brand/signature/novo-signature-bold-white.svg',   'signature-bold-white.png',   900],
];

const MIME={'.html':'text/html','.svg':'image/svg+xml','.png':'image/png'};
const srv=http.createServer((q,r)=>{
  const u=decodeURIComponent(q.url.split('?')[0]);
  if(u==='/__frame'){ r.writeHead(200,{'content-type':'text/html'});
    return r.end('<style>html,body{margin:0;background:transparent}img{display:block}</style><img id="i">'); }
  const f=path.join(ROOT,u);
  if(!fs.existsSync(f)){r.writeHead(404);return r.end('x');}
  r.writeHead(200,{'content-type':MIME[path.extname(f)]||'text/plain'});
  fs.createReadStream(f).pipe(r);
});

srv.listen(0,'127.0.0.1',async()=>{
  const port=srv.address().port,PORT=9541,PROF=process.env.TMP+'/rb-'+process.pid;
  fs.mkdirSync(OUT,{recursive:true});
  const p=spawn(process.env.CHROME_BIN||'C:/Program Files/Google/Chrome/Application/chrome.exe',
    ['--headless=new',`--remote-debugging-port=${PORT}`,`--user-data-dir=${PROF}`,'--no-first-run',
     '--disable-gpu','--force-color-profile=srgb','about:blank'],{stdio:'ignore'});
  let wrote=0;
  try{
    await sleep(2500);
    const list=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const sock=new WebSocket(list.find(t=>t.type==='page').webSocketDebuggerUrl);
    await dl(new Promise(r=>sock.onopen=r),8000,'ws');
    let id=0;const send=(m,pr={})=>dl(new Promise(res=>{const i=++id;
      const h=e=>{const d=JSON.parse(e.data);if(d.id===i){sock.removeEventListener('message',h);res(d.result);}};
      sock.addEventListener('message',h);sock.send(JSON.stringify({id:i,method:m,params:pr}));}),25000,m);
    await send('Page.enable');
    /* omitBackground alone is NOT enough in headless: the page still composites over an
       opaque default ground, and the PNG comes back fully opaque with a correct bounding
       box - which looks like a working rasteriser until something needs the alpha. The
       background colour override is what actually makes the ground transparent. */
    await send('Emulation.setDefaultBackgroundColorOverride',{color:{r:0,g:0,b:0,a:0}});
    for(const [src,out,h] of WANT){
      if(!fs.existsSync(path.join(ROOT,src))){ console.log('  !! missing '+src); continue; }
      await send('Emulation.setDeviceMetricsOverride',{width:Math.round(h*2.4),height:h,deviceScaleFactor:2,mobile:false});
      await send('Page.navigate',{url:`http://127.0.0.1:${port}/__frame`});
      await sleep(500);
      const r=await send('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`new Promise(function(res){
        var i=document.getElementById('i');
        i.onload=function(){ i.style.height='${h}px'; res(JSON.stringify({w:i.naturalWidth,h:i.naturalHeight})); };
        i.onerror=function(){ res('ERR'); };
        i.src='/${src}';
      })`});
      if(r.result.value==='ERR'){ console.log('  !! failed to load '+src); continue; }
      await sleep(250);
      const box=await send('Runtime.evaluate',{returnByValue:true,expression:
        `(function(){var b=document.getElementById('i').getBoundingClientRect();
          return JSON.stringify({x:b.x,y:b.y,w:b.width,h:b.height});})()`});
      const b=JSON.parse(box.result.value);
      const sh=await send('Page.captureScreenshot',{format:'png',omitBackground:true,captureBeyondViewport:true,
        clip:{x:b.x,y:b.y,width:b.w,height:b.h,scale:1}});
      const buf=Buffer.from(sh.data,'base64');
      /* A rasteriser whose output is silently opaque is the exact defect this file already hit.
         The PNG header carries the colour type at byte 25: 6 = RGBA, 2 = RGB. Anything without an
         alpha channel is a failure, not a file. */
      const colourType=buf[25];
      if(colourType!==6&&colourType!==4){ console.error('  !! '+out+' has NO alpha channel (PNG colour type '+colourType+')'); continue; }
      fs.writeFileSync(path.join(OUT,out),buf);
      console.log('  ' + out.padEnd(30) + Math.round(buf.length/1024) + ' KB');
      wrote++;
    }
    sock.close();
  } finally{p.kill();srv.close();}
  // A rasteriser that silently writes nothing looks exactly like one that had nothing to do.
  if(wrote!==WANT.length){ console.error('!! wrote %d of %d — refusing to call this a success',wrote,WANT.length); process.exit(1); }
  console.log('.. brand raster: ' + wrote + ' files -> public/brand/raster/');
});
