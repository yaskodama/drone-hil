document.addEventListener("DOMContentLoaded", () => {
  document.body.innerHTML = `
  <div style="padding:16px;font-family:monospace;">
    <h2>Browser AIPL</h2>
    <p style="color:#555;">Actor-based concurrent programs running in the browser.</p>
    <h3>Demos</h3>
    <ul>
      <li><a href="/rotate4lines.html">Rotate 4 Lines</a> &mdash; four actor threads rotating lines around square vertices (setTimeout)</li>
      <li><a href="/rotate4lines_workers.html">Rotate 4 Lines (Web Worker threads)</a> &mdash; same demo, each actor in its own Worker (real OS threads)</li>
      <li><a href="/cooperative_chat.html">AI Cooperative Chat</a> &mdash; Planner / Solver / Reviewer の 3 役協調を吹き出しで可視化 (now/future/await + AI mock)</li>
      <li><a href="/cooperative_solve.html">協調問題解決ワークスペース</a> &mdash; Console+Chat+Source 一体型で協調プログラムを書いて実行</li>
      <li><a href="/philosophers.html">5 Dining Philosophers</a> &mdash; deadlock-free with resource hierarchy</li>
      <li><a href="/bounded_buffer.html">Bounded Buffer</a> &mdash; producer / consumer with capacity 4</li>
      <li><a href="/drone_simulator.html">Drone Return-Route Simulator</a> &mdash; MANET-style obstacle diffusion</li>
    </ul>
    <h3>Local Generative AI</h3>
    <ul>
      <li><a href="http://127.0.0.1:7861/" target="_blank">Local Generative AI</a> &mdash; local LLM chat (Ollama: gemma3 / llama3.2 / gemma2), runs entirely on this machine</li>
    </ul>
    <h3>Console</h3>
    <button id="openBrowserConsole">Open Browser Console</button>
  </div>
  `;
  document.getElementById("openBrowserConsole").onclick = () => {
    window.open("/browser_console.html", "_blank", "width=1000,height=700");
  };
});
