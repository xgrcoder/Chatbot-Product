/**
 * Zempotis Chat — Premium Embeddable Widget v1.0
 *
 * Drop-in script for any client website:
 *   <script src="https://chat.zempotis.com/widget.js" data-client="clientId" async></script>
 *
 * Features:
 *  • Floating pulse-glow button, frosted-glass chat window
 *  • Spring slide-up animation on open
 *  • Brand colours loaded from /api/client/{clientId}
 *  • Greeting + quick reply chips on open
 *  • Lead capture after 2 messages (name + email)
 *  • Chat history persisted in sessionStorage
 *  • Separate minimise / close buttons
 *  • Animated typing indicator
 *  • Mobile-responsive (full-screen on mobile)
 *  • "Powered by Zempotis" footer
 */
(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────────
  // Priority 1: window global set by inline script (most reliable, works with
  //             next/script, async, and any dynamic injection method)
  // Priority 2: data-client attribute on the script tag
  // Priority 3: data-client on any widget.js script tag in the document
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
    messages: [],          // { role, content, time }
    config: null,          // loaded from /api/client/{clientId}
    msgCount: 0,           // user messages sent this session
    leadCaptured: false,
    leadStep: null,        // null | 'ask_name' | 'ask_email' | 'done'
    leadName: '',
    leadEmail: '',
    quickRepliesVisible: true,
  };

  var STORAGE_KEY = 'zempotis_' + CLIENT_ID;

  // ── Styles ────────────────────────────────────────────────────────────────
  function injectStyles(primary, accent) {
    var css = [
      ':root{--zp-primary:' + primary + ';--zp-accent:' + accent + '}',

      /* Keyframes */
      '@keyframes zp-pulse{0%,100%{box-shadow:0 0 0 0 ' + primary + '55}50%{box-shadow:0 0 0 12px ' + primary + '00}}',
      '@keyframes zp-slide-up{from{opacity:0;transform:translateY(24px) scale(0.96)}to{opacity:1;transform:translateY(0) scale(1)}}',
      '@keyframes zp-dot{0%,80%,100%{transform:scale(0.6);opacity:.4}40%{transform:scale(1);opacity:1}}',
      '@keyframes zp-spin{to{transform:rotate(360deg)}}',

      /* Launcher button */
      '#zp-btn{position:fixed;bottom:24px;right:24px;width:60px;height:60px;border-radius:50%;',
      'background:var(--zp-primary);border:none;cursor:pointer;z-index:2147483640;',
      'display:flex;align-items:center;justify-content:center;',
      'box-shadow:0 4px 24px ' + primary + '66;',
      'animation:zp-pulse 2.4s ease-in-out infinite;',
      'transition:transform .2s,background .2s}',
      '#zp-btn:hover{transform:scale(1.08)}',
      '#zp-btn svg{width:28px;height:28px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',

      /* Unread badge */
      '#zp-badge{position:absolute;top:-2px;right:-2px;background:#ef4444;color:#fff;',
      'font:bold 10px/16px system-ui;width:16px;height:16px;border-radius:50%;',
      'display:none;align-items:center;justify-content:center;pointer-events:none}',

      /* Chat window */
      '#zp-win{position:fixed;bottom:96px;right:24px;width:380px;max-height:600px;',
      'background:rgba(15,15,25,0.88);backdrop-filter:blur(32px) saturate(1.4);',
      '-webkit-backdrop-filter:blur(32px) saturate(1.4);',
      'border:1px solid rgba(255,255,255,0.1);border-radius:20px;',
      'display:flex;flex-direction:column;overflow:hidden;',
      'box-shadow:0 24px 80px rgba(0,0,0,.55);',
      'z-index:2147483639;animation:zp-slide-up .32s cubic-bezier(.34,1.56,.64,1) forwards}',

      /* Header */
      '#zp-header{display:flex;align-items:center;gap:10px;padding:14px 16px;',
      'background:rgba(255,255,255,0.05);border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0}',
      '#zp-avatar{width:36px;height:36px;border-radius:50%;background:var(--zp-primary);',
      'display:flex;align-items:center;justify-content:center;flex-shrink:0}',
      '#zp-avatar svg{width:20px;height:20px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
      '#zp-title-wrap{flex:1;min-width:0}',
      '#zp-title{font:600 14px/1 system-ui;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#zp-status{display:flex;align-items:center;gap:4px;margin-top:3px}',
      '.zp-dot-online{width:7px;height:7px;border-radius:50%;background:#22c55e;flex-shrink:0}',
      '#zp-status span{font:400 11px/1 system-ui;color:#86efac}',
      '.zp-ctrl{background:none;border:none;cursor:pointer;padding:6px;border-radius:8px;',
      'color:rgba(255,255,255,.6);transition:background .15s,color .15s;display:flex}',
      '.zp-ctrl:hover{background:rgba(255,255,255,.1);color:#fff}',
      '.zp-ctrl svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',

      /* Messages */
      '#zp-msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;',
      'scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.15) transparent}',
      '#zp-msgs::-webkit-scrollbar{width:4px}',
      '#zp-msgs::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:4px}',

      /* Bubbles */
      '.zp-bubble-wrap{display:flex;flex-direction:column;max-width:84%}',
      '.zp-bubble-wrap.zp-user{align-self:flex-end;align-items:flex-end}',
      '.zp-bubble-wrap.zp-bot{align-self:flex-start;align-items:flex-start}',
      '.zp-bubble{padding:10px 14px;border-radius:18px;font:400 13.5px/1.5 system-ui;word-break:break-word}',
      '.zp-user .zp-bubble{background:var(--zp-primary);color:#fff;border-bottom-right-radius:4px}',
      '.zp-bot .zp-bubble{background:rgba(255,255,255,0.1);color:rgba(255,255,255,.92);border-bottom-left-radius:4px}',
      '.zp-time{font:400 10px/1 system-ui;color:rgba(255,255,255,.35);margin-top:4px;padding:0 4px}',

      /* Typing indicator */
      '#zp-typing{display:none;align-self:flex-start;padding:10px 14px;',
      'background:rgba(255,255,255,0.1);border-radius:18px;border-bottom-left-radius:4px;gap:5px;align-items:center}',
      '#zp-typing span{display:inline-block;width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.5)}',
      '#zp-typing span:nth-child(1){animation:zp-dot 1.2s .0s infinite}',
      '#zp-typing span:nth-child(2){animation:zp-dot 1.2s .2s infinite}',
      '#zp-typing span:nth-child(3){animation:zp-dot 1.2s .4s infinite}',

      /* Quick reply chips */
      '#zp-chips{display:flex;flex-wrap:wrap;gap:7px;padding:0 16px 12px}',
      '.zp-chip{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);',
      'color:rgba(255,255,255,.85);font:400 12px/1 system-ui;padding:7px 12px;',
      'border-radius:20px;cursor:pointer;transition:background .15s,border-color .15s,color .15s;white-space:nowrap}',
      '.zp-chip:hover{background:var(--zp-primary);border-color:var(--zp-primary);color:#fff}',

      /* Input area */
      '#zp-input-wrap{display:flex;align-items:flex-end;gap:8px;padding:12px 14px;',
      'border-top:1px solid rgba(255,255,255,.08);flex-shrink:0}',
      '#zp-input{flex:1;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);',
      'border-radius:14px;padding:10px 14px;color:#fff;font:400 13.5px/1.5 system-ui;',
      'resize:none;outline:none;max-height:120px;overflow-y:auto;',
      'transition:border-color .2s}',
      '#zp-input::placeholder{color:rgba(255,255,255,.35)}',
      '#zp-input:focus{border-color:var(--zp-primary)}',
      '#zp-send{width:38px;height:38px;border-radius:50%;background:var(--zp-primary);border:none;',
      'cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;',
      'transition:background .2s,transform .15s}',
      '#zp-send:hover{transform:scale(1.08)}',
      '#zp-send:disabled{opacity:.5;cursor:default;transform:none}',
      '#zp-send svg{width:18px;height:18px;fill:none;stroke:#fff;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}',

      /* Footer */
      '#zp-footer{text-align:center;padding:6px 0 10px;font:400 10px/1 system-ui;color:rgba(255,255,255,.25)}',
      '#zp-footer a{color:rgba(255,255,255,.35);text-decoration:none}',
      '#zp-footer a:hover{color:rgba(255,255,255,.65)}',

      /* Mobile: full screen */
      '@media(max-width:480px){',
      '#zp-win{right:0;bottom:0;left:0;width:100%;max-height:100%;border-radius:20px 20px 0 0;border-bottom:none}',
      '#zp-btn{bottom:16px;right:16px}',
      '}',
    ].join('');

    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── SVG icons ─────────────────────────────────────────────────────────────
  var ICONS = {
    chat: '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    minus: '<svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    send: '<svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    bot: '<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M12 2v3"/><circle cx="12" cy="5" r="2"/><line x1="8" y1="15" x2="8" y2="17"/><line x1="16" y1="15" x2="16" y2="17"/></svg>',
  };

  // ── Utility ───────────────────────────────────────────────────────────────
  function formatTime(date) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function saveHistory() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state.messages.slice(-60)));
    } catch (_) {}
  }

  function loadHistory() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) state.messages = JSON.parse(raw);
    } catch (_) {}
  }

  // ── DOM builders ──────────────────────────────────────────────────────────
  function buildLauncher() {
    var btn = document.createElement('button');
    btn.id = 'zp-btn';
    btn.setAttribute('aria-label', 'Open chat');
    btn.innerHTML = ICONS.chat;

    var badge = document.createElement('span');
    badge.id = 'zp-badge';
    badge.textContent = '1';
    btn.appendChild(badge);

    btn.addEventListener('click', toggleOpen);
    document.body.appendChild(btn);
  }

  function buildWindow() {
    var win = document.createElement('div');
    win.id = 'zp-win';
    win.style.display = 'none';

    var name = (state.config && state.config.name) ? state.config.name : 'Support';

    // Header
    win.innerHTML = [
      '<div id="zp-header">',
        '<div id="zp-avatar">' + ICONS.bot + '</div>',
        '<div id="zp-title-wrap">',
          '<div id="zp-title">' + escHtml(name) + '</div>',
          '<div id="zp-status"><div class="zp-dot-online"></div><span>Online now</span></div>',
        '</div>',
        '<button class="zp-ctrl" id="zp-min-btn" title="Minimise" aria-label="Minimise chat">' + ICONS.minus + '</button>',
        '<button class="zp-ctrl" id="zp-close-btn" title="Close" aria-label="Close chat">' + ICONS.close + '</button>',
      '</div>',
      '<div id="zp-msgs"></div>',
      '<div id="zp-typing"><span></span><span></span><span></span></div>',
      '<div id="zp-chips" style="display:none"></div>',
      '<div id="zp-input-wrap">',
        '<textarea id="zp-input" rows="1" placeholder="Type a message…" autocomplete="off"></textarea>',
        '<button id="zp-send" aria-label="Send">' + ICONS.send + '</button>',
      '</div>',
      '<div id="zp-footer">Powered by <a href="https://zempotis.com" target="_blank" rel="noopener">Zempotis</a></div>',
    ].join('');

    document.body.appendChild(win);

    // Wire up controls
    win.querySelector('#zp-min-btn').addEventListener('click', minimise);
    win.querySelector('#zp-close-btn').addEventListener('click', closeChat);
    win.querySelector('#zp-send').addEventListener('click', sendMessage);

    var input = win.querySelector('#zp-input');
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    // Auto-grow textarea
    input.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Message rendering ─────────────────────────────────────────────────────
  function appendMessage(role, content, time) {
    var msgs = document.getElementById('zp-msgs');
    if (!msgs) return;

    var wrap = document.createElement('div');
    wrap.className = 'zp-bubble-wrap ' + (role === 'user' ? 'zp-user' : 'zp-bot');

    var bubble = document.createElement('div');
    bubble.className = 'zp-bubble';
    // Sanitise line breaks but no raw HTML from AI
    bubble.innerHTML = escHtml(content).replace(/\n/g, '<br>');

    var timeEl = document.createElement('div');
    timeEl.className = 'zp-time';
    timeEl.textContent = formatTime(time || new Date());

    wrap.appendChild(bubble);
    wrap.appendChild(timeEl);
    msgs.appendChild(wrap);

    scrollToBottom();
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

  // ── Open / close / minimise ───────────────────────────────────────────────
  function toggleOpen() {
    if (state.isOpen && !state.isMinimised) {
      minimise();
    } else {
      openChat();
    }
  }

  function openChat() {
    state.isOpen = true;
    state.isMinimised = false;

    var win = document.getElementById('zp-win');
    if (win) {
      win.style.display = 'flex';
      win.style.animation = 'zp-slide-up .32s cubic-bezier(.34,1.56,.64,1) forwards';
    }

    // Update launcher icon to close
    var btn = document.getElementById('zp-btn');
    if (btn) {
      btn.innerHTML = ICONS.close;
      var badge = document.createElement('span');
      badge.id = 'zp-badge';
      badge.textContent = '1';
      btn.appendChild(badge);
      document.getElementById('zp-badge').style.display = 'none';
    }

    // Render persisted history or show greeting
    renderHistory();
    if (state.messages.length === 0) {
      showGreeting();
    } else {
      scrollToBottom();
      // Don't show chips if history exists
      state.quickRepliesVisible = false;
    }

    var input = document.getElementById('zp-input');
    if (input) setTimeout(function () { input.focus(); }, 200);
  }

  function minimise() {
    state.isMinimised = true;
    var win = document.getElementById('zp-win');
    if (win) win.style.display = 'none';

    var btn = document.getElementById('zp-btn');
    if (btn) btn.innerHTML = ICONS.chat;
  }

  function closeChat() {
    state.isOpen = false;
    state.isMinimised = false;
    var win = document.getElementById('zp-win');
    if (win) win.style.display = 'none';

    var btn = document.getElementById('zp-btn');
    if (btn) btn.innerHTML = ICONS.chat;
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

    setTimeout(function () { showQuickReplies(); }, 400);
  }

  // ── Send message ──────────────────────────────────────────────────────────
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
    state.msgCount++;

    // Disable send while processing
    var sendBtn = document.getElementById('zp-send');
    if (sendBtn) sendBtn.disabled = true;

    // Lead capture: trigger on 4th user message — after the conversation is warm
    if (state.msgCount === 4 && !state.leadCaptured && !state.leadStep) {
      state.leadStep = 'ask_name';
      simulateBotReply("Quick one — could I get your name so I can personalise your experience?");
      return;
    }
    if (state.leadStep === 'ask_name') {
      state.leadName = text;
      state.leadStep = 'ask_email';
      simulateBotReply("Thanks, " + escHtml(text.split(' ')[0]) + "! What's your email in case we need to follow up?");
      return;
    }
    if (state.leadStep === 'ask_email') {
      // Validate email before accepting
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        simulateBotReply("That doesn't look like a valid email address — could you double-check it?");
        return;
      }
      state.leadEmail = text;
      state.leadStep = 'done';
      state.leadCaptured = true;
      simulateBotReply("Perfect, thanks " + escHtml(state.leadName.split(' ')[0]) + "! Go ahead — what would you like to know?");
      return;
    }

    callAPI();
  }

  function simulateBotReply(text) {
    showTyping(true);
    setTimeout(function () {
      showTyping(false);
      var now = new Date();
      state.messages.push({ role: 'assistant', content: text, time: now.toISOString() });
      appendMessage('assistant', text, now);
      saveHistory();
      var sendBtn = document.getElementById('zp-send');
      if (sendBtn) sendBtn.disabled = false;
      var input = document.getElementById('zp-input');
      if (input) input.focus();
    }, 800 + Math.random() * 600);
  }

  function callAPI() {
    showTyping(true);

    // Build messages array from history (exclude lead capture steps for context clarity)
    var contextMsgs = state.messages
      .filter(function (m) {
        var isLeadCapture = [
          'could i grab your name',
          'thanks,',
          "perfect! i've noted",
          'let me answer',
        ].some(function (kw) { return m.content.toLowerCase().indexOf(kw) !== -1; });
        return !isLeadCapture;
      })
      .map(function (m) { return { role: m.role, content: m.content }; });

    fetch(API_BASE + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, messages: contextMsgs }),
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
    var accent = (config && config.accentColor) ? config.accentColor : '#7c3aed';

    injectStyles(primary, accent);
    loadHistory();
    buildLauncher();
    buildWindow();

    // Show unread badge after a short delay to invite engagement
    setTimeout(function () {
      var badge = document.getElementById('zp-badge');
      if (badge && !state.isOpen) badge.style.display = 'flex';
    }, 3000);
  }

  function bootstrap() {
    // Fetch client config then initialise
    fetch(API_BASE + '/api/client/' + CLIENT_ID)
      .then(function (r) { return r.json(); })
      .then(function (cfg) { init(cfg); })
      .catch(function () {
        // Fallback: initialise with defaults if config fetch fails
        init({ name: 'Support', primaryColor: '#2563eb', accentColor: '#7c3aed', greeting: 'Hi! How can I help you?', quickReplies: [] });
      });
  }

  // Wait for DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
