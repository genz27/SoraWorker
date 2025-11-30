/**
 * SoraWeb - Cloudflare Worker Version
 * 
 * 部署说明:
 * 1. 在 Cloudflare Workers 创建一个新 Worker。
 * 2. 将此代码粘贴到 worker.js。
 * 3. 在 Settings -> Variables and Secrets 中添加变量:
 *    - SORA_API_KEY: (必填) 您的 API Key (例如: han1234)
 *    - ACCESS_CODE: (可选) 设置访问密码
 *    - SORA_BASE_URL: (可选) API Base URL，默认为 http://localhost:8000 (请务必修改为您实际的 API 地址)
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. 处理 API 请求
    if (request.method === 'POST' && url.pathname === '/api/generate') {
      return await handleGenerateRequest(request, env);
    }

    // 2. 处理前端页面请求
    return new Response(HTML_CONTENT, {
      headers: {
        'Content-Type': 'text/html;charset=UTF-8',
      },
    });
  },
};

/**
 * 处理生成请求，调用 Sora API (OpenAI 格式)
 */
async function handleGenerateRequest(request, env) {
  // 1. 检查 API Key
  if (!env.SORA_API_KEY) {
    return new Response(JSON.stringify({ error: '服务端未配置 SORA_API_KEY' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 2. 检查访问密码
  if (env.ACCESS_CODE) {
    const authHeader = request.headers.get('x-access-code');
    if (!authHeader || authHeader !== env.ACCESS_CODE) {
      return new Response(JSON.stringify({ error: '访问密码错误或未授权', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  try {
    const { model, prompt, files } = await request.json();

    // 3. 构建 API URL
    const baseUrl = env.SORA_BASE_URL || 'http://localhost:8000';
    const cleanBaseUrl = baseUrl.replace(/\/$/, '');
    const apiUrl = `${cleanBaseUrl}/v1/chat/completions`;

    // 4. 构建 OpenAI 格式的消息体
    const content = [];

    // 处理文件输入 (图片或视频)
    if (files && Array.isArray(files) && files.length > 0) {
      files.forEach(file => {
        if (file.mimeType.startsWith('image/')) {
          content.push({
            type: "image_url",
            image_url: {
              url: `data:${file.mimeType};base64,${file.data}`
            }
          });
        } else if (file.mimeType.startsWith('video/')) {
          content.push({
            type: "video_url",
            video_url: {
              url: `data:${file.mimeType};base64,${file.data}`
            }
          });
        }
      });
    }

    // 处理文本提示词
    // 注意：如果是 Remix 模式（prompt是URL），直接作为文本发送
    if (prompt) {
      content.push({
        type: "text",
        text: prompt
      });
    }

    // 如果 content 只有一个纯文本元素，简化结构（兼容某些 API 实现）
    let finalContent = content;
    if (content.length === 1 && content[0].type === 'text') {
       finalContent = content[0].text;
    }

    const payload = {
      model: model,
      messages: [
        {
          role: "user",
          content: finalContent
        }
      ],
      stream: false //为了简化 Worker 处理，这里尝试使用非流式。如果后端强制流式，需要修改此处逻辑解析 SSE。
    };

    const apiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.SORA_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      try {
        const errJson = JSON.parse(errorText);
        throw new Error(errJson.error?.message || errorText);
      } catch (e) {
        throw new Error(`API Error (${apiResponse.status}): ${errorText}`);
      }
    }

    const data = await apiResponse.json();
    
    // 解析 OpenAI 格式响应
    // 通常内容在 choices[0].message.content
    // Sora API 可能返回 markdown 格式的 URL，或者直接 URL
    let resultUrl = '';
    const messageContent = data.choices?.[0]?.message?.content;

    if (messageContent) {
        // 尝试提取 URL (简单的正则匹配 http/https)
        const urlMatch = messageContent.match(/https?:\/\/[^\s)]+/);
        if (urlMatch) {
            resultUrl = urlMatch[0];
        } else {
            // 如果没找到 URL，可能返回了错误信息或纯文本
            resultUrl = messageContent; 
        }
    } else {
        throw new Error('API 返回成功但未包含有效内容');
    }

    return new Response(JSON.stringify({ 
        url: resultUrl,
        raw: messageContent 
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
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
    <link rel="icon" type="image/svg+xml" href="https://upload.wikimedia.org/wikipedia/commons/4/4d/OpenAI_Logo.svg" />
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&display=swap');
      body { font-family: 'Inter', sans-serif; background-color: #09090b; color: #f4f4f5; }
      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: #27272a; border-radius: 3px; }
      ::-webkit-scrollbar-thumb:hover { background: #3f3f46; }
      @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      .animate-fadeIn { animation: fadeIn 0.3s ease-out forwards; }
      .glass-panel { background: rgba(24, 24, 27, 0.6); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1); }
    </style>
    <!-- React & Babel -->
    <script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <!-- Lucide Icons -->
    <script src="https://unpkg.com/lucide@latest"></script>
</head>
<body>
    <div id="root"></div>

    <script type="text/babel">
        const { useState, useEffect, useRef } = React;

        // --- IndexedDB Manager ---
        const DB_NAME = 'SoraWebDB';
        const DB_VERSION = 1;
        const STORE_NAME = 'generations';

        const dbHelper = {
          open: () => {
            return new Promise((resolve, reject) => {
              const request = indexedDB.open(DB_NAME, DB_VERSION);
              request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                  db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                }
              };
              request.onsuccess = (event) => resolve(event.target.result);
              request.onerror = (event) => reject(event.target.error);
            });
          },
          add: async (item) => {
            const db = await dbHelper.open();
            return new Promise((resolve, reject) => {
              const tx = db.transaction(STORE_NAME, 'readwrite');
              const store = tx.objectStore(STORE_NAME);
              const req = store.add(item);
              req.onsuccess = () => resolve(true);
              req.onerror = () => reject(req.error);
            });
          },
          getAll: async () => {
            const db = await dbHelper.open();
            return new Promise((resolve, reject) => {
              const tx = db.transaction(STORE_NAME, 'readonly');
              const store = tx.objectStore(STORE_NAME);
              const req = store.getAll();
              req.onsuccess = () => resolve(req.result.reverse());
              req.onerror = () => reject(req.error);
            });
          },
          clear: async () => {
             const db = await dbHelper.open();
             return new Promise((resolve, reject) => {
               const tx = db.transaction(STORE_NAME, 'readwrite');
               const store = tx.objectStore(STORE_NAME);
               const req = store.clear();
               req.onsuccess = () => resolve(true);
               req.onerror = () => reject(req.error);
             });
          }
        };

        // --- Constants & Config ---
        const MODE = {
            IMAGE: 'image',
            VIDEO: 'video'
        };

        const ORIENTATION = {
            SQUARE: 'square',
            LANDSCAPE: 'landscape',
            PORTRAIT: 'portrait'
        };

        const DURATION = {
            D10: '10s',
            D15: '15s'
        };

        const Icons = {
            Video: (props) => <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg>,
            Image: (props) => <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>,
            Wand2: (props) => <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/></svg>,
            Trash2: (props) => <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>,
            Upload: (props) => <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>,
            X: (props) => <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 18 18"/></svg>,
            Github: (props) => <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>,
            Download: (props) => <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>,
            Lock: (props) => <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>,
            AlertCircle: (props) => <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>,
            Clapperboard: (props) => <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.2 6 3 11l-.9-2.4c-.5-1.1.2-2.3 1.3-2.8l3.2-1.4c1.1-.5 2.3.2 2.8 1.3l.9 2.4"/><path d="m8.8 16.4 1.3-3.3"/><path d="m15.3 13.8 1.3-3.3"/><path d="M4 11v9.8c0 1.2 1.1 2.2 2.3 2.2h15.4c1.2 0 2.3-1.1 2.3-2.2V11"/></svg>,
            Play: (props) => <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        };

        const fileToBase64 = (file) => {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                   const result = reader.result;
                   const base64 = result.split(',')[1];
                   resolve(base64);
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        };

        function App() {
            // State
            const [prompt, setPrompt] = useState('');
            const [mode, setMode] = useState(MODE.VIDEO); // image | video
            const [orientation, setOrientation] = useState(ORIENTATION.LANDSCAPE);
            const [duration, setDuration] = useState(DURATION.D10);
            const [referenceFiles, setReferenceFiles] = useState([]); // Can be images or videos
            
            const [history, setHistory] = useState([]);
            const [error, setError] = useState(null);
            const [pendingRequests, setPendingRequests] = useState([]);
            
            // Modal States
            const [selectedItem, setSelectedItem] = useState(null);
            const [showPasswordModal, setShowPasswordModal] = useState(false);
            const [accessCodeInput, setAccessCodeInput] = useState('');

            useEffect(() => {
                dbHelper.getAll().then(setHistory).catch(console.error);
            }, []);

            const handleFileUpload = (e) => {
                if (e.target.files && e.target.files.length > 0) {
                    setReferenceFiles(prev => [...prev, ...Array.from(e.target.files)]);
                }
                e.target.value = '';
            };

            const getModelId = () => {
                // Logic to map selections to API Model IDs
                if (mode === MODE.IMAGE) {
                    if (orientation === ORIENTATION.LANDSCAPE) return 'sora-image-landscape';
                    if (orientation === ORIENTATION.PORTRAIT) return 'sora-image-portrait';
                    return 'sora-image';
                } else {
                    // Video Mode
                    let base = 'sora-video';
                    if (orientation !== ORIENTATION.SQUARE) base += `-${orientation}`;
                    base += `-${duration}`;
                    return base;
                }
            };

            const checkAndGenerate = () => {
                const savedCode = localStorage.getItem('sora_access_code');
                if (savedCode) {
                    doGenerate(savedCode);
                } else {
                    setShowPasswordModal(true);
                }
            };

            const handlePasswordSubmit = () => {
                if (accessCodeInput.trim()) {
                    localStorage.setItem('sora_access_code', accessCodeInput.trim());
                    setShowPasswordModal(false);
                    doGenerate(accessCodeInput.trim());
                }
            };

            const doGenerate = async (code) => {
                if (!prompt.trim() && referenceFiles.length === 0) {
                    setError("请输入提示词或上传参考文件");
                    return;
                }
                setError(null);

                const modelId = getModelId();
                const tempId = crypto.randomUUID();
                const newPending = {
                    id: tempId,
                    prompt: prompt,
                    timestamp: Date.now(),
                    model: modelId,
                    type: mode
                };

                setPendingRequests(prev => [newPending, ...prev]);

                try {
                    const filesPayload = await Promise.all(referenceFiles.map(async (file) => ({
                        data: await fileToBase64(file),
                        mimeType: file.type
                    })));

                    const response = await fetch('/api/generate', {
                        method: 'POST',
                        headers: { 
                            'Content-Type': 'application/json',
                            'x-access-code': code || '' 
                        },
                        body: JSON.stringify({
                            model: modelId,
                            prompt: prompt,
                            files: filesPayload
                        })
                    });

                    const data = await response.json();

                    if (response.status === 401) {
                        localStorage.removeItem('sora_access_code');
                        setShowPasswordModal(true);
                        setAccessCodeInput('');
                        setError("访问密码错误，请重新输入");
                        setPendingRequests(prev => prev.filter(p => p.id !== tempId));
                        return;
                    }

                    if (!response.ok) {
                        throw new Error(data.error || '请求失败');
                    }

                    const newItem = {
                        id: crypto.randomUUID(),
                        url: data.url,
                        prompt: newPending.prompt,
                        model: newPending.model,
                        type: mode,
                        timestamp: Date.now()
                    };

                    await dbHelper.add(newItem);
                    setHistory(prev => [newItem, ...prev]);

                } catch (err) {
                    console.error(err);
                    setError(err.message || "生成失败");
                } finally {
                    setPendingRequests(prev => prev.filter(p => p.id !== tempId));
                }
            };

            const downloadItem = (url, id, type) => {
                const link = document.createElement('a');
                link.href = url;
                link.download = `sora-${id}.${type === 'video' ? 'mp4' : 'png'}`;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            };

            return (
                <div className="min-h-screen pb-12">
                    {/* Password Modal */}
                    {showPasswordModal && (
                        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/90 backdrop-blur-sm p-4">
                            <div className="bg-zinc-900 p-8 w-full max-w-sm border border-zinc-800 rounded-2xl shadow-2xl">
                                <div className="flex flex-col items-center gap-4 mb-6">
                                    <div className="p-3 bg-indigo-600 text-white rounded-full shadow-lg shadow-indigo-500/20">
                                        <Icons.Lock className="w-6 h-6" />
                                    </div>
                                    <h3 className="text-xl font-bold text-white">需要访问密码</h3>
                                </div>
                                <input
                                    type="password"
                                    value={accessCodeInput}
                                    onChange={(e) => setAccessCodeInput(e.target.value)}
                                    placeholder="输入访问密码"
                                    className="w-full p-3 bg-zinc-950 border border-zinc-800 rounded-lg mb-4 text-center text-white focus:outline-none focus:border-indigo-500 transition-colors"
                                    onKeyDown={(e) => e.key === 'Enter' && handlePasswordSubmit()}
                                />
                                <button 
                                    onClick={handlePasswordSubmit}
                                    className="w-full bg-indigo-600 text-white py-3 font-bold rounded-lg hover:bg-indigo-500 transition-colors"
                                >
                                    解锁
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Lightbox */}
                    {selectedItem && (
                        <div 
                            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 backdrop-blur-md p-4 animate-fadeIn"
                            onClick={() => setSelectedItem(null)}
                        >
                            <button 
                                className="absolute top-6 right-6 text-zinc-400 hover:text-white transition-colors"
                                onClick={() => setSelectedItem(null)}
                            >
                                <Icons.X className="w-8 h-8" />
                            </button>
                            
                            <div className="max-w-5xl w-full flex flex-col items-center" onClick={e => e.stopPropagation()}>
                                {selectedItem.url.match(/\.(mp4|webm)/) || selectedItem.model.includes('video') ? (
                                    <video 
                                        src={selectedItem.url} 
                                        controls 
                                        autoPlay 
                                        loop
                                        className="max-h-[80vh] w-auto rounded-lg shadow-2xl shadow-indigo-900/20 border border-zinc-800"
                                    />
                                ) : (
                                    <img 
                                        src={selectedItem.url} 
                                        className="max-h-[80vh] object-contain rounded-lg shadow-2xl border border-zinc-800" 
                                    />
                                )}
                                
                                <div className="mt-6 flex gap-4">
                                    <button 
                                        onClick={() => downloadItem(selectedItem.url, selectedItem.id, selectedItem.type)} 
                                        className="bg-white text-black px-6 py-2.5 font-bold rounded-full flex items-center gap-2 hover:bg-zinc-200 transition-colors"
                                    >
                                        <Icons.Download className="w-4 h-4" />
                                        下载
                                    </button>
                                </div>
                                <p className="mt-4 text-zinc-500 text-sm max-w-2xl text-center">{selectedItem.prompt}</p>
                            </div>
                        </div>
                    )}

                    {/* Header */}
                    <header className="fixed top-0 left-0 right-0 h-16 bg-zinc-950/80 backdrop-blur-md border-b border-zinc-800 z-40 px-6 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="w-8 h-8 bg-gradient-to-tr from-indigo-600 to-purple-600 text-white flex items-center justify-center rounded-lg">
                                <Icons.Clapperboard className="w-5 h-5" />
                            </div>
                            <h1 className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-zinc-400">SoraWeb</h1>
                        </div>
                        <div className="flex items-center gap-4">
                            <a href="https://github.com/openai/sora" target="_blank" className="flex items-center gap-2 text-zinc-400 hover:text-white transition-colors">
                                <Icons.Github className="w-5 h-5" />
                            </a>
                        </div>
                    </header>

                    <main className="pt-24 px-4 md:px-6 max-w-[1600px] mx-auto flex flex-col lg:flex-row gap-8">
                        {/* Sidebar Controls */}
                        <div className="w-full lg:w-[400px] flex-shrink-0 space-y-6">
                            
                            {/* Mode Toggle */}
                            <div className="glass-panel p-1 rounded-xl flex gap-1">
                                <button
                                    onClick={() => { setMode(MODE.VIDEO); setReferenceFiles([]); }}
                                    className={`flex-1 py-2.5 px-4 rounded-lg flex items-center justify-center gap-2 text-sm font-bold transition-all ${mode === MODE.VIDEO ? 'bg-zinc-800 text-white shadow-lg' : 'text-zinc-400 hover:text-zinc-200'}`}
                                >
                                    <Icons.Video className="w-4 h-4" /> 视频生成
                                </button>
                                <button
                                    onClick={() => { setMode(MODE.IMAGE); setReferenceFiles([]); }}
                                    className={`flex-1 py-2.5 px-4 rounded-lg flex items-center justify-center gap-2 text-sm font-bold transition-all ${mode === MODE.IMAGE ? 'bg-zinc-800 text-white shadow-lg' : 'text-zinc-400 hover:text-zinc-200'}`}
                                >
                                    <Icons.Image className="w-4 h-4" /> 图像生成
                                </button>
                            </div>

                            <div className="glass-panel p-6 rounded-2xl space-y-6">
                                {/* Parameters */}
                                <div>
                                   <label className="text-xs font-bold uppercase text-zinc-500 mb-3 block">画面比例</label>
                                   <div className="grid grid-cols-3 gap-2">
                                     {['landscape', 'portrait', 'square'].map((o) => (
                                       <button
                                         key={o}
                                         onClick={() => setOrientation(o)}
                                         disabled={mode === MODE.IMAGE && o === 'square' && false /* Image supports square usually, API says default 360x360 */}
                                         className={`py-2 rounded-lg text-xs font-bold border transition-all ${
                                           orientation === o
                                           ? 'bg-indigo-600/20 text-indigo-300 border-indigo-500/50'
                                           : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700'
                                         }`}
                                       >
                                         {o === 'landscape' ? '16:9' : o === 'portrait' ? '9:16' : '1:1'}
                                       </button>
                                     ))}
                                   </div>
                                </div>

                                {mode === MODE.VIDEO && (
                                    <div className="animate-fadeIn">
                                       <label className="text-xs font-bold uppercase text-zinc-500 mb-3 block">视频时长</label>
                                       <div className="flex gap-2">
                                         {['10s', '15s'].map((d) => (
                                           <button
                                             key={d}
                                             onClick={() => setDuration(d)}
                                             className={`flex-1 py-2 rounded-lg text-xs font-bold border transition-all ${
                                               duration === d
                                               ? 'bg-indigo-600/20 text-indigo-300 border-indigo-500/50'
                                               : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700'
                                             }`}
                                           >
                                             {d}
                                           </button>
                                         ))}
                                       </div>
                                    </div>
                                )}

                                {/* Reference Upload */}
                                <div>
                                   <label className="text-xs font-bold uppercase text-zinc-500 mb-3 block flex justify-between items-center">
                                     <span>参考内容 (图生视频/角色/Remix)</span>
                                     {referenceFiles.length > 0 && (
                                       <button onClick={() => setReferenceFiles([])} className="text-red-400 text-xs hover:text-red-300 flex items-center gap-1">
                                         <Icons.Trash2 className="w-3 h-3" /> 清除
                                       </button>
                                     )}
                                   </label>
                                   
                                   <div className="space-y-3">
                                       <div className="relative group">
                                         <input 
                                           id="file-upload"
                                           type="file" 
                                           multiple
                                           accept="image/*,video/*" 
                                           onChange={handleFileUpload}
                                           className="hidden"
                                         />
                                         <label 
                                           htmlFor="file-upload"
                                           className="w-full h-24 flex flex-col items-center justify-center gap-2 border border-dashed border-zinc-700 rounded-xl cursor-pointer hover:bg-zinc-800/50 hover:border-zinc-500 transition-all"
                                         >
                                            <Icons.Upload className="w-5 h-5 text-zinc-500 group-hover:text-zinc-300" />
                                            <span className="text-xs text-zinc-500 group-hover:text-zinc-300 font-medium">点击上传图片或视频</span>
                                         </label>
                                       </div>

                                       {referenceFiles.length > 0 && (
                                         <div className="grid grid-cols-4 gap-2">
                                           {referenceFiles.map((file, idx) => (
                                             <div key={idx} className="relative aspect-square rounded-lg overflow-hidden border border-zinc-700 bg-zinc-900 group">
                                               {file.type.startsWith('video') ? (
                                                   <video src={URL.createObjectURL(file)} className="w-full h-full object-cover opacity-60" />
                                               ) : (
                                                   <img src={URL.createObjectURL(file)} className="w-full h-full object-cover opacity-80" />
                                               )}
                                               <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                                   {file.type.startsWith('video') && <Icons.Video className="w-4 h-4 text-white drop-shadow-md" />}
                                               </div>
                                             </div>
                                           ))}
                                         </div>
                                       )}
                                   </div>
                                </div>
                            </div>

                            {/* Prompt Input */}
                            <div className="space-y-4">
                                <textarea
                                    value={prompt}
                                    onChange={(e) => setPrompt(e.target.value)}
                                    placeholder="描述你想要生成的视频内容..."
                                    className="w-full h-32 p-4 bg-zinc-900 border border-zinc-800 rounded-2xl focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500 focus:outline-none transition-all text-sm placeholder:text-zinc-600 resize-none"
                                />
                                
                                {error && (
                                  <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-2 text-red-400">
                                    <Icons.AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                                    <p className="text-xs">{error}</p>
                                  </div>
                                )}

                                <button
                                  onClick={checkAndGenerate}
                                  disabled={pendingRequests.length > 0}
                                  className={`w-full py-4 font-bold text-sm uppercase tracking-wider flex items-center justify-center gap-2 rounded-xl transition-all ${
                                      pendingRequests.length > 0 
                                      ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed' 
                                      : 'bg-white text-black hover:bg-indigo-50 hover:scale-[1.02] shadow-[0_0_20px_-5px_rgba(255,255,255,0.3)]'
                                  }`}
                                >
                                  {pendingRequests.length > 0 ? (
                                      <>Wait...</>
                                  ) : (
                                      <>
                                        <Icons.Wand2 className="w-4 h-4" /> 生成内容
                                      </>
                                  )}
                                </button>
                            </div>
                        </div>

                        {/* Gallery Grid */}
                        <div className="flex-1 min-w-0">
                          <div className="mb-6 flex items-center justify-between">
                            <h2 className="text-2xl font-bold text-white">历史记录</h2>
                            <button onClick={() => { if(confirm('确定清空历史记录?')) dbHelper.clear().then(() => setHistory([])); }} className="text-xs text-zinc-500 hover:text-red-400 transition-colors">
                                清空历史
                            </button>
                          </div>

                          {(history.length === 0 && pendingRequests.length === 0) ? (
                            <div className="h-[400px] flex flex-col items-center justify-center border border-dashed border-zinc-800 rounded-2xl bg-zinc-900/30">
                              <div className="w-16 h-16 rounded-full bg-zinc-900 flex items-center justify-center mb-4">
                                <Icons.Video className="w-8 h-8 text-zinc-700" />
                              </div>
                              <p className="font-medium text-zinc-500">暂无生成记录</p>
                            </div>
                          ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                              
                              {/* Pending Cards */}
                              {pendingRequests.map((req) => (
                                <div key={req.id} className="relative aspect-video bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden flex flex-col items-center justify-center gap-3">
                                    <div className="absolute inset-0 bg-gradient-to-tr from-indigo-500/10 to-purple-500/10 animate-pulse"></div>
                                    <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                                    <p className="text-xs font-medium text-zinc-400 relative z-10">正在生成中...</p>
                                </div>
                              ))}

                              {/* History Items */}
                              {history.map((item) => (
                                <div 
                                    key={item.id} 
                                    className="group relative bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden cursor-pointer hover:border-zinc-600 transition-all duration-300"
                                    onClick={() => setSelectedItem(item)}
                                >
                                  <div className="aspect-video w-full bg-zinc-950 relative">
                                    {item.url.match(/\.(mp4|webm)/) || item.model.includes('video') ? (
                                        <div className="w-full h-full flex items-center justify-center bg-zinc-950">
                                            <video src={item.url} className="w-full h-full object-cover" muted loop onMouseOver={e => e.target.play()} onMouseOut={e => e.target.pause()} />
                                            <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:opacity-0 transition-opacity">
                                                <div className="w-10 h-10 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
                                                    <Icons.Play className="w-4 h-4 text-white fill-white" />
                                                </div>
                                            </div>
                                        </div>
                                    ) : (
                                        <img src={item.url} alt="Generated" className="w-full h-full object-cover" />
                                    )}
                                    <div className="absolute bottom-2 right-2 px-1.5 py-0.5 bg-black/60 backdrop-blur-md rounded text-[10px] text-zinc-300 font-mono border border-white/10">
                                        {item.model}
                                    </div>
                                  </div>
                                  
                                  <div className="p-4">
                                    <p className="text-xs text-zinc-300 line-clamp-2 leading-relaxed">
                                      {item.prompt || (item.type === MODE.VIDEO ? 'Video Generation' : 'Image Generation')}
                                    </p>
                                    <div className="mt-3 flex items-center justify-between text-zinc-500 text-[10px]">
                                        <span>{new Date(item.timestamp).toLocaleTimeString()}</span>
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                    </main>
                </div>
            );
        }

        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(<App />);
    </script>
</body>
</html>
`