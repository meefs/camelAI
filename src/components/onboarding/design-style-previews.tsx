function ColorfulDesignPreview() {
  return (
    <div style={{ fontFamily: "'Nunito', sans-serif" }}>
      <div className="w-full rounded-3xl border border-purple-200/40 bg-gradient-to-br from-violet-100 via-purple-50 to-pink-100 p-3 sm:p-4">
        <div>
          <h2 className="text-[15px] font-extrabold text-purple-700">
            <span className="mr-1">✨</span>Team Standup
          </h2>
          <p className="mt-0.5 text-[10px] font-medium text-purple-400">Monday, Jan 27</p>
        </div>

        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2 rounded-2xl bg-white/70 px-2.5 py-2">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-400 to-purple-500 text-xs font-bold text-white">
              S
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-bold text-purple-800">Sarah Chen</p>
              <p className="truncate text-[10px] font-medium text-purple-500">
                Shipped auth flow
              </p>
            </div>
            <span className="text-base leading-none">🎉</span>
          </div>

          <div className="flex items-center gap-2 rounded-2xl bg-white/70 px-2.5 py-2">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-green-400 to-emerald-500 text-xs font-bold text-white">
              M
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-bold text-purple-800">Marcus Rivera</p>
              <p className="truncate text-[10px] font-medium text-purple-500">
                Fixed pagination bug
              </p>
            </div>
            <span className="text-base leading-none">🎉</span>
          </div>

          <div className="flex items-center gap-2 rounded-2xl border border-dashed border-orange-300/80 bg-orange-100/50 px-2.5 py-2">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-orange-300 to-amber-400 text-xs font-bold text-white">
              P
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-bold text-orange-700">Priya Patel</p>
              <p className="truncate text-[10px] font-medium text-orange-400">
                Waiting for update...
              </p>
            </div>
            <span className="text-base leading-none">⏳</span>
          </div>
        </div>

        <div className="mt-3 flex gap-1.5">
          <input
            readOnly
            tabIndex={-1}
            value=""
            placeholder="What did you work on?"
            className="h-8 flex-1 rounded-full border-none bg-white/70 px-2.5 text-[11px] text-purple-800 placeholder:text-purple-300 outline-none"
          />
          <button
            type="button"
            tabIndex={-1}
            className="h-8 rounded-full bg-gradient-to-r from-purple-500 to-pink-500 px-3 text-[11px] font-bold text-white"
          >
            Post ✌️
          </button>
        </div>
      </div>
    </div>
  );
}

function SleekDesignPreview() {
  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
      <div className="w-full rounded-[18px] border border-neutral-800/90 bg-gradient-to-b from-[#0d1015] to-[#08090c] p-3 sm:p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight text-white">
              Team Standup
            </h2>
            <p className="mt-0.5 text-[10px] text-neutral-500">Monday, Jan 27</p>
          </div>
          <span className="rounded-full bg-[#10d95a] px-2.5 py-1 text-[10px] font-semibold tracking-wide text-[#05120a]">
            2/3 DONE
          </span>
        </div>

        <div className="mt-3 space-y-1.5">
          <div className="flex items-center gap-2.5 rounded-xl border border-neutral-800 bg-[#111318] px-2.5 py-2">
            <div className="size-2 shrink-0 rounded-full bg-emerald-400" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-neutral-100">Sarah Chen</p>
              <p className="truncate text-[10px] text-neutral-500">Shipped auth flow</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5 rounded-xl border border-neutral-800 bg-[#111318] px-2.5 py-2">
            <div className="size-2 shrink-0 rounded-full bg-emerald-400" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-neutral-100">
                Marcus Rivera
              </p>
              <p className="truncate text-[10px] text-neutral-500">Fixed pagination bug</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5 rounded-xl border border-neutral-800 bg-[#0e1014] px-2.5 py-2">
            <div className="size-2 shrink-0 rounded-full bg-neutral-700" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-neutral-400">Priya Patel</p>
              <p className="truncate text-[10px] text-neutral-600">No update yet</p>
            </div>
          </div>
        </div>

        <div className="mt-3 flex gap-1.5">
          <input
            readOnly
            tabIndex={-1}
            value=""
            placeholder="Your update..."
            className="h-8 flex-1 rounded-xl border border-neutral-800 bg-[#0b0d10] px-2.5 text-[11px] text-white placeholder:text-neutral-500 outline-none"
          />
          <button
            type="button"
            tabIndex={-1}
            className="h-8 rounded-xl bg-white px-3 text-[11px] font-semibold text-neutral-950"
          >
            Post
          </button>
        </div>
      </div>
    </div>
  );
}

function MinimalDesignPreview() {
  return (
    <div style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      <div className="w-full rounded-sm border border-neutral-200 bg-white p-3 sm:p-4">
        <div>
          <h2 className="text-[13px] font-medium tracking-tight text-neutral-800">
            Team Standup
          </h2>
          <p className="mt-0.5 text-[10px] text-neutral-400">Monday, Jan 27</p>
        </div>

        <div className="mt-3 divide-y divide-neutral-100">
          <div className="flex items-start gap-2 py-2">
            <span className="mt-0.5 text-[11px] text-neutral-800">✓</span>
            <p className="text-[11px]">
              <span className="font-medium text-neutral-700">Sarah Chen</span>
              <span className="text-neutral-400"> — Shipped auth flow</span>
            </p>
          </div>
          <div className="flex items-start gap-2 py-2">
            <span className="mt-0.5 text-[11px] text-neutral-800">✓</span>
            <p className="text-[11px]">
              <span className="font-medium text-neutral-700">Marcus Rivera</span>
              <span className="text-neutral-400"> — Fixed pagination bug</span>
            </p>
          </div>
          <div className="flex items-start gap-2 py-2">
            <span className="mt-0.5 text-[11px] text-neutral-300">○</span>
            <p className="text-[11px]">
              <span className="text-neutral-400">Priya Patel</span>
              <span className="text-neutral-300 italic"> — waiting</span>
            </p>
          </div>
        </div>

        <div className="mt-3 border-t border-neutral-100 pt-2.5">
          <div className="flex gap-1.5">
            <input
              readOnly
              tabIndex={-1}
              value=""
              placeholder="Add update"
              className="h-6 flex-1 border-b border-neutral-200 bg-transparent px-0 text-[11px] text-neutral-800 placeholder:text-neutral-300 outline-none"
            />
            <button
              type="button"
              tabIndex={-1}
              className="h-6 rounded-sm border border-neutral-800 px-2 text-[9px] font-medium text-neutral-800"
            >
              Post
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WarmDesignPreview() {
  return (
    <div style={{ fontFamily: "'Lora', serif" }}>
      <div className="w-full rounded-2xl border border-[#ecd9aa] bg-[#fbf8ee] p-3 sm:p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-stone-800">Team Standup</h2>
            <p className="mt-0.5 text-[10px] text-stone-400">Monday, Jan 27</p>
          </div>
          <span className="rounded-full border border-[#f1dca9] bg-[#fff2cf] px-2 py-1 text-[9px] font-medium text-amber-700">
            2 of 3
          </span>
        </div>

        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2 rounded-xl border border-[#ebe2d4] bg-[#fffdf8] px-2.5 py-2">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-green-100 text-[11px] font-semibold text-green-700">
              S
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-stone-700">Sarah Chen</p>
              <p className="truncate text-[10px] text-stone-400">Shipped auth flow</p>
            </div>
            <svg
              width="16"
              height="16"
              viewBox="0 0 20 20"
              fill="none"
              className="shrink-0 text-green-600"
            >
              <circle cx="10" cy="10" r="8.5" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M6.5 10L9 12.5L13.5 7.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>

          <div className="flex items-center gap-2 rounded-xl border border-[#ebe2d4] bg-[#fffdf8] px-2.5 py-2">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-100 text-[11px] font-semibold text-amber-700">
              M
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-stone-700">Marcus Rivera</p>
              <p className="truncate text-[10px] text-stone-400">Fixed pagination bug</p>
            </div>
            <svg
              width="16"
              height="16"
              viewBox="0 0 20 20"
              fill="none"
              className="shrink-0 text-green-600"
            >
              <circle cx="10" cy="10" r="8.5" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M6.5 10L9 12.5L13.5 7.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>

          <div className="flex items-center gap-2 rounded-xl border border-[#e6ddd0] bg-[#f3efe7] px-2.5 py-2">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-stone-100 text-[11px] font-semibold text-stone-500">
              P
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-stone-500">Priya Patel</p>
              <p className="truncate text-[10px] text-stone-400">No update yet</p>
            </div>
          </div>
        </div>

        <div className="mt-3 flex gap-1.5">
          <input
            readOnly
            tabIndex={-1}
            value=""
            placeholder="Share your update..."
            className="h-7 flex-1 rounded-xl border border-[#d8cec0] bg-[#fbf8f2] px-2.5 text-[11px] text-stone-700 placeholder:text-stone-400 outline-none"
          />
          <button
            type="button"
            tabIndex={-1}
            className="h-7 rounded-xl bg-amber-700 px-3 text-[11px] font-semibold text-white"
          >
            Post
          </button>
        </div>
      </div>
    </div>
  );
}

function BoldDesignPreview() {
  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif" }}>
      <div className="w-full overflow-hidden rounded-sm border border-neutral-800 bg-neutral-900">
        <div className="h-1.5 bg-gradient-to-r from-red-500 via-orange-500 to-yellow-500" />

        <div className="space-y-3 p-3 sm:p-4">
          <div>
            <h2
              className="text-lg font-normal tracking-tight text-white"
              style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
            >
              Team Standup
            </h2>
            <p className="mt-1 text-[9px] font-medium uppercase tracking-[0.2em] text-neutral-500">
              Monday, Jan 27
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-gradient-to-br from-red-500 to-orange-500 text-xs font-bold text-white">
                S
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-xs text-neutral-100"
                  style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
                >
                  Sarah Chen
                </p>
                <p className="truncate text-[10px] text-neutral-500">Shipped auth flow</p>
              </div>
              <span className="rounded-sm border border-emerald-500/30 bg-emerald-500/20 px-2 py-0.5 text-[8px] font-bold uppercase tracking-wider text-emerald-400">
                Done
              </span>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-gradient-to-br from-orange-500 to-amber-500 text-xs font-bold text-white">
                M
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-xs text-neutral-100"
                  style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
                >
                  Marcus Rivera
                </p>
                <p className="truncate text-[10px] text-neutral-500">Fixed pagination bug</p>
              </div>
              <span className="rounded-sm border border-emerald-500/30 bg-emerald-500/20 px-2 py-0.5 text-[8px] font-bold uppercase tracking-wider text-emerald-400">
                Done
              </span>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-neutral-800 text-xs font-bold text-neutral-500">
                P
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-xs text-neutral-400"
                  style={{ fontFamily: "'Instrument Serif', Georgia, serif" }}
                >
                  Priya Patel
                </p>
                <p className="truncate text-[10px] text-neutral-600">-</p>
              </div>
            </div>
          </div>

          <div className="flex gap-1.5">
            <input
              readOnly
              tabIndex={-1}
              value=""
              placeholder="Your update"
              className="h-7 flex-1 rounded-sm border border-neutral-700 bg-neutral-800 px-2.5 text-[11px] text-white placeholder:text-neutral-600 outline-none"
            />
            <button
              type="button"
              tabIndex={-1}
              className="h-7 rounded-sm bg-gradient-to-r from-red-500 to-orange-500 px-3 text-[9px] font-bold uppercase tracking-wider text-white"
            >
              Post
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export const DESIGN_STYLE_PREVIEWS = {
  colorful: ColorfulDesignPreview,
  sleek: SleekDesignPreview,
  minimal: MinimalDesignPreview,
  warm: WarmDesignPreview,
  bold: BoldDesignPreview,
} as const;
