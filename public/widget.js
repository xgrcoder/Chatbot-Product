/**
 * Zempotis Chat — Premium Embeddable Widget v3.0
 *
 *   <script src="https://chatbot-product-flax.vercel.app/widget.js" data-client="clientId" async></script>
 *
 * v3.0 features:
 *  • Full-screen mobile (< 768px) with visualViewport keyboard adjustment
 *  • Flashing green dot on button + header (CSS heartbeat pulse)
 *  • Bot display name derived from config.name or config.url
 *  • Time-based greeting (morning / afternoon / evening)
 *  • Idle nudge after 30 s of inactivity (once per session)
 *  • Follow-up suggestion chips after every AI response
 *  • Frustration detection → immediate empathy reply
 *  • Thumbs up/down + copy on every AI bubble
 *  • Book Now button after booking-related exchanges
 *  • Breathing animation on closed button; spring open animation
 *  • Sound toggle (Web Audio API sine sweep)
 *  • Unread badge with pulse when chat is closed
 *  • "↓ Latest" scroll-to-bottom pill
 *  • Lead capture form (name, email, phone) with animated confirm
 *  • Accessibility: aria-labels, role="dialog", focus rings
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

  var STORAGE_KEY = 'zempotis_' + CLIENT_ID;

  // ── State ─────────────────────────────────────────────────────────────────
  var state = {
    isOpen: false,
    isMinimised: false,
    messages: [],        // {role, content, time}
    config: null,
    unreadCount: 0,
    leadCaptured: false,
    soundEnabled: false,
    nudgeSent: false,
    nudgeTimer: null,
    quickRepliesVisible: true,
  };

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Relative luminance (0=black … 1=white) of a hex colour.
   * Used to decide dark vs light theme.
   */
  function hexLuminance(hex) {
    hex = String(hex).replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return 0.2;
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

  /**
   * Extract a short display name from config:
   *  1. Take the first 2 words before any '—' or '-' separator in config.name.
   *  2. Fallback: strip "www." and TLD from config.url.
   */
  function getDisplayName(config) {
    if (config && config.name) {
      // Split on em-dash, en-dash, or hyphen-space
      var parts = config.name.split(/\s*[—–-]\s*/);
      var words = parts[0].trim().split(/\s+/);
      return words.slice(0, 2).join(' ');
    }
    if (config && config.url) {
      try {
        var host = new URL(config.url).hostname;
        host = host.replace(/^www\./, '');
        // Strip TLD (.com, .co.uk, etc.)
        host = host.replace(/\.[a-z]{2,}(\.[a-z]{2})?$/, '');
        return host.charAt(0).toUpperCase() + host.slice(1);
      } catch (_) {}
    }
    return 'Support';
  }

  /**
   * Returns time-based greeting prefix.
   * 0-11 → "Good morning", 12-16 → "Good afternoon", 17-23 → "Good evening"
   */
  function getTimeGreeting() {
    var h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }

  /**
   * Build the opening greeting message from config.
   */
  function buildGreetingText(config) {
    var botName   = getDisplayName(config);
    var timeGreet = getTimeGreeting();
    var custom    = (config && config.greeting) ? config.greeting : 'How can I help you today?';
    return timeGreet + '! Welcome to ' + botName + '. ' + custom;
  }

  // ── FRUSTRATION keywords ──────────────────────────────────────────────────
  var FRUSTRATION_WORDS = [
    'useless','not helpful','terrible','awful','broken','stupid',
    'rubbish','waste','hate','annoying','pointless','ridiculous'
  ];

  function isFrustrated(text) {
    var lower = text.toLowerCase();
    for (var i = 0; i < FRUSTRATION_WORDS.length; i++) {
      if (lower.indexOf(FRUSTRATION_WORDS[i]) !== -1) return true;
    }
    return false;
  }

  // ── BOOKING keywords ──────────────────────────────────────────────────────
  var BOOKING_WORDS = [
    'book','booking','appointment','tour','price','pricing',
    'cost','schedule','reserve','visit','join'
  ];

  function hasBookingKeyword(text) {
    var lower = text.toLowerCase();
    for (var i = 0; i < BOOKING_WORDS.length; i++) {
      if (lower.indexOf(BOOKING_WORDS[i]) !== -1) return true;
    }
    return false;
  }

  // ── FOLLOW-UP chip patterns ───────────────────────────────────────────────
  var CHIP_PATTERNS = [
    { words: ['membership','member'],        chips: ['What does membership include?', 'How much is membership?'] },
    { words: ['spa','treatment','massage'],  chips: ['What spa treatments are available?', 'How do I book a treatment?'] },
    { words: ['gym','fitness','class','equipment'], chips: ['What classes do you offer?', 'What are the gym hours?'] },
    { words: ['price','cost','fee','pricing'], chips: ['Are there payment plans?', 'Is there a joining fee?'] },
    { words: ['book','booking','appointment','tour'], chips: ['How do I make a booking?', 'What availability do you have?'] },
    { words: ['hour','open','opening','time','schedule'], chips: ['What are your opening hours?', 'Are you open on weekends?'] },
    { words: ['contact','phone','email','address','location'], chips: ['Where are you located?', 'How do I get in touch?'] },
    { words: ['food','restaurant','dining','menu'], chips: ['What food do you serve?', 'Do I need to book a table?'] },
    { words: ['pool','swim','swimming'],     chips: ['Is the pool heated?', 'What are the pool hours?'] },
  ];

  function getSuggestionChips(text) {
    var lower = text.toLowerCase();
    for (var i = 0; i < CHIP_PATTERNS.length; i++) {
      var p = CHIP_PATTERNS[i];
      for (var j = 0; j < p.words.length; j++) {
        if (lower.indexOf(p.words[j]) !== -1) return p.chips;
      }
    }
    return [];
  }

  // ── Sound ─────────────────────────────────────────────────────────────────
  function playNotificationTone() {
    if (!state.soundEnabled) return;
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(440, ctx.currentTime + 0.25);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.25);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.25);
    } catch (_) {}
  }

  // ── Idle nudge ────────────────────────────────────────────────────────────
  function resetNudgeTimer() {
    if (state.nudgeTimer) { clearTimeout(state.nudgeTimer); state.nudgeTimer = null; }
    if (state.nudgeSent || !state.isOpen) return;
    state.nudgeTimer = setTimeout(function () {
      if (!state.nudgeSent && state.isOpen) {
        state.nudgeSent = true;
        appendBotMessage("Still there? I'm happy to help with anything — just ask 😊", {});
      }
    }, 30000);
  }

  function cancelNudgeTimer() {
    if (state.nudgeTimer) { clearTimeout(state.nudgeTimer); state.nudgeTimer = null; }
  }

  // ── Toast ─────────────────────────────────────────────────────────────────
  function showToast(msg) {
    var existing = document.getElementById('zp-toast');
    if (existing) existing.remove();
    var toast = document.createElement('div');
    toast.id = 'zp-toast';
    toast.textContent = msg;
    toast.style.cssText = [
      'position:fixed;bottom:100px;right:28px;',
      'background:rgba(0,0,0,0.82);color:#fff;',
      'padding:7px 14px;border-radius:20px;',
      'font:500 12px/1.4 Inter,system-ui,sans-serif;',
      'z-index:2147483647;pointer-events:none;',
      'animation:zp-fade-in .2s ease-out both',
    ].join('');
    document.body.appendChild(toast);
    setTimeout(function () { if (toast.parentNode) toast.remove(); }, 2000);
  }

  // ── Styles ────────────────────────────────────────────────────────────────
  function injectStyles(primary, accent, dark) {
    var winBg      = dark ? 'rgba(13,13,22,0.96)'    : 'rgba(255,255,255,0.97)';
    var winBorder  = dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.1)';
    var botBg      = dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.055)';
    var botColor   = dark ? 'rgba(255,255,255,0.92)' : '#1a1a1a';
    var inputBg    = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)';
    var inputBdr   = dark ? 'rgba(255,255,255,0.11)' : 'rgba(0,0,0,0.14)';
    var inputColor = dark ? '#fff'                    : '#1a1a1a';
    var inputPh    = dark ? 'rgba(255,255,255,0.32)' : 'rgba(0,0,0,0.32)';
    var divider    = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
    var timeColor  = dark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.32)';
    var scrollbar  = dark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.13)';
    var footerC    = dark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.38)';
    var footerA    = dark ? 'rgba(255,255,255,0.42)' : 'rgba(0,0,0,0.52)';
    var ctrlColor  = dark ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.75)';
    var ctrlHover  = dark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.22)';
    var dotColor   = dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.25)';
    var confirmC   = dark ? '#4ade80'                 : '#16a34a';
    var actionC    = dark ? 'rgba(255,255,255,0.38)' : 'rgba(0,0,0,0.32)';
    var actionHov  = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)';
    var scrollPill = dark ? 'rgba(30,30,50,0.92)'    : 'rgba(255,255,255,0.95)';
    var scrollPillC= dark ? 'rgba(255,255,255,0.7)'  : 'rgba(0,0,0,0.6)';

    var css = [
      "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');",
      ':root{--zp-primary:'+primary+';--zp-accent:'+accent+'}',

      // ── Keyframes ──
      // Badge pulse
      '@keyframes zp-badge-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.25)}}',
      // Window slide-up (spring)
      '@keyframes zp-slide-up{from{opacity:0;transform:translateY(28px) scale(.95)}to{opacity:1;transform:translateY(0) scale(1)}}',
      // Message fade-in + lift
      '@keyframes zp-msg-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
      // Typing dots
      '@keyframes zp-dot{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1);opacity:1}}',
      // Button bounce-in from below on load
      '@keyframes zp-btn-enter{0%{opacity:0;transform:translateY(60px) scale(.7)}60%{transform:translateY(-8px) scale(1.06)}100%{opacity:1;transform:translateY(0) scale(1)}}',
      // Button breathing (when closed)
      '@keyframes zp-breathe{0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}',
      // General fade-in
      '@keyframes zp-fade-in{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}',
      // Flashing green dot heartbeat
      '@keyframes zp-heartbeat{0%,100%{opacity:1}50%{opacity:.25}}',
      // Header shimmer sweep
      '@keyframes zp-shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(200%)}}',
      // Checkmark draw
      '@keyframes zp-check-draw{from{stroke-dashoffset:50}to{stroke-dashoffset:0}}',

      // ── Launcher button ──
      '#zp-btn{position:fixed;bottom:24px;right:24px;width:60px;height:60px;border-radius:50%;',
      'background:var(--zp-primary);border:none;cursor:pointer;z-index:2147483640;',
      'display:flex;align-items:center;justify-content:center;',
      'box-shadow:0 4px 28px '+primary+'70;',
      'opacity:0;',  // starts hidden — zp-btn-enter animates it in
      'animation:zp-btn-enter .55s cubic-bezier(.34,1.56,.64,1) 1.5s forwards, zp-breathe 3s ease-in-out 2.1s infinite;',
      'transition:box-shadow .2s}',
      '#zp-btn.zp-open{animation:none;transform:scale(1)}',  // stop breathing when open
      '#zp-btn:hover{box-shadow:0 6px 32px '+primary+'90}',
      '#zp-btn-icon{display:flex;align-items:center;justify-content:center;pointer-events:none}',
      '#zp-btn-icon svg{width:28px;height:28px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',

      // Green dot on button (bottom-left)
      '#zp-btn-dot{position:absolute;bottom:3px;left:3px;width:10px;height:10px;border-radius:50%;',
      'background:#4ade80;border:2px solid #fff;',
      'animation:zp-heartbeat 2s ease-in-out infinite}',

      // ── Badge ──
      '#zp-badge{position:absolute;top:-3px;right:-3px;background:#ef4444;color:#fff;',
      'font:700 10px/1 Inter,system-ui;min-width:18px;height:18px;border-radius:9px;',
      'padding:0 4px;display:none;align-items:center;justify-content:center;pointer-events:none;',
      'box-shadow:0 0 0 2px #fff}',
      '#zp-badge.zp-pulse{animation:zp-badge-pulse 1.2s ease-in-out infinite}',

      // ── Chat window ──
      '#zp-win{position:fixed;bottom:96px;right:24px;width:380px;max-height:600px;',
      'background:'+winBg+';backdrop-filter:blur(32px) saturate(1.4);',
      '-webkit-backdrop-filter:blur(32px) saturate(1.4);',
      'border:1px solid '+winBorder+';border-radius:20px;',
      'display:flex;flex-direction:column;overflow:hidden;',
      'box-shadow:0 24px 80px rgba(0,0,0,.42);',
      'z-index:2147483639;',
      'animation:zp-slide-up .35s cubic-bezier(.34,1.56,.64,1) forwards;',
      'font-family:Inter,system-ui,sans-serif}',

      // ── Header — gradient + shimmer ──
      '#zp-header{display:flex;align-items:center;gap:10px;padding:14px 16px;flex-shrink:0;',
      'background:linear-gradient(135deg,'+primary+' 0%,'+accent+' 100%);',
      'position:relative;overflow:hidden}',
      // Shimmer pseudo-element (handled via a real element for vanilla JS compat)
      '#zp-header-shimmer{position:absolute;top:0;left:0;width:40%;height:100%;',
      'background:linear-gradient(90deg,transparent,rgba(255,255,255,.18),transparent);',
      'animation:zp-shimmer 3.5s ease-in-out infinite;pointer-events:none}',
      '#zp-avatar{width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.18);',
      'display:flex;align-items:center;justify-content:center;flex-shrink:0;position:relative;z-index:1}',
      '#zp-avatar svg{width:20px;height:20px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',
      '#zp-title-wrap{flex:1;min-width:0;position:relative;z-index:1}',
      '#zp-title{font:600 14px/1 Inter,system-ui;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '#zp-status{display:flex;align-items:center;gap:5px;margin-top:4px}',
      // Flashing green dot in header
      '.zp-dot-online{width:7px;height:7px;border-radius:50%;background:#4ade80;flex-shrink:0;',
      'animation:zp-heartbeat 2s ease-in-out infinite}',
      '#zp-status span{font:400 11px/1 Inter,system-ui;color:rgba(255,255,255,.82)}',
      '.zp-ctrl{background:none;border:none;cursor:pointer;padding:6px;border-radius:8px;',
      'color:'+ctrlColor+';transition:background .15s,color .15s;display:flex;position:relative;z-index:1;',
      'outline:none}',
      '.zp-ctrl:focus-visible{outline:2px solid rgba(255,255,255,.8);outline-offset:2px}',
      '.zp-ctrl:hover{background:'+ctrlHover+';color:#fff}',
      '.zp-ctrl svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',

      // ── Messages area ──
      '#zp-msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;',
      'position:relative;',   // needed for the scroll pill
      '-webkit-overflow-scrolling:touch;',
      'scrollbar-width:thin;scrollbar-color:'+scrollbar+' transparent}',
      '#zp-msgs::-webkit-scrollbar{width:4px}',
      '#zp-msgs::-webkit-scrollbar-thumb{background:'+scrollbar+';border-radius:4px}',

      // ── "↓ Latest" scroll pill ──
      '#zp-scroll-pill{position:sticky;bottom:0;align-self:center;',
      'background:'+scrollPill+';color:'+scrollPillC+';',
      'border:1px solid '+winBorder+';',
      'font:500 11px/1 Inter,system-ui;padding:5px 12px;border-radius:20px;',
      'cursor:pointer;display:none;z-index:10;',
      'box-shadow:0 2px 10px rgba(0,0,0,.15);',
      'transition:opacity .2s;outline:none}',
      '#zp-scroll-pill:focus-visible{outline:2px solid var(--zp-primary)}',

      // ── Bubbles ──
      '.zp-bubble-wrap{display:flex;flex-direction:column;max-width:84%;',
      'animation:zp-msg-in .25s ease-out both}',
      '.zp-bubble-wrap.zp-user{align-self:flex-end;align-items:flex-end}',
      '.zp-bubble-wrap.zp-bot{align-self:flex-start;align-items:flex-start}',
      '.zp-bubble{padding:10px 14px;border-radius:18px;font:400 13.5px/1.55 Inter,system-ui;word-break:break-word;',
      'border:2px solid transparent;transition:border-color .3s}',
      '.zp-user .zp-bubble{background:var(--zp-primary);color:#fff;border-bottom-right-radius:4px}',
      '.zp-bot .zp-bubble{background:'+botBg+';color:'+botColor+';border-bottom-left-radius:4px}',
      '.zp-bubble.zp-thumbs-up{border-color:#4ade80}',
      '.zp-time{font:400 10px/1 Inter,system-ui;color:'+timeColor+';margin-top:4px;padding:0 4px}',

      // ── Action bar (thumbs up/down, copy) ──
      '.zp-action-bar{display:flex;align-items:center;gap:2px;margin-top:4px;padding:0 2px}',
      '.zp-action-btn{background:none;border:none;cursor:pointer;padding:4px 6px;border-radius:6px;',
      'font:400 11px/1 Inter,system-ui;color:'+actionC+';transition:background .15s,color .15s;',
      'display:flex;align-items:center;gap:3px;outline:none}',
      '.zp-action-btn:focus-visible{outline:2px solid var(--zp-primary)}',
      '.zp-action-btn:hover{background:'+actionHov+';color:var(--zp-primary)}',
      '.zp-action-btn svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}',

      // Thumbs-down feedback inline input
      '.zp-feedback-wrap{display:flex;gap:6px;margin-top:6px;max-width:280px}',
      '.zp-feedback-input{flex:1;background:'+inputBg+';border:1px solid '+inputBdr+';',
      'border-radius:10px;padding:6px 10px;color:'+inputColor+';',
      'font:400 12px/1.4 Inter,system-ui;outline:none;transition:border-color .2s}',
      '.zp-feedback-input:focus{border-color:var(--zp-primary)}',
      '.zp-feedback-send{background:var(--zp-primary);color:#fff;border:none;',
      'border-radius:8px;padding:6px 10px;font:600 11px/1 Inter,system-ui;',
      'cursor:pointer;white-space:nowrap;outline:none}',
      '.zp-feedback-send:focus-visible{outline:2px solid var(--zp-primary);outline-offset:2px}',

      // ── Book Now button ──
      '.zp-book-btn{display:inline-flex;align-items:center;margin-top:8px;',
      'background:var(--zp-primary);color:#fff;border:none;cursor:pointer;',
      'padding:8px 16px;border-radius:20px;font:600 12px/1 Inter,system-ui;',
      'text-decoration:none;transition:opacity .15s;outline:none}',
      '.zp-book-btn:hover{opacity:.88}',
      '.zp-book-btn:focus-visible{outline:2px solid var(--zp-primary);outline-offset:2px}',

      // ── Typing indicator ──
      '#zp-typing{display:none;align-self:flex-start;padding:10px 14px;',
      'background:'+botBg+';border-radius:18px;border-bottom-left-radius:4px;',
      'gap:5px;align-items:center}',
      '#zp-typing span{display:inline-block;width:7px;height:7px;border-radius:50%;background:'+dotColor+'}',
      '#zp-typing span:nth-child(1){animation:zp-dot 1.2s 0s infinite}',
      '#zp-typing span:nth-child(2){animation:zp-dot 1.2s .2s infinite}',
      '#zp-typing span:nth-child(3){animation:zp-dot 1.2s .4s infinite}',

      // ── Suggestion chips (follow-up, post AI reply) ──
      '.zp-suggestion-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;max-width:300px}',
      '.zp-sug-chip{background:transparent;border:1.5px solid var(--zp-primary);',
      'color:var(--zp-primary);font:500 11px/1 Inter,system-ui;padding:6px 11px;',
      'border-radius:20px;cursor:pointer;transition:background .15s,color .15s;white-space:nowrap;',
      'outline:none}',
      '.zp-sug-chip:hover{background:var(--zp-primary);color:#fff}',
      '.zp-sug-chip:focus-visible{outline:2px solid var(--zp-primary);outline-offset:2px}',

      // ── Quick reply chips (initial) ──
      '#zp-chips{display:flex;flex-wrap:wrap;gap:7px;padding:0 16px 12px}',
      '.zp-chip{background:transparent;border:1.5px solid var(--zp-primary);',
      'color:var(--zp-primary);font:500 12px/1 Inter,system-ui;padding:7px 13px;',
      'border-radius:20px;cursor:pointer;transition:background .15s,color .15s;white-space:nowrap;',
      'outline:none}',
      '.zp-chip:hover{background:var(--zp-primary);color:#fff}',
      '.zp-chip:focus-visible{outline:2px solid var(--zp-primary);outline-offset:2px}',

      // ── Lead capture form ──
      '#zp-lead-form{display:none;flex-direction:column;gap:8px;',
      'padding:12px 14px;border-top:1px solid '+divider+';flex-shrink:0}',
      '#zp-lead-form.zp-open{display:flex}',
      '.zp-lead-input{background:'+inputBg+';border:1px solid '+inputBdr+';',
      'border-radius:10px;padding:9px 12px;color:'+inputColor+';',
      'font:400 13px/1 Inter,system-ui;outline:none;transition:border-color .2s}',
      '.zp-lead-input::placeholder{color:'+inputPh+'}',
      '.zp-lead-input:focus{border-color:var(--zp-primary)}',
      '.zp-lead-input:focus-visible{outline:2px solid var(--zp-primary);outline-offset:2px}',
      '#zp-lead-submit{background:var(--zp-primary);color:#fff;border:none;',
      'border-radius:10px;padding:10px;font:600 13px/1 Inter,system-ui;',
      'cursor:pointer;transition:opacity .15s;outline:none}',
      '#zp-lead-submit:hover{opacity:.88}',
      '#zp-lead-submit:focus-visible{outline:2px solid var(--zp-primary);outline-offset:2px}',
      // Animated checkmark confirm
      '#zp-lead-confirm{display:none;flex-direction:column;align-items:center;',
      'gap:8px;padding:8px 0;animation:zp-fade-in .35s ease-out both}',
      '#zp-lead-confirm svg{width:36px;height:36px;stroke:'+confirmC+';fill:none;stroke-width:2.5;',
      'stroke-linecap:round;stroke-linejoin:round}',
      '#zp-lead-confirm svg path{stroke-dasharray:50;stroke-dashoffset:50;',
      'animation:zp-check-draw .4s ease-out .1s forwards}',
      '#zp-lead-confirm span{font:500 12px/1.4 Inter,system-ui;color:'+confirmC+';text-align:center}',

      // ── Input area ──
      '#zp-input-wrap{display:flex;align-items:flex-end;gap:8px;padding:12px 14px;',
      'border-top:1px solid '+divider+';flex-shrink:0}',
      '#zp-input{flex:1;background:'+inputBg+';border:1px solid '+inputBdr+';',
      'border-radius:14px;padding:10px 14px;color:'+inputColor+';',
      'font:400 13.5px/1.5 Inter,system-ui;',
      'resize:none;outline:none;max-height:120px;overflow-y:auto;transition:border-color .2s}',
      '#zp-input::placeholder{color:'+inputPh+'}',
      '#zp-input:focus{border-color:var(--zp-primary)}',
      '#zp-input:focus-visible{outline:none}',  // handled by border-color
      '#zp-send{width:38px;height:38px;border-radius:50%;background:var(--zp-primary);border:none;',
      'cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;',
      'transition:opacity .2s,transform .15s;outline:none}',
      '#zp-send:hover{transform:scale(1.08)}',
      '#zp-send:focus-visible{outline:2px solid var(--zp-primary);outline-offset:2px}',
      '#zp-send:disabled{opacity:.45;cursor:default;transform:none}',
      '#zp-send svg{width:18px;height:18px;fill:none;stroke:#fff;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}',

      // Sound button
      '#zp-sound-btn svg{width:16px;height:16px}',

      // ── Footer ──
      '#zp-footer{display:flex;align-items:center;justify-content:space-between;',
      'padding:7px 14px 10px;flex-shrink:0}',
      '#zp-footer-brand{font:400 10px/1 Inter,system-ui;color:'+footerC+'}',
      '#zp-footer-brand a{color:'+footerA+';text-decoration:none}',
      '#zp-footer-brand a:hover{color:var(--zp-primary)}',
      '#zp-lead-btn{background:none;border:none;cursor:pointer;padding:0;',
      'font:400 10px/1 Inter,system-ui;color:var(--zp-primary);',
      'text-decoration:underline;opacity:.75;transition:opacity .15s;outline:none}',
      '#zp-lead-btn:hover{opacity:1}',
      '#zp-lead-btn:focus-visible{outline:2px solid var(--zp-primary);outline-offset:2px}',
      '#zp-lead-btn[disabled]{opacity:.35;cursor:default;pointer-events:none}',

      // ── Mobile: full screen below 768 px ──
      '@media(max-width:767px){',
      '#zp-win{',
      'top:0!important;left:0!important;right:0!important;bottom:0!important;',
      'width:100%!important;max-height:100%!important;',
      'border-radius:0!important;border:none!important;',
      '}',
      '#zp-btn{bottom:16px;right:16px}',
      '}',

      // Minimum 320 px width support (no extra rules needed — flexbox handles it)
    ].join('');

    var el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  // ── Icons ─────────────────────────────────────────────────────────────────
  var ICONS = {
    chat:     '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    close:    '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    minus:    '<svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    send:     '<svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    bot:      '<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M12 2v3"/><circle cx="12" cy="5" r="2"/><line x1="8" y1="15" x2="8" y2="17"/><line x1="16" y1="15" x2="16" y2="17"/></svg>',
    thumbUp:  '<svg viewBox="0 0 24 24"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>',
    thumbDn:  '<svg viewBox="0 0 24 24"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>',
    copy:     '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    soundOn:  '<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
    soundOff: '<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>',
  };

  // ── DOM builders ──────────────────────────────────────────────────────────

  function buildLauncher() {
    var btn = document.createElement('button');
    btn.id = 'zp-btn';
    btn.setAttribute('aria-label', 'Open chat');

    var icon = document.createElement('span');
    icon.id = 'zp-btn-icon';
    icon.innerHTML = ICONS.chat;

    // Flashing green dot
    var dot = document.createElement('span');
    dot.id = 'zp-btn-dot';
    dot.setAttribute('aria-hidden', 'true');

    var badge = document.createElement('span');
    badge.id = 'zp-badge';
    badge.setAttribute('aria-live', 'polite');

    btn.appendChild(icon);
    btn.appendChild(dot);
    btn.appendChild(badge);
    btn.addEventListener('click', toggleOpen);
    document.body.appendChild(btn);
  }

  function setLauncherIcon(iconHtml) {
    var el = document.getElementById('zp-btn-icon');
    if (el) el.innerHTML = iconHtml;
  }

  function buildWindow() {
    var win = document.createElement('div');
    win.id = 'zp-win';
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-label', 'Chat window');
    win.style.display = 'none';

    var displayName = state.config ? getDisplayName(state.config) : 'Support';

    win.innerHTML = [
      '<div id="zp-header">',
        '<div id="zp-header-shimmer" aria-hidden="true"></div>',
        '<div id="zp-avatar" aria-hidden="true">'+ICONS.bot+'</div>',
        '<div id="zp-title-wrap">',
          '<div id="zp-title">'+escHtml(displayName)+'</div>',
          '<div id="zp-status">',
            '<div class="zp-dot-online" aria-hidden="true"></div>',
            '<span>Online now</span>',
          '</div>',
        '</div>',
        '<button class="zp-ctrl" id="zp-sound-btn" title="Toggle sound" aria-label="Toggle sound">'+ICONS.soundOff+'</button>',
        '<button class="zp-ctrl" id="zp-min-btn"   title="Minimise"     aria-label="Minimise">'+ICONS.minus+'</button>',
        '<button class="zp-ctrl" id="zp-close-btn" title="Close"        aria-label="Close">'+ICONS.close+'</button>',
      '</div>',
      '<div id="zp-msgs" role="log" aria-live="polite" aria-label="Chat messages">',
        '<button id="zp-scroll-pill" aria-label="Scroll to latest">↓ Latest</button>',
      '</div>',
      '<div id="zp-typing" aria-label="Bot is typing" aria-live="polite"><span></span><span></span><span></span></div>',
      '<div id="zp-chips" style="display:none" role="group" aria-label="Suggested replies"></div>',
      '<div id="zp-lead-form" aria-label="Leave your details">',
        '<input class="zp-lead-input" id="zp-lead-name"  type="text"  placeholder="Full Name"          autocomplete="name"  aria-label="Full Name">',
        '<input class="zp-lead-input" id="zp-lead-email" type="email" placeholder="Email"              autocomplete="email" aria-label="Email">',
        '<input class="zp-lead-input" id="zp-lead-phone" type="tel"   placeholder="Phone (optional)"   autocomplete="tel"   aria-label="Phone (optional)">',
        '<button id="zp-lead-submit" aria-label="Submit your details">Send details</button>',
        '<div id="zp-lead-confirm">',
          '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M7 12.5l3.5 3.5 6-7" stroke-dasharray="50" stroke-dashoffset="50"/></svg>',
          '<span>Thanks! We\'ll be in touch soon.</span>',
        '</div>',
      '</div>',
      '<div id="zp-input-wrap">',
        '<textarea id="zp-input" rows="1" placeholder="Type a message…" autocomplete="off" aria-label="Type a message"></textarea>',
        '<button id="zp-send" aria-label="Send message">'+ICONS.send+'</button>',
      '</div>',
      '<div id="zp-footer">',
        '<div id="zp-footer-brand">Powered by <a href="https://zempotis.com" target="_blank" rel="noopener">Zempotis</a></div>',
        '<button id="zp-lead-btn" aria-label="Leave your details">Leave your details</button>',
      '</div>',
    ].join('');

    document.body.appendChild(win);

    // Wire up header controls
    win.querySelector('#zp-min-btn').addEventListener('click', minimise);
    win.querySelector('#zp-close-btn').addEventListener('click', closeChat);
    win.querySelector('#zp-sound-btn').addEventListener('click', toggleSound);
    win.querySelector('#zp-lead-btn').addEventListener('click', toggleLeadForm);
    win.querySelector('#zp-lead-submit').addEventListener('click', submitLead);

    // Scroll pill
    var scrollPill = win.querySelector('#zp-scroll-pill');
    scrollPill.addEventListener('click', function () {
      scrollToBottom();
      scrollPill.style.display = 'none';
    });

    // Input handlers
    var input = win.querySelector('#zp-input');
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    input.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
      // User is interacting — reset nudge timer
      resetNudgeTimer();
      // Hide suggestion chips when user starts typing
      hideSuggestionChips();
    });

    // Scroll event to show/hide scroll pill
    var msgs = win.querySelector('#zp-msgs');
    msgs.addEventListener('scroll', function () {
      var distFromBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight;
      if (scrollPill) {
        scrollPill.style.display = (distFromBottom > 100) ? 'block' : 'none';
      }
    });

    // Mobile: adjust height when virtual keyboard appears via visualViewport
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () {
        var vpHeight = window.visualViewport.height;
        var winEl = document.getElementById('zp-win');
        if (winEl && state.isOpen && window.innerWidth < 768) {
          winEl.style.height = vpHeight + 'px';
          winEl.style.maxHeight = vpHeight + 'px';
        }
      });
    }
  }

  // ── Sound toggle ──────────────────────────────────────────────────────────
  function toggleSound() {
    state.soundEnabled = !state.soundEnabled;
    var btn = document.getElementById('zp-sound-btn');
    if (btn) {
      btn.innerHTML = state.soundEnabled ? ICONS.soundOn : ICONS.soundOff;
      btn.setAttribute('aria-label', state.soundEnabled ? 'Sound on' : 'Sound off');
    }
    if (state.soundEnabled) playNotificationTone();
  }

  // ── Lead form ─────────────────────────────────────────────────────────────
  function toggleLeadForm() {
    if (state.leadCaptured) return;
    var form = document.getElementById('zp-lead-form');
    if (!form) return;
    var isOpen = form.classList.contains('zp-open');
    if (isOpen) {
      form.classList.remove('zp-open');
    } else {
      form.classList.add('zp-open');
      var nameEl = document.getElementById('zp-lead-name');
      if (nameEl) setTimeout(function () { nameEl.focus(); }, 50);
    }
  }

  function submitLead() {
    var nameEl  = document.getElementById('zp-lead-name');
    var emailEl = document.getElementById('zp-lead-email');
    var phoneEl = document.getElementById('zp-lead-phone');
    var name    = nameEl  ? nameEl.value.trim()  : '';
    var email   = emailEl ? emailEl.value.trim() : '';
    var phone   = phoneEl ? phoneEl.value.trim() : '';

    // Validate required fields
    if (!name) { if (nameEl) nameEl.focus(); return; }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (emailEl) emailEl.focus();
      return;
    }

    var submitBtn = document.getElementById('zp-lead-submit');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Sending…'; }

    // POST to API
    fetch(API_BASE + '/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, name: name, email: email, phone: phone || undefined }),
    })
      .then(function () { onLeadSuccess(name); })
      .catch(function () { onLeadSuccess(name); }); // best-effort — confirm regardless
  }

  function onLeadSuccess(name) {
    state.leadCaptured = true;

    // Hide form fields, show animated checkmark
    var nameEl  = document.getElementById('zp-lead-name');
    var emailEl = document.getElementById('zp-lead-email');
    var phoneEl = document.getElementById('zp-lead-phone');
    var submitBtn = document.getElementById('zp-lead-submit');
    var confirm   = document.getElementById('zp-lead-confirm');
    if (nameEl)   nameEl.style.display   = 'none';
    if (emailEl)  emailEl.style.display  = 'none';
    if (phoneEl)  phoneEl.style.display  = 'none';
    if (submitBtn) submitBtn.style.display = 'none';
    if (confirm)  confirm.style.display  = 'flex';

    // Disable the footer lead button permanently
    var leadBtn = document.getElementById('zp-lead-btn');
    if (leadBtn) leadBtn.setAttribute('disabled', 'true');

    // Bot sends a personalised follow-up message after a beat
    setTimeout(function () {
      var form = document.getElementById('zp-lead-form');
      if (form) form.classList.remove('zp-open');
      appendBotMessage("Thanks " + escHtml(name) + "! We\u2019ve got your details and will be in touch soon. \uD83D\uDE0A", {});
    }, 1800);
  }

  // ── Badge ─────────────────────────────────────────────────────────────────
  function updateBadge() {
    var badge = document.getElementById('zp-badge');
    if (!badge) return;
    if (state.unreadCount > 0 && !state.isOpen) {
      badge.textContent = state.unreadCount > 9 ? '9+' : String(state.unreadCount);
      badge.style.display = 'flex';
      badge.classList.add('zp-pulse');
    } else {
      badge.style.display = 'none';
      badge.classList.remove('zp-pulse');
    }
  }

  // ── Suggestion chips ──────────────────────────────────────────────────────

  function hideSuggestionChips() {
    // Remove all currently visible suggestion chip rows
    var chips = document.querySelectorAll('.zp-suggestion-chips');
    chips.forEach(function (el) { el.remove(); });
  }

  function appendSuggestionChips(botBubbleWrap, responseText) {
    var chips = getSuggestionChips(responseText);
    if (!chips.length) return;

    var row = document.createElement('div');
    row.className = 'zp-suggestion-chips';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Suggested follow-up questions');

    chips.forEach(function (chipText) {
      var btn = document.createElement('button');
      btn.className = 'zp-sug-chip';
      btn.textContent = chipText;
      btn.setAttribute('aria-label', chipText);
      btn.addEventListener('click', function () {
        hideSuggestionChips();
        sendUserMessage(chipText);
        resetNudgeTimer();
      });
      row.appendChild(btn);
    });

    botBubbleWrap.appendChild(row);
  }

  // ── Bot message append (full-featured) ───────────────────────────────────

  /**
   * appendBotMessage(content, opts)
   *  opts.bookNow {boolean} — append Book Now button
   *  opts.skipHistory {boolean} — don't push to state.messages
   */
  function appendBotMessage(content, opts) {
    opts = opts || {};
    var msgs = document.getElementById('zp-msgs');
    if (!msgs) return;

    var now = new Date();

    if (!opts.skipHistory) {
      state.messages.push({ role: 'assistant', content: content, time: now.toISOString() });
      saveHistory();
    }

    // Build bubble wrapper
    var wrap = document.createElement('div');
    wrap.className = 'zp-bubble-wrap zp-bot';

    // Bubble
    var bubble = document.createElement('div');
    bubble.className = 'zp-bubble';
    bubble.innerHTML = escHtml(content).replace(/\n/g, '<br>');
    wrap.appendChild(bubble);

    // Timestamp
    var timeEl = document.createElement('div');
    timeEl.className = 'zp-time';
    timeEl.textContent = formatTime(now);
    wrap.appendChild(timeEl);

    // Action bar: thumbs up, thumbs down, copy
    var actionBar = document.createElement('div');
    actionBar.className = 'zp-action-bar';
    actionBar.setAttribute('role', 'group');
    actionBar.setAttribute('aria-label', 'Message actions');

    // Thumbs up
    var thumbUpBtn = document.createElement('button');
    thumbUpBtn.className = 'zp-action-btn';
    thumbUpBtn.setAttribute('aria-label', 'Thumbs up');
    thumbUpBtn.innerHTML = ICONS.thumbUp;
    thumbUpBtn.addEventListener('click', function () {
      bubble.classList.add('zp-thumbs-up');
      showToast('Thanks! 👍');
      setTimeout(function () { bubble.classList.remove('zp-thumbs-up'); }, 2000);
    });

    // Thumbs down
    var thumbDnBtn = document.createElement('button');
    thumbDnBtn.className = 'zp-action-btn';
    thumbDnBtn.setAttribute('aria-label', 'Thumbs down');
    thumbDnBtn.innerHTML = ICONS.thumbDn;
    thumbDnBtn.addEventListener('click', function () {
      // Show inline feedback input if not already shown
      var existing = wrap.querySelector('.zp-feedback-wrap');
      if (existing) return;
      var feedWrap = document.createElement('div');
      feedWrap.className = 'zp-feedback-wrap';
      var feedInput = document.createElement('input');
      feedInput.className = 'zp-feedback-input';
      feedInput.type = 'text';
      feedInput.placeholder = 'What could be better?';
      feedInput.setAttribute('aria-label', 'What could be better?');
      var feedSend = document.createElement('button');
      feedSend.className = 'zp-feedback-send';
      feedSend.textContent = 'Send';
      feedSend.setAttribute('aria-label', 'Send feedback');
      feedSend.addEventListener('click', function () {
        feedWrap.innerHTML = '<span style="font:500 11px/1.4 Inter,system-ui;opacity:.7">Thanks for the feedback</span>';
      });
      feedInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { feedSend.click(); }
      });
      feedWrap.appendChild(feedInput);
      feedWrap.appendChild(feedSend);
      wrap.appendChild(feedWrap);
      setTimeout(function () { feedInput.focus(); }, 50);
    });

    // Copy
    var copyBtn = document.createElement('button');
    copyBtn.className = 'zp-action-btn';
    copyBtn.setAttribute('aria-label', 'Copy message');
    copyBtn.innerHTML = ICONS.copy;
    copyBtn.addEventListener('click', function () {
      navigator.clipboard.writeText(content).then(function () {
        showToast('Copied ✓');
      }).catch(function () {
        // Fallback for browsers without clipboard API
        var ta = document.createElement('textarea');
        ta.value = content;
        ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showToast('Copied ✓');
      });
    });

    actionBar.appendChild(thumbUpBtn);
    actionBar.appendChild(thumbDnBtn);
    actionBar.appendChild(copyBtn);
    wrap.appendChild(actionBar);

    // Book Now button (appended before chips)
    if (opts.bookNow && state.config && state.config.url) {
      var bookBtn = document.createElement('a');
      bookBtn.className = 'zp-book-btn';
      bookBtn.href = state.config.url.replace(/\/$/, '') + '/contact';
      bookBtn.target = '_blank';
      bookBtn.rel = 'noopener';
      bookBtn.textContent = 'Book Now';
      bookBtn.setAttribute('aria-label', 'Book Now');
      wrap.appendChild(bookBtn);
    }

    msgs.appendChild(wrap);
    scrollToBottom();

    // Suggestion chips — after 300 ms
    setTimeout(function () {
      appendSuggestionChips(wrap, content);
      scrollToBottom();
    }, 300);

    // Sound
    playNotificationTone();

    // Unread badge when chat not open
    if (!state.isOpen) {
      state.unreadCount++;
      updateBadge();
    }
  }

  // ── User message append ───────────────────────────────────────────────────
  function appendUserMessage(content) {
    var msgs = document.getElementById('zp-msgs');
    if (!msgs) return;

    var now = new Date();
    var wrap = document.createElement('div');
    wrap.className = 'zp-bubble-wrap zp-user';

    var bubble = document.createElement('div');
    bubble.className = 'zp-bubble';
    bubble.innerHTML = escHtml(content).replace(/\n/g, '<br>');

    var timeEl = document.createElement('div');
    timeEl.className = 'zp-time';
    timeEl.textContent = formatTime(now);

    wrap.appendChild(bubble);
    wrap.appendChild(timeEl);
    msgs.appendChild(wrap);
    scrollToBottom();
  }

  function renderHistory() {
    var msgs = document.getElementById('zp-msgs');
    if (!msgs) return;
    // Keep the scroll pill as first child
    var pill = document.getElementById('zp-scroll-pill');
    msgs.innerHTML = '';
    if (pill) msgs.appendChild(pill);

    state.messages.forEach(function (m) {
      if (m.role === 'user') {
        appendUserMessage(m.content);
      } else {
        // Re-render bot messages simply (no action bars for history to keep it fast)
        var wrap = document.createElement('div');
        wrap.className = 'zp-bubble-wrap zp-bot';
        var bubble = document.createElement('div');
        bubble.className = 'zp-bubble';
        bubble.innerHTML = escHtml(m.content).replace(/\n/g, '<br>');
        var timeEl = document.createElement('div');
        timeEl.className = 'zp-time';
        timeEl.textContent = formatTime(new Date(m.time));
        wrap.appendChild(bubble);
        wrap.appendChild(timeEl);
        msgs.appendChild(wrap);
      }
    });
    scrollToBottom();
  }

  function scrollToBottom() {
    var msgs = document.getElementById('zp-msgs');
    if (msgs) msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'smooth' });
  }

  function showTyping(show) {
    var el = document.getElementById('zp-typing');
    if (el) el.style.display = show ? 'flex' : 'none';
    if (show) scrollToBottom();
  }

  // ── Quick replies (initial session) ──────────────────────────────────────
  function showQuickReplies() {
    if (!state.config || !state.quickRepliesVisible) return;
    var chips = document.getElementById('zp-chips');
    if (!chips) return;
    chips.innerHTML = '';
    (state.config.quickReplies || []).forEach(function (reply) {
      var chip = document.createElement('button');
      chip.className = 'zp-chip';
      chip.textContent = reply;
      chip.setAttribute('aria-label', reply);
      chip.addEventListener('click', function () {
        hideQuickReplies();
        sendUserMessage(reply);
        resetNudgeTimer();
      });
      chips.appendChild(chip);
    });
    chips.style.display = (chips.children.length > 0) ? 'flex' : 'none';
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
    var btn = document.getElementById('zp-btn');
    if (win) {
      win.style.display = 'flex';
      // Re-trigger spring slide-up animation
      win.style.animation = 'none';
      // Force reflow
      void win.offsetHeight;
      win.style.animation = 'zp-slide-up .35s cubic-bezier(.34,1.56,.64,1) forwards';
    }
    if (btn) btn.classList.add('zp-open');   // stop breathing

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

    // Start idle nudge timer
    resetNudgeTimer();
  }

  function minimise() {
    state.isMinimised = true;
    state.isOpen = false;
    cancelNudgeTimer();
    var win = document.getElementById('zp-win');
    var btn = document.getElementById('zp-btn');
    if (win) win.style.display = 'none';
    if (btn) btn.classList.remove('zp-open');
    setLauncherIcon(ICONS.chat);
    updateBadge();
  }

  function closeChat() {
    state.isOpen = false;
    state.isMinimised = false;
    state.unreadCount = 0;
    cancelNudgeTimer();
    var win = document.getElementById('zp-win');
    var btn = document.getElementById('zp-btn');
    if (win) win.style.display = 'none';
    if (btn) btn.classList.remove('zp-open');
    setLauncherIcon(ICONS.chat);
    updateBadge();
  }

  // ── Greeting ──────────────────────────────────────────────────────────────
  function showGreeting() {
    var greetingText = buildGreetingText(state.config);
    var now = new Date();
    state.messages.push({ role: 'assistant', content: greetingText, time: now.toISOString() });
    saveHistory();

    // Render greeting as a bot bubble (without action bar — it's the welcome message)
    var msgs = document.getElementById('zp-msgs');
    if (msgs) {
      var wrap = document.createElement('div');
      wrap.className = 'zp-bubble-wrap zp-bot';
      var bubble = document.createElement('div');
      bubble.className = 'zp-bubble';
      bubble.innerHTML = escHtml(greetingText).replace(/\n/g, '<br>');
      var timeEl = document.createElement('div');
      timeEl.className = 'zp-time';
      timeEl.textContent = formatTime(now);
      wrap.appendChild(bubble);
      wrap.appendChild(timeEl);
      msgs.appendChild(wrap);
      scrollToBottom();
    }

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
    hideSuggestionChips();
    cancelNudgeTimer();

    var now = new Date();
    state.messages.push({ role: 'user', content: text, time: now.toISOString() });
    appendUserMessage(text);
    saveHistory();

    var sendBtn = document.getElementById('zp-send');
    if (sendBtn) sendBtn.disabled = true;

    // Frustration detection — short-circuit the API call
    if (isFrustrated(text)) {
      showTyping(true);
      setTimeout(function () {
        showTyping(false);
        appendBotMessage(
          "I\u2019m really sorry you\u2019re having a frustrating experience. Let me try to help properly \u2014 what can I do for you?",
          {}
        );
        var sendBtn2 = document.getElementById('zp-send');
        if (sendBtn2) sendBtn2.disabled = false;
        var inp2 = document.getElementById('zp-input');
        if (inp2) inp2.focus();
        resetNudgeTimer();
      }, 800);
      return;
    }

    // Check for booking keywords (user message)
    var needsBookNow = hasBookingKeyword(text);

    callAPI(needsBookNow);
    // Reset nudge after sending
    resetNudgeTimer();
  }

  function callAPI(forceBookNow) {
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
        var reply = data.reply || "Sorry, I couldn\u2019t get a response right now.";
        // Booking check: user msg OR bot reply
        var showBook = forceBookNow || hasBookingKeyword(reply);
        appendBotMessage(reply, { bookNow: showBook });
        resetNudgeTimer();
      })
      .catch(function () {
        showTyping(false);
        var msg = "I\u2019m having trouble connecting right now. Please try again in a moment.";
        appendBotMessage(msg, {});
        resetNudgeTimer();
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
        init({
          name: 'Support',
          primaryColor: '#2563eb',
          accentColor: '#7c3aed',
          greeting: 'Hi! How can I help you?',
          quickReplies: [],
        });
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
