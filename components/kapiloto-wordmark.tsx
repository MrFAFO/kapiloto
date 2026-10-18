/** Brand/Kapiloto Wordmark · Size=Header (Figma node 69:11). */
export function KapilotoWordmark() {
  return (
    <div className="flex items-center justify-center gap-[5px] p-1" aria-label="קפילוטו">
      <span
        aria-hidden
        className="whitespace-nowrap bg-gradient-to-r from-[#fafaff] via-[#cca3ff] via-[58%] to-[#8c3dfa] bg-clip-text text-[22px] font-extrabold leading-none text-transparent [filter:drop-shadow(0_3px_8px_rgba(112,56,250,0.26))]"
        style={{ fontFamily: "var(--font-wordmark), Rubik, sans-serif" }}
      >
        קפילוטו
      </span>
      <img
        src="/brand/kapiloto-football-mark.svg"
        alt=""
        width={19}
        height={19}
        className="block size-[19px] shrink-0"
      />
    </div>
  );
}
