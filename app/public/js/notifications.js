(() => {
    async function fetchUnread() {
      try {
        const res = await fetch('/api/notificacoes/nao-lidas', { headers: { 'Accept': 'application/json' } });
        if (!res.ok) return 0;
        const data = await res.json();
        return Number(data.count || 0);
      } catch (_) { return 0; }
    }
  
    function ensureBadge() {
      let link = document.querySelector('a[href="/minhas-notificacoes"]');
      if (!link) return null;
      let badge = link.querySelector('.notif-nav-badge');
      if (!badge) {
        badge = document.createElement('output');
        badge.className = 'notif-nav-badge';
        badge.style.cssText = 'background:#e74c3c;color:#fff;border-radius:999px;padding:1px 6px;font-size:.72rem;margin-left:6px;display:none;vertical-align:middle;';
        link.appendChild(badge);
      }
      return badge;
    }
  
    async function refreshBadge() {
      const badge = ensureBadge();
      if (!badge) return;
      const count = await fetchUnread();
      badge.textContent = String(count);
      badge.style.display = count > 0 ? 'inline-block' : 'none';
    }
  
    function injectToast(n) {
      let container = document.getElementById('notif-toast-container');
      if (!container) {
        container = document.createElement('section');
        container.id = 'notif-toast-container';
        container.style.cssText = 'position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:10px;max-width:min(360px,calc(100vw - 32px));';
        document.body.appendChild(container);
      }
      const meta = n.meta || { label: n.tipo || 'Notificação', icon: 'fa-bell', cor: '#800020' };
      const toast = document.createElement('section');
      toast.style.cssText = `background:#fff;border-left:5px solid ${meta.cor};box-shadow:0 8px 24px rgba(0,0,0,.15);border-radius:10px;padding:12px 14px;font-family:Poppins,sans-serif;animation:notifSlideIn .25s ease;`;
      toast.innerHTML = `<section style="font-weight:700;color:${meta.cor};margin-bottom:4px;"><i class="fas ${meta.icon}"></i> ${meta.label}</section><section style="font-size:.92rem;color:#333;line-height:1.4;"></section>${n.link_relacionado ? `<a href="${n.link_relacionado}" style="display:inline-block;margin-top:8px;font-size:.85rem;color:#800020;font-weight:600;text-decoration:none;">Abrir</a>`:''}`;
      toast.querySelector('section:nth-child(2)').textContent = n.mensagem || '';
      container.appendChild(toast);
      setTimeout(() => { toast.style.opacity='0'; toast.style.transition='opacity .3s'; setTimeout(()=>toast.remove(),300); }, 6000);
    }
  
    function connectSocket() {
      if (typeof io === 'undefined') return;
      try {
        const socket = io();
        socket.on('notification:new', (n) => { injectToast(n); refreshBadge(); });
      } catch (_) {}
    }
  
    function init() {
      if (!document.getElementById('notif-toast-style')) {
        const style = document.createElement('style');
        style.id = 'notif-toast-style';
        style.textContent = '@keyframes notifSlideIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}';
        document.head.appendChild(style);
      }
      refreshBadge();
      if (typeof io !== 'undefined') connectSocket();
      else {
        const s = document.createElement('script');
        s.src = '/socket.io/socket.io.js';
        s.onload = connectSocket;
        document.body.appendChild(s);
      }
    }
  
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  })();
  