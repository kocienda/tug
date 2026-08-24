export const retronow = {
  shell:
    "rn-shell rounded-sm border border-[#a29b8a] bg-[#dddad2] text-[#29343c] shadow-none",
  panel:
    "rn-panel rounded-[4px] border border-[#b0a998] bg-[#c5c0b5] shadow-none",
  title:
    "font-mono text-xs uppercase tracking-[0.07em]",
  button:
    "rn-button rounded-[4px] border border-[#b0a998] bg-[linear-gradient(180deg,#f2bf52_0%,#ff7f2a_100%)] px-2 py-1 font-mono text-[0.62rem] uppercase tracking-[0.08em] text-[#2e3b44] shadow-none active:translate-y-0",
  buttonSecondary:
    "rounded-[4px] border border-[#b0a998] bg-[linear-gradient(180deg,#ccd0d2_0%,#b7bdc1_100%)] px-2 py-1 font-mono text-[0.62rem] uppercase tracking-[0.08em] text-[#2e3b44]",
  input:
    "rn-control min-h-[26px] rounded-[4px] border border-[#b0a998] bg-[#ece9e1] px-2 py-1 font-mono text-[0.78rem] text-[#1e2b32] shadow-none focus-visible:ring-1 focus-visible:ring-[#42b8e6]/60 focus-visible:ring-offset-0",
  textarea:
    "rn-control min-h-[98px] rounded-[4px] border border-[#b0a998] bg-[#ece9e1] px-2 py-1 text-[0.78rem] text-[#1e2b32] shadow-none focus-visible:ring-1 focus-visible:ring-[#42b8e6]/60 focus-visible:ring-offset-0",
  tabs:
    "rn-tab rounded-t-[4px] border border-[#b0a998] border-b-0 bg-[#cfcbc1] px-2 py-1 font-mono text-[0.62rem] uppercase tracking-[0.08em] text-[#2a3841] data-[state=active]:translate-y-0 data-[state=active]:bg-[#dddad2]",
  cardCanvas:
    "relative min-h-[70vh] overflow-hidden rounded-[4px] border border-[#8e8878] bg-[linear-gradient(transparent_23px,rgba(255,255,255,0.06)_24px),linear-gradient(90deg,transparent_23px,rgba(255,255,255,0.06)_24px),linear-gradient(180deg,#46545d_0%,#36434c_100%)] bg-[length:24px_24px,24px_24px,100%_100%]",
  card:
    "absolute flex min-h-40 min-w-[220px] flex-col overflow-hidden rounded-[6px] border border-[#b0a998] bg-[#dddad2] shadow-none",
  cardHeader:
    "flex cursor-move items-center justify-between border-b border-[#b0a998] bg-[#c5cdd3] px-2 py-1 font-mono text-[0.62rem] uppercase tracking-[0.08em]",
  cardBody: "flex-1 overflow-auto bg-[#ece9e1] p-2"
};

export type RetronowClassKey = keyof typeof retronow;
