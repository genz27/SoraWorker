/**
 * SoraWeb - Cloudflare Worker Version (Stream & Proxy Support)
 * 
 * 部署说明:
 * 1. 在 Cloudflare Workers 创建一个新 Worker。
 * 2. 将此代码粘贴到 worker.js。
 * 3. 在 Settings -> Variables and Secrets 中添加变量:
 *    - SORA_API_KEY: (必填) 您的 API Key
 *    - ACCESS_CODE: (可选) 设置访问密码
 *    - SORA_BASE_URL: (可选) API Base URL (默认 http://localhost:8000)
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. 处理 API 生成请求 (POST)
    if (request.method === 'POST' && url.pathname === '/api/generate') {
      return await handleGenerateRequest(request, env);
    }

    // 2. 处理视频代理请求 (GET) - 新增功能
    if (request.method === 'GET' && url.pathname === '/api/proxy') {
      return await handleProxyRequest(request);
    }

    // 3. 处理前端页面请求
    return new Response(HTML_CONTENT, {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
      },
    });
  },
};

/**
 * 处理生成请求，调用 Sora API (流式转发)
 */
async function handleGenerateRequest(request, env) {
  // 1. 检查 API Key
  if (!env.SORA_API_KEY) {
    return new Response(JSON.stringify({ error: '服务端未配置 SORA_API_KEY' }), { status: 500 });
  }

  // 2. 检查访问密码
  if (env.ACCESS_CODE) {
    const authHeader = request.headers.get('x-access-code');
    if (!authHeader || authHeader !== env.ACCESS_CODE) {
      return new Response(JSON.stringify({ error: '访问密码错误', code: 'UNAUTHORIZED' }), { status: 401 });
    }
  }

  try {
    const { model, prompt, files } = await request.json();
    const baseUrl = env.SORA_BASE_URL || 'http://localhost:8000';
    const cleanBaseUrl = baseUrl.replace(/\/$/, '');
    const apiUrl = `${cleanBaseUrl}/v1/chat/completions`;

    // 构建消息体
    const content = [];
    if (files && Array.isArray(files) && files.length > 0) {
      files.forEach(file => {
        if (file.mimeType.startsWith('image/') || file.mimeType.startsWith('video/')) {
          const type = file.mimeType.startsWith('image/') ? "image_url" : "video_url";
          content.push({
            type: type,
            [type]: { url: `data:${file.mimeType};base64,${file.data}` }
          });
        }
      });
    }
    if (prompt) content.push({ type: "text", text: prompt });

    let finalContent = content;
    if (content.length === 1 && content[0].type === 'text') finalContent = content[0].text;

    const payload = {
      model: model,
      messages: [{ role: "user", content: finalContent }],
      stream: true // 开启流式传输
    };

    // 请求上游 API
    const apiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.SORA_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    if (!apiResponse.ok) {
        const errText = await apiResponse.text();
        return new Response(JSON.stringify({ error: `Upstream Error: ${errText}` }), { status: apiResponse.status });
    }

    // 直接透传流式响应
    return new Response(apiResponse.body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}

/**
 * 处理代理请求，用于中转视频文件
 */
async function handleProxyRequest(request) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');

    if (!targetUrl) {
        return new Response('Missing URL parameter', { status: 400 });
    }

    try {
        const response = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
        
        // 创建新的 Response 以避免不可变的 headers 问题
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Access-Control-Allow-Origin', '*'); // 允许跨域

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders
        });
    } catch (e) {
        return new Response(`Proxy Error: ${e.message}`, { status: 500 });
    }
}

/**
 * 前端 HTML 代码
 */
const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SoraWeb</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/lucide@latest"></script>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&display=swap');
      body { font-family: 'Inter', sans-serif; background-color: #09090b; color: #f4f4f5; }
      ::-webkit-scrollbar { width: 6px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: #27272a; border-radius: 3px; }
      .glass { background: rgba(24, 24, 27, 0.6); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1); }
      .loader { border: 2px solid #3f3f46; border-top: 2px solid #6366f1; border-radius: 50%; width: 16px; height: 16px; animation: spin 1s linear infinite; }
      @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
      .btn-active { background-color: #27272a; color: white; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
      .btn-inactive { color: #a1a1aa; }
      .opt-btn { border: 1px solid #27272a; color: #a1a1aa; transition: all 0.2s; }
      .opt-active { background-color: rgba(99, 102, 241, 0.1); color: #818cf8; border-color: rgba(99, 102, 241, 0.5); }
    </style>
</head>
<body class="min-h-screen flex flex-col">
    <header class="h-16 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur fixed w-full top-0 z-50 flex items-center justify-between px-6">
        <div class="flex items-center gap-3">
            <div class="w-8 h-8 bg-gradient-to-tr from-indigo-600 to-purple-600 rounded-lg flex items-center justify-center"><i data-lucide="clapperboard" class="w-5 h-5 text-white"></i></div>
            <span class="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-zinc-400">SoraWeb</span>
        </div>
        <a href="https://github.com/genz27/SoraWorker" target="_blank" class="text-zinc-500 hover:text-white"><i data-lucide="github" class="w-5 h-5"></i></a>
    </header>

    <main class="flex-1 pt-24 px-4 md:px-6 max-w-[1600px] mx-auto w-full flex flex-col lg:flex-row gap-8 pb-12">
        <!-- Sidebar -->
        <div class="w-full lg:w-[400px] flex-shrink-0 space-y-6">
            <div class="glass p-1 rounded-xl flex">
                <button onclick="app.setMode('video')" id="mode-video" class="flex-1 py-2.5 rounded-lg text-sm font-bold flex gap-2 justify-center transition-all"><i data-lucide="video" class="w-4 h-4"></i> 视频生成</button>
                <button onclick="app.setMode('image')" id="mode-image" class="flex-1 py-2.5 rounded-lg text-sm font-bold flex gap-2 justify-center transition-all"><i data-lucide="image" class="w-4 h-4"></i> 图像生成</button>
            </div>

            <div class="glass p-6 rounded-2xl space-y-6">
                <div>
                    <label class="text-xs font-bold text-zinc-500 uppercase block mb-3">画面比例</label>
                    <div class="grid grid-cols-3 gap-2">
                        <button onclick="app.setRatio('landscape')" data-ratio="landscape" class="opt-btn py-2 rounded-lg text-xs font-bold">16:9</button>
                        <button onclick="app.setRatio('portrait')" data-ratio="portrait" class="opt-btn py-2 rounded-lg text-xs font-bold">9:16</button>
                        <button onclick="app.setRatio('square')" data-ratio="square" class="opt-btn py-2 rounded-lg text-xs font-bold">1:1</button>
                    </div>
                </div>
                <div id="duration-block">
                    <label class="text-xs font-bold text-zinc-500 uppercase block mb-3">视频时长</label>
                    <div class="flex gap-2">
                        <button onclick="app.setDuration('10s')" data-duration="10s" class="opt-btn flex-1 py-2 rounded-lg text-xs font-bold">10s</button>
                        <button onclick="app.setDuration('15s')" data-duration="15s" class="opt-btn flex-1 py-2 rounded-lg text-xs font-bold">15s</button>
                    </div>
                </div>
                <div>
                    <div class="flex justify-between items-center mb-3">
                        <label class="text-xs font-bold text-zinc-500 uppercase">参考内容</label>
                        <button onclick="app.clearFiles()" id="btn-clear-files" class="hidden text-xs text-red-400 hover:text-red-300 flex items-center gap-1"><i data-lucide="trash-2" class="w-3 h-3"></i> 清除</button>
                    </div>
                    <input type="file" id="file-upload" class="hidden" multiple accept="image/*,video/*" onchange="app.handleFileUpload(this)">
                    <div id="upload-zone" onclick="document.getElementById('file-upload').click()" class="border border-dashed border-zinc-700 rounded-xl h-24 flex flex-col items-center justify-center gap-2 cursor-pointer hover:bg-zinc-800/50 transition-all">
                        <i data-lucide="upload" class="w-5 h-5 text-zinc-500"></i>
                        <span class="text-xs text-zinc-500">上传图片/视频</span>
                    </div>
                    <div id="file-previews" class="grid grid-cols-4 gap-2 mt-2 hidden"></div>
                </div>
            </div>

            <div class="space-y-4">
                <textarea id="prompt-in" class="w-full h-32 p-4 bg-zinc-900 border border-zinc-800 rounded-2xl focus:ring-2 focus:ring-indigo-500/50 outline-none transition-all text-sm resize-none" placeholder="描述你想要生成的内容..."></textarea>
                <div id="err-msg" class="hidden p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-2 text-red-400 text-xs"><i data-lucide="alert-circle" class="w-4 h-4"></i><p id="err-text"></p></div>
                <button onclick="app.generate()" id="btn-generate" class="w-full py-4 bg-white text-black rounded-xl font-bold uppercase tracking-wider hover:bg-indigo-50 transition-all flex items-center justify-center gap-2">
                    <i data-lucide="wand-2" class="w-4 h-4"></i> 生成内容
                </button>
            </div>
        </div>

        <!-- Gallery -->
        <div class="flex-1 min-w-0">
            <div class="mb-6 flex items-center justify-between"><h2 class="text-2xl font-bold">历史记录</h2><button onclick="app.clearHistory()" class="text-xs text-zinc-500 hover:text-white">清空历史</button></div>
            <div id="gallery-container" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6"></div>
            <div id="empty-state" class="hidden h-[400px] flex flex-col items-center justify-center border border-dashed border-zinc-800 rounded-2xl bg-zinc-900/30"><div class="w-16 h-16 rounded-full bg-zinc-900 flex items-center justify-center mb-4"><i data-lucide="film" class="w-8 h-8 text-zinc-700"></i></div><p class="font-medium text-zinc-500">暂无生成记录</p></div>
        </div>
    </main>

    <!-- Pwd Modal -->
    <div id="pwd-modal" class="hidden fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-zinc-900 p-8 w-full max-w-sm border border-zinc-800 rounded-2xl">
            <h3 class="text-xl font-bold text-white text-center mb-6">需要访问密码</h3>
            <input type="password" id="pwd-input" class="w-full p-3 bg-zinc-950 border border-zinc-800 rounded-lg mb-4 text-center text-white outline-none focus:border-indigo-500" placeholder="输入密码" onkeydown="if(event.key==='Enter') app.submitPwd()">
            <button onclick="app.submitPwd()" class="w-full bg-indigo-600 text-white py-3 font-bold rounded-lg hover:bg-indigo-500">解锁</button>
        </div>
    </div>

    <!-- Lightbox -->
    <div id="lightbox" class="hidden fixed inset-0 z-[100] flex items-center justify-center bg-black/95 backdrop-blur-md p-4" onclick="app.closeLightbox()">
        <button class="absolute top-6 right-6 text-zinc-400 hover:text-white" onclick="app.closeLightbox()"><i data-lucide="x" class="w-8 h-8"></i></button>
        <div class="max-w-5xl w-full flex flex-col items-center gap-4" onclick="event.stopPropagation()">
            <div id="lightbox-media" class="w-full flex justify-center max-h-[80vh]"></div>
            <button onclick="app.downloadCurrent()" class="bg-white text-black px-6 py-2.5 font-bold rounded-full flex gap-2 hover:bg-zinc-200"><i data-lucide="download" class="w-4 h-4"></i> 下载</button>
            <p id="lightbox-text" class="text-zinc-500 text-sm max-w-2xl text-center"></p>
        </div>
    </div>

    <script>
    const app = (() => {
        const state = { mode: 'video', ratio: 'landscape', duration: '10s', files: [], loading: false, currentItem: null };
        const DB_CFG = { name: 'SoraWebDB', version: 1, store: 'generations' };
        let dbInstance = null;
        const db = {
            open: () => new Promise((res, rej) => {
                const r = indexedDB.open(DB_CFG.name, DB_CFG.version);
                r.onupgradeneeded = e => { if(!e.target.result.objectStoreNames.contains(DB_CFG.store)) e.target.result.createObjectStore(DB_CFG.store, { keyPath: 'id' }); };
                r.onsuccess = e => { dbInstance = e.target.result; res(); };
                r.onerror = rej;
            }),
            add: async i => { if(!dbInstance) await db.open(); const tx = dbInstance.transaction(DB_CFG.store, 'readwrite'); tx.objectStore(DB_CFG.store).add(i); return new Promise(r => tx.oncomplete = r); },
            getAll: async () => { if(!dbInstance) await db.open(); const tx = dbInstance.transaction(DB_CFG.store, 'readonly'); const r = tx.objectStore(DB_CFG.store).getAll(); return new Promise(res => r.onsuccess = () => res(r.result.reverse())); },
            clear: async () => { if(!dbInstance) await db.open(); const tx = dbInstance.transaction(DB_CFG.store, 'readwrite'); tx.objectStore(DB_CFG.store).clear(); return new Promise(r => tx.oncomplete = r); }
        };

        const el = id => document.getElementById(id);
        const fileToBase64 = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });

        const render = {
            controls: () => {
                el('mode-video').className = \`flex-1 py-2.5 rounded-lg text-sm font-bold flex gap-2 justify-center transition-all \${state.mode==='video'?'btn-active':'btn-inactive'}\`;
                el('mode-image').className = \`flex-1 py-2.5 rounded-lg text-sm font-bold flex gap-2 justify-center transition-all \${state.mode==='image'?'btn-active':'btn-inactive'}\`;
                state.mode==='image' ? el('duration-block').classList.add('opacity-30','pointer-events-none') : el('duration-block').classList.remove('opacity-30','pointer-events-none');
                document.querySelectorAll('[data-ratio]').forEach(b => b.className = \`opt-btn py-2 rounded-lg text-xs font-bold \${b.dataset.ratio===state.ratio?'opt-active':''}\`);
                document.querySelectorAll('[data-duration]').forEach(b => b.className = \`opt-btn flex-1 py-2 rounded-lg text-xs font-bold \${b.dataset.duration===state.duration?'opt-active':''}\`);
            },
            files: () => {
                const z = el('file-previews'); z.innerHTML = '';
                if(state.files.length>0) { z.classList.remove('hidden'); el('upload-zone').classList.add('hidden'); el('btn-clear-files').classList.remove('hidden'); state.files.forEach(f => { const d = document.createElement('div'); d.className='relative aspect-square bg-zinc-800 rounded overflow-hidden border border-zinc-700'; d.innerHTML=f.mimeType.startsWith('video')?\`<video src="\${f.preview}" class="w-full h-full object-cover opacity-60"></video><div class="absolute inset-0 flex items-center justify-center"><i data-lucide="video" class="w-4 h-4 text-white"></i></div>\`:\`<img src="\${f.preview}" class="w-full h-full object-cover">\`; z.appendChild(d); }); } 
                else { z.classList.add('hidden'); el('upload-zone').classList.remove('hidden'); el('btn-clear-files').classList.add('hidden'); }
                lucide.createIcons();
            },
            gallery: async () => {
                const items = await db.getAll(); const c = el('gallery-container'); c.innerHTML = '';
                items.length===0 ? el('empty-state').classList.remove('hidden') : el('empty-state').classList.add('hidden');
                items.forEach(i => {
                    const model = i.model || 'unknown';
                    const url = i.url || '';
                    const isV = (url && url.match(/\.(mp4|webm)/)) || model.includes('video');
                    const card = document.createElement('div');
                    card.className = 'group relative bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden cursor-pointer hover:border-zinc-600 transition-all';
                    card.onclick = () => app.openLightbox(i);
                    const media = isV ? \`<video src="\${url}" class="w-full h-full object-cover" muted onmouseover="this.play()" onmouseout="this.pause()"></video><div class="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:opacity-0"><i data-lucide="play" class="w-8 h-8 text-white fill-white"></i></div>\` : \`<img src="\${url}" class="w-full h-full object-cover">\`;
                    card.innerHTML = \`<div class="aspect-video w-full bg-zinc-950 relative">\${media}<div class="absolute bottom-2 right-2 px-1.5 py-0.5 bg-black/60 backdrop-blur rounded text-[10px] text-zinc-300 font-mono">\${model}</div></div><div class="p-4"><p class="text-xs text-zinc-300 line-clamp-2">\${i.prompt||'No prompt'}</p><div class="mt-3 text-[10px] text-zinc-500">\${new Date(i.timestamp).toLocaleTimeString()}</div></div>\`;
                    c.appendChild(card);
                });
                lucide.createIcons();
            },
            loading: (progress = null) => {
                const btn = el('btn-generate');
                if(state.loading) {
                    btn.disabled = true;
                    // 显示进度
                    const text = progress ? \`生成中 \${progress}%\` : '正在初始化...';
                    btn.innerHTML = \`<div class="loader"></div><span>\${text}</span>\`;
                    btn.className = 'w-full py-4 bg-zinc-800 text-zinc-500 rounded-xl font-bold flex items-center justify-center gap-2 cursor-not-allowed';
                } else {
                    btn.disabled = false;
                    btn.innerHTML = '<i data-lucide="wand-2" class="w-4 h-4"></i> 生成内容';
                    btn.className = 'w-full py-4 bg-white text-black rounded-xl font-bold uppercase hover:bg-indigo-50 transition-all flex items-center justify-center gap-2';
                    lucide.createIcons();
                }
            }
        };

        const actions = {
            init: () => { render.controls(); render.gallery(); lucide.createIcons(); },
            setMode: m => { state.mode = m; state.files=[]; render.files(); render.controls(); },
            setRatio: r => { state.ratio = r; render.controls(); },
            setDuration: d => { state.duration = d; render.controls(); },
            handleFileUpload: async i => { for(let f of i.files) state.files.push({data:await fileToBase64(f), mimeType:f.type, preview:URL.createObjectURL(f)}); render.files(); i.value=''; },
            clearFiles: () => { state.files=[]; render.files(); },
            clearHistory: async () => { if(confirm('清空记录?')) await db.clear(); render.gallery(); },
            submitPwd: () => { if(el('pwd-input').value) { localStorage.setItem('sora_code', el('pwd-input').value); el('pwd-modal').classList.add('hidden'); actions.generate(); } },
            
            generate: async () => {
                const prompt = el('prompt-in').value.trim();
                if(!prompt && state.files.length===0) return alert("请输入提示词或上传文件");
                const code = localStorage.getItem('sora_code');
                if(!code) return el('pwd-modal').classList.remove('hidden');

                state.loading = true;
                render.loading('0');
                el('err-msg').classList.add('hidden');

                let modelId = state.mode === 'image' 
                    ? (state.ratio==='landscape'?'sora-image-landscape':state.ratio==='portrait'?'sora-image-portrait':'sora-image') 
                    : \`sora-video\${state.ratio!=='square'?'-'+state.ratio:''}-\${state.duration}\`;

                try {
                    const res = await fetch('/api/generate', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-access-code': code },
                        body: JSON.stringify({ model: modelId, prompt, files: state.files.map(f=>({mimeType:f.mimeType, data:f.data})) })
                    });

                    if(res.status===401) { localStorage.removeItem('sora_code'); el('pwd-modal').classList.remove('hidden'); throw new Error("密码错误"); }
                    if(!res.ok) throw new Error((await res.json()).error || '请求失败');

                    // Stream Reading Logic
                    const reader = res.body.getReader();
                    const decoder = new TextDecoder();
                    let finalUrl = '';
                    let buffer = '';

                    const processLine = (line) => {
                        const trimmed = line.trim();
                        if (!trimmed.startsWith('data:')) return;

                        const jsonStr = trimmed.slice(5).trim();
                        if (jsonStr === '[DONE]') return;

                        try {
                            const data = JSON.parse(jsonStr);
                            const delta = data.choices?.[0]?.delta || {};

                            // 1. 处理进度（兼容新格式，如 "**Video Generation Progress**: 9% (running)")
                            if (delta.reasoning_content) {
                                const progMatch = delta.reasoning_content.match(/(\d+)%/);
                                if (progMatch) {
                                    render.loading(progMatch[1]);
                                }
                            }

                            // 2. 处理最终内容 (提取 URL)
                            if (delta.content) {
                                const urlMatch = delta.content.match(/src=['"]([^'"\\]+)['"]/);
                                if (urlMatch) {
                                    finalUrl = urlMatch[1];
                                } else if (delta.content.startsWith('http')) {
                                    finalUrl = delta.content;
                                }
                            }
                        } catch (e) { console.error('Parse error', e); }
                    };

                    while (true) {
                        const { done, value } = await reader.read();
                        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

                        const lines = buffer.split('\\n');
                        buffer = lines.pop() || '';

                        for (const line of lines) {
                            processLine(line);
                        }

                        if (done) {
                            if (buffer) processLine(buffer);
                            break;
                        }
                    }

                    if (!finalUrl) throw new Error("未获取到生成结果链接");

                    // 使用 Proxy URL
                    const proxyUrl = \`/api/proxy?url=\${encodeURIComponent(finalUrl)}\`;

                    await db.add({ id: crypto.randomUUID(), url: proxyUrl, prompt, model: modelId, type: state.mode, timestamp: Date.now() });
                    el('prompt-in').value = '';
                    actions.clearFiles();
                    await render.gallery();

                } catch (e) {
                    el('err-msg').classList.remove('hidden');
                    el('err-text').textContent = e.message;
                } finally {
                    state.loading = false;
                    render.loading();
                }
            },
            
            openLightbox: i => {
                state.currentItem = i;
                const box = el('lightbox-media');
                const url = i.url || '';
                const model = i.model || '';
                const isV = (url && url.match(/proxy/)) || model.includes('video'); // Proxy implies video/large file typically
                box.innerHTML = isV
                    ? \`<video src="\${url}" controls autoplay loop class="max-h-[80vh] w-auto rounded-lg shadow-2xl"></video>\`
                    : \`<img src="\${url}" class="max-h-[80vh] object-contain rounded-lg shadow-2xl">\`;
                el('lightbox-text').textContent = i.prompt || '';
                el('lightbox').classList.remove('hidden');
            },
            closeLightbox: () => { el('lightbox').classList.add('hidden'); el('lightbox-media').innerHTML=''; state.currentItem=null; },
            downloadCurrent: () => {
                if(!state.currentItem) return;
                const link = document.createElement('a');
                link.href = state.currentItem.url;
                link.download = \`sora-\${state.currentItem.id}.mp4\`; // Defaulting to mp4 for ease
                document.body.appendChild(link); link.click(); document.body.removeChild(link);
            }
        };
        return actions;
    })();
    window.onload = app.init;
    </script>
</body>
</html>
`;
