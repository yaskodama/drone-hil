document.body.innerHTML = `
<div style="padding:16px;">
  <h2>Browser AIPL</h2>
  <button id="openBrowserConsole">Open Browser Console</button>
</div>
`;

document.getElementById("openBrowserConsole").onclick = () => {
  const w = window.open("", "_blank", "width=1000,height=700");
  if (!w) return;
  w.document.open();
  w.document.write(`
<!doctype html>
<html>
<head><meta charset="utf-8"><title>Browser ABCL Console</title></head>
<body>
  <script type="module" src="/src/ui/console_browser.js"></script>
</body>
</html>
`);
  w.document.close();
};
