// @ts-nocheck
// All 5 styles stacked vertically for comparison screenshots

const stylesInfo = [
    { id: "colorful" as const, name: "Colorful & Playful", subtitle: "Bright, bouncy, approachable" },
    { id: "sleek" as const, name: "Sleek & Modern", subtitle: "Dark, clean, tech-forward" },
    { id: "minimal" as const, name: "Minimal & Clean", subtitle: "Sparse, calm, focused" },
    { id: "warm" as const, name: "Warm & Friendly", subtitle: "Soft tones, inviting, human" },
    { id: "bold" as const, name: "Bold & Dramatic", subtitle: "High contrast, confident" },
  ];
  
  // ─── 1. Colorful & Playful ─────────────────────────────────────────────
  // Font: Nunito (bouncy rounded sans-serif) for everything
  // Gradient on the CARD itself, not the background
  function ColorfulCard() {
    return (
      <div className="flex items-center justify-center p-8 pb-12 bg-neutral-50" style={{ fontFamily: "'Nunito', sans-serif" }}>
        <div className="w-full max-w-sm bg-gradient-to-br from-violet-100 via-purple-50 to-pink-100 rounded-3xl shadow-xl shadow-purple-200/40 p-6 space-y-5 border border-purple-200/40">
          {/* Header */}
          <div>
            <h1 className="text-2xl font-extrabold text-purple-700">
              <span className="mr-1.5">✨</span>Team Standup
            </h1>
            <p className="text-purple-400 text-sm mt-0.5 font-medium">Monday, Jan 27</p>
          </div>
  
          {/* Team members */}
          <div className="space-y-3">
            {/* Sarah - done */}
            <div className="flex items-center gap-3 bg-white/70 rounded-2xl px-4 py-3">
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-violet-400 to-purple-500 flex items-center justify-center text-white text-sm font-bold shrink-0">S</div>
              <div className="flex-1">
                <p className="font-bold text-purple-800 text-sm">Sarah Chen</p>
                <p className="text-purple-500 text-xs font-medium">Shipped auth flow</p>
              </div>
              <span className="text-lg">🎉</span>
            </div>
  
            {/* Marcus - done */}
            <div className="flex items-center gap-3 bg-white/70 rounded-2xl px-4 py-3">
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-green-400 to-emerald-500 flex items-center justify-center text-white text-sm font-bold shrink-0">M</div>
              <div className="flex-1">
                <p className="font-bold text-purple-800 text-sm">Marcus Rivera</p>
                <p className="text-purple-500 text-xs font-medium">Fixed pagination bug</p>
              </div>
              <span className="text-lg">🎉</span>
            </div>
  
            {/* Priya - pending */}
            <div className="flex items-center gap-3 bg-orange-100/50 rounded-2xl px-4 py-3">
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-orange-300 to-amber-400 flex items-center justify-center text-white text-sm font-bold shrink-0">P</div>
              <div className="flex-1">
                <p className="font-bold text-orange-700 text-sm">Priya Patel</p>
                <p className="text-orange-400 text-xs font-medium">Waiting for update...</p>
              </div>
            </div>
          </div>
  
          {/* Input */}
          <div className="flex gap-2">
            <input type="text" placeholder="What did you work on?" className="flex-1 h-11 rounded-full bg-white/70 border-none px-4 text-sm text-purple-800 placeholder:text-purple-300 outline-none font-medium" />
            <button className="h-11 px-5 rounded-full bg-gradient-to-r from-purple-500 to-pink-500 text-white text-sm font-bold shadow-lg shadow-purple-200/50">
              Post ✌️
            </button>
          </div>
        </div>
      </div>
    );
  }
  
  // ─── 2. Sleek & Modern ──────────────────────────────────────────────────
  // Font: Inter throughout (the actual Linear/Vercel font)
  function SleekCard() {
    return (
      <div className="bg-neutral-950 flex items-center justify-center p-8 pb-12" style={{ fontFamily: "'Inter', sans-serif" }}>
        <div className="w-full max-w-sm bg-neutral-900 rounded-xl border border-neutral-800 p-6 space-y-5">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-semibold text-white tracking-tight">Team Standup</h1>
              <p className="text-neutral-500 text-xs mt-0.5">Monday, Jan 27</p>
            </div>
            <span className="text-[11px] font-medium bg-emerald-500/15 text-emerald-400 px-2.5 py-1 rounded-full border border-emerald-500/20">2/3 DONE</span>
          </div>
  
          {/* Team members */}
          <div className="space-y-1">
            <div className="flex items-center gap-3 border-l-2 border-emerald-500 bg-neutral-800/50 rounded-r-lg px-4 py-3">
              <div className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
              <div className="flex-1">
                <p className="font-medium text-neutral-200 text-sm">Sarah Chen</p>
                <p className="text-neutral-500 text-xs">Shipped auth flow</p>
              </div>
            </div>
            <div className="flex items-center gap-3 border-l-2 border-emerald-500 bg-neutral-800/50 rounded-r-lg px-4 py-3">
              <div className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
              <div className="flex-1">
                <p className="font-medium text-neutral-200 text-sm">Marcus Rivera</p>
                <p className="text-neutral-500 text-xs">Fixed pagination bug</p>
              </div>
            </div>
            <div className="flex items-center gap-3 border-l-2 border-neutral-700 bg-neutral-800/30 rounded-r-lg px-4 py-3">
              <div className="w-2 h-2 rounded-full bg-neutral-600 shrink-0" />
              <div className="flex-1">
                <p className="font-medium text-neutral-400 text-sm">Priya Patel</p>
                <p className="text-neutral-600 text-xs">No update yet</p>
              </div>
            </div>
          </div>
  
          {/* Input */}
          <div className="flex gap-2">
            <input type="text" placeholder="Your update..." className="flex-1 h-9 rounded-lg bg-neutral-800 border border-neutral-700 px-3 text-sm text-white placeholder:text-neutral-600 outline-none" />
            <button className="h-9 px-4 rounded-lg bg-white text-neutral-900 text-sm font-medium">Post</button>
          </div>
        </div>
      </div>
    );
  }
  
  // ─── 3. Minimal & Clean ─────────────────────────────────────────────────
  // Font: JetBrains Mono throughout (monospace for everything)
  function MinimalCard() {
    return (
      <div className="bg-white flex items-center justify-center p-8 pb-12" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
        <div className="w-full max-w-sm border border-neutral-200 rounded-sm p-6 space-y-5">
          {/* Header */}
          <div>
            <h1 className="text-base font-medium text-neutral-800 tracking-tight">Team Standup</h1>
            <p className="text-neutral-400 text-xs mt-0.5">Monday, Jan 27</p>
          </div>
  
          {/* Team members */}
          <div className="divide-y divide-neutral-100">
            <div className="flex items-start gap-3 py-3">
              <span className="text-neutral-800 text-sm mt-0.5">✓</span>
              <p className="text-sm">
                <span className="font-medium text-neutral-700">Sarah Chen</span>
                <span className="text-neutral-400"> — Shipped auth flow</span>
              </p>
            </div>
            <div className="flex items-start gap-3 py-3">
              <span className="text-neutral-800 text-sm mt-0.5">✓</span>
              <p className="text-sm">
                <span className="font-medium text-neutral-700">Marcus Rivera</span>
                <span className="text-neutral-400"> — Fixed pagination bug</span>
              </p>
            </div>
            <div className="flex items-start gap-3 py-3">
              <span className="text-neutral-300 text-sm mt-0.5">○</span>
              <p className="text-sm">
                <span className="text-neutral-400">Priya Patel</span>
                <span className="text-neutral-300 italic"> — waiting</span>
              </p>
            </div>
          </div>
  
          <div className="border-t border-neutral-100" />
  
          {/* Input */}
          <div className="flex gap-3">
            <input type="text" placeholder="Add update" className="flex-1 h-8 bg-transparent border-b border-neutral-200 px-0 text-sm text-neutral-800 placeholder:text-neutral-300 outline-none" />
            <button className="h-8 px-3 border border-neutral-800 text-neutral-800 text-xs font-medium rounded-sm">Post</button>
          </div>
        </div>
      </div>
    );
  }
  
  // ─── 4. Warm & Friendly ─────────────────────────────────────────────────
  // Font: Lora (serif) for headings AND body
  // Gradient/color on the CARD itself, not just background
  // Badge: warm amber tone instead of green
  function WarmCard() {
    return (
      <div className="flex items-center justify-center p-8 pb-12 bg-neutral-50" style={{ fontFamily: "'Lora', serif" }}>
        <div className="w-full max-w-sm bg-gradient-to-b from-amber-50 to-orange-50/50 rounded-2xl shadow-sm border border-amber-200/60 p-6 space-y-5">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold text-stone-800">Team Standup</h1>
              <p className="text-stone-400 text-sm mt-0.5">Monday, Jan 27</p>
            </div>
            <span className="text-xs font-medium bg-amber-100 text-amber-700 px-2.5 py-1 rounded-full border border-amber-200/60">2 of 3</span>
          </div>
  
          {/* Team members */}
          <div className="space-y-3">
            {/* Sarah - done */}
            <div className="flex items-center gap-3 bg-white/80 rounded-xl px-4 py-3 border border-stone-100">
              <div className="w-9 h-9 rounded-full bg-green-100 flex items-center justify-center text-green-700 text-sm font-semibold shrink-0">S</div>
              <div className="flex-1">
                <p className="font-semibold text-stone-700 text-sm">Sarah Chen</p>
                <p className="text-stone-400 text-xs">Shipped auth flow</p>
              </div>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="text-green-500 shrink-0">
                <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.5" />
                <path d="M6.5 10L9 12.5L13.5 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
  
            {/* Marcus - done */}
            <div className="flex items-center gap-3 bg-white/80 rounded-xl px-4 py-3 border border-stone-100">
              <div className="w-9 h-9 rounded-full bg-amber-100 flex items-center justify-center text-amber-700 text-sm font-semibold shrink-0">M</div>
              <div className="flex-1">
                <p className="font-semibold text-stone-700 text-sm">Marcus Rivera</p>
                <p className="text-stone-400 text-xs">Fixed pagination bug</p>
              </div>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="text-green-500 shrink-0">
                <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.5" />
                <path d="M6.5 10L9 12.5L13.5 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
  
            {/* Priya - pending */}
            <div className="flex items-center gap-3 bg-white/40 rounded-xl px-4 py-3 border border-stone-100/60">
              <div className="w-9 h-9 rounded-full bg-stone-100 flex items-center justify-center text-stone-400 text-sm font-semibold shrink-0">P</div>
              <div className="flex-1">
                <p className="font-medium text-stone-500 text-sm">Priya Patel</p>
                <p className="text-stone-300 text-xs">Hasn't posted yet</p>
              </div>
            </div>
          </div>
  
          {/* Input */}
          <div className="flex gap-2">
            <input type="text" placeholder="Share your update..." className="flex-1 h-10 rounded-xl bg-white/70 border border-stone-200 px-4 text-sm text-stone-700 placeholder:text-stone-300 outline-none" />
            <button className="h-10 px-5 rounded-xl bg-amber-700 text-white text-sm font-semibold">Post</button>
          </div>
        </div>
      </div>
    );
  }
  
  // ─── 5. Bold & Dramatic ─────────────────────────────────────────────────
  // Font: Instrument Serif for title + member names, DM Sans for all utility text
  // Sharper corners (rounded-sm on card, no rounding on avatars)
  function BoldCard() {
    return (
      <div className="bg-neutral-950 flex items-center justify-center p-8 pb-12" style={{ fontFamily: "'DM Sans', sans-serif" }}>
        <div className="w-full max-w-sm bg-neutral-900 rounded-sm overflow-hidden border border-neutral-800">
          {/* Gradient accent bar */}
          <div className="h-1.5 bg-gradient-to-r from-red-500 via-orange-500 to-yellow-500" />
  
          <div className="p-6 space-y-5">
            {/* Header */}
            <div>
              <h1 className="text-white" style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: '26px', fontWeight: 400, letterSpacing: '-0.03em' }}>Team Standup</h1>
              <p className="text-neutral-500 text-xs mt-1 uppercase tracking-widest font-medium">Monday, Jan 27</p>
            </div>
  
            {/* Team members */}
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-sm bg-gradient-to-br from-red-500 to-orange-500 flex items-center justify-center text-white text-sm font-bold shrink-0">S</div>
                <div className="flex-1">
                  <p className="text-neutral-100" style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: '15px', fontWeight: 400 }}>Sarah Chen</p>
                  <p className="text-neutral-500 text-xs">Shipped auth flow</p>
                </div>
                <span className="text-[10px] font-bold tracking-wider bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-sm border border-emerald-500/30 uppercase">Done</span>
              </div>
  
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-sm bg-gradient-to-br from-orange-500 to-amber-500 flex items-center justify-center text-white text-sm font-bold shrink-0">M</div>
                <div className="flex-1">
                  <p className="text-neutral-100" style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: '15px', fontWeight: 400 }}>Marcus Rivera</p>
                  <p className="text-neutral-500 text-xs">Fixed pagination bug</p>
                </div>
                <span className="text-[10px] font-bold tracking-wider bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-sm border border-emerald-500/30 uppercase">Done</span>
              </div>
  
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-sm bg-neutral-800 flex items-center justify-center text-neutral-500 text-sm font-bold shrink-0">P</div>
                <div className="flex-1">
                  <p className="text-neutral-400" style={{ fontFamily: "'Instrument Serif', Georgia, serif", fontSize: '15px', fontWeight: 400 }}>Priya Patel</p>
                  <p className="text-neutral-600 text-xs">—</p>
                </div>
              </div>
            </div>
  
            {/* Input */}
            <div className="flex gap-2">
              <input type="text" placeholder="Your update" className="flex-1 h-10 rounded-sm bg-neutral-800 border border-neutral-700 px-3 text-sm text-white placeholder:text-neutral-600 outline-none" />
              <button className="h-10 px-5 rounded-sm bg-gradient-to-r from-red-500 to-orange-500 text-white text-sm font-bold uppercase tracking-wider">Post</button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  
  const cards: Record<string, { component: () => JSX.Element }> = {
    colorful: { component: ColorfulCard },
    sleek: { component: SleekCard },
    minimal: { component: MinimalCard },
    warm: { component: WarmCard },
    bold: { component: BoldCard },
  };
  
  export default function AllStyles() {
    return (
      <div>
        {stylesInfo.map((s, i) => {
          const Card = cards[s.id].component;
          return (
            <div key={s.id}>
              <div className="text-center py-3 bg-neutral-100 text-neutral-600 text-sm font-medium border-b border-neutral-200" style={{ fontFamily: "'Inter', sans-serif" }}>
                {i + 1}. {s.name} — <span className="text-neutral-400">{s.subtitle}</span>
              </div>
              <Card />
            </div>
          );
        })}
      </div>
    );
  }
  
