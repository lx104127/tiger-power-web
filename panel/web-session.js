// No wallet credentials are stored in the browser. Expired website sessions go
// back to the access screen before any further wallet operation can be made.
(() => {
  const originalFetch = window.fetch.bind(window);
  const clearPrivateCache = () => { for (const key of ["walletsCache", "sendRecent"]) localStorage.removeItem(key); };
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (response.status === 401 && new URL(response.url).origin === location.origin) {
      clearPrivateCache(); location.replace("/login"); throw new Error("网站登录已过期");
    }
    return response;
  };
  document.addEventListener("DOMContentLoaded", () => {
    const top = document.querySelector(".top");
    if (!top) return;
    const style = document.createElement("style");
    style.textContent = ".top{height:auto;min-height:50px;flex:0 0 auto;flex-wrap:wrap}.site-lock{flex:0 0 auto;white-space:nowrap}";
    document.head.appendChild(style);
    const button = document.createElement("button");
    button.textContent = "锁定网站"; button.className = "setbtn site-lock"; button.type = "button";
    button.title = "退出网站访问，不退出 Binance 钱包";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const html = await originalFetch(location.pathname, { cache: "no-store" }).then(r => r.text());
        const token = html.match(/const TOKEN_INIT = "([a-f0-9]{48})"/)?.[1];
        if (!token) { clearPrivateCache(); return location.replace("/login"); }
        const response = await originalFetch("/auth/logout", { method: "POST", headers: { "content-type": "application/json", "x-panel-token": token }, body: "{}" });
        if (!response.ok) throw new Error("锁定失败，请重试");
        clearPrivateCache(); location.replace("/login");
      } catch { button.textContent = "重试锁定"; button.disabled = false; }
    });
    top.appendChild(button);
  });
})();
