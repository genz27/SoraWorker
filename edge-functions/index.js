// 文件路径 ./edge-functions/api/hello.js
// 访问路径 example.com/api/hello
export default function onRequest(context) {
  return new Response('Hello from Edge Functions!');
}
