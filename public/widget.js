/**
 * Zempotis Chat — Premium Embeddable Widget v2.0
 *
 *   <script src="https://chatbot-product-flax.vercel.app/widget.js" data-client="clientId" async></script>
 *
 * v2.0 changes:
 *  • Lead capture moved to optional footer button (no mid-conversation interruption)
 *  • Full brand theming — header gradient, bubbles, chips, pulse all driven by client colours
 *  • Auto dark/light theme based on primary colour luminance
 *  • Inter font throughout
 *  • Fade-in animation on every new message
 *  • Notification badge updates when minimised and bot replies
 *  • Chat history per session (sessionStorage)
 */
(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────────
  var SCRIPT_TAG = document.currentScript ||
    document.querySelector('script[src*="widget.js"][data-client]') ||
    document.querySelector('script[src*="widget.js"]');
  var CLIENT_ID = (typeof window !== 'undefined' && window.ZEMPOTIS_CLIENT_ID)
    || (SCRIPT_TAG && SCRIPT_TAG.getAttribute('data-client'))
    || null;
  var API_BASE = 'https://chatbot-product-flax.vercel.app';

  if (!CLIENT_ID) {
    console.warn('[Zempotis] Missing data-client attribute.');
    return;
  }

  // ── State ─────────────────────────────────────────────────────────────────
  var state = {
    isOpen: false,
    isMinimised: false,
    messages: [],
    config: null,
    unreadCount: 0,
    leadCaptured: false,
    leadFormVisible: false,
    quickRepliesVisible: true,
  };

  var STORAGE_KEY = 'zempotis_' + CLIENT_ID;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function hexLuminance(hex) {
    hex = String(hex).replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return 0.2; // default dark
    var r = parseInt(hex.slice(0,2),16)/255;
    var g = parseInt(hex.slice(2,4),16)/255;
    var b = parseInt(hex.slice(4,6),16)/255;
    return 0.299*r + 0.587*g + 0.114*b;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function formatTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function saveHistory() {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state.messages.slice(-60))); } catch (_) {}
  }

  function loadHistory() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) state.messages = JSON.parse(raw);
    } catch (_) {}
  }

  // ── Styles ────────────────────────────────────────────────────────────────
  function injectStyles(primary, accent, dark) {
    // Theme tokens
    var winBg      = dark ? 'rgba(13,13,22,0.94)'      : 'rgba(255,255,255,0.97)';
    var winBorder  = dark ? 'rgba(255,255,255,0.09)'   : 'rgba(0,0,0,0.1)';
    var botBg      = dark ? 'rgba(255,255,255,0.09)'   : 'rgba(0,0,0,0.055)';
    var botColor   = dark ? 'rgba(255,255,255,0.92)'   : '#1a1a1a';
    var inputBg    = dark ? 'rgba(255,255,255,0.07)'   : 'rgba(0,0,0,0.05)';
    var inputBdr   = dark ? 'rgba(255,255,255,0.11)'   : 'rgba(0,0,0,0.14)';
    var inputColor = dark ? '#fff'                      : '#1a1a1a';
    var inputPh    = dark ? 'rgba(255,255,255,0.32)'   : 'rgba(0,0,0,0.32)';
    var divider    = dark ? 'rgba(255,255,255,0.07)'   : 'rgba(0,0,0,0.07)';
    var timeColor  = dark ? 'rgba(255,255,255,0.28)'   : 'rgba(0,0,0,0.32)';
    var scrollbar  = dark ? 'rgba(255,255,255,0.13)'   : 'rgba(0,0,0,0.13)';
    var footerC    = dark ? 'rgba(255,255,255,0.28)'   : 'rgba(0,0,0,0.38)';
    var footerA    = dark ? 'rgba(255,255,255,0.42)'   : 'rgba(0,0,0,0.52)';
    var ctrlColor  = dark ? 'rgba(255,255,255,0.65)'   : 'rgba(255,255,255,0.75)';
    var ctrlHover  = dark ? 'rgba(255,255,255,0.12)'   : 'rgba(255,255,255,0.22)';
    var dotColor   = dark ? 'rgba(255,255,255,0.45)'   : 'rgba(0,0,0,0.25)';
    var confirmC   = dark ? '#4ade80'                  : '#16a34a';

    var css = [
      "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');",
      ':root{--zp-primary:'+primary+';--zp-accent:'+accent+'}',

      // Keyframes
      '@keyframes zp-pulse{0%,100%{box-shadow:0 0 0 0 '+primary+'55}50%{box-shadow:0 0 0 14px '+primary+'00}}',
      '@keyframes zp-slide-up{from{opacity:0;transform:translateY(24px) scale(.96)}to{opacity:1;transform:none}}',
      '@keyframes zp-dot{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1);opacity:1}}',
      '@keyframes zp-fade-in{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}',

      // Launcher button
      '#zp-btn{position:fixed;bottom:24px;right:24px;width:60px;height:60px;border-radius:50%;',
      'background:var(--zp-primary);border:none;cursor:pointer;z-index:2147483640;',
      'display:flex;align-items:center;justify-content:center;',
      'box-shadow:0 4px 28px '+primary+'70;',
      'animation:zp-pulse 2.4s ease-in-out infinite;',
      'transition:transform .2s}',
      '#zp-btn:hover{transform:scale(1.08)}',
      '#zp-btn-icon{display:flex;align-items:center;justify-content:center;pointer-events:none}',
      '#zp-btn-icon svg{width:28px;height:28px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',

      // Badge
      '#zp-badge{position:absolute;top:-3px;right:-3px;background:#ef4444;color:#fff;',
      'font:700 10px/1 Inter,system-ui;min-width:18px;height:18px;border-radius:9px;',
      'padding:0 4px;display:none;align-items:center;justify-content:center;pointer-events:none;',
      'box-shadow:0 0 0 2px #fff}',

      // Chat window
      '#zp-win{position:fixed;bottom:96px;right:24px;width:380px;max-height:600px;',
      'background:'+winBg+';backdrop-filter:blur(32px) saturate(1.4);',
      '-webkit-backdrop-filter:blur(32px) saturate(1.4);',
      'border:1px solid '+winBorder+';border-radius:20px;',
      'display:flex;flex-direction:column;overflow:hidden;',
      'box-shadow:0 24px 80px rgba(0,0,0,.42);',
      'z-index:2147483639;',
      'animation:zp-slide-up .32s cubic-bezier(.34,1.56,.64,1) forwards;',
      'font-family:Inter,system-ui,sans-serif}',

      // Header — brand gradient
      '#zp-header{display:flex;align-items:center;gap:10px;padding:14px 16px;flex-shrink:0;',
      'background:linear-gradient(135deg,'+primary+' 0%,'+accent+' 100%)}',
      '#zp-avatar{width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.18);',
      'display:flex;align-items:center;justify-content:center;flex-shrink:0}',
      '#zp-avatar svg{width:20px;height:20px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
      '#zp-title-wrap{flex:1;min-width:0}',
      '#zp-title{font:600 14px/1 Inter,system-ui;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#zp-status{display:flex;align-items:center;gap:4px;margin-top:3px}',
      '.zp-dot-online{width:7px;height:7px;border-radius:50%;background:#4ade80;flex-shrink:0}',
      '#zp-status span{font:400 11px/1 Inter,system-ui;color:rgba(255,255,255,.82)}',
      '.zp-ctrl{background:none;border:none;cursor:pointer;padding:6px;border-radius:8px;',
      'color:'+ctrlColor+';transition:background .15s,color .15s;display:flex}',
      '.zp-ctrl:hover{background:'+ctrlHover+';color:#fff}',
      '.zp-ctrl svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',

      // Messages
      '#zp-msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;',
      'scrollbar-width:thin;scrollbar-color:'+scrollbar+' transparent}',
      '#zp-msgs::-webkit-scrollbar{width:4px}',
      '#zp-msgs::-webkit-scrollbar-thumb{background:'+scrollbar+';border-radius:4px}',

      // Bubbles
      '.zp-bubble-wrap{display:flex;flex-direction:column;max-width:84%;',
      'animation:zp-fade-in .22s ease-out both}',
      '.zp-bubble-wrap.zp-user{align-self:flex-end;align-items:flex-end}',
      '.zp-bubble-wrap.zp-bot{align-self:flex-start;align-items:flex-start}',
      '.zp-bubble{padding:10px 14px;border-radius:18px;font:400 13.5px/1.55 Inter,system-ui;word-break:break-word}',
      '.zp-user .zp-bubble{background:var(--zp-primary);color:#fff;border-bottom-right-radius:4px}',
      '.zp-bot .zp-bubble{background:'+botBg+';color:'+botColor+';border-bottom-left-radius:4px}',
      '.zp-time{font:400 10px/1 Inter,system-ui;color:'+timeColor+';margin-top:4px;padding:0 4px}',

      // Typing indicator
      '#zp-typing{display:none;align-self:flex-start;padding:10px 14px;',
      'background:'+botBg+';border-radius:18px;border-bottom-left-radius:4px;',
      'gap:5px;align-items:center}',
      '#zp-typing span{display:inline-block;width:7px;height:7px;border-radius:50%;background:'+dotColor+'}',
      '#zp-typing span:nth-child(1){animation:zp-dot 1.2s 0s infinite}',
      '#zp-typing span:nth-child(2){animation:zp-dot 1.2s .2s infinite}',
      '#zp-typing span:nth-child(3){animation:zp-dot 1.2s .4s infinite}',

      // Quick reply chips — branded border + text
      '#zp-chips{display:flex;flex-wrap:wrap;gap:7px;padding:0 16px 12px}',
      '.zp-chip{background:transparent;border:1.5px solid var(--zp-primary);',
      'color:var(--zp-primary);font:500 12px/1 Inter,system-ui;padding:7px 13px;',
      'border-radius:20px;cursor:pointer;transition:background .15s,color .15s;white-space:nowrap}',
      '.zp-chip:hover{background:var(--zp-primary);color:#fff}',

      // Input area
      '#zp-input-wrap{display:flex;align-items:flex-end;gap:8px;padding:12px 14px;',
      'border-top:1px solid '+divider+';flex-shrink:0}',
      '#zp-input{flex:1;background:'+inputBg+';border:1px solid '+inputBdr+';',
      'border-radius:14px;padding:10px 14px;color:'+inputColor+';',
      'font:400 13.5px/1.5 Inter,system-ui;',
      'resize:none;outline:none;max-height:120px;overflow-y:auto;transition:border-color .2s}',
      '#zp-input::placeholder{color:'+inputPh+'}',
      '#zp-input:focus{border-color:var(--zp-primary)}',
      '#zp-send{width:38px;height:38px;border-radius:50%;background:var(--zp-primary);border:none;',
      'cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;',
      'transition:opacity .2s,transform .15s}',
      '#zp-send:hover{transform:scale(1.08)}',
      '#zp-send:disabled{opacity:.45;cursor:default;transform:none}',
      '#zp-send svg{width:18px;height:18px;fill:none;stroke:#fff;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}',

      // Lead capture form (inline, above footer)
      '#zp-lead-form{display:none;flex-direction:column;gap:8px;',
      'padding:12px 14px;border-top:1px solid '+divider+';flex-shrink:0}',
      '#zp-lead-form.zp-open{display:flex}',
      '.zp-lead-input{background:'+inputBg+';border:1px solid '+inputBdr+';',
      'border-radius:10px;padding:9px 12px;color:'+inputColor+';',
      'font:400 13px/1 Inter,system-ui;outline:none;transition:border-color .2s}',
      '.zp-lead-input::placeholder{color:'+inputPh+'}',
      '.zp-lead-input:focus{border-color:var(--zp-primary)}',
      '#zp-lead-submit{background:var(--zp-primary);color:#fff;border:none;',
      'border-radius:10px;padding:10px;font:600 13px/1 Inter,system-ui;',
      'cursor:pointer;transition:opacity .15s}',
      '#zp-lead-submit:hover{opacity:.88}',
      '#zp-lead-confirm{font:500 12px/1.4 Inter,system-ui;color:'+confirmC+';text-align:center;display:none}',

      // Footer
      '#zp-footer{display:flex;align-items:center;justify-content:space-between;',
      'padding:7px 14px 10px;flex-shrink:0}',
      '#zp-footer-brand{font:400 10px/1 Inter,system-ui;color:'+footerC+'}',
      '#zp-footer-brand a{color:'+footerA+';text-decoration:none}',
      '#zp-footer-brand a:hover{color:var(--zp-primary)}',
      '#zp-lead-btn{background:none;border:none;cursor:pointer;padding:0;',
      'font:400 10px/1 Inter,system-ui;color:var(--zp-primary);',
      'text-decoration:underline;opacity:.75;transition:opacity .15s}',
      '#zp-lead-btn:hover{opacity:1}',
      '#zp-lead-btn[disabled]{display:none}',

      // Mobile
      '@media(max-width:480px){',
      '#zp-win{right:0;bottom:0;left:0;width:100%;max-height:100%;',
      'border-radius:20px 20px 0 0;border-bottom:none}',
      '#zp-btn{bottom:16px;right:16px}',
      '}',
    ].join('');

    var el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  // ── Icons ─────────────────────────────────────────────────────────────────
  var ICONS = {
    chat:  '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    minus: '<svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    send:  '<svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    bot:   '<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M12 2v3"/><circle cx="12" cy="5" r="2"/><line x1="8" y1="15" x2="8" y2="17"/><line x1="16" y1="15" x2="16" y2="17"/></svg>',
  };

  // ── DOM builders ──────────────────────────────────────────────────────────
  function buildLauncher() {
    var btn = document.createElement('button');
    btn.id = 'zp-btn';
    btn.setAttribute('aria-label', 'Open chat');

    var icon = document.createElement('span');
    icon.id = 'zp-btn-icon';
    icon.innerHTML = ICONS.chat;

    var badge = document.createElement('span');
    badge.id = 'zp-badge';

    btn.appendChild(icon);
    btn.appendChild(badge);
    btn.addEventListener('click', toggleOpen);
    document.body.appendChild(btn);
  }

  function setLauncherIcon(icon) {
    var el = document.getElementById('zp-btn-icon');
    if (el) el.innerHTML = icon;
  }

  function buildWindow() {
    var win = document.createElement('div');
    win.id = 'zp-win';
    win.style.display = 'none';

    var name = (state.config && state.config.name) ? state.config.name : 'Support';

    win.innerHTML = [
      '<div id="zp-header">',
        '<div id="zp-avatar">'+ICONS.bot+'</div>',
        '<div id="zp-title-wrap">',
          '<div id="zp-title">'+escHtml(name)+'</div>',
          '<div id="zp-status"><div class="zp-dot-online"></div><span>Online now</span></div>',
        '</div>',
        '<button class="zp-ctrl" id="zp-min-btn" title="Minimise" aria-label="Minimise">'+ICONS.minus+'</button>',
        '<button class="zp-ctrl" id="zp-close-btn" title="Close" aria-label="Close">'+ICONS.close+'</button>',
      '</div>',
      '<div id="zp-msgs"></div>',
      '<div id="zp-typing"><span></span><span></span><span></span></div>',
      '<div id="zp-chips" style="display:none"></div>',
      '<div id="zp-lead-form">',
        '<input class="zp-lead-input" id="zp-lead-name" type="text" placeholder="Your name" autocomplete="name">',
        '<input class="zp-lead-input" id="zp-lead-email" type="email" placeholder="Your email" autocomplete="email">',
        '<button id="zp-lead-submit">Send details</button>',
        '<div id="zp-lead-confirm">Thanks! We\'ll be in touch soon. ✓</div>',
      '</div>',
      '<div id="zp-input-wrap">',
        '<textarea id="zp-input" rows="1" placeholder="Type a message…" autocomplete="off"></textarea>',
        '<button id="zp-send" aria-label="Send">'+ICONS.send+'</button>',
      '</div>',
      '<div id="zp-footer">',
        '<div id="zp-footer-brand">Powered by <a href="https://zempotis.com" target="_blank" rel="noopener">Zempotis</a></div>',
        '<button id="zp-lead-btn">Leave your details</button>',
      '</div>',
    ].join('');

    document.body.appendChild(win);

    win.querySelector('#zp-min-btn').addEventListener('click', minimise);
    win.querySelector('#zp-close-btn').addEventListener('click', closeChat);
    win.querySelector('#zp-send').addEventListener('click', sendMessage);
    win.querySelector('#zp-lead-btn').addEventListener('click', toggleLeadForm);
    win.querySelector('#zp-lead-submit').addEventListener('click', submitLead);

    var input = win.querySelector('#zp-input');
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    input.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
  }

  // ── Lead form ─────────────────────────────────────────────────────────────
  function toggleLeadForm() {
    if (state.leadCaptured) return;
    state.leadFormVisible = !state.leadFormVisible;
    var form = document.getElementById('zp-lead-form');
    if (!form) return;
    if (state.leadFormVisible) {
      form.classList.add('zp-open');
      var nameEl = document.getElementById('zp-lead-name');
      if (nameEl) setTimeout(function () { nameEl.focus(); }, 50);
    } else {
      form.classList.remove('zp-open');
    }
  }

  function submitLead() {
    var nameEl  = document.getElementById('zp-lead-name');
    var emailEl = document.getElementById('zp-lead-email');
    var name    = nameEl  ? nameEl.value.trim()  : '';
    var email   = emailEl ? emailEl.value.trim() : '';

    if (!name)  { if (nameEl)  nameEl.focus();  return; }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (emailEl) emailEl.focus();
      return;
    }

    state.leadCaptured = true;

    // Swap form fields for confirmation message
    if (nameEl)  nameEl.style.display  = 'none';
    if (emailEl) emailEl.style.display = 'none';
    var submitBtn = document.getElementById('zp-lead-submit');
    if (submitBtn) submitBtn.style.display = 'none';
    var confirm = document.getElementById('zp-lead-confirm');
    if (confirm) confirm.style.display = 'block';

    // Disable the footer button permanently
    var leadBtn = document.getElementById('zp-lead-btn');
    if (leadBtn) leadBtn.setAttribute('disabled', 'true');

    // Auto-close form after 3 s
    setTimeout(function () {
      var form = document.getElementById('zp-lead-form');
      if (form) form.classList.remove('zp-open');
    }, 3000);
  }

  // ── Badge ─────────────────────────────────────────────────────────────────
  function updateBadge() {
    var badge = document.getElementById('zp-badge');
    if (!badge) return;
    if (state.unreadCount > 0 && !state.isOpen) {
      badge.textContent = state.unreadCount > 9 ? '9+' : String(state.unreadCount);
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  // ── Message rendering ─────────────────────────────────────────────────────
  function appendMessage(role, content, time) {
    var msgs = document.getElementById('zp-msgs');
    if (!msgs) return;

    var wrap = document.createElement('div');
    wrap.className = 'zp-bubble-wrap ' + (role === 'user' ? 'zp-user' : 'zp-bot');

    var bubble = document.createElement('div');
    bubble.className = 'zp-bubble';
    bubble.innerHTML = escHtml(content).replace(/\n/g, '<br>');

    var timeEl = document.createElement('div');
    timeEl.className = 'zp-time';
    timeEl.textContent = formatTime(time || new Date());

    wrap.appendChild(bubble);
    wrap.appendChild(timeEl);
    msgs.appendChild(wrap);
    scrollToBottom();

    // Increment badge if chat is not open
    if (role === 'assistant' && !state.isOpen) {
      state.unreadCount++;
      updateBadge();
    }
  }

  function renderHistory() {
    var msgs = document.getElementById('zp-msgs');
    if (!msgs) return;
    msgs.innerHTML = '';
    state.messages.forEach(function (m) {
      appendMessage(m.role, m.content, new Date(m.time));
    });
  }

  function scrollToBottom() {
    var msgs = document.getElementById('zp-msgs');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  }

  function showTyping(show) {
    var el = document.getElementById('zp-typing');
    if (el) el.style.display = show ? 'flex' : 'none';
    if (show) scrollToBottom();
  }

  // ── Quick replies ─────────────────────────────────────────────────────────
  function showQuickReplies() {
    if (!state.config || !state.quickRepliesVisible) return;
    var chips = document.getElementById('zp-chips');
    if (!chips) return;
    chips.innerHTML = '';
    (state.config.quickReplies || []).forEach(function (reply) {
      var chip = document.createElement('button');
      chip.className = 'zp-chip';
      chip.textContent = reply;
      chip.addEventListener('click', function () {
        hideQuickReplies();
        sendUserMessage(reply);
      });
      chips.appendChild(chip);
    });
    chips.style.display = 'flex';
  }

  function hideQuickReplies() {
    state.quickRepliesVisible = false;
    var chips = document.getElementById('zp-chips');
    if (chips) chips.style.display = 'none';
  }

  // ── Open / minimise / close ───────────────────────────────────────────────
  function toggleOpen() {
    if (state.isOpen && !state.isMinimised) { minimise(); }
    else { openChat(); }
  }

  function openChat() {
    state.isOpen = true;
    state.isMinimised = false;
    state.unreadCount = 0;

    var win = document.getElementById('zp-win');
    if (win) {
      win.style.display = 'flex';
      win.style.animation = 'zp-slide-up .32s cubic-bezier(.34,1.56,.64,1) forwards';
    }

    setLauncherIcon(ICONS.close);
    updateBadge();

    renderHistory();
    if (state.messages.length === 0) {
      showGreeting();
    } else {
      scrollToBottom();
      state.quickRepliesVisible = false;
    }

    var input = document.getElementById('zp-input');
    if (input) setTimeout(function () { input.focus(); }, 200);
  }

  function minimise() {
    state.isMinimised = true;
    state.isOpen = false;
    var win = document.getElementById('zp-win');
    if (win) win.style.display = 'none';
    setLauncherIcon(ICONS.chat);
    updateBadge();
  }

  function closeChat() {
    state.isOpen = false;
    state.isMinimised = false;
    state.unreadCount = 0;
    var win = document.getElementById('zp-win');
    if (win) win.style.display = 'none';
    setLauncherIcon(ICONS.chat);
    updateBadge();
  }

  // ── Greeting ──────────────────────────────────────────────────────────────
  function showGreeting() {
    var greeting = (state.config && state.config.greeting)
      ? state.config.greeting
      : 'Hi! How can I help you today?';
    var now = new Date();
    state.messages.push({ role: 'assistant', content: greeting, time: now.toISOString() });
    appendMessage('assistant', greeting, now);
    saveHistory();
    setTimeout(showQuickReplies, 400);
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  function sendMessage() {
    var input = document.getElementById('zp-input');
    if (!input) return;
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    sendUserMessage(text);
  }

  function sendUserMessage(text) {
    hideQuickReplies();
    var now = new Date();
    state.messages.push({ role: 'user', content: text, time: now.toISOString() });
    appendMessage('user', text, now);
    saveHistory();

    var sendBtn = document.getElementById('zp-send');
    if (sendBtn) sendBtn.disabled = true;

    callAPI();
  }

  function callAPI() {
    showTyping(true);

    var msgs = state.messages.map(function (m) {
      return { role: m.role, content: m.content };
    });

    fetch(API_BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, messages: msgs }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        showTyping(false);
        var reply = data.reply || "Sorry, I couldn't get a response right now.";
        var now = new Date();
        state.messages.push({ role: 'assistant', content: reply, time: now.toISOString() });
        appendMessage('assistant', reply, now);
        saveHistory();
      })
      .catch(function () {
        showTyping(false);
        var now = new Date();
        var msg = "I'm having trouble connecting right now. Please try again in a moment.";
        state.messages.push({ role: 'assistant', content: msg, time: now.toISOString() });
        appendMessage('assistant', msg, now);
        saveHistory();
      })
      .finally(function () {
        var sendBtn = document.getElementById('zp-send');
        if (sendBtn) sendBtn.disabled = false;
        var input = document.getElementById('zp-input');
        if (input) input.focus();
      });
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────
  function init(config) {
    state.config = config;
    var primary = (config && config.primaryColor) ? config.primaryColor : '#2563eb';
    var accent  = (config && config.accentColor)  ? config.accentColor  : '#7c3aed';
    var dark    = hexLuminance(primary) < 0.5;

    injectStyles(primary, accent, dark);
    loadHistory();
    buildLauncher();
    buildWindow();

    // Show initial unread badge after 3 s to invite engagement
    setTimeout(function () {
      if (!state.isOpen) {
        state.unreadCount = 1;
        updateBadge();
      }
    }, 3000);
  }

  function bootstrap() {
    fetch(API_BASE + '/api/client/' + CLIENT_ID)
      .then(function (r) { return r.json(); })
      .then(function (cfg) { init(cfg); })
      .catch(function () {
        init({ name: 'Support', primaryColor: '#2563eb', accentColor: '#7c3aed',
               greeting: 'Hi! How can I help you?', quickReplies: [] });
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
