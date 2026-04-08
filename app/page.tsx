export default function Home() {
  return (
    <main
      className="min-h-screen flex flex-col items-center justify-center p-8"
      style={{ background: "linear-gradient(135deg, #0f0f19 0%, #1a1a2e 50%, #0f0f19 100%)" }}
    >
      {/* Logo + title */}
      <div className="text-center mb-12">
        <div
          className="inline-flex items-center justify-center w-20 h-20 rounded-2xl mb-6"
          style={{ background: "linear-gradient(135deg, #2563eb, #7c3aed)", boxShadow: "0 8px 32px #2563eb55" }}
        >
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <h1 className="text-5xl font-bold text-white mb-3 tracking-tight">Zempotis Chat</h1>
        <p className="text-lg max-w-md mx-auto" style={{ color: "#93c5fd" }}>
          Intelligent AI chatbots, powered by RAG — built for premium business clients.
        </p>
      </div>

      {/* Feature cards */}
      <div className="grid grid-cols-1 gap-5 max-w-3xl w-full mb-12 md:grid-cols-3">
        {[
          {
            title: "RAG-Powered",
            desc: "Retrieves the most relevant chunks from your site before every response.",
            path: "M22 12l-4 0-3 9-6-18-3 9-4 0",
          },
          {
            title: "Auto-Scraped",
            desc: "Crawls up to 30 pages, extracts content and detects brand colours automatically.",
            path: "M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
          },
          {
            title: "One-Line Embed",
            desc: "Drop a single script tag on any website to deploy a fully branded chatbot.",
            path: "M2 3h20v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V3zM8 21h8M12 17v4",
          },
        ].map((card) => (
          <div
            key={card.title}
            className="rounded-2xl p-6 flex flex-col gap-3"
            style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
              stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d={card.path} />
            </svg>
            <h2 className="text-white font-semibold text-base">{card.title}</h2>
            <p className="text-sm leading-relaxed" style={{ color: "rgba(255,255,255,0.55)" }}>
              {card.desc}
            </p>
          </div>
        ))}
      </div>

      {/* Embed snippet */}
      <div
        className="w-full max-w-xl rounded-2xl overflow-hidden"
        style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}
      >
        <div
          className="flex items-center gap-2 px-5 py-3"
          style={{ borderBottom: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.04)" }}
        >
          <div className="w-3 h-3 rounded-full" style={{ background: "#ef4444", opacity: 0.7 }} />
          <div className="w-3 h-3 rounded-full" style={{ background: "#eab308", opacity: 0.7 }} />
          <div className="w-3 h-3 rounded-full" style={{ background: "#22c55e", opacity: 0.7 }} />
          <span className="ml-2 text-xs" style={{ color: "rgba(255,255,255,0.3)" }}>embed</span>
        </div>
        <pre
          className="px-5 py-4 text-sm overflow-x-auto"
          style={{ color: "#93c5fd", fontFamily: "monospace", margin: 0 }}
        >{`<script\n  src="https://chat.zempotis.com/widget.js"\n  data-client="your-client-id"\n  async\n></script>`}</pre>
      </div>

      <p className="mt-8 text-sm" style={{ color: "rgba(255,255,255,0.25)" }}>
        Zempotis Chat — microservice API at{" "}
        <span style={{ color: "rgba(255,255,255,0.45)" }}>chat.zempotis.com</span>
      </p>
    </main>
  );
}
