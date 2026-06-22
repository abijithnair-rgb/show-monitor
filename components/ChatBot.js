'use client';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/useStore';
import { buildContext } from '@/lib/buildContext';

const BOT_NAME = 'Show Master';
const TAGLINE = 'Lifecycle × fatigue, reconciled.';

// First-touch quick picks help the bot scope to the user's slice.
const SUGGESTIONS = [
  'I work on Hindi — Awareness BU',
  'I work on Hindi — Income BU',
  'I work on Hindi — Skill BU',
  'I work on Telugu (whole language)',
  'Skip — give me the whole-product view',
];

const PEEK_MESSAGES = [
  '👋 Want me to flag the shows that need action today?',
  'Need a Slack-ready summary of this week’s verdicts?',
  'Curious which shows are scale-ready? Ask me.',
  'I can explain why a show is flagged Stop vs Fix.',
  'Want the lowdown on a specific show? Just ask.',
  'Shall I rank the shows slipping vs peers?',
  'I can turn the dashboard into a quick exec update.',
  'Ask me which experiments are ready to promote.',
];

// Bot avatar: user-provided /bot-mascot.png, with an inline SVG robot fallback.
function Avatar({ size = 28, className = '' }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden>
        <rect x="8" y="8" width="48" height="48" rx="12" fill="#fff" />
        <rect x="14" y="18" width="36" height="28" rx="8" fill="#1D9E75" />
        <circle cx="25" cy="32" r="4.5" fill="#fff" />
        <circle cx="39" cy="32" r="4.5" fill="#fff" />
        <rect x="27" y="40" width="10" height="3" rx="1.5" fill="#fff" />
        <rect x="30" y="9" width="4" height="7" rx="2" fill="#0B5D44" />
        <circle cx="32" cy="8" r="3" fill="#0B5D44" />
      </svg>
    );
  }
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src="/bot-mascot.png"
      alt={BOT_NAME}
      width={size}
      height={size}
      className={'rounded-full object-cover ' + className}
      style={{ width: size, height: size }}
      onError={() => setBroken(true)}
    />
  );
}

function TypingDots() {
  return (
    <span className="inline-flex gap-1 items-center py-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-theme-fg/60 inline-block animate-bounce"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  );
}

function AssistantBubble({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group relative flex gap-2 items-start">
      <Avatar size={26} className="mt-0.5 shrink-0" />
      <div className="relative max-w-[80%] rounded-2xl rounded-tl-sm bg-theme-bg text-slate-800 px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap break-words border border-theme-border">
        {text}
        <button
          onClick={() => {
            navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 transition bg-white border border-theme-border text-theme-fg text-[10px] font-semibold rounded-full px-2 py-0.5 shadow-sm"
          title="Copy for Slack"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export default function ChatBot() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]); // {role, content}
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [hasChatted, setHasChatted] = useState(false);
  const [peek, setPeek] = useState(null);
  const peekIdx = useRef(0);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // Auto-grow the input textarea with its content (1 line → up to ~6 lines).
  function autosize(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }
  useEffect(() => {
    autosize(inputRef.current);
  }, [input]);

  // periodic peek-out greetings (first at 8s, then every 2 min; visible 7s each)
  useEffect(() => {
    if (open || hasChatted) {
      setPeek(null);
      return;
    }
    let hideT;
    const show = () => {
      setPeek(PEEK_MESSAGES[peekIdx.current % PEEK_MESSAGES.length]);
      peekIdx.current += 1;
      hideT = setTimeout(() => setPeek(null), 7000);
    };
    const first = setTimeout(show, 8000);
    const iv = setInterval(show, 120000);
    return () => {
      clearTimeout(first);
      clearInterval(iv);
      clearTimeout(hideT);
    };
  }, [open, hasChatted]);

  // auto-scroll to latest
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading, open]);

  async function send(text) {
    const content = (text ?? input).trim();
    if (!content || loading) return;
    setHasChatted(true);
    setPeek(null);
    const next = [...messages, { role: 'user', content }];
    setMessages(next);
    setInput('');
    setLoading(true);
    setError(null);
    try {
      const context = buildContext(useStore.getState().data());
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: next, context }),
      });
      const ct = res.headers.get('content-type') || '';
      // Error responses come back as JSON with a proper status.
      if (!res.ok || ct.includes('application/json') || !res.body) {
        const json = await res.json().catch(() => ({}));
        setError(json.error || `Request failed (HTTP ${res.status}).`);
        return;
      }
      // Stream the reply token-by-token into a growing assistant bubble.
      setMessages((m) => [...m, { role: 'assistant', content: '' }]);
      setLoading(false);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = { role: 'assistant', content: acc };
          return copy;
        });
      }
      if (!acc.trim()) {
        setMessages((m) => {
          const copy = [...m];
          copy[copy.length - 1] = { role: 'assistant', content: '(empty response)' };
          return copy;
        });
      }
    } catch (e) {
      setError(e.message || 'Network error.');
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setMessages([]);
    setError(null);
    setInput('');
  }

  return (
    <>
      {/* Peek greeting (only when closed) */}
      {!open && peek && (
        <div className="fixed bottom-24 right-5 z-[60] flex items-end gap-2 max-w-[280px] animate-[fadeIn_.2s_ease]">
          <div className="relative bg-white border border-theme-border shadow-lg rounded-2xl rounded-br-sm px-3 py-2 text-[13px] text-slate-700">
            <button
              onClick={() => setPeek(null)}
              className="absolute -top-2 -right-2 bg-white border border-slate-200 rounded-full w-5 h-5 text-slate-400 text-xs leading-none shadow-sm"
              aria-label="Dismiss"
            >
              ×
            </button>
            <button className="text-left" onClick={() => setOpen(true)}>
              {peek}
            </button>
          </div>
          <Avatar size={36} className="shrink-0 border-2 border-white shadow" />
        </div>
      )}

      {/* Floating button */}
      {!open && (
        <button
          onClick={() => { setOpen(true); setPeek(null); }}
          className="fixed bottom-5 right-5 z-[60] w-14 h-14 rounded-full shadow-xl flex items-center justify-center text-white hover:scale-105 transition"
          style={{ background: '#1D9E75' }}
          aria-label={`Open ${BOT_NAME}`}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
        </button>
      )}

      {/* Chat window */}
      {open && (
        <div
          className="fixed bottom-5 right-5 z-[60] flex flex-col bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden"
          style={{ width: 480, height: 720, maxWidth: 'calc(100vw - 2rem)', maxHeight: 'calc(100vh - 2rem)' }}
        >
          {/* header */}
          <div className="flex items-center gap-2 px-3 py-2.5 text-white" style={{ background: '#1D9E75' }}>
            <Avatar size={34} className="border-2 border-white/70 shrink-0" />
            <div className="leading-tight flex-1 min-w-0">
              <div className="font-semibold text-sm truncate">{BOT_NAME}</div>
              <div className="text-[11px] opacity-90 truncate">{TAGLINE}</div>
            </div>
            <button onClick={reset} title="Start a fresh conversation" className="text-white/90 hover:text-white text-xs font-semibold px-2 py-1 rounded hover:bg-white/15">
              Reset
            </button>
            <button onClick={() => setOpen(false)} title="Close" className="text-white/90 hover:text-white text-lg leading-none px-2 py-1 rounded hover:bg-white/15">
              ×
            </button>
          </div>

          {/* messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3 bg-slate-50">
            {messages.length === 0 && (
              <div className="space-y-3">
                <AssistantBubble text={`Hi! I’m ${BOT_NAME}. To tailor my answers, tell me what you own: which language do you work on — Hindi, Telugu, Tamil, Malayalam, or Kannada? If it’s Hindi, also tell me your BU (Awareness, Income, or Skill). Working across everything? Just say so or ask your question directly.`} />
                <div className="flex flex-col gap-2">
                  {SUGGESTIONS.map((q) => (
                    <button
                      key={q}
                      onClick={() => send(q)}
                      className="text-left text-[12.5px] border border-theme-border text-theme-fg bg-theme-bg/60 hover:bg-theme-bg rounded-xl px-3 py-2 transition"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) =>
              m.role === 'assistant' ? (
                <AssistantBubble key={i} text={m.content} />
              ) : (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[80%] rounded-2xl rounded-tr-sm px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap break-words text-white" style={{ background: '#1D9E75' }}>
                    {m.content}
                  </div>
                </div>
              )
            )}

            {loading && (
              <div className="flex gap-2 items-center">
                <Avatar size={26} className="shrink-0" />
                <div className="rounded-2xl rounded-tl-sm bg-theme-bg border border-theme-border px-3 py-2">
                  <TypingDots />
                </div>
              </div>
            )}

            {error && (
              <div className="banner banner-red text-[12px]">
                <span>⚠ {error}</span>
              </div>
            )}
          </div>

          {/* input */}
          <form
            onSubmit={(e) => { e.preventDefault(); send(); }}
            className="flex items-end gap-2 border-t border-slate-200 p-2.5 bg-white"
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder="Ask about your shows…  (Shift+Enter for a new line)"
              disabled={loading}
              className="flex-1 resize-none border border-slate-300 rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed focus:outline-none focus:border-theme-solid disabled:opacity-60 overflow-y-auto"
              style={{ maxHeight: 140 }}
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="text-white rounded-full w-9 h-9 flex items-center justify-center disabled:opacity-40 transition shrink-0"
              style={{ background: '#1D9E75' }}
              aria-label="Send"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </form>
        </div>
      )}
      <style jsx global>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
      `}</style>
    </>
  );
}
