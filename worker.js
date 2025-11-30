/**
 * SoraWeb - Cloudflare Worker Version (Pure JS, SSE Progress)
 *
 * 环境变量说明:
 *  - SORA_API_KEY: (必填) 你的 Sora API Key
 *  - ACCESS_CODE: (可选) 前端访问密码
 *  - SORA_BASE_URL: (可选) Sora API Base URL (默认 http://localhost:8000)
 */

export default {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
  
      // 仅提供 SSE 接口和前端页面
      // 1. SSE 进度接口
      if (request.method === 'POST' && url.pathname === '/api/generate') {
        return await handleGenerateRequest(request, env);
      }
  
      // 2. 前端页面
      return new Response(HTML_CONTENT, {
        headers: {
          'Content-Type': 'text/html;charset=UTF-8',
        },
      });
    },
  };
  
  /** 从 HTML / 文本中解析视频 URL */
  function extractVideoUrlFromContent(fullContent) {
    if (!fullContent) return '';
  
    let clean = fullContent.trim();
  
    // 去掉 ```html 包裹
    if (clean.startsWith('```')) {
      const firstNewLine = clean.indexOf('\n');
      if (firstNewLine !== -1) {
        clean = clean.slice(firstNewLine + 1);
      }
      if (clean.endsWith('```')) {
        clean = clean.slice(0, -3);
      }
    }
  
    // 优先从 <video src="..."> 中取
    let match = clean.match(/<video[^>]*\s+src=['"]([^'"]+)['"][^>]*>/i);
    if (match) {
      return match[1];
    }
  
    // 次选：任意 http(s) 链接
    const urlMatch = clean.match(/https?:\/\/[^\s"'<>]+/);
    if (urlMatch) {
      return urlMatch[0];
    }
  
    return '';
  }
  
  /**
   * /api/generate
   * - 接收前端请求
   * - 调用 Sora SSE
   * - 把进度和最终 URL 以 SSE 推给前端
   */
  async function handleGenerateRequest(request, env) {
    // 1. 检查 API Key
    if (!env.SORA_API_KEY) {
      return new Response(JSON.stringify({ error: '服务端未配置 SORA_API_KEY' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  
    // 2. 检查访问密码
    if (env.ACCESS_CODE) {
      const authHeader = request.headers.get('x-access-code');
      if (!authHeader || authHeader !== env.ACCESS_CODE) {
        return new Response(
          JSON.stringify({ error: '访问密码错误或未授权', code: 'UNAUTHORIZED' }),
          {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    }
  
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: '请求体不是合法 JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  
    const { model, prompt, files } = body || {};
  
    // 3. 构建 API URL
    const baseUrl = env.SORA_BASE_URL || 'http://localhost:8000';
    const cleanBaseUrl = baseUrl.replace(/\/$/, '');
    const apiUrl = `${cleanBaseUrl}/v1/chat/completions`;
  
    // 4. 构建 messages.content
    const content = [];
  
    if (files && Array.isArray(files) && files.length > 0) {
      files.forEach((file) => {
        if (file.mimeType.startsWith('image/')) {
          content.push({
            type: 'image_url',
            image_url: {
              url: `data:${file.mimeType};base64,${file.data}`,
            },
          });
        } else if (file.mimeType.startsWith('video/')) {
          content.push({
            type: 'video_url',
            video_url: {
              url: `data:${file.mimeType};base64,${file.data}`,
            },
          });
        }
      });
    }
  
    if (prompt) {
      content.push({
        type: 'text',
        text: prompt,
      });
    }
  
    let finalContent = content;
    if (content.length === 1 && content[0].type === 'text') {
      finalContent = content[0].text;
    }
  
    const payload = {
      model,
      messages: [
        {
          role: 'user',
          content: finalContent,
        },
      ],
      stream: true, // 要求 Sora 用 SSE 流返回
    };
  
    let soraRes;
    try {
      soraRes = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.SORA_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: '请求 Sora 失败: ' + e.message }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  
    if (!soraRes.ok) {
      const errorText = await soraRes.text();
      let errMsg = errorText;
      try {
        const errJson = JSON.parse(errorText);
        errMsg = errJson.error?.message || errorText;
      } catch (e) {}
      return new Response(JSON.stringify({ error: errMsg }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  
    // 5. 创建 SSE 流，边读 Sora 返回，边转发给前端
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
  
    (async () => {
      let buffer = '';
      let fullContent = '';
  
      try {
        const reader = soraRes.body.getReader();
  
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
  
          buffer += decoder.decode(value, { stream: true });
  
          const parts = buffer.split('\n\n');
          buffer = parts.pop(); // 剩下半截
  
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith('data:')) continue;
  
            const dataStr = line.slice(5).trim();
            if (!dataStr) continue;
  
            if (dataStr === '[DONE]') {
              // Sora 结束
              break;
            }
  
            let json;
            try {
              json = JSON.parse(dataStr);
            } catch (e) {
              continue;
            }
  
            const delta = json?.choices?.[0]?.delta || {};
  
            // 进度: "**Video Generation Progress**: 9% (running)"
            if (delta.reasoning_content) {
              const text = delta.reasoning_content;
              const m = text.match(/Progress\*\*: *(\d+)%/i);
              if (m) {
                const percent = Number(m[1]);
                const evt = { type: 'progress', percent };
                await writer.write(
                  encoder.encode('data: ' + JSON.stringify(evt) + '\n\n')
                );
              }
            }
  
            // 累积最终 HTML 内容
            if (delta.content) {
              fullContent += delta.content;
            }
          }
        }
  
        // 全部读取完毕，解析视频 URL
        const directUrl = extractVideoUrlFromContent(fullContent);
        if (!directUrl) {
          const evt = {
            type: 'error',
            message: '未能从返回内容中解析出视频 URL',
          };
          await writer.write(encoder.encode('data: ' + JSON.stringify(evt) + '\n\n'));
        } else {
          // 直接返回真实视频地址（不再通过 /proxy）
          const evt = { type: 'result', url: directUrl };
          await writer.write(encoder.encode('data: ' + JSON.stringify(evt) + '\n\n'));
        }
      } catch (e) {
        const evt = { type: 'error', message: e.message || 'SSE 处理异常' };
        await writer.write(encoder.encode('data: ' + JSON.stringify(evt) + '\n\n'));
      } finally {
        writer.close();
      }
    })();
  
    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  }
  
  /**
   * 前端 HTML + JS
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
        <link rel="icon" type="image/svg+xml" href="https://upload.wikimedia.org/wikipedia/commons/4/4d/OpenAI_Logo.svg" />
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&display=swap');
          body { font-family: 'Inter', sans-serif; background-color: #09090b; color: #f4f4f5; }
          ::-webkit-scrollbar { width: 6px; }
          ::-webkit-scrollbar-track { background: transparent; }
          ::-webkit-scrollbar-thumb { background: #27272a; border-radius: 3px; }
          ::-webkit-scrollbar-thumb:hover { background: #3f3f46; }
          .glass { background: rgba(24, 24, 27, 0.6); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1); }
          .loader { border: 2px solid #3f3f46; border-top: 2px solid #6366f1; border-radius: 50%; width: 16px; height: 16px; animation: spin 1s linear infinite; }
          @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          .btn-active { background-color: #27272a; color: white; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
          .btn-inactive { color: #a1a1aa; }
          .btn-inactive:hover { color: white; }
          .opt-btn { border: 1px solid #27272a; color: #a1a1aa; transition: all 0.2s; }
          .opt-btn:hover { background-color: #18181b; }
          .opt-active { background-color: rgba(99, 102, 241, 0.1); color: #818cf8; border-color: rgba(99, 102, 241, 0.5); }
        </style>
    </head>
    <body class="min-h-screen flex flex-col">
        <!-- Header -->
        <header class="h-16 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur fixed w-full top-0 z-50 flex items-center justify-between px-6">
            <div class="flex items-center gap-3">
                <div class="w-8 h-8 bg-gradient-to-tr from-indigo-600 to-purple-600 rounded-lg flex items-center justify-center">
                    <i data-lucide="clapperboard" class="w-5 h-5 text-white"></i>
                </div>
                <span class="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-zinc-400">SoraWeb</span>
            </div>
            <div class="flex items-center gap-4">
                <a href="https://github.com/openai/sora" target="_blank" class="text-zinc-500 hover:text-white transition-colors">
                    <i data-lucide="github" class="w-5 h-5"></i>
                </a>
            </div>
        </header>
    
        <main class="flex-1 pt-24 px-4 md:px-6 max-w-[1600px] mx-auto w-full flex flex-col lg:flex-row gap-8 pb-12">
            <!-- Sidebar -->
            <div class="w-full lg:w-[400px] flex-shrink-0 space-y-6">
                <!-- Mode Toggle -->
                <div class="glass p-1 rounded-xl flex">
                    <button onclick="app.setMode('video')" id="mode-video" class="flex-1 py-2.5 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all">
                        <i data-lucide="video" class="w-4 h-4"></i> 视频生成
                    </button>
                    <button onclick="app.setMode('image')" id="mode-image" class="flex-1 py-2.5 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all">
                        <i data-lucide="image" class="w-4 h-4"></i> 图像生成
                    </button>
                </div>
    
                <div class="glass p-6 rounded-2xl space-y-6">
                    <!-- Ratio -->
                    <div>
                        <label class="text-xs font-bold text-zinc-500 uppercase block mb-3">画面比例</label>
                        <div class="grid grid-cols-3 gap-2">
                            <button onclick="app.setRatio('landscape')" data-ratio="landscape" class="opt-btn py-2 rounded-lg text-xs font-bold">16:9</button>
                            <button onclick="app.setRatio('portrait')" data-ratio="portrait" class="opt-btn py-2 rounded-lg text-xs font-bold">9:16</button>
                            <button onclick="app.setRatio('square')" data-ratio="square" class="opt-btn py-2 rounded-lg text-xs font-bold">1:1</button>
                        </div>
                    </div>
    
                    <!-- Duration -->
                    <div id="duration-block">
                        <label class="text-xs font-bold text-zinc-500 uppercase block mb-3">视频时长</label>
                        <div class="flex gap-2">
                            <button onclick="app.setDuration('10s')" data-duration="10s" class="opt-btn flex-1 py-2 rounded-lg text-xs font-bold">10s</button>
                            <button onclick="app.setDuration('15s')" data-duration="15s" class="opt-btn flex-1 py-2 rounded-lg text-xs font-bold">15s</button>
                        </div>
                    </div>
    
                    <!-- Upload -->
                    <div>
                        <div class="flex justify-between items-center mb-3">
                            <label class="text-xs font-bold text-zinc-500 uppercase">参考内容</label>
                            <button onclick="app.clearFiles()" id="btn-clear-files" class="hidden text-xs text-red-400 hover:text-red-300 flex items-center gap-1">
                                <i data-lucide="trash-2" class="w-3 h-3"></i> 清除
                            </button>
                        </div>
                        <input type="file" id="file-upload" class="hidden" multiple accept="image/*,video/*" onchange="app.handleFileUpload(this)">
                        <div id="upload-zone" onclick="document.getElementById('file-upload').click()" class="border border-dashed border-zinc-700 rounded-xl h-24 flex flex-col items-center justify-center gap-2 cursor-pointer hover:bg-zinc-800/50 hover:border-zinc-500 transition-all">
                            <i data-lucide="upload" class="w-5 h-5 text-zinc-500"></i>
                            <span class="text-xs text-zinc-500">上传图片/视频 (Remix/图生视频)</span>
                        </div>
                        <div id="file-previews" class="grid grid-cols-4 gap-2 mt-2 hidden"></div>
                    </div>
                </div>
    
                <!-- Input -->
                <div class="space-y-4">
                    <textarea id="prompt-in" class="w-full h-32 p-4 bg-zinc-900 border border-zinc-800 rounded-2xl focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 focus:outline-none transition-all text-sm placeholder:text-zinc-600 resize-none" placeholder="描述你想要生成的内容..."></textarea>
                    
                    <div id="err-msg" class="hidden p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-2 text-red-400">
                        <i data-lucide="alert-circle" class="w-4 h-4 mt-0.5 flex-shrink-0"></i>
                        <p class="text-xs" id="err-text"></p>
                    </div>
    
                    <button onclick="app.generate()" id="btn-generate" class="w-full py-4 bg-white text-black rounded-xl font-bold uppercase tracking-wider hover:bg-indigo-50 hover:scale-[1.02] transition-all flex items-center justify-center gap-2 shadow-[0_0_20px_-5px_rgba(255,255,255,0.3)]">
                        <i data-lucide="wand-2" class="w-4 h-4"></i> 生成内容
                    </button>
    
                    <!-- 进度条 -->
                    <div id="progress-wrapper" class="hidden mt-2">
                        <div class="flex justify-between text-[10px] text-zinc-500">
                            <span>生成进度</span>
                            <span id="progress-text">0%</span>
                        </div>
                        <div class="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden mt-1">
                            <div id="progress-bar" class="h-full bg-indigo-500 transition-all" style="width:0%"></div>
                        </div>
                    </div>
                </div>
            </div>
    
            <!-- Gallery -->
            <div class="flex-1 min-w-0">
                <div class="mb-6 flex items-center justify-between">
                    <h2 class="text-2xl font-bold">历史记录</h2>
                    <button onclick="app.clearHistory()" class="text-xs text-zinc-500 hover:text-white transition-colors">清空历史</button>
                </div>
                
                <div id="gallery-container" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6"></div>
                
                <div id="empty-state" class="hidden h-[400px] flex flex-col items-center justify-center border border-dashed border-zinc-800 rounded-2xl bg-zinc-900/30">
                    <div class="w-16 h-16 rounded-full bg-zinc-900 flex items-center justify-center mb-4">
                        <i data-lucide="film" class="w-8 h-8 text-zinc-700"></i>
                    </div>
                    <p class="font-medium text-zinc-500">暂无生成记录</p>
                </div>
            </div>
        </main>
    
        <!-- Password Modal -->
        <div id="pwd-modal" class="hidden fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4">
            <div class="bg-zinc-900 p-8 w-full max-w-sm border border-zinc-800 rounded-2xl shadow-2xl">
                <div class="flex flex-col items-center gap-4 mb-6">
                    <div class="p-3 bg-indigo-600 text-white rounded-full shadow-lg shadow-indigo-500/20">
                        <i data-lucide="lock" class="w-6 h-6"></i>
                    </div>
                    <h3 class="text-xl font-bold text-white">需要访问密码</h3>
                </div>
                <input type="password" id="pwd-input" class="w-full p-3 bg-zinc-950 border border-zinc-800 rounded-lg mb-4 text-center text-white focus:outline-none focus:border-indigo-500 transition-colors" placeholder="输入访问密码" onkeydown="if(event.key==='Enter') app.submitPwd()">
                <button onclick="app.submitPwd()" class="w-full bg-indigo-600 text-white py-3 font-bold rounded-lg hover:bg-indigo-500 transition-colors">解锁</button>
            </div>
        </div>
    
        <!-- Lightbox -->
        <div id="lightbox" class="hidden fixed inset-0 z-[100] flex items-center justify-center bg-black/95 backdrop-blur-md p-4" onclick="app.closeLightbox()">
            <button class="absolute top-6 right-6 text-zinc-400 hover:text-white transition-colors" onclick="app.closeLightbox()">
                <i data-lucide="x" class="w-8 h-8"></i>
            </button>
            <div class="max-w-5xl w-full flex flex-col items-center gap-4" onclick="event.stopPropagation()">
                <div id="lightbox-media" class="w-full flex justify-center max-h-[80vh]"></div>
                <div class="flex gap-4">
                    <button onclick="app.downloadCurrent()" class="bg-white text-black px-6 py-2.5 font-bold rounded-full flex items-center gap-2 hover:bg-zinc-200 transition-colors">
                        <i data-lucide="download" class="w-4 h-4"></i> 下载
                    </button>
                </div>
                <p id="lightbox-text" class="text-zinc-500 text-sm max-w-2xl text-center"></p>
            </div>
        </div>
    
        <script>
        /**
         * Pure JS Application Logic
         */
        const app = (() => {
            const state = {
                mode: 'video',
                ratio: 'landscape',
                duration: '10s',
                files: [],
                loading: false,
                currentItem: null,
                progress: 0,
            };
    
            // IndexedDB
            const DB_CFG = { name: 'SoraWebDB', version: 1, store: 'generations' };
            let dbInstance = null;
    
            const db = {
                open: () => new Promise((resolve, reject) => {
                    const req = indexedDB.open(DB_CFG.name, DB_CFG.version);
                    req.onupgradeneeded = (e) => {
                        const d = e.target.result;
                        if (!d.objectStoreNames.contains(DB_CFG.store)) d.createObjectStore(DB_CFG.store, { keyPath: 'id' });
                    };
                    req.onsuccess = (e) => { dbInstance = e.target.result; resolve(); };
                    req.onerror = reject;
                }),
                add: async (item) => {
                    if(!dbInstance) await db.open();
                    return new Promise((resolve, reject) => {
                        const tx = dbInstance.transaction(DB_CFG.store, 'readwrite');
                        tx.objectStore(DB_CFG.store).add(item);
                        tx.oncomplete = resolve;
                        tx.onerror = reject;
                    });
                },
                getAll: async () => {
                    if(!dbInstance) await db.open();
                    return new Promise((resolve) => {
                        const tx = dbInstance.transaction(DB_CFG.store, 'readonly');
                        const req = tx.objectStore(DB_CFG.store).getAll();
                        req.onsuccess = () => resolve(req.result.reverse());
                    });
                },
                clear: async () => {
                    if(!dbInstance) await db.open();
                    const tx = dbInstance.transaction(DB_CFG.store, 'readwrite');
                    tx.objectStore(DB_CFG.store).clear();
                    return new Promise(r => { tx.oncomplete = r; });
                }
            };
    
            const el = (id) => document.getElementById(id);
            const fileToBase64 = (file) => new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
    
            const render = {
                controls: () => {
                    el('mode-video').className = \`flex-1 py-2.5 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all \${state.mode === 'video' ? 'btn-active' : 'btn-inactive'}\`;
                    el('mode-image').className = \`flex-1 py-2.5 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all \${state.mode === 'image' ? 'btn-active' : 'btn-inactive'}\`;
                    if(state.mode === 'image') el('duration-block').classList.add('opacity-30', 'pointer-events-none');
                    else el('duration-block').classList.remove('opacity-30', 'pointer-events-none');
    
                    document.querySelectorAll('[data-ratio]').forEach(b => {
                        b.className = \`opt-btn py-2 rounded-lg text-xs font-bold \${b.dataset.ratio === state.ratio ? 'opt-active' : ''}\`;
                    });
                    document.querySelectorAll('[data-duration]').forEach(b => {
                        b.className = \`opt-btn flex-1 py-2 rounded-lg text-xs font-bold \${b.dataset.duration === state.duration ? 'opt-active' : ''}\`;
                    });
                },
                files: () => {
                    const zone = el('file-previews');
                    zone.innerHTML = '';
                    if(state.files.length > 0) {
                        zone.classList.remove('hidden');
                        el('upload-zone').classList.add('hidden');
                        el('btn-clear-files').classList.remove('hidden');
                        state.files.forEach(f => {
                            const div = document.createElement('div');
                            div.className = 'relative aspect-square bg-zinc-800 rounded overflow-hidden border border-zinc-700';
                            if(f.mimeType.startsWith('video')) {
                                div.innerHTML = \`<video src="\${f.preview}" class="w-full h-full object-cover opacity-60"></video><div class="absolute inset-0 flex items-center justify-center"><i data-lucide="video" class="w-4 h-4 text-white"></i></div>\`;
                            } else {
                                div.innerHTML = \`<img src="\${f.preview}" class="w-full h-full object-cover">\`;
                            }
                            zone.appendChild(div);
                        });
                    } else {
                        zone.classList.add('hidden');
                        el('upload-zone').classList.remove('hidden');
                        el('btn-clear-files').classList.add('hidden');
                    }
                    lucide.createIcons();
                },
                gallery: async () => {
                    const items = await db.getAll();
                    const container = el('gallery-container');
                    container.innerHTML = '';
                    if(items.length === 0) {
                        el('empty-state').classList.remove('hidden');
                        return;
                    }
                    el('empty-state').classList.add('hidden');
    
                    items.forEach(item => {
                        const isVideo = item.url.match(/\\.(mp4|webm)/) || item.model.includes('video');
                        const card = document.createElement('div');
                        card.className = 'group relative bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden cursor-pointer hover:border-zinc-600 transition-all duration-300';
                        card.onclick = () => app.openLightbox(item);
                        
                        const media = isVideo 
                            ? \`<video src="\${item.url}" class="w-full h-full object-cover" loop muted onmouseover="this.play()" onmouseout="this.pause()"></video><div class="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:opacity-0"><div class="w-10 h-10 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center"><i data-lucide="play" class="w-4 h-4 text-white fill-white"></i></div></div>\`
                            : \`<img src="\${item.url}" class="w-full h-full object-cover">\`;
    
                        card.innerHTML = \`
                            <div class="aspect-video w-full bg-zinc-950 relative">\${media}<div class="absolute bottom-2 right-2 px-1.5 py-0.5 bg-black/60 backdrop-blur-md rounded text-[10px] text-zinc-300 font-mono border border-white/10">\${item.model}</div></div>
                            <div class="p-4">
                                <p class="text-xs text-zinc-300 line-clamp-2 leading-relaxed">\${item.prompt || (item.type === 'video' ? 'Video Generation' : 'Image Generation')}</p>
                                <div class="mt-3 text-[10px] text-zinc-500">\${new Date(item.timestamp).toLocaleTimeString()}</div>
                            </div>
                        \`;
                        container.appendChild(card);
                    });
                    lucide.createIcons();
                },
                loading: () => {
                    const btn = el('btn-generate');
                    if(state.loading) {
                        btn.disabled = true;
                        btn.innerHTML = '<div class="loader"></div>';
                        btn.classList.add('bg-zinc-800', 'text-zinc-500', 'cursor-not-allowed');
                        btn.classList.remove('bg-white', 'text-black', 'hover:bg-indigo-50');
                    } else {
                        btn.disabled = false;
                        btn.innerHTML = '<i data-lucide="wand-2" class="w-4 h-4"></i> 生成内容';
                        btn.classList.remove('bg-zinc-800', 'text-zinc-500', 'cursor-not-allowed');
                        btn.classList.add('bg-white', 'text-black', 'hover:bg-indigo-50');
                        lucide.createIcons();
                    }
                    render.progress();
                },
                progress: () => {
                    const wrapper = el('progress-wrapper');
                    const bar = el('progress-bar');
                    const text = el('progress-text');
                    if (!wrapper || !bar || !text) return;
    
                    if (state.loading || state.progress > 0) {
                        wrapper.classList.remove('hidden');
                        bar.style.width = state.progress + '%';
                        text.textContent = state.progress + '%';
                    } else {
                        wrapper.classList.add('hidden');
                        bar.style.width = '0%';
                        text.textContent = '0%';
                    }
                },
                error: (msg) => {
                    const box = el('err-msg');
                    if(msg) {
                        box.classList.remove('hidden');
                        el('err-text').textContent = msg;
                    } else {
                        box.classList.add('hidden');
                    }
                }
            };
    
            const actions = {
                init: () => {
                    render.controls();
                    render.gallery();
                    render.progress();
                    lucide.createIcons();
                },
                setMode: (m) => { state.mode = m; state.files = []; render.files(); render.controls(); },
                setRatio: (r) => { state.ratio = r; render.controls(); },
                setDuration: (d) => { state.duration = d; render.controls(); },
                handleFileUpload: async (input) => {
                    const files = Array.from(input.files);
                    for(let f of files) {
                        const b64 = await fileToBase64(f);
                        state.files.push({ data: b64, mimeType: f.type, preview: URL.createObjectURL(f) });
                    }
                    render.files();
                    input.value = '';
                },
                clearFiles: () => { state.files = []; render.files(); },
                clearHistory: async () => { 
                    if(confirm('确定清空历史记录?')) { await db.clear(); render.gallery(); } 
                },
                submitPwd: () => {
                    const val = el('pwd-input').value.trim();
                    if(val) {
                        localStorage.setItem('sora_access_code', val);
                        el('pwd-modal').classList.add('hidden');
                        actions.generate();
                    }
                },
                generate: async () => {
                    const prompt = el('prompt-in').value.trim();
                    if (!prompt && state.files.length === 0) {
                        render.error("请输入提示词或上传参考文件");
                        return;
                    }
                    
                    const code = localStorage.getItem('sora_access_code');
                    if(!code) {
                        el('pwd-modal').classList.remove('hidden');
                        return;
                    }
    
                    state.progress = 0;
                    state.loading = true;
                    render.loading();
                    render.error(null);
    
                    // 构建 modelId
                    let modelId = 'sora-image';
                    if(state.mode === 'image') {
                        if(state.ratio === 'landscape') modelId = 'sora-image-landscape';
                        else if(state.ratio === 'portrait') modelId = 'sora-image-portrait';
                    } else {
                        let base = 'sora-video';
                        if(state.ratio !== 'square') base += \`-\${state.ratio}\`;
                        base += \`-\${state.duration}\`;
                        modelId = base;
                    }
    
                    try {
                        const payload = {
                            model: modelId,
                            prompt: prompt,
                            files: state.files.map(f => ({ mimeType: f.mimeType, data: f.data }))
                        };
    
                        const res = await fetch('/api/generate', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'x-access-code': code },
                            body: JSON.stringify(payload)
                        });
    
                        if (!res.ok && res.headers.get('Content-Type')?.includes('application/json')) {
                            const err = await res.json();
                            throw new Error(err.error || '请求失败');
                        }
    
                        // SSE 流解析
                        const reader = res.body.getReader();
                        const decoder = new TextDecoder();
                        let buffer = '';
                        let finalUrl = null;
    
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
    
                            buffer += decoder.decode(value, { stream: true });
                            const parts = buffer.split('\\n\\n');
                            buffer = parts.pop();
    
                            for (const part of parts) {
                                const line = part.trim();
                                if (!line.startsWith('data:')) continue;
                                const dataStr = line.slice(5).trim();
                                if (!dataStr) continue;
    
                                let evt;
                                try {
                                    evt = JSON.parse(dataStr);
                                } catch (e) {
                                    continue;
                                }
    
                                if (evt.type === 'progress') {
                                    const p = Math.max(0, Math.min(100, Number(evt.percent || 0)));
                                    if (p > state.progress) {
                                        state.progress = p;
                                        render.progress();
                                    }
                                } else if (evt.type === 'result') {
                                    finalUrl = evt.url; // 现在是 Sora 的真实 URL
                                    state.progress = 100;
                                    render.progress();
                                } else if (evt.type === 'error') {
                                    throw new Error(evt.message || '生成失败');
                                }
                            }
                        }
    
                        if (!finalUrl) {
                            throw new Error('生成完成但未返回视频地址');
                        }
    
                        await db.add({
                            id: crypto.randomUUID(),
                            url: finalUrl,
                            prompt: prompt,
                            model: modelId,
                            type: state.mode,
                            timestamp: Date.now()
                        });
    
                        el('prompt-in').value = '';
                        actions.clearFiles();
                        await render.gallery();
    
                    } catch (e) {
                        render.error(e.message);
                    } finally {
                        state.loading = false;
                        render.loading();
                        setTimeout(() => {
                            if (!state.loading) {
                                state.progress = 0;
                                render.progress();
                            }
                        }, 800);
                    }
                },
                openLightbox: (item) => {
                    state.currentItem = item;
                    const box = el('lightbox-media');
                    const isVideo = item.url.match(/\\.(mp4|webm)/) || item.model.includes('video');
                    box.innerHTML = isVideo 
                        ? \`<video src="\${item.url}" controls autoplay loop class="max-h-[80vh] w-auto rounded-lg shadow-2xl border border-zinc-800"></video>\`
                        : \`<img src="\${item.url}" class="max-h-[80vh] object-contain rounded-lg shadow-2xl border border-zinc-800">\`;
                    el('lightbox-text').textContent = item.prompt;
                    el('lightbox').classList.remove('hidden');
                },
                closeLightbox: () => {
                    el('lightbox').classList.add('hidden');
                    el('lightbox-media').innerHTML = '';
                    state.currentItem = null;
                },
                downloadCurrent: () => {
                    if(!state.currentItem) return;
                    const link = document.createElement('a');
                    link.href = state.currentItem.url;
                    const isVideo = state.currentItem.url.match(/\\.(mp4|webm)/) || state.currentItem.model.includes('video');
                    link.download = \`sora-\${state.currentItem.id}.\${isVideo ? 'mp4' : 'png'}\`;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                }
            };
    
            return actions;
        })();
    
        window.onload = app.init;
        </script>
    </body>
    </html>
  `;
  
